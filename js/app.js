// CSTP AR CAM — main controller.

import { parseLandXML, stationOffset, pointAtStation, surfaceElevation, nearestStructure } from './landxml.js';
import { parsePointFile, isPointFile } from './points.js';
import { Georef, CRS_PRESETS, resolveCRS, unitScale, latLonToENU, enuToLatLon, isRamseyCS } from './geo.js';
import { Units, USFT, dLen, toDisp, fromDisp, staText, elevText } from './units.js';
import { OrientationSource, GPSSource, MotionSource, WakeLock, vibrate } from './sensors.js';
import { CameraFeed } from './camera.js';
import { XRMode } from './xr.js';
import * as THREE from 'three';
import { ARScene, PALETTE } from './ar.js';
import { PlanView } from './plan.js';
import { PhotoStore, FileStore, composePhoto, photoFileName, downloadBlob, sharePhoto, photosToCSV } from './photos.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const DEG = Math.PI / 180;

// --- Settings --------------------------------------------------------------

// Length settings (eyeHeight, verticalOffset, manualElevation, offsets,
// tickInterval, labelInterval, labelRange) are stored in display units.
const LENGTH_KEYS = ['eyeHeight', 'verticalOffset', 'manualElevation', 'tickInterval', 'labelInterval', 'labelRange', 'datumAdjust', 'geoidHeight'];
const DEFAULTS = {
  schema: 3,
  units: 'us',
  heightMode: 'auto',
  surfaceStyle: 'mesh',
  showPipes: true,
  eyeHeight: 5.25,
  verticalOffset: 0,
  // Saint Paul city datum: drawing elevation = sea-level (NAVD88) elevation - 694.10 ft.
  datumAdjust: -694.1,
  // Geoid height N in Saint Paul (GEOID18, approx.): sea-level elevation = GPS ellipsoid height - N.
  geoidHeight: -90.2,
  manualElevation: '',
  offsets: '',
  tickInterval: 25,
  labelInterval: 100,
  labelRange: 1300,
  lineWidth: 6,
  showPoints: true,
  headingOffset: 0,
  fovLong: 66,
  smoothing: 0.3,
  photoOverlay: true,
  photoStamp: true,
  photoClean: false,
  photoAutoDownload: false,
  crsChoice: 'RAMSEY',
  crsCustom: '',
  anchorSta: 0,
  activeAlign: 'auto',
};

const stored = safeJSON(localStorage.getItem('settings'));
// Settings from the first (metric, Portugal-oriented) version are replaced by the Saint Paul defaults.
// Schema 2 -> 3 keeps the user's settings and switches to the new 'auto' height model.
if (stored.schema === 2) Object.assign(stored, { schema: 3, heightMode: 'auto' });
if (stored.schema === 3 && stored.datumAdjust === undefined) {
  // Added later: seed the Saint Paul values in the user's display units.
  const k = stored.units === 'metric' ? 1200 / 3937 : 1;
  Object.assign(stored, { datumAdjust: +(-694.1 * k).toFixed(4), geoidHeight: +(-90.2 * k).toFixed(4) });
}
const settings = stored.schema === DEFAULTS.schema ? { ...DEFAULTS, ...stored } : { ...DEFAULTS };
Units.system = settings.units;
function safeJSON(s) {
  try { return JSON.parse(s) || {}; } catch { return {}; }
}
function saveSettings() {
  try { localStorage.setItem('settings', JSON.stringify(settings)); } catch { /* ignore */ }
}

// --- State -------------------------------------------------------------------

const state = {
  files: [], // {name, text, parsed}
  model: null,
  visible: [],
  georef: Georef.fromJSON(safeJSON(localStorage.getItem('georef'))),
  started: false,
  nearest: null, // {al, idx, so}
  pendingAutoAnchor: false,
  photoCount: 0,
};

const orientation = new OrientationSource();
const gps = new GPSSource();
const motion = new MotionSource();
const wake = new WakeLock();
const camera = new CameraFeed($('#video'));
const ar = new ARScene($('#ar'));
const plan = new PlanView($('#plan'));
const xr = new XRMode(ar);

applySettingsToEngines();
if (settings.posShift && Number.isFinite(settings.posShift.dLat)) gps.shift = settings.posShift;

// GPS ellipsoid height (m) -> elevation in the drawings' vertical datum (m).
function gpsToDrawingElev(h) {
  if (h === null || h === undefined) return null;
  return h - fromDisp(+settings.geoidHeight || 0) + fromDisp(+settings.datumAdjust || 0);
}
// GPS ellipsoid height (m) -> sea-level (NAVD88) elevation (m).
function gpsToSeaLevel(h) {
  return h === null || h === undefined ? null : h - fromDisp(+settings.geoidHeight || 0);
}

// View direction for the UI: the ARCore camera when tracking, else the phone sensors.
function viewAngles() {
  return orientation.angles(state.viewQuat || orientation.update());
}

// --- UI helpers ---------------------------------------------------------------

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function openSheet(name) {
  $$('.sheet').forEach((s) => s.classList.toggle('open', s.id === 'sheet-' + name));
  $$('.bar-btn').forEach((b) => b.classList.toggle('active', b.dataset.sheet === name));
  if (name === 'map') requestAnimationFrame(() => plan.fit());
  if (name === 'photos') renderGallery();
}
function closeSheets() {
  $$('.sheet').forEach((s) => s.classList.remove('open'));
  $$('.bar-btn').forEach((b) => b.classList.remove('active'));
}

$$('.bar-btn').forEach((b) => b.addEventListener('click', () => {
  const s = $('#sheet-' + b.dataset.sheet);
  if (s.classList.contains('open')) closeSheets();
  else openSheet(b.dataset.sheet);
}));
$$('.sheet .close').forEach((b) => b.addEventListener('click', closeSheets));

function fmt(v, d = 2, unit = '') {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d) + unit;
}

// --- Loading files -------------------------------------------------------------

// Utility colours (APWA-style: green sewers, blue water, yellow gas, red power).
function networkColor(net) {
  const n = `${net.name} ${net.type}`;
  if (/san|sewer/i.test(n) && !/storm|strm/i.test(n)) return '#34c759';
  if (/strm|storm|drain/i.test(n)) return '#2EC4B6';
  if (/wat|wm\b/i.test(n)) return '#4F9BFF';
  if (/gas/i.test(n)) return '#FFD60A';
  if (/elec|pwr|power/i.test(n)) return '#ff3b30';
  return '#34c759';
}

function rebuildModel() {
  const alignments = [], points = [], pipeNetworks = [], surfaces = [];
  let cs = null, linearUnit = 'meter';
  for (const f of state.files) {
    alignments.push(...f.parsed.alignments);
    points.push(...f.parsed.points);
    pipeNetworks.push(...(f.parsed.pipeNetworks || []));
    surfaces.push(...(f.parsed.surfaces || []));
    if (!cs && f.parsed.coordinateSystem) cs = f.parsed.coordinateSystem;
    linearUnit = f.parsed.linearUnit || linearUnit;
  }
  if (!alignments.length && !points.length && !pipeNetworks.length && !surfaces.length) {
    state.model = null;
  } else {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const f of state.files) {
      const b = f.parsed.bbox;
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
    }
    alignments.forEach((a, i) => { if (!a.color) a.color = PALETTE[i % PALETTE.length]; });
    pipeNetworks.forEach((n) => {
      if (!n.color) n.color = networkColor(n);
      if (n.visible === undefined) n.visible = true;
    });
    surfaces.forEach((sf) => {
      if (!sf.color) sf.color = '#5AA0FF';
      if (sf.visible === undefined) sf.visible = true;
    });
    state.model = { alignments, points, pipeNetworks, surfaces, coordinateSystem: cs, linearUnit, bbox: { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 } };
  }
  state.visible = alignments.map(() => true);
  state.georef.units = unitScale(linearUnit);
  plan.setModel(state.model, state.visible);
  renderAlignList();
  renderCrsSelect();
}

async function loadText(name, text, { persist = true, quiet = false, georef = true } = {}) {
  const parsed = isPointFile(name, text) ? parsePointFile(text) : parseLandXML(text);
  state.files = state.files.filter((f) => f.name !== name);
  state.files.push({ name, text, parsed });
  rebuildModel();
  if (persist) FileStore.put(name, text).catch(() => {});
  if (!quiet) toast(describeParsed(parsed), 4000);
  if (georef) await autoGeoref();
  scheduleRebuild();
}

function describeParsed(p) {
  const parts = [];
  if (p.alignments.length) parts.push(`${p.alignments.length} alignment(s)`);
  if (p.points.length) parts.push(`${p.points.length} point(s)`);
  const nets = p.pipeNetworks || [];
  if (nets.length) {
    const pipes = nets.reduce((a, n) => a + n.pipes.length, 0);
    const skipped = nets.reduce((a, n) => a + n.skipped.length, 0);
    parts.push(`${nets.length} pipe network(s), ${pipes} pipes` + (skipped ? ` (${skipped} skipped: structures missing in file)` : ''));
  }
  for (const sf of p.surfaces || []) parts.push(`surface ${sf.name} (${(sf.tris.length / 3).toLocaleString()} triangles)`);
  return 'Loaded ' + parts.join(', ');
}

