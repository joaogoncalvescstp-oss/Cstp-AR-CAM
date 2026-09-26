"""Generate a small road alignment (tangent - clothoid - arc - clothoid -
tangent) with a vertical profile and a few CgPoints.

  python3 tools/make_demo.py                      -> samples/demo-alignment.xml (local, no CRS)
  python3 tools/make_demo.py E N BEARING EPSG OUT -> georeferenced copy
"""
import math
import sys

if len(sys.argv) == 6:
    E0, N0, B0 = float(sys.argv[1]), float(sys.argv[2]), math.radians(float(sys.argv[3]))
    EPSG, OUT = sys.argv[4], sys.argv[5]
else:
    E0, N0, B0 = 1000.0, 5000.0, math.radians(30)  # start, bearing cw from north
    EPSG, OUT = None, "samples/demo-alignment.xml"
segs = [("line", 80), ("spiral", 40, math.inf, 200), ("arc", 60, 200), ("spiral", 40, 200, math.inf), ("line", 100)]
ROT = -1  # -1 = clockwise (right turn)


def curv(r):
    return 0.0 if math.isinf(r) else ROT / r


x, y, th = E0, N0, math.pi / 2 - B0  # math angle (ccw from east)
out, sta = [], 0.0
track = [(sta, x, y)]
for s in segs:
    kind, L = s[0], s[1]
    k0, k1 = (0, 0) if kind == "line" else (curv(s[2]), curv(s[3])) if kind == "spiral" else (curv(s[2]), curv(s[2]))
    sx, sy, sth = x, y, th
    n = 4000
    ds = L / n
    for i in range(n):
        sm = (i + 0.5) * ds
        a = sth + k0 * sm + (k1 - k0) * sm * sm / (2 * L)
        x += ds * math.cos(a)
        y += ds * math.sin(a)
    th = sth + k0 * L + (k1 - k0) * L / 2
    sta += L
    track.append((sta, x, y))
    seg = {"kind": kind, "L": L, "start": (sx, sy), "end": (x, y), "th0": sth, "th1": th}
    if kind == "arc":
        r = s[2]
        # centre is to the right for a clockwise curve
        cx, cy = sx + r * math.cos(sth + ROT * math.pi / 2), sy + r * math.sin(sth + ROT * math.pi / 2)
        seg["center"] = (cx, cy)
        seg["r"] = r
    if kind in ("arc", "spiral"):
        # PI = intersection of start and end tangents
        d0 = (math.cos(sth), math.sin(sth))
        d1 = (math.cos(th), math.sin(th))
        den = d0[0] * d1[1] - d0[1] * d1[0]
        t = ((x - sx) * d1[1] - (y - sy) * d1[0]) / den
        seg["pi"] = (sx + t * d0[0], sy + t * d0[1])
        seg["s"] = s
    out.append(seg)


def pt(p):
    return f"{p[1]:.4f} {p[0]:.4f}"  # LandXML order: northing easting


def fr(v):
    return "INF" if math.isinf(v) else f"{v:.4f}"


geom = []
for g in out:
    if g["kind"] == "line":
        geom.append(f'        <Line length="{g["L"]:.4f}">\n          <Start>{pt(g["start"])}</Start>\n          <End>{pt(g["end"])}</End>\n        </Line>')
    elif g["kind"] == "arc":
        geom.append(f'        <Curve rot="cw" radius="{g["r"]:.4f}" length="{g["L"]:.4f}">\n          <Start>{pt(g["start"])}</Start>\n          <Center>{pt(g["center"])}</Center>\n          <End>{pt(g["end"])}</End>\n          <PI>{pt(g["pi"])}</PI>\n        </Curve>')
    else:
        s = g["s"]
        geom.append(f'        <Spiral rot="cw" spiType="clothoid" length="{g["L"]:.4f}" radiusStart="{fr(s[2])}" radiusEnd="{fr(s[3])}">\n          <Start>{pt(g["start"])}</Start>\n          <PI>{pt(g["pi"])}</PI>\n          <End>{pt(g["end"])}</End>\n        </Spiral>')


def at_station(st, off=0.0):
    # walk a finely sampled copy of the geometry
    for (s0, x0, y0), (s1, x1, y1) in zip(track, track[1:]):
        if s0 <= st <= s1:
            break
    # resample precisely by re-integrating
    x, y, th, s = E0, N0, math.pi / 2 - B0, 0.0
    for seg in segs:
        kind, L = seg[0], seg[1]
        k0, k1 = (0, 0) if kind == "line" else (curv(seg[2]), curv(seg[3])) if kind == "spiral" else (curv(seg[2]), curv(seg[2]))
        n = 4000
        ds = L / n
        for i in range(n):
            if s >= st:
                a = th
                return x + off * math.cos(a - math.pi / 2), y + off * math.sin(a - math.pi / 2)
            sm = (i + 0.5) * ds
            a = th + k0 * sm + (k1 - k0) * sm * sm / (2 * L)
            x += ds * math.cos(a)
            y += ds * math.sin(a)
            s += ds
        th = th + k0 * L + (k1 - k0) * L / 2
    return x, y


def z_at(st):
    # PVI 0 @100, PVI 160 @104 with 100 m parabola, PVI 320 @101
    g1, g2 = 4 / 160, -3 / 160
    if 110 <= st <= 210:
        xx = st - 110
        return 100 + g1 * 110 + g1 * xx + (g2 - g1) / 200 * xx * xx
    return 100 + g1 * st if st < 160 else 104 + g2 * (st - 160)


pts = []
for name, code, st, off in [("SIGN-01", "Road sign", 50, 5.0), ("MH-01", "Manhole", 180, -4.0), ("TREE-07", "Tree to remove", 260, 8.0)]:
    px, py = at_station(st, off)
    pts.append(f'    <CgPoint name="{name}" code="{code}">{py:.4f} {px:.4f} {z_at(st):.3f}</CgPoint>')

total = sum(s[1] for s in segs)
xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2" date="2026-09-26" time="12:00:00">
  <Units>
    <Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="milliBars" angularUnit="decimal degrees" directionUnit="decimal degrees"/>
  </Units>
{f'  <CoordinateSystem name="EPSG:{EPSG}" epsgCode="{EPSG}"/>' + chr(10) if EPSG else ''}  <Project name="CSTP AR CAM demo"/>
  <Application name="make_demo.py" manufacturer="CSTP"/>
  <CgPoints name="Features">
{chr(10).join(pts)}
  </CgPoints>
  <Alignments name="Demo">
    <Alignment name="EN-Demo" length="{total:.4f}" staStart="0.0000" desc="Tangent, clothoid, R200 arc, clothoid, tangent">
      <CoordGeom>
{chr(10).join(geom)}
      </CoordGeom>
      <Profile name="EN-Demo profile">
        <ProfAlign name="Design">
          <PVI>0.0000 100.000</PVI>
          <ParaCurve length="100.0000">160.0000 104.000</ParaCurve>
          <PVI>{total:.4f} 101.000</PVI>
        </ProfAlign>
      </Profile>
    </Alignment>
  </Alignments>
</LandXML>
'''
open(OUT, "w").write(xml)
print("written, end point", out[-1]["end"])
