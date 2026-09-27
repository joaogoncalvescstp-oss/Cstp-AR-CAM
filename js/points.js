// Plain-text point files: PNEZD (point, northing, easting, elevation,
// description), comma, tab or space delimited, as exported by Civil 3D and
// imported by FBK-Checker. Coordinates are assumed to be Ramsey County US feet.

export function isPointFile(name, text) {
  if (/\.(csv|txt|pts|pnezd)$/i.test(name)) return true;
  return !/^\s*</.test(text); // not XML
}

const isNum = (t) => t !== '' && Number.isFinite(Number(t));

export function parsePointFile(text) {
  const points = [];
  let tooFew = 0, rows = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const t = line.includes(',') ? line.split(',').map((x) => x.trim()) : line.split(/\s+/);
    rows++;
    // PNEZD needs point, N, E numeric; a header row is skipped.
    if (t.length < 3 || !isNum(t[1]) || !isNum(t[2])) {
      if (t.length >= 2 && isNum(t[0]) && isNum(t[1])) tooFew++;
      continue;
    }
    const z = t.length > 3 && isNum(t[3]) ? Number(t[3]) : null;
    const desc = t.slice(z === null ? 3 : 4).join(' ');
    points.push({ name: t[0], code: desc, x: Number(t[2]), y: Number(t[1]), z });
  }
  // Mostly "point, value, code" rows: a numeric code on a stray row is not a coordinate.
  if (tooFew > points.length) {
    throw new Error(`This point file has no coordinates: most rows are only "point, value, code" (${tooFew} of ${rows}). Export it as PNEZD (point, northing, easting, elevation, description).`);
  }
  if (!points.length) {
    if (tooFew) {
      throw new Error(`This point file has no coordinates: each row is only "point, value, code" (${tooFew} rows). Export it as PNEZD (point, northing, easting, elevation, description).`);
    }
    throw new Error('No PNEZD points (point, northing, easting, elevation, description) found in the file.');
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return {
    alignments: [],
    points,
    pipeNetworks: [],
    surfaces: [],
    coordinateSystem: null,
    linearUnit: 'USSurveyFoot',
    skippedRows: rows - points.length,
    bbox: { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 },
  };
}
