// Georeferencing: converts between alignment grid coordinates (file units)
// and WGS84 lat/lon, plus a local East-North-Up frame for the AR scene.
//
// Two modes:
//  - 'crs'    : alignment coordinates are in a projected CRS (proj4 definition)
//  - 'anchor' : no CRS; a chosen station of the alignment is pinned to a GPS
//               position and rotated so the alignment runs along a bearing.

const proj4 = globalThis.proj4;

// Ramsey County Coordinate System (MnDOT county system) as used by FBK-Checker
// (https://joaogoncalvescstp-oss.github.io/FBK-Checker/): Lambert Conformal Conic
// on the county-enlarged NAD83 ellipsoid, US survey feet. Standard parallels
// 44°53' / 45°08', central meridian -93°23', origin 44°47'28", FE 500000 ftUS,
// FN 100000 ftUS. No datum shift: lat/lon are NAD83 (treated as WGS84, ~1 m),
// the enlarged ellipsoid only scales projected distances to ground level.
export const RAMSEY_DEF = '+proj=lcc +lat_1=44.88333333333333 +lat_2=45.13333333333333 +lat_0=44.79111111111111 +lon_0=-93.38333333333333 +x_0=152400.3048006096 +y_0=30480.06096012192 +a=6378418.941 +b=6357033.31 +units=us-ft +no_defs';

