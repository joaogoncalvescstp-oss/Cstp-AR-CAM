// Display units. Internally the AR engine works in metres; alignment data stays
// in file units (converted with georef.units = metres per file unit).
// 'us'     : US survey feet, stationing 12+34.56 (100 ft stations)
// 'metric' : metres, stationing 1+234.56 (1 km stations)

import { formatStation } from './landxml.js';

export const USFT = 1200 / 3937; // metres per US survey foot

export const Units = {
  system: 'us',
  get len() {
    return this.system === 'us' ? USFT : 1;
  },
  get label() {
    return this.system === 'us' ? 'ft' : 'm';
  },
};

// Metres -> display number.
export const toDisp = (m) => m / Units.len;
// Display number -> metres.
export const fromDisp = (v) => v * Units.len;

// Metres -> "12.34 ft".
export function dLen(m, d = 2) {
  if (m === null || m === undefined || Number.isNaN(m)) return '—';
  return `${toDisp(m).toFixed(d)} ${Units.label}`;
}

// Station in file units (fileScale = metres per file unit) -> display stationing.
export function staText(sta, fileScale = 1, d = 2) {
  const v = toDisp(sta * fileScale);
  return formatStation(v, d, Units.system === 'us' ? 100 : 1000);
}

// Elevation in file units -> display number string.
export function elevText(z, fileScale = 1, d = 2) {
  return z === null || z === undefined ? '—' : toDisp(z * fileScale).toFixed(d);
}