async function loadFiles(fileList) {
  for (const file of fileList) {
    try {
      await loadText(file.name, await file.text());
    } catch (e) {
      console.error(e);
      toast(`${file.name}: ${e.message}`, 5000);
    }
  }
}

async function loadDemo() {
  try {
    const r = await fetch('samples/demo-alignment.xml');
    // The demo has no coordinate system: pin it in front of the user without
    // changing the saved CRS choice used for real (Ramsey County) files.
    await loadText('demo-alignment.xml', await r.text(), { georef: false });
    settings.anchorSta = 0;
    state.georef.mode = 'none';
    state.pendingAutoAnchor = true;
    renderCrsSelect('anchor');
    tryAutoAnchor();
    if (!state.started) toast('Demo loaded — start the AR camera; it will be placed in front of you.', 3500);
  } catch (e) {
    toast('Could not load demo: ' + e.message, 4000);
  }
}

async function loadSample() {
  try {
    const r = await fetch('samples/saint-paul-ramsey.xml');
    await loadText('saint-paul-ramsey.xml', await r.text());
  } catch (e) {
    toast('Could not load sample: ' + e.message, 4000);
  }
}
$('#btnSample').addEventListener('click', loadSample);
$('#btnStartSample').addEventListener('click', loadSample);

$('#fileInput').addEventListener('change', async (e) => {
  await loadFiles(e.target.files);
  e.target.value = '';
});
const pickFile = () => $('#fileInput').click();
$('#btnLoad').addEventListener('click', pickFile);
$('#btnStartLoad').addEventListener('click', pickFile);
$('#btnDemo').addEventListener('click', loadDemo);
$('#btnStartDemo').addEventListener('click', loadDemo);
$('#btnClear').addEventListener('click', async () => {
  if (!confirm('Remove all loaded alignments?')) return;
  state.files = [];
  await FileStore.clear().catch(() => {});
  rebuildModel();
  scheduleRebuild();
});

// Drag & drop (desktop)
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
});

function renderAlignList() {
  const ul = $('#alignList');
  ul.innerHTML = '';
  const m = state.model;
  const info = $('#fileInfo');
  if (!m) {
    info.textContent = 'No file loaded. LandXML 1.x alignments (lines, arcs, spirals), profiles and CgPoints are supported.';
  } else {
    info.textContent = `${state.files.map((f) => f.name).join(', ')} · units: ${m.linearUnit}` + (m.coordinateSystem ? ` · CRS: ${m.coordinateSystem.epsg ? 'EPSG:' + m.coordinateSystem.epsg : m.coordinateSystem.name || 'unnamed'}` : ' · no CRS in file');
  }
  const sel = $('#activeAlign');
  sel.innerHTML = '<option value="auto">Nearest (auto)</option>';
  (m ? m.alignments : []).forEach((al, i) => {
    const li = document.createElement('li');
    const u = state.georef.units;
    li.innerHTML = `<input type="checkbox" ${state.visible[i] ? 'checked' : ''} aria-label="Show"><input type="color" value="${al.color}" aria-label="Colour"><div class="meta"><b></b><small>${staText(al.staStart, u)} → ${staText(al.staStart + al.length, u)} · ${dLen(al.length * u, 1)}${al.profiles.length ? ' · profile' : ''}</small></div>`;
    li.querySelector('b').textContent = al.name;
    li.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
      state.visible[i] = e.target.checked;
      scheduleRebuild();
    });
    li.querySelector('input[type=color]').addEventListener('input', (e) => {
      al.color = e.target.value;
      scheduleRebuild();
    });
    ul.appendChild(li);
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = al.name;
    sel.appendChild(o);
  });
  const addLayer = (obj, title, detail) => {
    const li = document.createElement('li');
    li.innerHTML = `<input type="checkbox" ${obj.visible ? 'checked' : ''} aria-label="Show"><input type="color" value="${obj.color}" aria-label="Colour"><div class="meta"><b></b><small></small></div>`;
    li.querySelector('b').textContent = title;
    li.querySelector('small').textContent = detail;
    li.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
      obj.visible = e.target.checked;
      scheduleRebuild();
    });
    li.querySelector('input[type=color]').addEventListener('input', (e) => {
      obj.color = e.target.value;
      scheduleRebuild();
    });
    ul.appendChild(li);
  };
  for (const n of m ? m.pipeNetworks : []) {
    const structs = n.structs.filter((x) => !x.dummy).length;
    addLayer(n, `⛁ ${n.name}`, `${structs} structures · ${n.pipes.length} pipes` + (n.skipped.length ? ` · ${n.skipped.length} pipes skipped (structure missing in file)` : ''));
  }
  for (const sf of m ? m.surfaces : []) {
    addLayer(sf, `◭ ${sf.name}`, `surface · ${(sf.xyz.length / 3).toLocaleString()} points · ${(sf.tris.length / 3).toLocaleString()} triangles`);
  }
  sel.value = settings.activeAlign;
  if (sel.value !== settings.activeAlign) sel.value = 'auto';
}
$('#activeAlign').addEventListener('change', (e) => {
  settings.activeAlign = e.target.value;
  saveSettings();
});

// --- Coordinate system ----------------------------------------------------------

function renderCrsSelect(force) {
  const sel = $('#crsSelect');
  const cs = state.model && state.model.coordinateSystem;
  sel.innerHTML = '';
  const add = (v, t) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    sel.appendChild(o);
  };
  if (cs && (cs.epsg || cs.wkt)) add('file', `From file (${cs.epsg ? 'EPSG:' + cs.epsg : 'WKT'}${cs.name ? ' – ' + cs.name : ''})`);
  add('anchor', 'Local – pin to my position (no CRS)');
  for (const [k, v] of Object.entries(CRS_PRESETS)) add(k, `${k} – ${v.name}`);
  add('custom', 'Other EPSG / proj4 / WKT…');
  let choice = force || (state.georef.mode === 'anchor' ? 'anchor' : settings.crsChoice);
  if (choice === 'file' && !(cs && (cs.epsg || cs.wkt))) choice = 'RAMSEY';
  sel.value = choice;
  if (sel.value !== choice) sel.value = 'RAMSEY';
  $('#crsCustom').value = settings.crsCustom || '';
  updateCrsUI();
}

function updateCrsUI() {
  const v = $('#crsSelect').value;
  $('#crsCustom').classList.toggle('hidden', v !== 'custom');
  $('#anchorBox').classList.toggle('hidden', v !== 'anchor');
  $('#btnApplyCrs').classList.toggle('hidden', v === 'anchor');
  $('#anchorSta').value = settings.anchorSta;
  renderGeorefStatus();
}
$('#crsSelect').addEventListener('change', updateCrsUI);

function renderGeorefStatus(msg, cls) {
  const el = $('#georefStatus');
  const g = state.georef;
  el.className = 'status ' + (cls || (g.ready ? 'ok' : ''));
  el.textContent = msg || (g.ready ? `Georeferenced: ${g.label || g.mode}` : 'Not georeferenced yet.');
}

async function applyCrs(choice, custom) {
  const cs = state.model && state.model.coordinateSystem;
  let input = null, label = choice;
  if (choice === 'file' && cs) {
    input = cs.epsg ? 'EPSG:' + cs.epsg : cs.wkt;
    label = cs.epsg ? 'EPSG:' + cs.epsg : cs.name || 'file CRS';
  } else if (choice === 'custom') {
    input = custom;
    label = custom.length > 30 ? custom.slice(0, 30) + '…' : custom;
  } else if (CRS_PRESETS[choice]) {
    input = choice;
    label = choice === 'RAMSEY' ? 'Ramsey County (NAD83, US ft)' : choice;
  }
  if (!input) return false;
  renderGeorefStatus('Resolving coordinate system…');
  const def = await resolveCRS(input);
  if (!def) {
    renderGeorefStatus(`Unknown CRS "${input}". Enter a proj4 string instead (online lookup failed).`, 'err');
    return false;
  }
  try {
    state.georef.setCRS(def, label);
  } catch (e) {
    renderGeorefStatus('Invalid CRS definition: ' + e.message, 'err');
    return false;
  }
  persistGeoref();
  // Sanity check: the model should be somewhere on Earth.
  if (state.model) {
    const ll = state.georef.gridToLatLon(state.model.bbox.cx, state.model.bbox.cy);
    if (!ll || !Number.isFinite(ll.lat) || Math.abs(ll.lat) > 90) {
      renderGeorefStatus('The coordinates do not fit this CRS — check the selection.', 'err');
      return false;
    }
    const gp = gps.position;
    let extra = ` · centre ${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)}`;
    if (gp) {
      const d = latLonToENU(gp, ll.lat, ll.lon);
      const dist = Math.hypot(d.e, d.n);
      extra += Units.system === 'us' ? ` · ${(dist / 1609.344).toFixed(2)} mi from you` : ` · ${(dist / 1000).toFixed(2)} km from you`;
    }
    renderGeorefStatus(`Georeferenced: ${label}${extra}`, 'ok');
  }
  scheduleRebuild(true);
  return true;
}

