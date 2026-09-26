// Photo capture: composes camera frame + AR overlay + info stamp, writes EXIF
// (GPS position, direction, time, description) and stores photos in IndexedDB.

const piexif = globalThis.piexif;
const DB_NAME = 'cstp-ar-cam';
const STORE = 'photos';
const FILES = 'files';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'name' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn, storeName = STORE) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const req = fn(store);
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}

export const PhotoStore = {
  add: (rec) => tx('readwrite', (s) => s.add(rec)),
  put: (rec) => tx('readwrite', (s) => s.put(rec)),
  all: () => tx('readonly', (s) => s.getAll()),
  get: (id) => tx('readonly', (s) => s.get(id)),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
  clear: () => tx('readwrite', (s) => s.clear()),
};

// Loaded LandXML files, kept so the app restores them on the next visit.
export const FileStore = {
  put: (name, text) => tx('readwrite', (s) => s.put({ name, text, time: Date.now() }), FILES),
  all: () => tx('readonly', (s) => s.getAll(), FILES),
  clear: () => tx('readwrite', (s) => s.clear(), FILES),
};

// --- EXIF ------------------------------------------------------------------

function rational(v, den = 1000000) {
  return [Math.round(Math.abs(v) * den), den];
}

function dms(deg) {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const mFloat = (a - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return [[d, 1], [m, 1], [Math.round(s * 10000), 10000]];
}

function exifDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Strip characters EXIF ASCII fields cannot hold.
const ascii = (s) => String(s).normalize('NFD').replace(/[^\x20-\x7e]/g, '');

function addExif(dataURL, meta) {
  if (!piexif) return dataURL;
  const d = new Date(meta.time);
  const zeroth = {
    [piexif.ImageIFD.Make]: 'CSTP AR CAM',
    [piexif.ImageIFD.Software]: 'CSTP AR CAM web',
    [piexif.ImageIFD.ImageDescription]: ascii(meta.description || ''),
    [piexif.ImageIFD.DateTime]: exifDate(d),
  };
  const exif = {
    [piexif.ExifIFD.DateTimeOriginal]: exifDate(d),
    [piexif.ExifIFD.UserComment]: 'ASCII\0\0\0' + ascii(JSON.stringify(meta.info || {})),
  };
  const gps = {};
  if (meta.lat !== undefined && meta.lat !== null) {
    gps[piexif.GPSIFD.GPSVersionID] = [2, 3, 0, 0];
    gps[piexif.GPSIFD.GPSLatitudeRef] = meta.lat >= 0 ? 'N' : 'S';
    gps[piexif.GPSIFD.GPSLatitude] = dms(meta.lat);
    gps[piexif.GPSIFD.GPSLongitudeRef] = meta.lon >= 0 ? 'E' : 'W';
    gps[piexif.GPSIFD.GPSLongitude] = dms(meta.lon);
    if (meta.alt !== null && meta.alt !== undefined) {
      gps[piexif.GPSIFD.GPSAltitudeRef] = meta.alt >= 0 ? 0 : 1;
      gps[piexif.GPSIFD.GPSAltitude] = rational(meta.alt, 100);
    }
    if (meta.accuracy) gps[piexif.GPSIFD.GPSHPositioningError] = rational(meta.accuracy, 100);
    gps[piexif.GPSIFD.GPSMapDatum] = 'WGS-84';
    const ud = new Date(meta.time);
    gps[piexif.GPSIFD.GPSDateStamp] = `${ud.getUTCFullYear()}:${String(ud.getUTCMonth() + 1).padStart(2, '0')}:${String(ud.getUTCDate()).padStart(2, '0')}`;
    gps[piexif.GPSIFD.GPSTimeStamp] = [[ud.getUTCHours(), 1], [ud.getUTCMinutes(), 1], [ud.getUTCSeconds(), 1]];
  }
  if (meta.heading !== null && meta.heading !== undefined) {
    gps[piexif.GPSIFD.GPSImgDirectionRef] = 'T';
    gps[piexif.GPSIFD.GPSImgDirection] = rational(meta.heading, 100);
  }
  try {
    const bytes = piexif.dump({ '0th': zeroth, Exif: exif, GPS: gps });
    return piexif.insert(bytes, dataURL);
  } catch (e) {
    console.warn('EXIF write failed', e);
    return dataURL;
  }
}

function dataURLToBlob(url) {
  const [head, b64] = url.split(',');
  const mime = head.match(/:(.*?);/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// --- Composition -----------------------------------------------------------

function drawStamp(ctx, W, H, lines) {
  let scale = Math.max(1, Math.min(W, H) / 900);
  // Shrink to fit the image width.
  ctx.font = `600 ${22 * scale}px system-ui, sans-serif`;
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
  scale *= Math.min(1, (W - 60 * scale) / widest);
  const fs = Math.round(22 * scale);
  const lh = Math.round(fs * 1.3);
  const pad = Math.round(14 * scale);
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
  const h = lines.length * lh + pad * 2 - (lh - fs);
  const x = pad, y = H - h - pad;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 10 * scale);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, x + pad, y + pad + i * lh));
}