export const CRS_PRESETS = {
  RAMSEY: { name: 'Ramsey County Coordinate System, NAD83, US ft (Saint Paul · FBK-Checker)', def: RAMSEY_DEF },
  'EPSG:26915': { name: 'NAD83 / UTM zone 15N (m)', def: '+proj=utm +zone=15 +datum=NAD83 +units=m +no_defs' },
  'EPSG:32615': { name: 'WGS 84 / UTM zone 15N (m)', def: '+proj=utm +zone=15 +datum=WGS84 +units=m +no_defs' },
  'EPSG:3763': { name: 'ETRS89 / PT-TM06 (Portugal)', def: '+proj=tmerc +lat_0=39.6682583333333 +lon_0=-8.13310833333333 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  'EPSG:20790': { name: 'Lisboa / Portuguese National Grid (Hayford-Gauss IGeoE)', def: '+proj=tmerc +lat_0=39.6666666666667 +lon_0=1 +k=1 +x_0=200000 +y_0=300000 +ellps=intl +towgs84=-304.046,-60.576,103.64,0,0,0,0 +pm=lisbon +units=m +no_defs' },
  'EPSG:20791': { name: 'Lisboa / Portuguese Grid (Hayford-Gauss IPCC)', def: '+proj=tmerc +lat_0=39.6666666666667 +lon_0=1 +k=1 +x_0=0 +y_0=0 +ellps=intl +towgs84=-304.046,-60.576,103.64,0,0,0,0 +pm=lisbon +units=m +no_defs' },
  'EPSG:27493': { name: 'Datum 73 / Modified Portuguese Grid', def: '+proj=tmerc +lat_0=39.6666666666667 +lon_0=-8.13190611111111 +k=1 +x_0=180.598 +y_0=-86.99 +ellps=intl +towgs84=-231,102.6,29.8,0.615,-0.198,0.881,1.79 +units=m +no_defs' },
  'EPSG:5016': { name: 'PTRA08 / UTM zone 28N (Madeira)', def: '+proj=utm +zone=28 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  'EPSG:5014': { name: 'PTRA08 / UTM zone 25N (Azores West)', def: '+proj=utm +zone=25 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  'EPSG:5015': { name: 'PTRA08 / UTM zone 26N (Azores Central/East)', def: '+proj=utm +zone=26 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  'EPSG:25829': { name: 'ETRS89 / UTM zone 29N', def: '+proj=utm +zone=29 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  'EPSG:25830': { name: 'ETRS89 / UTM zone 30N', def: '+proj=utm +zone=30 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  'EPSG:25831': { name: 'ETRS89 / UTM zone 31N', def: '+proj=utm +zone=31 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  'EPSG:27700': { name: 'OSGB36 / British National Grid', def: '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs' },
  'EPSG:2154': { name: 'RGF93 / Lambert-93 (France)', def: '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  'EPSG:31983': { name: 'SIRGAS 2000 / UTM zone 23S (Brazil)', def: '+proj=utm +zone=23 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  'EPSG:3857': { name: 'WGS84 / Pseudo-Mercator', def: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs' },
};

export const UNIT_SCALE = {
  meter: 1,
  metre: 1,
  millimeter: 0.001,
  centimeter: 0.01,
  kilometer: 1000,
  foot: 0.3048,
  internationalfoot: 0.3048,
  ussurveyfoot: 1200 / 3937,
};

export function unitScale(linearUnit) {
  return UNIT_SCALE[String(linearUnit || 'meter').toLowerCase()] ?? 1;
}

// Build a proj4 definition for UTM-style EPSG codes without network access.
function utmDef(code) {
  const n = Number(code);
  if (n >= 32601 && n <= 32660) return `+proj=utm +zone=${n - 32600} +datum=WGS84 +units=m +no_defs`;
  if (n >= 32701 && n <= 32760) return `+proj=utm +zone=${n - 32700} +south +datum=WGS84 +units=m +no_defs`;
  if (n >= 26901 && n <= 26923) return `+proj=utm +zone=${n - 26900} +datum=NAD83 +units=m +no_defs`;
  if (n >= 25828 && n <= 25838) return `+proj=utm +zone=${n - 25800} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  if (n >= 31965 && n <= 31985) return `+proj=utm +zone=${n - 31964} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  return null;
}

// Resolve an "EPSG:xxxx", bare code, proj4 string or WKT into a proj4 definition.
export async function resolveCRS(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (CRS_PRESETS[s]) return CRS_PRESETS[s].def;
  if (s.startsWith('+proj') || /^(PROJCS|PROJCRS|GEOGCS)\[/i.test(s)) return s;
  const m = s.match(/(\d{4,6})/);
  if (!m) return null;
  const key = 'EPSG:' + m[1];
  if (CRS_PRESETS[key]) return CRS_PRESETS[key].def;
  const utm = utmDef(m[1]);
  if (utm) return utm;
  const cached = localStorage.getItem('crs:' + key);
  if (cached) return cached;
  for (const url of [`https://epsg.io/${m[1]}.proj4`, `https://spatialreference.org/ref/epsg/${m[1]}/proj4.txt`]) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const t = (await r.text()).trim();
      if (t.startsWith('+proj')) {
        try { localStorage.setItem('crs:' + key, t); } catch { /* storage full or blocked */ }
        return t;
      }
    } catch { /* offline */ }
  }
  return null;
}

// Does a LandXML <CoordinateSystem> describe the Ramsey County system?
export function isRamseyCS(cs) {
  if (!cs) return false;
  return /ramsey/i.test([cs.name, cs.wkt, cs.desc].filter(Boolean).join(' '));
}

// --- Local tangent plane -------------------------------------------------

const A = 6378137.0;
const E2 = 0.00669437999014;

export function metersPerDegree(latDeg) {
  const lat = (latDeg * Math.PI) / 180;
  const s = Math.sin(lat);
  const w = Math.sqrt(1 - E2 * s * s);
  const rn = A / w; // prime vertical
  const rm = (A * (1 - E2)) / (w * w * w); // meridian
  return { lat: (rm * Math.PI) / 180, lon: (rn * Math.cos(lat) * Math.PI) / 180 };
}

// Flat-earth ENU offset (metres) from origin to target. Accurate to cm over a few km.
export function latLonToENU(origin, lat, lon) {
  const m = metersPerDegree((origin.lat + lat) / 2);
  return { e: (lon - origin.lon) * m.lon, n: (lat - origin.lat) * m.lat };
}

export function enuToLatLon(origin, e, n) {
  const m = metersPerDegree(origin.lat);
  return { lat: origin.lat + n / m.lat, lon: origin.lon + e / m.lon };
}

// --- Georeference ------------------------------------------------------

export class Georef {
  constructor() {
    this.mode = 'none';
    this.units = 1; // metres per file unit
  }

  get ready() {
    return this.mode === 'crs' || this.mode === 'anchor';
  }

  setCRS(def, label = '') {
    const p = proj4(def);
    // Sanity check.
    p.inverse([0, 0]);
    this.mode = 'crs';
    this.def = def;
    this.label = label;
    this.proj = p;
  }

  // Pin grid point (x, y) to lat/lon; alignment bearing (grid, radians cw from north)
  // is rotated to trueBearing (radians cw from true north).
  setAnchor(grid, latlon, gridBearing, trueBearing) {
    this.mode = 'anchor';
    this.anchor = { grid: { ...grid }, latlon: { ...latlon }, rot: trueBearing - gridBearing };
    this.label = 'Local anchor';
  }

  gridToLatLon(x, y) {
    if (this.mode === 'crs') {
      const [lon, lat] = this.proj.inverse([x, y]);
      return { lat, lon };
    }
    if (this.mode === 'anchor') {
      const a = this.anchor;
      const dx = (x - a.grid.x) * this.units, dy = (y - a.grid.y) * this.units;
      // Rotate clockwise by rot (bearing convention).
      const c = Math.cos(a.rot), s = Math.sin(a.rot);
      const e = dx * c + dy * s;
      const n = -dx * s + dy * c;
      return enuToLatLon(a.latlon, e, n);
    }
    return null;
  }

  latLonToGrid(lat, lon) {
    if (this.mode === 'crs') {
      const [x, y] = this.proj.forward([lon, lat]);
      return { x, y };
    }
    if (this.mode === 'anchor') {
      const a = this.anchor;
      const { e, n } = latLonToENU(a.latlon, lat, lon);
      const c = Math.cos(a.rot), s = Math.sin(a.rot);
      const dx = e * c - n * s;
      const dy = e * s + n * c;
      return { x: a.grid.x + dx / this.units, y: a.grid.y + dy / this.units };
    }
    return null;
  }

  // Angle (radians) to add to a true bearing to get a grid bearing at lat/lon.
  gridConvergence(lat, lon) {
    const g0 = this.latLonToGrid(lat, lon);
    const m = metersPerDegree(lat);
    const g1 = this.latLonToGrid(lat + 10 / m.lat, lon);
    if (!g0 || !g1) return 0;
    return Math.atan2(g1.x - g0.x, g1.y - g0.y);
  }

  toJSON() {
    return { mode: this.mode, def: this.def, label: this.label, anchor: this.anchor, units: this.units };
  }

  static fromJSON(o) {
    const g = new Georef();
    if (!o) return g;
    g.units = o.units || 1;
    try {
      if (o.mode === 'crs' && o.def) g.setCRS(o.def, o.label);
      else if (o.mode === 'anchor' && o.anchor) {
        g.mode = 'anchor';
        g.anchor = o.anchor;
        g.label = o.label;
      }
    } catch { /* invalid stored def */ }
    return g;
  }
}