$('#btnApplyCrs').addEventListener('click', async () => {
  settings.crsChoice = $('#crsSelect').value;
  settings.crsCustom = $('#crsCustom').value.trim();
  saveSettings();
  if (await applyCrs(settings.crsChoice, settings.crsCustom)) toast('Coordinate system applied');
});

// Pick the coordinate system after loading: a file tagged as Ramsey County uses
// the FBK-Checker definition, another declared EPSG/WKT is used as-is, and files
// without one use the saved choice (Ramsey County by default).
async function autoGeoref() {
  const cs = state.model && state.model.coordinateSystem;
  if (isRamseyCS(cs)) settings.crsChoice = 'RAMSEY';
  else if (cs && (cs.epsg || cs.wkt)) settings.crsChoice = 'file';
  else if (settings.crsChoice === 'file') settings.crsChoice = 'RAMSEY';
  saveSettings();
  if (settings.crsChoice === 'file' || CRS_PRESETS[settings.crsChoice] || (settings.crsChoice === 'custom' && settings.crsCustom)) {
    await applyCrs(settings.crsChoice, settings.crsCustom);
  } else if (settings.crsChoice === 'anchor' && state.georef.mode !== 'anchor') {
    renderGeorefStatus('Pin the alignment to your position (Files ▸ Pin station here).');
  }
  renderCrsSelect();
}

function persistGeoref() {
  try { localStorage.setItem('georef', JSON.stringify(state.georef.toJSON())); } catch { /* ignore */ }
}

function currentAlignment() {
  const m = state.model;
  if (!m || !m.alignments.length) return null;
  if (settings.activeAlign !== 'auto' && m.alignments[+settings.activeAlign]) return m.alignments[+settings.activeAlign];
  if (state.nearest) return state.nearest.al;
  return m.alignments.find((a, i) => state.visible[i]) || m.alignments[0];
}

function pinAnchor({ ahead = 0 } = {}) {
  const al = currentAlignment();
  const pos = gps.position;
  if (!al) return toast('Load an alignment first');
  if (!pos) return toast('Waiting for GPS…');
  const sta = Number($('#anchorSta').value) || al.staStart;
  settings.anchorSta = sta;
  if (!ahead) settings.crsChoice = 'anchor'; // the demo's automatic pin keeps the saved (Ramsey) choice
  saveSettings();
  const p = pointAtStation(al, sta);
  const heading = orientation.hasData ? viewAngles().heading : 0;
  let ll = { lat: pos.lat, lon: pos.lon };
  if (ahead) ll = enuToLatLon(ll, ahead * Math.sin(heading * DEG), ahead * Math.cos(heading * DEG));
  state.georef.setAnchor({ x: p.x, y: p.y }, ll, p.bearing, heading * DEG);
  persistGeoref();
  state.pendingAutoAnchor = false;
  renderGeorefStatus(`Pinned ${al.name} ${staText(sta, state.georef.units)} at ${ll.lat.toFixed(6)}, ${ll.lon.toFixed(6)}, bearing ${heading.toFixed(1)}°`, 'ok');
  scheduleRebuild(true);
  toast('Alignment pinned to your position');
}
$('#btnAnchor').addEventListener('click', () => pinAnchor());

function tryAutoAnchor() {
  if (!state.pendingAutoAnchor || !gps.position || !state.model) return;
  if (!orientation.hasData && state.started && performance.now() - (state.startTime || 0) < 3000) return; // wait for compass
  pinAnchor({ ahead: 5 });
}

// --- Settings UI -------------------------------------------------------------------

function applySettingsToEngines() {
  orientation.headingOffset = Number(settings.headingOffset) || 0;
  orientation.smoothing = Number(settings.smoothing) || 0.3;
  camera.fovLong = Number(settings.fovLong) || 66;
  Object.assign(ar.settings, {
    heightMode: settings.heightMode,
    eyeHeight: fromDisp(Number(settings.eyeHeight) || toDisp(1.6)),
    tickInterval: fromDisp(Math.max(1, Number(settings.tickInterval) || 25)),
    labelInterval: fromDisp(Math.max(1, Number(settings.labelInterval) || 100)),
    labelRange: fromDisp(Math.max(10, Number(settings.labelRange) || 1300)),
    lineWidth: Math.max(1, Number(settings.lineWidth) || 6),
    showPoints: !!settings.showPoints,
    showPipes: settings.showPipes !== false,
    surfaceStyle: settings.surfaceStyle || 'mesh',
    offsets: String(settings.offsets || '').split(/[,;\s]+/).map(Number).filter((v) => Number.isFinite(v) && v !== 0).map(fromDisp),
  });
  plan.units = state ? state.georef.units : 1;
}

// Switching unit systems converts the stored length settings.
function setUnits(system) {
  if (system === Units.system) return;
  const k = system === 'us' ? 1 / USFT : USFT;
  const conv = (v) => (v === '' || v === null || !Number.isFinite(+v) ? v : +(+v * k).toFixed(4));
  for (const key of LENGTH_KEYS) settings[key] = conv(settings[key]);
  settings.offsets = String(settings.offsets || '').split(/[,;\s]+/).filter(Boolean).map((v) => conv(v)).join(', ');
  settings.units = system;
  Units.system = system;
  saveSettings();
  applySettingsToEngines();
  syncSettingInputs();
  updateUnitLabels();
  updateCalibUI();
  renderAlignList();
  scheduleRebuild(true);
}

function updateUnitLabels() {
  $$('.u').forEach((el) => { el.textContent = Units.label; });
  const off = $('[data-set=offsets]');
  if (off) off.placeholder = Units.system === 'us' ? '-12, 12' : '-3.5, 3.5';
}

const GEOMETRY_KEYS = new Set(['heightMode', 'tickInterval', 'labelInterval', 'lineWidth', 'showPoints', 'offsets', 'surfaceStyle', 'showPipes']);
$$('[data-set]').forEach((el) => {
  const k = el.dataset.set;
  if (k === 'units') {
    el.value = settings.units;
    el.addEventListener('change', () => setUnits(el.value));
    return;
  }
  if (el.type === 'checkbox') el.checked = !!settings[k];
  else el.value = settings[k];
  el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number' || el.type === 'range') v = el.value === '' ? '' : Number(el.value);
    settings[k] = v;
    saveSettings();
    applySettingsToEngines();
    updateCalibUI();
    if (GEOMETRY_KEYS.has(k)) scheduleRebuild(true);
  });
});

function syncSettingInputs() {
  $$('[data-set]').forEach((el) => {
    const k = el.dataset.set;
    if (el.type === 'checkbox') el.checked = !!settings[k];
    else if (document.activeElement !== el) el.value = settings[k];
  });
}
updateUnitLabels();

// --- Calibration panel ---------------------------------------------------------------

function updateCalibUI() {
  $('#calHdg').textContent = `${(+settings.headingOffset || 0).toFixed(1)}°`;
  $('#calH').textContent = `${(+settings.verticalOffset || 0).toFixed(2)} ${Units.label}`;
  $('#calFov').textContent = `${(+settings.fovLong || 66).toFixed(1)}°`;
}
updateCalibUI();

function setAlignPanel(open) {
  $('#calib').classList.toggle('hidden', !open);
  $('#crosshair').classList.toggle('hidden', !open);
  $('#btnCalib').setAttribute('aria-pressed', String(open));
  $('#app').classList.toggle('aligning', open);
  if (open) {
    closeSheets();
    renderControlList();
    updateAlignStatus();
  }
}
$('#btnCalib').addEventListener('click', () => setAlignPanel($('#calib').classList.contains('hidden')));
$('#btnCalibDone').addEventListener('click', () => setAlignPanel(false));
$$('[data-cal]').forEach((b) => b.addEventListener('click', () => {
  const d = Number(b.dataset.d);
  if (b.dataset.cal === 'hdg') settings.headingOffset = +((+settings.headingOffset || 0) + d).toFixed(2);
  if (b.dataset.cal === 'h') settings.verticalOffset = +((+settings.verticalOffset || 0) + d).toFixed(2);
  if (b.dataset.cal === 'fov') settings.fovLong = Math.min(120, Math.max(20, +((+settings.fovLong || 66) + d).toFixed(2)));
  saveSettings();
  applySettingsToEngines();
  syncSettingInputs();
  updateCalibUI();
}));

$('#btnAlignHeading').addEventListener('click', () => {
  if (xr.active) return toast('In ARCore mode, sight or occupy two control points to set the heading');
  const n = state.nearest;
  if (!n || !ar.origin) return toast('No alignment nearby');
  if (n.so.distance * state.georef.units > 30) return toast(`Walk onto the alignment first (within ${dLen(30, 0)})`);
  const al = n.al;
  const a = pointAtStation(al, n.so.station - 2), b = pointAtStation(al, n.so.station + 2);
  const la = state.georef.gridToLatLon(a.x, a.y), lb = state.georef.gridToLatLon(b.x, b.y);
  const d = latLonToENU(la, lb.lat, lb.lon);
  let bearing = Math.atan2(d.e, d.n) / DEG;
  const { heading } = viewAngles();
  let diff = ((bearing - heading + 540) % 360) - 180;
  if (Math.abs(diff) > 90) { // facing the other way along the alignment
    bearing += 180;
    diff = ((bearing - heading + 540) % 360) - 180;
  }
  settings.headingOffset = +(((+settings.headingOffset || 0) + diff + 540) % 360 - 180).toFixed(2);
  saveSettings();
  applySettingsToEngines();
  syncSettingInputs();
  updateCalibUI();
  toast(`Heading corrected by ${diff.toFixed(1)}°`);
});