// Compose visible camera region + AR canvas + stamp. Returns {blob, thumb, width, height}.
export async function composePhoto({ camera, arCanvas, viewW, viewH, overlay = true, stamp = [], meta, quality = 0.92 }) {
  let W, H, src;
  if (camera && camera.active) {
    src = camera.visibleRect(viewW, viewH);
    // Never go below the overlay's resolution so lines and labels stay crisp.
    const k = Math.max(1, arCanvas.width / src.sw);
    W = Math.round(src.sw * k);
    H = Math.round(src.sh * k);
  } else {
    W = arCanvas.width;
    H = arCanvas.height;
  }
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  if (src) ctx.drawImage(camera.video, src.sx, src.sy, src.sw, src.sh, 0, 0, W, H);
  else {
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, W, H);
  }
  if (overlay) ctx.drawImage(arCanvas, 0, 0, W, H);
  if (stamp.length) drawStamp(ctx, W, H, stamp);

  let url = c.toDataURL('image/jpeg', quality);
  url = addExif(url, meta);
  const blob = dataURLToBlob(url);

  const t = document.createElement('canvas');
  const ts = 240 / Math.max(W, H);
  t.width = Math.round(W * ts);
  t.height = Math.round(H * ts);
  t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
  const thumb = t.toDataURL('image/jpeg', 0.7);
  return { blob, thumb, width: W, height: H };
}

export function photoFileName(rec) {
  const d = new Date(rec.meta.time);
  const p = (n) => String(n).padStart(2, '0');
  const sta = rec.meta.info && rec.meta.info.station ? '_' + rec.meta.info.station.replace(/[^0-9+.-]/g, '') : '';
  return `CSTP_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sta}.jpg`;
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export async function sharePhoto(rec) {
  const file = new File([rec.blob], photoFileName(rec), { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: 'CSTP AR photo', text: rec.meta.description || '' });
    return true;
  }
  downloadBlob(rec.blob, file.name);
  return false;
}

export function photosToCSV(recs) {
  const cols = ['file', 'time', 'lat', 'lon', 'alt', 'accuracy_m', 'heading_deg', 'pitch_deg', 'alignment', 'station', 'offset', 'units', 'grid_n', 'grid_e', 'crs', 'note'];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = recs.map((r) => {
    const m = r.meta, i = m.info || {};
    return [photoFileName(r), new Date(m.time).toISOString(), m.lat, m.lon, m.alt, m.accuracy, m.heading, i.pitch, i.alignment, i.station, i.offset, i.units || 'm', i.gridY, i.gridX, i.crs, r.note || ''].map(esc).join(',');
  });
  return [cols.join(','), ...rows].join('\n');
}
