// LandXML alignment parser.
//
// Supports horizontal geometry (Line, Curve, Spiral/clothoid, IrregularLine,
// Chain of CgPoints), vertical profiles (PVI, ParaCurve, CircCurve), CgPoints
// and the CoordinateSystem / Units headers.
//
// LandXML stores coordinates as "northing easting [elevation]". Everything
// this module returns uses {x: easting, y: northing, z: elevation}.

const SAMPLE_STEP = 1.0; // metres (or file units) between sampled points on arcs/spirals

function nums(text) {
  if (!text) return [];
  return text.trim().split(/[\s,]+/).map(Number).filter((v) => !Number.isNaN(v));
}

function childrenByName(el, name) {
  return Array.from(el.children).filter((c) => c.localName === name);
}

function firstChild(el, name) {
  return Array.from(el.children).find((c) => c.localName === name) || null;
}

function descendants(el, name) {
  return Array.from(el.getElementsByTagNameNS('*', name));
}

// Parse a "N E [Z]" point element; resolves pntRef to CgPoints when needed.
function readPoint(el, cgPoints) {
  if (!el) return null;
  let v = nums(el.textContent);
  if (v.length < 2) {
    const ref = el.getAttribute('pntRef');
    if (ref && cgPoints.has(ref)) return { ...cgPoints.get(ref) };
    return null;
  }
  return { x: v[1], y: v[0], z: v.length > 2 ? v[2] : null };
}

function attrNum(el, name, fallback = null) {
  const v = el.getAttribute(name);
  if (v === null || v === '') return fallback;
  if (/^inf/i.test(v.trim())) return Infinity;
  const n = Number(v);
  return Number.isNaN(n) ? fallback : n;
}

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

// --- Horizontal elements --------------------------------------------------

function sampleLine(start, end) {
  return [start, end];
}

function sampleArc(start, center, end, rot, step) {
  const r = dist(center, start);
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  let a1 = Math.atan2(end.y - center.y, end.x - center.x);
  const cw = rot === 'cw';
  let sweep = a1 - a0;
  if (cw) {
    while (sweep > 0) sweep -= 2 * Math.PI;
    if (sweep === 0) sweep = -2 * Math.PI;
  } else {
    while (sweep < 0) sweep += 2 * Math.PI;
    if (sweep === 0) sweep = 2 * Math.PI;
  }
  const len = Math.abs(sweep) * r;
  const n = Math.max(2, Math.ceil(len / step));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a), z: null });
  }
  pts[0] = { ...start };
  pts[n] = { ...end };
  return pts;
}

// Clothoid: curvature varies linearly from 1/radiusStart to 1/radiusEnd.
// Integrated numerically from Start along the tangent towards PI, then fitted
// onto Start/End with a similarity transform to remove integration drift.
function sampleSpiral(el, start, end, pi, step) {
  const len = attrNum(el, 'length', null) ?? dist(start, end);
  const r0 = attrNum(el, 'radiusStart', Infinity);
  const r1 = attrNum(el, 'radiusEnd', Infinity);
  const rot = el.getAttribute('rot') || 'cw';
  const sign = rot === 'ccw' ? 1 : -1;
  const k0 = r0 === Infinity || r0 === 0 ? 0 : sign / r0;
  const k1 = r1 === Infinity || r1 === 0 ? 0 : sign / r1;

  let theta;
  if (pi && dist(start, pi) > 1e-9) theta = Math.atan2(pi.y - start.y, pi.x - start.x);
  else theta = Math.atan2(end.y - start.y, end.x - start.x);

  const n = Math.max(4, Math.ceil(len / step));
  const sub = 8;
  const ds = len / (n * sub);
  const raw = [{ x: 0, y: 0 }];
  let x = 0, y = 0, s = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < sub; j++) {
      const sm = s + ds / 2;
      const th = theta + k0 * sm + ((k1 - k0) * sm * sm) / (2 * len);
      x += ds * Math.cos(th);
      y += ds * Math.sin(th);
      s += ds;
    }
    raw.push({ x, y });
  }

  // Fit raw (0,0)->(x,y) onto start->end.
  const rawLen = Math.hypot(x, y);
  const tgtLen = dist(start, end);
  if (rawLen < 1e-9 || tgtLen < 1e-9) return [start, end];
  const rawAng = Math.atan2(y, x);
  const tgtAng = Math.atan2(end.y - start.y, end.x - start.x);
  const scale = tgtLen / rawLen;
  const da = tgtAng - rawAng;
  const c = Math.cos(da) * scale, sn = Math.sin(da) * scale;
  const pts = raw.map((p) => ({ x: start.x + p.x * c - p.y * sn, y: start.y + p.x * sn + p.y * c, z: null }));
  pts[0] = { ...start };
  pts[pts.length - 1] = { ...end };
  return pts;
}