// --- Control points: occupy / sight -----------------------------------------------------

// All loaded points (PNEZD files and LandXML CgPoints) usable as control.
function controlPoints() {
  return state.model ? state.model.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) : [];
}

function selectedControl() {
  const v = $('#ctrlPoint').value;
  const pts = controlPoints();
  if (v === '') return null;
  return pts[+v] || null;
}

// Grid distance from the user (file units), or null without a position.
function controlDistance(pt) {
  return state.userGrid ? Math.hypot(pt.x - state.userGrid.x, pt.y - state.userGrid.y) : null;
}

function renderControlList() {
  const sel = $('#ctrlPoint');
  const prev = sel.value;
  const pts = controlPoints();
  const u = state.georef.units;
  sel.innerHTML = '';
  if (!pts.length) {
    sel.innerHTML = '<option value="">No points loaded — load a PNEZD file (Files)</option>';
    $('#ctrlInfo').textContent = '';
    return;
  }
  // Nearest first when we know where we are.
  const order = pts.map((p, i) => ({ p, i, d: controlDistance(p) }));
  if (order[0].d !== null) order.sort((a, b) => a.d - b.d);
  for (const { p, i, d } of order.slice(0, 500)) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${p.name}${p.code ? ' · ' + p.code : ''}${d !== null ? ' · ' + dLen(d * u, 0) : ''}`;
    sel.appendChild(o);
  }
  sel.value = prev !== '' && pts[+prev] ? prev : String(order[0].i);
  showControlInfo();
}
$('#ctrlPoint').addEventListener('change', showControlInfo);

function showControlInfo() {
  const pt = selectedControl();
  const u = state.georef.units;
  if (!pt) return ($('#ctrlInfo').textContent = '');
  const d = controlDistance(pt);
  $('#ctrlInfo').textContent = `N ${pt.y.toFixed(3)}  E ${pt.x.toFixed(3)}${pt.z !== null ? `  Z ${elevText(pt.z, u)}` : ''}${d !== null ? `  ·  ${dLen(d * u, 1)} away` : ''}`;
}

function updateAlignStatus() {
  const lines = [];
  const a = settings.alignInfo || {};
  if (gps.shift) {
    const e = gps.shift.dLon * metersPerDegreeLon(), n = gps.shift.dLat * 111320;
    lines.push(`Occupied ${a.occupy || '?'}: GPS shift E ${e >= 0 ? '+' : ''}${dLen(e)}  N ${n >= 0 ? '+' : ''}${dLen(n)}`);
  }
  if (a.sight) lines.push(`Sighted ${a.sight}: heading ${(+settings.headingOffset || 0) >= 0 ? '+' : ''}${(+settings.headingOffset || 0).toFixed(2)}°`);
  if (+settings.verticalOffset) lines.push(`Height correction ${(+settings.verticalOffset).toFixed(2)} ${Units.label}`);
  if (xr.active) {
    lines.length = 0;
    lines.push(xr.pairs.length ? `ARCore control: ${xr.pairs.map((p) => p.name).join(', ')}${xr.pairs.length >= 2 ? '' : ' (add a 2nd point)'}` : 'ARCore: placed from GPS + compass. Occupy or sight control points.');
  }
  $('#calStatus').textContent = lines.join('\n');
}
function metersPerDegreeLon() {
  const lat = (gps.uncorrected && gps.uncorrected.lat) || 45;
  return 111320 * Math.cos(lat * DEG);
}

function persistAlignment() {
  settings.posShift = gps.shift;
  saveSettings();
  applySettingsToEngines();
  syncSettingInputs();
  updateCalibUI();
  updateAlignStatus();
}

// Occupy: the phone is on the control point, so the corrected position must equal it.
// ARCore mode: control points pin the tracked frame to the design (see xr.js).
function controlWorldPoint(pt) {
  const u = state.georef.units;
  const ll = state.georef.gridToLatLon(pt.x, pt.y);
  const e = latLonToENU(ar.origin, ll.lat, ll.lon);
  const hasZ = pt.z !== null && ar.settings.heightMode !== 'flat';
  return { v: new THREE.Vector3(e.e, hasZ ? pt.z * u + ar.root.position.y : ar.root.position.y, -e.n), hasZ };
}

function xrPairDone(pt, how, res) {
  settings.alignInfo = { ...(settings.alignInfo || {}), [how]: pt.name, xr: true };
  saveSettings();
  updateAlignStatus();
  vibrate(30);
  const rot = res.usedPoints === 2 ? ` · heading ${res.headingChangeDeg >= 0 ? '+' : ''}${res.headingChangeDeg.toFixed(2)}° from 2 points` : ' · add a 2nd point to fix the heading';
  toast(`ARCore: ${how === 'occupy' ? 'occupied' : 'sighted'} ${pt.name}${rot}${res.usedPoints === 2 ? ` · fit ${dLen(res.residual, 2)}` : ''}`, 5000);
}

$('#btnOccupy').addEventListener('click', () => {
  const pt = selectedControl();
  if (xr.active) {
    if (!pt) return toast('Pick a control point first');
    if (!xr.pose || !xr.aligned) return toast('ARCore is still starting…');
    const { v, hasZ } = controlWorldPoint(pt);
    const feet = xr.pose.position.clone();
    feet.y -= ar.settings.eyeHeight;
    return xrPairDone(pt, 'occupy', xr.addPair(pt.name, v, feet, hasZ && $('#ctrlHeight').checked));
  }
  const raw = gps.uncorrected;
  if (!pt) return toast('Pick a control point first');
  if (!state.georef.ready) return toast('Georeference the files first');
  if (!raw) return toast('Waiting for GPS…');
  const ll = state.georef.gridToLatLon(pt.x, pt.y);
  const before = gps.shift;
  gps.shift = { dLat: ll.lat - raw.lat, dLon: ll.lon - raw.lon, dAlt: 0 };
  const moved = latLonToENU(before ? { lat: raw.lat + before.dLat, lon: raw.lon + before.dLon } : raw, ll.lat, ll.lon);
  // Hold the position while set up on the point (tap 📍 to walk again).
  gps.locked = true;
  $('#btnLock').setAttribute('aria-pressed', 'true');
  settings.alignInfo = { ...(settings.alignInfo || {}), occupy: pt.name };
  if ($('#ctrlHeight').checked && pt.z !== null) state.pendingHeightZero = { z: pt.z, mode: 'occupy' };
  persistAlignment();
  scheduleRebuild(true);
  vibrate(30);
  toast(`Zeroed on ${pt.name}: moved ${dLen(Math.hypot(moved.e, moved.n), 2)} · position held (tap 📍 to walk)`, 4500);
});

// Sight: the crosshair (screen centre) is on the control point; rotate the view onto it.
$('#btnSight').addEventListener('click', () => {
  const pt = selectedControl();
  if (!pt) return toast('Pick a control point first');
  if (xr.active) {
    // ARCore measures where the crosshair ray meets the ground: exact 3D point, no pitch maths.
    if (!xr.hit) return toast('No ground detected at the crosshair: move the phone slowly so ARCore can find the surface');
    const { v, hasZ } = controlWorldPoint(pt);
    return xrPairDone(pt, 'sight', xr.addPair(pt.name, v, xr.hit, hasZ && $('#ctrlHeight').checked));
  }
  if (!ar.origin || !state.georef.ready || !gps.position) return toast('Waiting for GPS…');
  const u = state.georef.units;
  const ll = state.georef.gridToLatLon(pt.x, pt.y);
  const t = latLonToENU(ar.origin, ll.lat, ll.lon);
  const cam = ar.camera.position;
  const dE = t.e - cam.x, dN = t.n - -cam.z;
  const dist = Math.hypot(dE, dN);
  if (dist < 2) return toast(`Too close to sight (${dLen(dist, 1)}): use “On point” instead`);
  const bearing = Math.atan2(dE, dN) / DEG;
  const { heading, pitch } = viewAngles();
  const diff = ((bearing - heading + 540) % 360) - 180;
  settings.headingOffset = +(((+settings.headingOffset || 0) + diff + 540) % 360 - 180).toFixed(3);
  let hMsg = '';
  if ($('#ctrlHeight').checked && pt.z !== null && ar.settings.heightMode !== 'flat' && dist >= 5) {
    // Move the model vertically so the point sits on the crosshair's line of sight.
    const want = cam.y + dist * Math.tan(pitch * DEG);
    const have = pt.z * u + ar.root.position.y;
    const dy = want - have;
    settings.verticalOffset = +((+settings.verticalOffset || 0) - toDisp(dy)).toFixed(3);
    hMsg = ` · height ${dy >= 0 ? '+' : ''}${dLen(dy, 2)}`;
  }
  settings.alignInfo = { ...(settings.alignInfo || {}), sight: pt.name };
  persistAlignment();
  vibrate(30);
  toast(`Sighted ${pt.name} at ${dLen(dist, 0)}: heading ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}°${hMsg}`, 4500);
});

// ARCore mode: make the design ground pass through the detected ground at the crosshair.
$('#btnGround').addEventListener('click', () => {
  if (!xr.active || !xr.aligned) return;
  if (!xr.hit) return toast('No ground detected at the crosshair yet');
  const u = state.georef.units;
  const hw = xr.toWorld(xr.hit);
  const ll = enuToLatLon(ar.origin, hw.x, -hw.z);
  const g = state.georef.latLonToGrid(ll.lat, ll.lon);
  let z = null, src = '';
  for (const sf of state.model ? state.model.surfaces : []) {
    if (!sf.visible) continue;
    z = surfaceElevation(sf, g.x, g.y);
    if (z !== null) { src = 'surface'; break; }
  }
  if (z === null && state.model) {
    let best = null;
    for (const al of state.model.alignments) {
      const so = stationOffset(al, g.x, g.y);
      if (so && so.z !== null && (!best || so.distance < best.distance)) best = so;
    }
    if (best && best.distance * u < 15) { z = best.z; src = 'alignment ' + staText(best.station, u); }
  }
  if (z === null) return toast('No design surface or alignment elevation at the crosshair');
  const dy = xr.zeroHeightAt(new THREE.Vector3(hw.x, z * u + ar.root.position.y, hw.z), xr.hit.y);
  vibrate(30);
  toast(`Height zeroed on the ground (${src}, Z ${elevText(z, u)}): ${dy >= 0 ? '+' : ''}${dLen(dy, 2)}`, 4500);
});

$('#btnResetAlign').addEventListener('click', () => {
  if (xr.active) {
    xr.pairs = [];
    xr.aligned = false; // re-placed from GPS + compass on the next frame
    settings.alignInfo = {};
    saveSettings();
    updateAlignStatus();
    return toast('ARCore alignment reset to GPS + compass');
  }
  if (!confirm('Clear the control-point alignment (GPS shift, heading and height corrections)?')) return;
  gps.shift = null;
  settings.headingOffset = 0;
  settings.verticalOffset = 0;
  settings.alignInfo = {};
  persistAlignment();
  scheduleRebuild(true);
  toast('Alignment reset');
});

// --- ARCore (WebXR) mode ---------------------------------------------------------------

XRMode.supported().then((ok) => {
  if (ok) $('#btnXR').classList.remove('hidden');
});

xr.onEnd = async () => {
  $('#app').classList.remove('xr');
  document.body.classList.remove('xr');
  $('#btnXR').setAttribute('aria-pressed', 'false');
  state.viewQuat = null;
  ar.viewPosition = null;
  try { await camera.start(); } catch (e) { toast('Camera: ' + e.message); }
  ar.resize();
  toast('ARCore mode ended: back to GPS + compass');
};

$('#btnXR').addEventListener('click', async () => {
  if (xr.active) return xr.stop();
  if (!state.started) return toast('Start the AR camera first');
  if (!gps.position) return toast('Waiting for GPS…');
  // The browser can't share the camera between the page and ARCore.
  camera.stop();
  try {
    $('#app').classList.add('xr');
    document.body.classList.add('xr');
    await xr.start($('#app'));
    $('#btnXR').setAttribute('aria-pressed', 'true');
    toast('ARCore tracking on. Move the phone slowly; then occupy or sight control points to lock the model in place.', 6000);
  } catch (e) {
    $('#app').classList.remove('xr');
    document.body.classList.remove('xr');
    try { await camera.start(); } catch { /* ignore */ }
    toast('ARCore could not start: ' + (e.message || e.name), 6000);
  }
});

// --- Tools ---------------------------------------------------------------------------

$('#btnLock').addEventListener('click', (e) => {
  gps.locked = !gps.locked;
  e.currentTarget.setAttribute('aria-pressed', String(gps.locked));
  toast(gps.locked ? 'Position frozen' : 'Live GPS');
});
$('#btnTorch').addEventListener('click', async (e) => {
  const on = !camera.torch;
  await camera.setTorch(on).catch(() => {});
  e.currentTarget.setAttribute('aria-pressed', String(camera.torch));
});
$('#btnZoom').addEventListener('click', async (e) => {
  const r = camera.zoomRange;
  if (!r) return;
  const steps = [1, 2, 3, 5].filter((z) => z >= r.min && z <= r.max);
  const next = steps[(steps.indexOf(camera.zoom) + 1) % steps.length] || r.min;
  await camera.setZoom(next).catch(() => {});
  e.currentTarget.textContent = `${camera.zoom}×`;
});

// Desktop fallback: drag to look around when there is no orientation sensor.
(() => {
  let last = null;
  const c = $('#ar');
  c.addEventListener('pointerdown', (e) => { last = { x: e.clientX, y: e.clientY }; });
  c.addEventListener('pointermove', (e) => {
    if (!last || orientation.hasData) return;
    orientation.manual.yaw += (e.clientX - last.x) * 0.2;
    orientation.manual.pitch = Math.max(-89, Math.min(89, orientation.manual.pitch + (e.clientY - last.y) * 0.2));
    last = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointerup', () => { last = null; });
})();

// --- Map -----------------------------------------------------------------------------

$('#btnFit').addEventListener('click', () => plan.fit());
$('#btnFollow').addEventListener('click', () => { plan.follow = true; });
$('#btnSimulate').addEventListener('click', () => {
  if (!state.georef.ready) return toast('Georeference the alignment first');
  const ll = state.georef.gridToLatLon(plan.view.cx, plan.view.cy);
  gps.locked = false;
  gps.setManual(ll.lat, ll.lon, null);
  gps.locked = true;
  $('#btnLock').setAttribute('aria-pressed', 'true');
  toast('Simulated position set (GPS frozen — tap 📍 to resume)');
});

// --- Start ---------------------------------------------------------------------------

if (!window.isSecureContext) $('#secureWarn').classList.remove('hidden');

$('#btnStart').addEventListener('click', start);

async function start() {
  const status = $('#startStatus');
  status.className = 'status';
  status.textContent = 'Requesting sensors…';
  const errors = [];
  // Orientation permission must be requested first, directly in the tap handler (iOS).
  try {
    const src = await orientation.start();
    if (orientation.error) errors.push(orientation.error);
    console.info('Orientation source:', src);
  } catch (e) {
    errors.push('Orientation: ' + e.message);
  }
  motion.start();
  if (!gps.start()) errors.push(gps.error);
  status.textContent = 'Opening camera…';
  try {
    await camera.start();
    if (camera.hasTorch) $('#btnTorch').classList.remove('hidden');
    if (camera.zoomRange && camera.zoomRange.max >= 2) $('#btnZoom').classList.remove('hidden');
  } catch (e) {
    errors.push('Camera: ' + (e.message || e.name));
  }
  wake.request();
  state.started = true;
  state.startTime = performance.now();
  $('#start').classList.add('hidden');
  if (errors.length) toast(errors.join(' · '), 6000);
  ar.resize();
  if (!state.model) setTimeout(() => openSheet('files'), 400);
}

// --- Photos --------------------------------------------------------------------------

$('#shutter').addEventListener('click', takePhoto);
document.addEventListener('keydown', (e) => {
  if (state.started && (e.key === ' ' || e.key === 'Enter') && e.target === document.body) {
    e.preventDefault();
    takePhoto();
  }
});

function photoContext() {
  const pos = gps.position;
  const { heading, pitch, roll } = viewAngles();
  const n = state.nearest;
  const u = state.georef.units;
  const info = { pitch: +pitch.toFixed(1), roll: +roll.toFixed(1), crs: state.georef.label || '' };
  if (n) {
    info.alignment = n.al.name;
    info.station = staText(n.so.station, u);
    info.offset = +toDisp(n.so.offset * u).toFixed(3);
    info.distance = +toDisp(n.so.distance * u).toFixed(3);
    info.units = Units.label;
    if (n.so.z !== null) info.designZ = +toDisp(n.so.z * u).toFixed(3);
  }
  if (state.userGrid) {
    info.gridX = +state.userGrid.x.toFixed(3);
    info.gridY = +state.userGrid.y.toFixed(3);
  }
  return { pos, heading, pitch, info };
}

async function takePhoto() {
  if (!state.started) return toast('Start the AR camera first');
  const { pos, heading, pitch, info } = photoContext();
  const time = Date.now();
  const d = new Date(time);
  const offTxt = info.offset !== undefined ? `${info.offset >= 0 ? 'R' : 'L'} ${Math.abs(info.offset).toFixed(2)} ${Units.label}` : '';
  const description = info.alignment ? `${info.alignment} ${info.station} ${offTxt}` : 'CSTP AR CAM';
  const stamp = [
    `CSTP AR CAM · ${d.toLocaleString()}`,
    pos ? `Lat ${pos.lat.toFixed(7)}  Lon ${pos.lon.toFixed(7)}  ±${dLen(pos.accuracy, 1)}${pos.alt !== null ? `  GPS elev ${dLen(gpsToDrawingElev(pos.alt), 1)} (datum ${(+settings.datumAdjust).toFixed(2)})` : ''}` : 'No GPS fix',
    `Heading ${heading.toFixed(1)}°  Pitch ${pitch.toFixed(1)}°`,
  ];
  if (info.alignment) stamp.push(`${info.alignment} · Sta ${info.station} · ${offTxt}${info.designZ !== undefined ? ` · Z ${info.designZ.toFixed(2)}` : ''}`);
  const al = settings.alignInfo || {};
  if (al.occupy || al.sight) stamp.push(`Aligned on control: ${[al.occupy && 'occupy ' + al.occupy, al.sight && 'sight ' + al.sight].filter(Boolean).join(', ')}`);
  if (info.gridX !== undefined && state.georef.mode === 'crs') stamp.push(`N ${info.gridY.toFixed(2)}  E ${info.gridX.toFixed(2)}  (${info.crs})`);

  const meta = { time, lat: pos ? pos.lat : null, lon: pos ? pos.lon : null, alt: pos ? gpsToSeaLevel(pos.alt) : null, accuracy: pos ? pos.accuracy : null, heading, description, info };

  // Visual + haptic feedback
  $('#flash').classList.add('on');
  setTimeout(() => $('#flash').classList.remove('on'), 60);
  const cam = $('#shutter');
  cam.classList.remove('bounce');
  void cam.offsetWidth; // restart the animation
  cam.classList.add('bounce');
  vibrate(40);

  try {
    let shots;
    if (xr.active) {
      // ARCore owns the camera: grab its image + the model from the next XR frame.
      const snap = await xr.capture();
      if (!snap.hasCamera) toast('ARCore did not share the camera image: photo shows the model only', 4000);
      shots = [await composePhoto({ snapshot: snap.canvas, stamp: settings.photoStamp ? stamp : [], meta })];
    } else {
      ar.render(); // make sure the overlay is current
      const common = { camera, arCanvas: $('#ar'), viewW: window.innerWidth, viewH: window.innerHeight, meta };
      shots = [await composePhoto({ ...common, overlay: settings.photoOverlay, stamp: settings.photoStamp ? stamp : [] })];
      if (settings.photoClean && settings.photoOverlay) shots.push(await composePhoto({ ...common, overlay: false, stamp: [] }));
    }
    for (const [k, shot] of shots.entries()) {
      const rec = { blob: shot.blob, thumb: shot.thumb, width: shot.width, height: shot.height, meta: { ...meta, clean: k > 0 }, note: '' };
      await PhotoStore.add(rec);
      if (settings.photoAutoDownload) downloadBlob(shot.blob, photoFileName(rec).replace('.jpg', k ? '_clean.jpg' : '.jpg'));
    }
    updatePhotoCount();
    toast(info.alignment ? `Saved · ${info.station} ${offTxt}` : 'Photo saved');
  } catch (e) {
    console.error(e);
    toast('Photo failed: ' + e.message, 4000);
  }
}

async function updatePhotoCount() {
  try {
    const all = await PhotoStore.all();
    state.photoCount = all.length;
    const b = $('#photoCount');
    b.textContent = all.length;
    b.classList.toggle('hidden', !all.length);
  } catch { /* IndexedDB unavailable */ }
}

// Polaroid-style cards, newest first, each with a small random tilt.
async function renderGallery() {
  const g = $('#gallery');
  g.innerHTML = '';
  const all = (await PhotoStore.all().catch(() => [])).reverse();
  gallery.recs = all;
  $('#galleryEmpty').classList.toggle('hidden', all.length > 0);
  all.forEach((rec, k) => {
    const b = document.createElement('button');
    b.className = 'thumb-card' + (k === 0 ? ' newest' : '');
    b.style.setProperty('--rot', `${((rec.id * 37) % 9) - 4}deg`);
    b.style.animationDelay = `${Math.min(k, 12) * 0.04}s`;
    const img = document.createElement('img');
    img.src = rec.thumb;
    img.alt = rec.meta.description || 'photo';
    const cap = document.createElement('span');
    cap.className = 'tcap';
    cap.textContent = (rec.meta.info && rec.meta.info.station) || new Date(rec.meta.time).toLocaleTimeString();
    b.append(img, cap);
    b.addEventListener('click', () => openViewer(k));
    g.appendChild(b);
  });
}

// Carousel viewer
const gallery = { recs: [], index: 0 };
let viewerRec = null, viewerURL = null;
function openViewer(k) {
  const recs = gallery.recs;
  if (!recs.length) return;
  gallery.index = (k + recs.length) % recs.length;
  const rec = recs[gallery.index];
  viewerRec = rec;
  const img = $('#viewerImg');
  img.classList.add('fade-out');
  setTimeout(() => {
    if (viewerURL) URL.revokeObjectURL(viewerURL);
    viewerURL = URL.createObjectURL(rec.blob);
    img.src = viewerURL;
    img.onload = () => img.classList.remove('fade-out');
  }, $('#viewer').classList.contains('hidden') ? 0 : 150);
  const m = rec.meta, i = m.info || {};
  $('#galCounter').textContent = `${gallery.index + 1} / ${recs.length}`;
  $('#galLabel').textContent = i.alignment ? `${i.alignment} · ${i.station}` : new Date(m.time).toLocaleString();
  $('#galLabel').classList.remove('label-anim');
  void $('#galLabel').offsetWidth;
  $('#galLabel').classList.add('label-anim');
  $('#galFile').textContent = photoFileName(rec) + (m.clean ? ' (clean)' : '');
  $('#galDots').innerHTML = recs.length > 40 ? '' : recs.map((_, j) => `<button class="gallery-dot${j === gallery.index ? ' active' : ''}" data-j="${j}" aria-label="Photo ${j + 1}"></button>`).join('');
  $('#viewerMeta').textContent = [
    `${new Date(m.time).toLocaleString()}  ·  Hdg ${fmt(m.heading, 1)}°  Pitch ${fmt(i.pitch, 1)}°`,
    m.lat !== null ? `${m.lat.toFixed(7)}, ${m.lon.toFixed(7)}  ±${dLen(m.accuracy, 1)}` : 'No GPS',
    i.alignment ? `Offset ${fmt(i.offset, 2)} ${i.units || 'm'}${i.designZ !== undefined ? `  ·  Z ${fmt(i.designZ, 2)}` : ''}` : '',
    i.gridX !== undefined ? `N ${fmt(i.gridY, 3)}  E ${fmt(i.gridX, 3)}` : '',
  ].filter(Boolean).join('\n');
  $('#viewerNote').value = rec.note || '';
  $('#galPrev').classList.toggle('hidden', recs.length < 2);
  $('#galNext').classList.toggle('hidden', recs.length < 2);
  $('#viewer').classList.remove('hidden');
}
$('#galPrev').addEventListener('click', () => openViewer(gallery.index - 1));
$('#galNext').addEventListener('click', () => openViewer(gallery.index + 1));
$('#galDots').addEventListener('click', (e) => { if (e.target.dataset.j) openViewer(+e.target.dataset.j); });
(() => {
  let x0 = null;
  const stage = $('#viewerImg').parentElement;
  stage.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 50) openViewer(gallery.index + (dx < 0 ? 1 : -1));
    x0 = null;
  });
})();
$('#viewerNote').addEventListener('change', async (e) => {
  if (!viewerRec) return;
  viewerRec.note = e.target.value;
  await PhotoStore.put(viewerRec);
});
$('#vClose').addEventListener('click', () => $('#viewer').classList.add('hidden'));
$('#vShare').addEventListener('click', () => viewerRec && sharePhoto(viewerRec).catch((e) => e.name !== 'AbortError' && toast(e.message)));
$('#vDownload').addEventListener('click', () => viewerRec && downloadBlob(viewerRec.blob, photoFileName(viewerRec)));
$('#vDelete').addEventListener('click', async () => {
  if (!viewerRec || !confirm('Delete this photo?')) return;
  await PhotoStore.remove(viewerRec.id);
  await renderGallery();
  updatePhotoCount();
  if (gallery.recs.length) openViewer(Math.min(gallery.index, gallery.recs.length - 1));
  else $('#viewer').classList.add('hidden');
});
$('#btnExportCsv').addEventListener('click', async () => {
  const all = await PhotoStore.all();
  downloadBlob(new Blob([photosToCSV(all)], { type: 'text/csv' }), `CSTP_photo_log_${new Date().toISOString().slice(0, 10)}.csv`);
});
$('#btnDownloadAll').addEventListener('click', async () => {
  const all = await PhotoStore.all();
  for (const rec of all) {
    downloadBlob(rec.blob, photoFileName(rec));
    await new Promise((r) => setTimeout(r, 350));
  }
});
$('#btnDeleteAll').addEventListener('click', async () => {
  if (!confirm('Delete ALL photos stored in this app? Download them first if needed.')) return;
  await PhotoStore.clear();
  renderGallery();
  updatePhotoCount();
});

// --- Scene rebuild ---------------------------------------------------------------------

let rebuildQueued = false;
function scheduleRebuild(force = false) {
  if (force && !xr.active) ar.origin = null;
  rebuildQueued = true;
}

function maybeRebuild(pos) {
  if (!state.model || !state.georef.ready) {
    if (rebuildQueued) { ar.clear(); rebuildQueued = false; }
    return;
  }
  const originFar = ar.origin && pos && !xr.active ? Math.hypot(...Object.values(latLonToENU(ar.origin, pos.lat, pos.lon))) > 2000 : false;
  if (!rebuildQueued && ar.origin && !originFar) return;
  const origin = xr.active && ar.origin ? ar.origin : pos ? { lat: pos.lat, lon: pos.lon } : state.georef.gridToLatLon(state.model.bbox.cx, state.model.bbox.cy);
  applySettingsToEngines();
  ar.build(state.model, state.georef, origin, state.visible);
  rebuildQueued = false;
}

// --- Main loop -------------------------------------------------------------------------

let lastHud = 0;
let frameCount = 0;
function frame(t, xrFrame) {
  if (!state.started) return;

  const q = orientation.update();
  const gpsPos = gps.position;
  tryAutoAnchor();
  maybeRebuild(gpsPos);

  const w = window.innerWidth, h = window.innerHeight;
  if (!xr.active) {
    if (ar.size.w !== $('#ar').clientWidth || ar.size.h !== $('#ar').clientHeight) ar.resize();
    ar.setFov(camera.active ? camera.verticalFov(w, h) : 60);
  }

  // ARCore mode: the tracked camera pose gives the position and view direction.
  let pos = gpsPos;
  state.viewQuat = null;
  ar.viewPosition = null;
  if (xr.active) {
    xr.update(xrFrame);
    if (!xr.aligned && xr.pose && gpsPos && ar.origin) {
      // First placement from GPS + compass; refine with control points.
      const e = latLonToENU(ar.origin, gpsPos.lat, gpsPos.lon);
      const { heading } = orientation.angles(q);
      xr.initFromSensors(new THREE.Vector3(e.e, ar.settings.eyeHeight, -e.n), heading * DEG);
    }
    const cw = xr.aligned ? xr.cameraWorld() : null;
    if (cw) {
      state.viewQuat = cw.quaternion;
      ar.viewPosition = cw.position;
      const ll = enuToLatLon(ar.origin, cw.position.x, -cw.position.z);
      pos = { ...(gpsPos || {}), lat: ll.lat, lon: ll.lon, accuracy: gpsPos ? gpsPos.accuracy : 0, xr: true };
    }
  }

  let userENU = { e: 0, n: 0 };
  state.nearest = null;
  state.userGrid = null;
  const u = state.georef.units;
  if (pos && ar.origin && state.model && state.georef.ready) {
    userENU = latLonToENU(ar.origin, pos.lat, pos.lon);
    const g = state.georef.latLonToGrid(pos.lat, pos.lon);
    state.userGrid = g;
    // Nearest (or selected) alignment
    let best = null;
    state.model.alignments.forEach((al, idx) => {
      if (!state.visible[idx]) return;
      if (settings.activeAlign !== 'auto' && String(idx) !== settings.activeAlign) return;
      const so = stationOffset(al, g.x, g.y);
      if (so && (!best || so.distance < best.so.distance)) best = { al, idx, so };
    });
    state.nearest = best;
    if (best) {
      const ll = state.georef.gridToLatLon(best.so.x, best.so.y);
      const ne = latLonToENU(ar.origin, ll.lat, ll.lon);
      const y = ar.settings.heightMode === 'flat' || best.so.z === null ? 0 : best.so.z * u;
      ar.setNearest([ne.e, y, -ne.n]);
    } else ar.setNearest(null);

    // Design surface under the user (file units), and the nearest structure.
    state.surfaceZ = null;
    for (const sf of state.model.surfaces) {
      if (!sf.visible) continue;
      const z = surfaceElevation(sf, g.x, g.y);
      if (z !== null) { state.surfaceZ = z; break; }
    }
    state.nearStruct = settings.showPipes ? nearestStructure(state.model.pipeNetworks.filter((n) => n.visible), g.x, g.y) : null;

    // Height model
    let ground = 0;
    const mode = ar.settings.heightMode;
    if ((mode === 'auto' || mode === 'surface') && state.surfaceZ !== null) ground = state.surfaceZ * u;
    else if ((mode === 'relative' || mode === 'auto') && best && best.so.z !== null) ground = best.so.z * u;
    else if (mode === 'absolute') {
      const manual = settings.manualElevation;
      ground = manual !== '' && manual !== null && Number.isFinite(+manual) ? fromDisp(+manual) : (gpsToDrawingElev(pos.alt) ?? 0) - ar.settings.eyeHeight;
    }
    if (state.pendingHeightZero && ar.settings.heightMode !== 'flat') {
      // Occupied point: the ground under the phone is the point's elevation.
      settings.verticalOffset = +toDisp(state.pendingHeightZero.z * u - ground).toFixed(3);
      state.pendingHeightZero = null;
      saveSettings();
      syncSettingInputs();
      updateCalibUI();
      updateAlignStatus();
    }
    const vOff = fromDisp(+settings.verticalOffset || 0);
    if (!xr.active) {
      ar.setGroundElevation(ground + (ar.settings.heightMode === 'flat' ? 0 : vOff));
      if (ar.settings.heightMode === 'flat') ar.root.position.y = -vOff;
    }
  } else {
    ar.setNearest(null);
  }

  // Highlight the selected control point while aligning.
  const ctrl = !$('#calib').classList.contains('hidden') && ar.origin && state.georef.ready ? selectedControl() : null;
  if (ctrl) {
    const ll = state.georef.gridToLatLon(ctrl.x, ctrl.y);
    const te = latLonToENU(ar.origin, ll.lat, ll.lon);
    const ty = ar.settings.heightMode === 'flat' || ctrl.z === null ? 0 : ctrl.z * u;
    ar.setTarget([te.e, ty, -te.n]);
  } else ar.setTarget(null);

  if (!xr.active) ar.setPose(userENU.e, userENU.n, q);
  // A tall panel covers most of the camera view: redraw less often to keep the UI smooth.
  const covered = $('.sheet.tall.open');
  if (xr.active || !covered || (frameCount++ % 4) === 0) ar.render();
  if (xr.active) xr.afterRender(xrFrame);
  updateEdgeArrow();
  updateCompass();

  if (t - lastHud > 200) {
    lastHud = t;
    updateHUD();
    if ($('#sheet-map').classList.contains('open')) updatePlan();
    if ($('#sheet-settings').classList.contains('open')) updateSensorTable();
    $('#shutter').classList.toggle('steady', motion.rotationRate !== null && motion.steady);
    if (!$('#calib').classList.contains('hidden')) showControlInfo();
  }
}
ar.renderer.setAnimationLoop(frame);

function updateHUD() {
  const n = state.nearest;
  const u = state.georef.units;
  const pos = gps.position;
  const { heading, pitch } = viewAngles();
  if (n) {
    $('#hudAlign').textContent = n.al.name;
    $('#hudSta').textContent = staText(n.so.station, u);
    const off = n.so.offset * u;
    $('#hudOff').textContent = `${off >= 0 ? 'R' : 'L'} ${dLen(Math.abs(off))}`;
    const elev = $('#hudElev');
    if (n.so.z !== null) {
      elev.classList.remove('hidden');
      elev.textContent = `Z ${elevText(n.so.z, u)}` + (n.so.beyond ? (n.so.i === 0 ? ' · before start' : ' · past end') : '');
    } else elev.classList.add('hidden');
  } else if (state.nearStruct) {
    // No alignment: lead with the nearest structure.
    const ns = state.nearStruct;
    $('#hudAlign').textContent = ns.net.name;
    $('#hudSta').textContent = ns.struct.name.replace(/\s*\(.*\)$/, '');
    $('#hudOff').textContent = dLen(ns.distance * u, 1);
    $('#hudElev').classList.add('hidden');
  } else {
    $('#hudAlign').textContent = state.model ? (state.georef.ready ? 'Waiting for GPS…' : 'Not georeferenced') : 'No alignment loaded';
    $('#hudSta').textContent = '—';
    $('#hudOff').textContent = '';
    $('#hudElev').classList.add('hidden');
  }
  const ns = state.nearStruct;
  const hs = $('#hudStruct');
  if (ns && n) {
    const inv = [...ns.struct.inverts.values()].filter((v) => v !== null);
    hs.textContent = `${ns.struct.name.replace(/\s*\(.*\)$/, '')} ${dLen(ns.distance * u, 0)}` + (inv.length ? ` · inv ${elevText(Math.min(...inv), u)}` : '');
    hs.classList.remove('hidden');
  } else if (ns) {
    const inv = [...ns.struct.inverts.values()].filter((v) => v !== null);
    hs.textContent = `${ns.struct.desc || 'structure'}${ns.struct.rim !== null ? ` · rim ${elevText(ns.struct.rim, u)}` : ''}${inv.length ? ` · inv ${elevText(Math.min(...inv), u)}` : ''}`;
    hs.classList.remove('hidden');
  } else hs.classList.add('hidden');
  // Design surface elevation under the user shares the Z pill.
  if (state.surfaceZ !== null && state.surfaceZ !== undefined) {
    const el = $('#hudElev');
    const base = el.classList.contains('hidden') ? '' : el.textContent + ' · ';
    el.textContent = `${base}Srf ${elevText(state.surfaceZ, u)}`;
    el.classList.remove('hidden');
  }
  const g = $('#hudGps');
  if (xr.active) {
    g.textContent = xr.tracking === 'tracking' ? `ARCore ✓${xr.pairs.length ? ' · ' + xr.pairs.length + ' ctrl' : ''}` : xr.tracking === 'limited' ? 'ARCore: limited' : 'ARCore: lost';
    g.className = 'pill ' + (xr.tracking === 'tracking' ? 'good' : 'bad');
  } else if (pos) {
    g.textContent = `${gps.locked ? '🔒 ' : ''}GPS ±${dLen(pos.accuracy, 1)}`;
    g.className = 'pill ' + (pos.accuracy <= 5 ? 'good' : pos.accuracy > 15 ? 'bad' : '');
  } else {
    g.textContent = gps.error ? 'GPS: ' + gps.error : 'GPS …';
    g.className = 'pill bad';
  }
  $('#hudHdg').textContent = `Hdg ${heading.toFixed(0)}° · ${pitch >= 0 ? '+' : ''}${pitch.toFixed(0)}°`;
  $('#compass').style.top = $('#hud').getBoundingClientRect().bottom + 6 + 'px';
  const warn = $('#hudWarn');
  let w = '';
  if (!orientation.hasData) w = 'No compass – drag to look';
  else if (orientation.source.includes('relative')) w = 'Relative orientation – calibrate heading';
  else if (orientation.accuracy !== null && orientation.accuracy > 25) w = 'Compass inaccurate – wave phone in figure 8';
  else if (n && n.so.distance * u > 500) w = Units.system === 'us' ? `${(n.so.distance * u / 1609.344).toFixed(2)} mi from alignment` : `${(n.so.distance * u / 1000).toFixed(2)} km from alignment`;
  warn.textContent = w;
  warn.classList.toggle('hidden', !w);
}

// Arrow on the screen edge pointing towards the nearest alignment point when it is off-screen.
function updateEdgeArrow() {
  const el = $('#edgeArrow');
  if (!ar.nearest.visible) return el.classList.add('hidden');
  const viewCam = xr.active ? ar.renderer.xr.getCamera().cameras[0] || ar.camera : ar.camera;
  const v = ar.nearest.getWorldPosition(new THREE.Vector3()).project(viewCam);
  const behind = v.z > 1;
  let x = v.x, y = v.y;
  if (behind) { x = -x; y = -y; }
  const inside = !behind && Math.abs(x) < 0.95 && Math.abs(y) < 0.95;
  if (inside) return el.classList.add('hidden');
  const ang = Math.atan2(-y, x);
  const m = Math.max(Math.abs(x), Math.abs(y)) || 1;
  const px = ((x / m) * 0.85 + 1) / 2 * window.innerWidth;
  const py = ((-y / m) * 0.8 + 1) / 2 * window.innerHeight;
  el.style.left = px + 'px';
  el.style.top = py + 'px';
  el.style.transform = `rotate(${ang}rad)`;
  el.classList.remove('hidden');
}

// Compass tape
const tape = $('#compassTape');
(() => {
  const labels = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
  let html = '';
  for (let d = -360; d <= 720; d += 5) {
    const n = ((d % 360) + 360) % 360;
    const card = labels[n];
    const cls = card ? 'card' : n % 30 === 0 ? '' : 'minor';
    html += `<span class="${cls}" style="left:${(d + 360) * 3}px">${card || (n % 30 === 0 ? n : '')}</span>`;
  }
  tape.innerHTML = html;
})();
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function updateCompass() {
  const { heading } = viewAngles();
  const w = tape.parentElement.clientWidth;
  tape.style.transform = `translateX(${w / 2 - (heading + 360) * 3}px)`;
  $('#compassDeg').textContent = `${Math.round(heading) % 360}°`;
  $('#compassCardinal').textContent = CARDINALS[Math.round(heading / 45) % 8];
}

function updatePlan() {
  const pos = gps.position;
  if (pos && state.georef.ready && state.userGrid) {
    const { heading } = viewAngles();
    const conv = state.georef.gridConvergence(pos.lat, pos.lon);
    plan.user = { x: state.userGrid.x, y: state.userGrid.y, bearing: heading * DEG + conv, accuracy: pos.accuracy / state.georef.units, fov: ar.camera.fov * ar.camera.aspect };
  } else plan.user = null;
  plan.nearest = state.nearest ? state.nearest.so : null;
  plan.visible = state.visible;
  plan.draw();
}
// Draw the plan even before the AR camera starts.
setInterval(() => {
  if (!state.started && $('#sheet-map').classList.contains('open')) updatePlan();
}, 300);

function updateSensorTable() {
  const pos = gps.position, raw = gps.raw;
  const { heading, pitch, roll } = viewAngles();
  const a = motion.gravity, r = motion.rotationRate;
  const cs = camera.track && camera.track.getSettings ? camera.track.getSettings() : {};
  const rows = [
    ['Orientation source', orientation.source],
    ['Heading / pitch / roll', `${heading.toFixed(1)}° / ${pitch.toFixed(1)}° / ${roll.toFixed(1)}°`],
    ['Compass accuracy', orientation.accuracy !== null ? `±${orientation.accuracy}°` : 'n/a'],
    ['Heading correction', `${(+settings.headingOffset || 0).toFixed(2)}°`],
    ['GPS (smoothed)', pos ? `${pos.lat.toFixed(7)}, ${pos.lon.toFixed(7)}` : gps.error || 'waiting'],
    ['GPS accuracy', pos ? `±${dLen(pos.accuracy, 1)} (raw ±${dLen(raw && raw.accuracy, 1)})` : '—'],
    ['GPS altitude (ellipsoid)', pos ? `${dLen(pos.alt, 1)} ±${dLen(pos.altAccuracy, 1)}` : '—'],
    ['GPS elevation, sea level', pos ? dLen(gpsToSeaLevel(pos.alt), 2) : '—'],
    ['GPS elevation, drawing datum', pos ? `${dLen(gpsToDrawingElev(pos.alt), 2)} (adj ${(+settings.datumAdjust).toFixed(2)} ${Units.label})` : '—'],
    ['Speed / course', raw ? `${fmt(raw.speed, 1)} m/s / ${fmt(raw.heading, 0)}°` : '—'],
    ['Grid position', state.userGrid ? `N ${state.userGrid.y.toFixed(3)} E ${state.userGrid.x.toFixed(3)}` : '—'],
    ['Accelerometer (g incl.)', a ? `${fmt(a.x, 2)}, ${fmt(a.y, 2)}, ${fmt(a.z, 2)} m/s²` : 'n/a'],
    ['Gyroscope', r ? `${fmt(r.alpha, 1)}, ${fmt(r.beta, 1)}, ${fmt(r.gamma, 1)} °/s` : 'n/a'],
    ['Screen', `${screen.orientation ? screen.orientation.type : ''} ${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`],
    ['Camera', camera.active ? `${camera.video.videoWidth}×${camera.video.videoHeight}${cs.frameRate ? ' @' + Math.round(cs.frameRate) + 'fps' : ''} · zoom ${camera.zoom} · torch ${camera.hasTorch ? 'yes' : 'no'}` : 'off'],
    ['Vertical FOV', `${ar.camera.fov.toFixed(1)}°`],
    ['Ground elevation used', `${dLen(ar.groundElevation)} (${ar.settings.heightMode})`],
    ['Georeference', state.georef.ready ? state.georef.label : 'none'],
  ];
  $('#sensorTable').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${String(v).replace(/</g, '&lt;')}</td></tr>`).join('');
}

window.addEventListener('resize', () => ar.resize());
if (screen.orientation) screen.orientation.addEventListener('change', () => setTimeout(() => ar.resize(), 200));

// --- Boot --------------------------------------------------------------------------------

(async function boot() {
  renderAlignList();
  renderCrsSelect();
  updatePhotoCount();
  try {
    const saved = await FileStore.all();
    for (const f of saved) {
      try { await loadText(f.name, f.text, { persist: false, quiet: true }); } catch (e) { console.warn(e); }
    }
    if (saved.length) $('#startStatus').textContent = `Restored ${saved.map((f) => f.name).join(', ')}`;
  } catch { /* IndexedDB unavailable */ }
  // Restore a pinned anchor (autoGeoref resets nothing for anchor mode).
  renderGeorefStatus();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Expose for debugging in the console.
  window.cstp = { state, settings, gps, orientation, camera, ar, plan };
})();
