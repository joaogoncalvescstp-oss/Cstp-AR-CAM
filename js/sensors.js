// Phone sensors: orientation (compass/gyro/accelerometer fusion), GPS,
// motion, screen orientation and wake lock.
//
// Orientation is exposed as a THREE.Quaternion for a camera in a world frame
// where +X = east, +Y = up, -Z = north (true or magnetic, depending on the
// device; a user heading correction is applied on top).

import * as THREE from 'three';

const DEG = Math.PI / 180;
const Q_WORLD = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

export class OrientationSource extends EventTarget {
  constructor() {
    super();
    this.raw = new THREE.Quaternion();
    this.quaternion = new THREE.Quaternion();
    this.headingOffset = 0; // degrees, added to the heading
    this.smoothing = 0.25; // 0 = frozen, 1 = no smoothing
    this.source = 'none';
    this.hasData = false;
    this.accuracy = null; // iOS compass accuracy (degrees)
    this._iosOffset = null;
    this._euler = new THREE.Euler();
    this._tmp = new THREE.Quaternion();
    this._screen = new THREE.Quaternion();
    this.manual = { yaw: 0, pitch: 0 }; // desktop fallback (drag to look)
  }

  // Must be called from a user gesture (iOS permission prompt).
  async start() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') throw new Error('Motion & orientation permission denied');
      } catch (e) {
        this.error = e.message;
      }
    }
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      try { await DeviceMotionEvent.requestPermission(); } catch { /* ignore */ }
    }

    if (await this._tryGenericSensor()) return this.source;

    const onAbs = (e) => this._onDeviceOrientation(e, true);
    const onRel = (e) => this._onDeviceOrientation(e, false);
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', onAbs);
      this.source = 'deviceorientationabsolute';
    } else {
      window.addEventListener('deviceorientation', onRel);
      this.source = 'deviceorientation';
    }
    return this.source;
  }

  async _tryGenericSensor() {
    if (!('AbsoluteOrientationSensor' in window)) return false;
    try {
      if (navigator.permissions) {
        const names = ['accelerometer', 'gyroscope', 'magnetometer'];
        const results = await Promise.all(names.map((name) => navigator.permissions.query({ name }).catch(() => null)));
        if (results.some((r) => r && r.state === 'denied')) return false;
      }
      const sensor = new window.AbsoluteOrientationSensor({ frequency: 60, referenceFrame: 'device' });
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 1500);
        sensor.addEventListener('reading', () => { clearTimeout(t); resolve(); }, { once: true });
        sensor.addEventListener('error', (e) => { clearTimeout(t); reject(e.error || e); }, { once: true });
        sensor.start();
      });
      sensor.addEventListener('reading', () => {
        const q = sensor.quaternion; // [x, y, z, w], device -> earth (ENU)
        this._tmp.set(q[0], q[1], q[2], q[3]);
        this._setDevice(this._tmp);
      });
      sensor.addEventListener('error', (e) => console.warn('Orientation sensor error', e.error));
      this.sensor = sensor;
      this.source = 'AbsoluteOrientationSensor';
      return true;
    } catch (e) {
      console.info('AbsoluteOrientationSensor unavailable:', e && e.message);
      return false;
    }
  }

  _onDeviceOrientation(e, absolute) {
    if (e.alpha === null || e.beta === null) return;
    let alpha = e.alpha;
    if (!absolute && typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      // iOS: alpha is relative to an arbitrary start; align it with the compass.
      this.accuracy = e.webkitCompassAccuracy;
      const target = 360 - e.webkitCompassHeading;
      const off = ((target - e.alpha + 540) % 360) - 180;
      if (this._iosOffset === null) this._iosOffset = off;
      else {
        const d = ((off - this._iosOffset + 540) % 360) - 180;
        // Compass heading is unreliable when the phone is near flat/upside-down.
        if (Math.abs(e.beta) > 20 && Math.abs(e.beta) < 160) this._iosOffset += d * 0.05;
      }
      alpha = e.alpha + this._iosOffset;
      this.source = 'deviceorientation+compass';
    } else if (!absolute && !e.absolute) {
      this.source = 'deviceorientation (relative: no compass)';
    }
    // W3C device orientation: R = Rz(alpha) * Rx(beta) * Ry(gamma), device -> earth ENU
    this._euler.set(e.beta * DEG, e.gamma * DEG, alpha * DEG, 'ZXY');
    this._tmp.setFromEuler(this._euler);
    this._setDevice(this._tmp);
  }

  // qDevice: rotation of device frame into the earth ENU frame.
  _setDevice(qDevice) {
    this._screen.setFromAxisAngle(Z_AXIS, -screenAngle() * DEG);
    const target = Q_WORLD.clone().multiply(qDevice).multiply(this._screen);
    if (!this.hasData) {
      this.raw.copy(target);
      this.hasData = true;
    } else {
      // Take the short way round.
      if (this.raw.dot(target) < 0) target.set(-target.x, -target.y, -target.z, -target.w);
      this.raw.slerp(target, this.smoothing);
    }
    this.dispatchEvent(new Event('change'));
  }

  // Final camera quaternion including heading correction.
  update() {
    if (!this.hasData) {
      // Desktop / no sensor: mouse-look.
      this._euler.set(this.manual.pitch * DEG, -this.manual.yaw * DEG, 0, 'YXZ');
      this.raw.setFromEuler(this._euler);
    }
    this._tmp.setFromAxisAngle(Y_AXIS, -this.headingOffset * DEG);
    this.quaternion.copy(this._tmp).multiply(this.raw);
    return this.quaternion;
  }

  // Heading (deg cw from north), pitch (deg, + = up), roll of the camera.
  angles(q = this.quaternion) {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const heading = (Math.atan2(f.x, -f.z) / DEG + 360) % 360;
    const pitch = Math.asin(Math.max(-1, Math.min(1, f.y))) / DEG;
    // Roll: angle between camera up and the vertical plane through the view direction.
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const roll = Math.atan2(right.y, up.y) / DEG;
    return { heading, pitch, roll };
  }
}

