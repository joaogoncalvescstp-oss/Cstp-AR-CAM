"""Generate a small road alignment in US survey feet (tangent - clothoid -
R650 arc - clothoid - tangent) with a crest vertical curve and a few CgPoints.

  python3 tools/make_demo.py
    -> samples/demo-alignment.xml   (local coordinates, no CRS: pinned to the user)
    -> samples/saint-paul-ramsey.xml (Ramsey County Coordinate System, NAD83 US ft,
       starting near the Minnesota State Capitol in Saint Paul)
"""
import math

ROT = -1  # clockwise (right turn)
# (kind, length ft, radiusStart, radiusEnd)
SEGS = [("line", 250), ("spiral", 150, math.inf, 650), ("arc", 200, 650, 650), ("spiral", 150, 650, math.inf), ("line", 300)]
TOTAL = sum(s[1] for s in SEGS)
PVIS = [(0.0, 850.0, 0), (525.0, 862.0, 300), (TOTAL, 853.0, 0)]  # station, elevation, curve length
POINTS = [("SIGN-01", "Road sign", 150, 15.0), ("MH-01", "Manhole", 600, -12.0), ("TREE-07", "Tree to remove", 850, 25.0)]


def curv(r):
    return 0.0 if math.isinf(r) else ROT / r


def seg_k(s):
    return (0.0, 0.0) if s[0] == "line" else (curv(s[2]), curv(s[3]))


def walk(E0, N0, B0, stop=None, off=0.0):
    """Integrate the geometry; returns element list, or the point at station `stop` (offset + = right)."""
    x, y, th, sta = E0, N0, math.pi / 2 - B0, 0.0
    out = []
    for s in SEGS:
        L = s[1]
        k0, k1 = seg_k(s)
        sx, sy, sth = x, y, th
        n = 4000
        ds = L / n
        for i in range(n):
            if stop is not None and sta + i * ds >= stop:
                a = sth + k0 * i * ds + (k1 - k0) * (i * ds) ** 2 / (2 * L)
                return x + off * math.cos(a - math.pi / 2), y + off * math.sin(a - math.pi / 2)
            sm = (i + 0.5) * ds
            a = sth + k0 * sm + (k1 - k0) * sm * sm / (2 * L)
            x += ds * math.cos(a)
            y += ds * math.sin(a)
        th = sth + k0 * L + (k1 - k0) * L / 2
        sta += L
        el = {"s": s, "start": (sx, sy), "end": (x, y)}
        if s[0] != "line":
            d0, d1 = (math.cos(sth), math.sin(sth)), (math.cos(th), math.sin(th))
            den = d0[0] * d1[1] - d0[1] * d1[0]
            t = ((x - sx) * d1[1] - (y - sy) * d1[0]) / den
            el["pi"] = (sx + t * d0[0], sy + t * d0[1])
        if s[0] == "arc":
            el["center"] = (sx + s[2] * math.cos(sth + ROT * math.pi / 2), sy + s[2] * math.sin(sth + ROT * math.pi / 2))
        out.append(el)
    return out if stop is None else (x, y)


def z_at(st):
    (s0, z0, _), (s1, z1, L), (s2, z2, _) = PVIS
    g1, g2 = (z1 - z0) / (s1 - s0), (z2 - z1) / (s2 - s1)
    if abs(st - s1) <= L / 2:
        xx = st - (s1 - L / 2)
        return z1 - g1 * L / 2 + g1 * xx + (g2 - g1) / (2 * L) * xx * xx
    return z0 + g1 * (st - s0) if st < s1 else z1 + g2 * (st - s1)


def pt(p):
    return f"{p[1]:.4f} {p[0]:.4f}"  # LandXML order: northing easting


def fr(v):
    return "INF" if math.isinf(v) else f"{v:.4f}"


def build(E0, N0, bearing_deg, cs_xml, out_path):
    B0 = math.radians(bearing_deg)
    geom = []
    for g in walk(E0, N0, B0):
        s = g["s"]
        if s[0] == "line":
            geom.append(f'        <Line length="{s[1]:.4f}">\n          <Start>{pt(g["start"])}</Start>\n          <End>{pt(g["end"])}</End>\n        </Line>')
        elif s[0] == "arc":
            geom.append(f'        <Curve rot="cw" radius="{s[2]:.4f}" length="{s[1]:.4f}">\n          <Start>{pt(g["start"])}</Start>\n          <Center>{pt(g["center"])}</Center>\n          <End>{pt(g["end"])}</End>\n          <PI>{pt(g["pi"])}</PI>\n        </Curve>')
        else:
            geom.append(f'        <Spiral rot="cw" spiType="clothoid" length="{s[1]:.4f}" radiusStart="{fr(s[2])}" radiusEnd="{fr(s[3])}">\n          <Start>{pt(g["start"])}</Start>\n          <PI>{pt(g["pi"])}</PI>\n          <End>{pt(g["end"])}</End>\n        </Spiral>')
    pts = []
    for name, code, st, off in POINTS:
        px, py = walk(E0, N0, B0, stop=st, off=off)
        pts.append(f'    <CgPoint name="{name}" code="{code}">{py:.4f} {px:.4f} {z_at(st):.3f}</CgPoint>')
    prof = [f"          <PVI>{PVIS[0][0]:.4f} {PVIS[0][1]:.3f}</PVI>",
            f'          <ParaCurve length="{PVIS[1][2]:.4f}">{PVIS[1][0]:.4f} {PVIS[1][1]:.3f}</ParaCurve>',
            f"          <PVI>{PVIS[2][0]:.4f} {PVIS[2][1]:.3f}</PVI>"]
    xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2" date="2026-09-26" time="12:00:00">
  <Units>
    <Imperial areaUnit="squareFoot" linearUnit="USSurveyFoot" volumeUnit="cubicYard" temperatureUnit="fahrenheit" pressureUnit="inHG" angularUnit="decimal degrees" directionUnit="decimal degrees"/>
  </Units>
{cs_xml}  <Project name="CSTP AR CAM demo"/>
  <Application name="make_demo.py" manufacturer="CSTP"/>
  <CgPoints name="Features">
{chr(10).join(pts)}
  </CgPoints>
  <Alignments name="Demo">
    <Alignment name="DEMO-CL" length="{TOTAL:.4f}" staStart="0.0000" desc="Tangent, clothoid, R650 ft curve, clothoid, tangent">
      <CoordGeom>
{chr(10).join(geom)}
      </CoordGeom>
      <Profile name="DEMO-CL profile">
        <ProfAlign name="Design">
{chr(10).join(prof)}
        </ProfAlign>
      </Profile>
    </Alignment>
  </Alignments>
</LandXML>
'''
    open(out_path, "w").write(xml)
    print("wrote", out_path)


build(3000.0, 15000.0, 30, "", "samples/demo-alignment.xml")
# 44.9551 N, -93.1022 W (near the State Capitol) in Ramsey County ft, running ESE.
build(572784.2122, 159918.7791, 110,
      '  <CoordinateSystem name="MN-RAMSEY" desc="Ramsey County Coordinate System, NAD83, US survey feet" horizontalDatum="NAD83" verticalDatum="NAVD88"/>\n',
      "samples/saint-paul-ramsey.xml")