function parseCoordGeom(cg, cgPoints, step) {
  const pts = [];
  const elements = [];
  const push = (arr) => {
    for (const p of arr) {
      const last = pts[pts.length - 1];
      if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
      pts.push(p);
    }
  };
  for (const el of Array.from(cg.children)) {
    const type = el.localName;
    const start = readPoint(firstChild(el, 'Start'), cgPoints);
    const end = readPoint(firstChild(el, 'End'), cgPoints);
    try {
      if (type === 'Line' && start && end) {
        push(sampleLine(start, end));
        elements.push({ type: 'Line', length: dist(start, end) });
      } else if (type === 'Curve' && start && end) {
        const center = readPoint(firstChild(el, 'Center'), cgPoints);
        if (!center) { push([start, end]); continue; }
        push(sampleArc(start, center, end, el.getAttribute('rot') || 'cw', step));
        elements.push({ type: 'Curve', radius: attrNum(el, 'radius', dist(center, start)), rot: el.getAttribute('rot') });
      } else if (type === 'Spiral' && start && end) {
        const pi = readPoint(firstChild(el, 'PI'), cgPoints);
        push(sampleSpiral(el, start, end, pi, step));
        elements.push({ type: 'Spiral', length: attrNum(el, 'length') });
      } else if (type === 'IrregularLine' || type === 'Chain') {
        const list = firstChild(el, 'PntList2D') || firstChild(el, 'PntList3D');
        if (list) {
          const v = nums(list.textContent);
          const dim = list.localName === 'PntList3D' ? 3 : 2;
          const arr = [];
          for (let i = 0; i + dim - 1 < v.length; i += dim) arr.push({ x: v[i + 1], y: v[i], z: dim === 3 ? v[i + 2] : null });
          push(arr);
        } else if (type === 'Chain') {
          const ids = (el.textContent || '').trim().split(/\s+/);
          push(ids.filter((id) => cgPoints.has(id)).map((id) => ({ ...cgPoints.get(id) })));
        } else if (start && end) {
          push([start, end]);
        }
        elements.push({ type });
      }
    } catch (e) {
      console.warn('Skipping element', type, e);
    }
  }
  return { pts, elements };
}

// --- Vertical profile -----------------------------------------------------

function parseProfAlign(pa) {
  // Build a list of PVIs with optional vertical curve length.
  const pvis = [];
  for (const el of Array.from(pa.children)) {
    const v = nums(el.textContent);
    if (v.length < 2) continue;
    if (el.localName === 'PVI') pvis.push({ sta: v[0], elev: v[1], L: 0 });
    else if (el.localName === 'ParaCurve') pvis.push({ sta: v[0], elev: v[1], L: attrNum(el, 'length', 0) });
    else if (el.localName === 'CircCurve') {
      // Approximate circular vertical curve with a parabola of the same length.
      pvis.push({ sta: v[0], elev: v[1], L: attrNum(el, 'length', 0) });
    } else if (el.localName === 'UnsymParaCurve') {
      const Li = attrNum(el, 'lengthIn', 0), Lo = attrNum(el, 'lengthOut', 0);
      pvis.push({ sta: v[0], elev: v[1], L: Li + Lo });
    }
  }
  pvis.sort((a, b) => a.sta - b.sta);
  return pvis.length >= 2 ? { name: pa.getAttribute('name') || '', pvis } : null;
}