// --- GPS -----------------------------------------------------------------

export class GPSSource extends EventTarget {
  constructor() {
    super();
    this._pos = null; // smoothed {lat, lon, alt, accuracy, altAccuracy, speed, heading, time}
    this.raw = null;
    // Control-point correction added to every fix: {dLat, dLon} (degrees) and dAlt (m).
    this.shift = null;
    this.locked = false;
    this.error = null;
    this.watchId = null;
  }

  start() {
    if (!('geolocation' in navigator)) {
      this.error = 'Geolocation not supported';
      return false;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this._onPosition(p),
      (e) => {
        this.error = e.message || 'GPS error';
        this.dispatchEvent(new Event('error'));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
    return true;
  }

  // Corrected position (smoothed fix + control-point shift).
  get position() {
    const p = this._pos;
    if (!p || !this.shift) return p;
    return { ...p, lat: p.lat + this.shift.dLat, lon: p.lon + this.shift.dLon, alt: p.alt === null ? null : p.alt + (this.shift.dAlt || 0), shifted: true };
  }

  // Position without the control-point shift.
  get uncorrected() {
    return this._pos;
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  _onPosition(p) {
    const c = p.coords;
    const fix = {
      lat: c.latitude,
      lon: c.longitude,
      alt: c.altitude,
      accuracy: c.accuracy,
      altAccuracy: c.altitudeAccuracy,
      speed: c.speed,
      heading: c.heading,
      time: p.timestamp,
    };
    this.raw = fix;
    this.error = null;
    if (this.locked) return;
    if (!this._pos || fix.speed > 1.5 || fix.time - this._pos.time > 20000) {
      this._pos = { ...fix };
    } else {
      // Accuracy-weighted exponential filter: better fixes pull harder.
      const prev = this._pos;
      const w = Math.min(1, Math.max(0.1, (prev.accuracy * prev.accuracy) / (prev.accuracy * prev.accuracy + fix.accuracy * fix.accuracy)));
      const lerp = (a, b) => (a === null || b === null ? b ?? a : a + (b - a) * w);
      this._pos = {
        ...fix,
        lat: lerp(prev.lat, fix.lat),
        lon: lerp(prev.lon, fix.lon),
        alt: lerp(prev.alt, fix.alt),
        accuracy: Math.min(fix.accuracy, prev.accuracy * (1 - w) + fix.accuracy * w + 0.5),
      };
    }
    this.dispatchEvent(new Event('change'));
  }

  // Manually override (e.g. simulate on desktop or tap map).
  setManual(lat, lon, alt = null) {
    this._pos = { lat, lon, alt, accuracy: 0.5, altAccuracy: null, speed: 0, heading: null, time: Date.now(), manual: true };
    this.dispatchEvent(new Event('change'));
  }
}

// --- Motion (accelerometer + gyroscope) ----------------------------------

export class MotionSource {
  constructor() {
    this.accel = null;
    this.gravity = null;
    this.rotationRate = null;
    this.shake = 0; // smoothed angular speed (deg/s), used for "steady shot" hint
  }

  start() {
    window.addEventListener('devicemotion', (e) => {
      this.accel = e.acceleration;
      this.gravity = e.accelerationIncludingGravity;
      this.rotationRate = e.rotationRate;
      const r = e.rotationRate;
      if (r) {
        const mag = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0);
        this.shake = this.shake * 0.9 + mag * 0.1;
      }
    });
  }

  get steady() {
    return this.shake < 8;
  }
}

// --- Misc device helpers -------------------------------------------------

export class WakeLock {
  async request() {
    try {
      if ('wakeLock' in navigator) {
        this.lock = await navigator.wakeLock.request('screen');
        document.addEventListener('visibilitychange', async () => {
          if (document.visibilityState === 'visible' && (!this.lock || this.lock.released)) {
            try { this.lock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
          }
        });
      }
    } catch { /* not allowed */ }
  }
}

export function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}