export function profileElevation(profile, sta) {
  const p = profile.pvis;
  if (!p.length) return null;
  if (sta <= p[0].sta) return p[0].elev + grade(p, 0) * (sta - p[0].sta);
  const last = p.length - 1;
  if (sta >= p[last].sta) return p[last].elev + grade(p, last - 1) * (sta - p[last].sta);

  // Vertical curves take precedence.
  for (let i = 1; i < last; i++) {
    const L = p[i].L;
    if (L > 0 && Math.abs(sta - p[i].sta) <= L / 2) {
      const g1 = grade(p, i - 1), g2 = grade(p, i);
      const bvcSta = p[i].sta - L / 2;
      const bvcElev = p[i].elev - g1 * (L / 2);
      const x = sta - bvcSta;
      return bvcElev + g1 * x + ((g2 - g1) / (2 * L)) * x * x;
    }
  }
  for (let i = 0; i < last; i++) {
    if (sta >= p[i].sta && sta <= p[i + 1].sta) return p[i].elev + grade(p, i) * (sta - p[i].sta);
  }
  return null;
}

function grade(p, i) {
  const a = p[i], b = p[i + 1];
  if (!a || !b || b.sta === a.sta) return 0;
  return (b.elev - a.elev) / (b.sta - a.sta);
}

// --- Public API -----------------------------------------------------------

export function parseLandXML(text, { step = SAMPLE_STEP } = {}) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('Invalid XML: ' + err.textContent.slice(0, 200));
  const root = doc.documentElement;
  if (!root || root.localName !== 'LandXML') throw new Error('Not a LandXML file (root element is <' + (root && root.localName) + '>)');

  // Units
  let linearUnit = 'meter';
  const metric = descendants(root, 'Metric')[0];
  const imperial = descendants(root, 'Imperial')[0];
  if (imperial) linearUnit = imperial.getAttribute('linearUnit') || 'USSurveyFoot';
  else if (metric) linearUnit = metric.getAttribute('linearUnit') || 'meter';

  // Coordinate system
  const csEl = descendants(root, 'CoordinateSystem')[0];
  const coordinateSystem = csEl
    ? {
        name: csEl.getAttribute('name') || csEl.getAttribute('horizontalCoordinateSystemName') || '',
        desc: [csEl.getAttribute('desc'), csEl.getAttribute('horizontalCoordinateSystemName')].filter(Boolean).join(' '),
        epsg: csEl.getAttribute('epsgCode') || null,
        wkt: csEl.getAttribute('ogcWktCode') || null,
        horizontalDatum: csEl.getAttribute('horizontalDatum') || '',
        verticalDatum: csEl.getAttribute('verticalDatum') || '',
      }
    : null;

  // CgPoints
  const cgPoints = new Map();
  const points = [];
  for (const p of descendants(root, 'CgPoint')) {
    const v = nums(p.textContent);
    const name = p.getAttribute('name') || p.getAttribute('oID') || '';
    if (v.length >= 2) {
      const pt = { x: v[1], y: v[0], z: v.length > 2 ? v[2] : null };
      if (name) cgPoints.set(name, pt);
      points.push({ name, code: p.getAttribute('code') || p.getAttribute('desc') || '', ...pt });
    }
  }

  const alignments = [];
  for (const al of descendants(root, 'Alignment')) {
    const cg = firstChild(al, 'CoordGeom');
    if (!cg) continue;
    const { pts, elements } = parseCoordGeom(cg, cgPoints, step);
    if (pts.length < 2) continue;

    const staStart = attrNum(al, 'staStart', 0);
    // Cumulative chainage
    const sta = new Array(pts.length);
    sta[0] = staStart;
    for (let i = 1; i < pts.length; i++) sta[i] = sta[i - 1] + dist(pts[i - 1], pts[i]);

    const profiles = [];
    for (const prof of childrenByName(al, 'Profile')) {
      for (const pa of childrenByName(prof, 'ProfAlign')) {
        const p = parseProfAlign(pa);
        if (p) profiles.push(p);
      }
    }

    const profile = profiles[0] || null;
    const hasZ = pts.every((p) => p.z !== null && p.z !== undefined);
    for (let i = 0; i < pts.length; i++) {
      if (profile) pts[i].z = profileElevation(profile, sta[i]);
      else if (!hasZ) pts[i].z = null;
    }

    alignments.push({
      name: al.getAttribute('name') || `Alignment ${alignments.length + 1}`,
      desc: al.getAttribute('desc') || '',
      staStart,
      length: sta[sta.length - 1] - staStart,
      pts,
      sta,
      elements,
      profiles,
      hasElevation: !!profile || hasZ,
    });
  }

  if (!alignments.length && !points.length) throw new Error('No alignments or points found in the file.');

  return { alignments, points, coordinateSystem, linearUnit, bbox: bbox(alignments, points) };
}

function bbox(alignments, points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (p) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  };
  alignments.forEach((a) => a.pts.forEach(add));
  points.forEach(add);
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// --- Geometry helpers shared by AR + plan views --------------------------

// Nearest point on alignment polyline: returns station, signed offset
// (positive = right of alignment direction), point and tangent bearing.
export function stationOffset(al, x, y) {
  const P = al.pts;
  let best = null;
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    if (L2 === 0) continue;
    let t = ((x - a.x) * dx + (y - a.y) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * dx, py = a.y + t * dy;
    const d2 = (x - px) ** 2 + (y - py) ** 2;
    if (!best || d2 < best.d2) {
      const L = Math.sqrt(L2);
      const cross = (dx * (y - a.y) - dy * (x - a.x)) / L; // + = left
      const za = a.z, zb = b.z;
      best = {
        d2,
        i,
        t,
        x: px,
        y: py,
        z: za !== null && zb !== null ? za + t * (zb - za) : null,
        station: al.sta[i] + t * L,
        offset: -cross,
        bearing: Math.atan2(dx, dy), // radians clockwise from grid north
        beyond: (i === 0 && t === 0) || (i === P.length - 2 && t === 1),
      };
    }
  }
  if (best) best.distance = Math.sqrt(best.d2);
  return best;
}

// Point + tangent at a given station.
export function pointAtStation(al, station) {
  const S = al.sta, P = al.pts;
  if (station <= S[0]) station = S[0];
  if (station >= S[S.length - 1]) station = S[S.length - 1];
  let lo = 0, hi = S.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (S[mid] <= station) lo = mid;
    else hi = mid;
  }
  const a = P[lo], b = P[hi];
  const L = S[hi] - S[lo] || 1;
  const t = (station - S[lo]) / L;
  return {
    x: a.x + t * (b.x - a.x),
    y: a.y + t * (b.y - a.y),
    z: a.z !== null && b.z !== null ? a.z + t * (b.z - a.z) : null,
    bearing: Math.atan2(b.x - a.x, b.y - a.y),
  };
}

// Parallel offset polyline (positive = right).
export function offsetPolyline(al, off) {
  const P = al.pts;
  const out = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    // right-hand normal of direction (dx,dy) is (dy,-dx)
    out.push({ x: P[i].x + (dy / L) * off, y: P[i].y - (dx / L) * off, z: P[i].z });
  }
  return out;
}

// group = 1000 -> metric "1+234.56"; group = 100 -> US "12+34.56".
export function formatStation(sta, decimals = 2, group = 1000) {
  const neg = sta < 0;
  const f = 10 ** decimals;
  const s = Math.round(Math.abs(sta) * f) / f;
  const whole = Math.floor(s / group);
  const digits = group === 100 ? 2 : 3;
  const rest = (s - whole * group).toFixed(decimals).padStart(digits + (decimals ? decimals + 1 : 0), '0');
  return (neg ? '-' : '') + whole + '+' + rest;
}
