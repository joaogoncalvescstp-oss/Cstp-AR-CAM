// three.js AR scene: renders alignments, offsets, station markers and points
// in a local ENU frame (x = east, y = up, z = -north) around a scene origin.

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { latLonToENU } from './geo.js';
import { offsetPolyline } from './landxml.js';
import { staText, elevText } from './units.js';

export const PALETTE = ['#ffd400', '#00e5ff', '#ff4fd8', '#7CFF4F', '#ff8a00', '#b18cff', '#ff4f4f', '#4fa3ff'];

function makeLabel(text, { color = '#ffffff', bg = 'rgba(0,0,0,0.65)', size = 0.045, sub = '' } = {}) {
  const pad = 14, fs = 44, fs2 = 30;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  let w = ctx.measureText(text).width;
  if (sub) {
    ctx.font = `500 ${fs2}px system-ui, sans-serif`;
    w = Math.max(w, ctx.measureText(sub).width);
  }
  c.width = Math.ceil(w + pad * 2);
  c.height = sub ? fs + fs2 + pad * 2.4 : fs + pad * 2;
  ctx.fillStyle = bg;
  const r = 14;
  ctx.beginPath();
  ctx.roundRect(0, 0, c.width, c.height, r);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText(text, pad, pad);
  if (sub) {
    ctx.fillStyle = '#ddd';
    ctx.font = `500 ${fs2}px system-ui, sans-serif`;
    ctx.fillText(sub, pad, pad + fs + 6);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, transparent: true });
  const sp = new THREE.Sprite(mat);
  sp.center.set(0.5, 0);
  const aspect = c.width / c.height;
  sp.userData.baseSize = size;
  sp.scale.set(size * aspect, size, 1);
  sp.renderOrder = 10;
  return sp;
}

export class ARScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 8000);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1));

    this.root = new THREE.Group(); // shifted vertically by the height model
    this.scene.add(this.root);
    this.labels = [];
    this.lineMaterials = [];

    // Nearest-point indicator
    const ringGeo = new THREE.RingGeometry(0.35, 0.5, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.nearest = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false }));
    this.nearest.renderOrder = 5;
    this.nearest.visible = false;
    this.scene.add(this.nearest);

    this.origin = null;
    this.settings = {
      lineWidth: 6,
      tickInterval: 20,
      labelInterval: 100,
      labelRange: 400,
      offsets: [],
      showPoints: true,
      heightMode: 'relative', // 'flat' | 'relative' | 'absolute'
      eyeHeight: 1.6,
    };
    this.groundElevation = 0; // design elevation (m) of the ground beneath the user
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const m of this.lineMaterials) m.resolution.set(w * this.renderer.getPixelRatio(), h * this.renderer.getPixelRatio());
    this.size = { w, h };
  }

  setFov(v) {
    if (Math.abs(this.camera.fov - v) > 0.01) {
      this.camera.fov = v;
      this.camera.updateProjectionMatrix();
    }
  }

  clear() {
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
    this.root.clear();
    this.labels = [];
    this.lineMaterials = [];
  }

  _lineMaterial(color, width, opts = {}) {
    const m = new LineMaterial({ color: new THREE.Color(color), linewidth: width, transparent: true, opacity: opts.opacity ?? 1, dashed: !!opts.dashed, dashSize: 2, gapSize: 1.5, depthTest: false });
    m.resolution.set(this.size.w * this.renderer.getPixelRatio(), this.size.h * this.renderer.getPixelRatio());
    this.lineMaterials.push(m);
    return m;
  }

  _enu(georef, x, y) {
    const ll = georef.gridToLatLon(x, y);
    const p = latLonToENU(this.origin, ll.lat, ll.lon);
    return p;
  }

  // Build the scene for the given model around origin {lat, lon}.
  build(model, georef, origin, visible) {
    this.clear();
    this.origin = { ...origin };
    if (!model || !georef.ready) return;
    const u = georef.units;
    const flat = this.settings.heightMode === 'flat';
    const yOf = (z) => (flat || z === null || z === undefined ? 0 : z * u);

    model.alignments.forEach((al, idx) => {
      if (visible && visible[idx] === false) return;
      const color = al.color || PALETTE[idx % PALETTE.length];
      const noZ = !al.hasElevation;
      const toLocal = (p) => {
        const e = this._enu(georef, p.x, p.y);
        return [e.e, noZ ? null : yOf(p.z), -e.n];
      };
      const enu = al.pts.map(toLocal);
      al._enu = enu; // cached for nearest-point/height queries
      al._flat = flat || noZ;
      const fix = (arr) => arr.map(([x, y, z]) => [x, y === null ? 0 : y, z]);

      // Centreline
      const center = fix(enu);
      this._addLine(center, color, this.settings.lineWidth, al);

      // Offset lines
      for (const off of this.settings.offsets) {
        if (!off) continue;
        const pts = offsetPolyline(al, off / u).map(toLocal);
        this._addLine(fix(pts), color, Math.max(2, this.settings.lineWidth * 0.5), al, { dashed: true, opacity: 0.85 });
      }

      // Station ticks + labels
      const ticks = [];
      const tickEvery = this.settings.tickInterval / u;
      const labelEvery = this.settings.labelInterval / u;
      const s0 = al.sta[0], s1 = al.sta[al.sta.length - 1];
      const first = Math.ceil(s0 / tickEvery - 1e-9) * tickEvery;
      let j = 0;
      const stations = [];
      for (let k = 0; first + k * tickEvery <= s1 + 1e-6 && k < 100000; k++) stations.push(first + k * tickEvery);
      if (!stations.length || Math.abs(stations[0] - s0) > 1e-6) stations.unshift(s0);
      if (Math.abs(stations[stations.length - 1] - s1) > 1e-6) stations.push(s1);
      for (const s of stations) {
        while (j < al.sta.length - 2 && al.sta[j + 1] < s) j++;
        const L = al.sta[j + 1] - al.sta[j] || 1;
        const t = Math.min(1, Math.max(0, (s - al.sta[j]) / L));
        const a = center[j], b = center[j + 1];
        const p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
        const isMajor = Math.abs(s / labelEvery - Math.round(s / labelEvery)) < 1e-6 || s === s0 || s === s1;
        const h = isMajor ? 2.0 : 0.8;
        ticks.push(p[0], p[1], p[2], p[0], p[1] + h, p[2]);
        if (isMajor) {
          const zp = al.pts[j].z !== null && al.pts[j + 1].z !== null ? al.pts[j].z + t * (al.pts[j + 1].z - al.pts[j].z) : null;
          const sub = zp !== null ? `Z ${elevText(zp, u)}` : '';
          const lab = makeLabel(staText(s, u, 0), { color, sub, size: 0.05 });
          lab.position.set(p[0], p[1] + h, p[2]);
          lab.userData.kind = 'station';
          this.root.add(lab);
          this.labels.push(lab);
        }
      }
      if (ticks.length) {
        const g = new LineSegmentsGeometry();
        g.setPositions(ticks);
        const segs = new LineSegments2(g, this._lineMaterial(color, 3, { opacity: 0.9 }));
        this.root.add(segs);
      }

      // Start / end name label
      const nameLab = makeLabel(al.name, { color, size: 0.04, sub: 'START' });
      nameLab.position.set(center[0][0], center[0][1] + 3, center[0][2]);
      this.root.add(nameLab);
      this.labels.push(nameLab);
    });

    // Points
    if (this.settings.showPoints && model.points.length) {
      const segs = [];
      for (const p of model.points.slice(0, 2000)) {
        const e = this._enu(georef, p.x, p.y);
        const y = yOf(p.z);
        segs.push(e.e, y, -e.n, e.e, y + 1.5, -e.n);
        const lab = makeLabel(p.name || p.code || '•', { color: '#ffffff', size: 0.035, sub: p.code && p.name ? p.code : '' });
        lab.position.set(e.e, y + 1.5, -e.n);
        lab.userData.kind = 'point';
        this.root.add(lab);
        this.labels.push(lab);
      }
      const g = new LineSegmentsGeometry();
      g.setPositions(segs);
      this.root.add(new LineSegments2(g, this._lineMaterial('#ffffff', 3)));
    }
  }

  _addLine(points, color, width, al, opts) {
    if (points.length < 2) return;
    const g = new LineGeometry();
    g.setPositions(points.flat());
    const line = new Line2(g, this._lineMaterial(color, width, opts));
    line.computeLineDistances();
    line.userData.alignment = al.name;
    this.root.add(line);
    return line;
  }

  // Camera position (metres, ENU relative to origin) and orientation.
  setPose(e, n, quaternion) {
    this.camera.position.set(e, this.settings.eyeHeight, -n);
    this.camera.quaternion.copy(quaternion);
  }

  // Ground elevation under the user (design units already converted to metres).
  setGroundElevation(z) {
    this.groundElevation = z || 0;
    this.root.position.y = this.settings.heightMode === 'flat' ? 0 : -this.groundElevation;
  }

  setNearest(p) {
    if (!p) {
      this.nearest.visible = false;
      return;
    }
    this.nearest.visible = true;
    this.nearest.position.set(p[0], p[1] + this.root.position.y + 0.02, p[2]);
  }

  render() {
    const cam = this.camera.position;
    const range2 = this.settings.labelRange * this.settings.labelRange;
    const rootY = this.root.position.y;
    for (const l of this.labels) {
      const dx = l.position.x - cam.x, dz = l.position.z - cam.z;
      const d2 = dx * dx + dz * dz;
      l.visible = d2 < range2;
      if (l.visible) {
        // Shrink distant labels a little, keep close ones readable.
        const d = Math.sqrt(d2 + (l.position.y + rootY - cam.y) ** 2);
        const k = Math.max(0.55, Math.min(1.2, 30 / (d + 10) + 0.5));
        const base = l.userData.baseSize;
        const aspect = l.material.map.image.width / l.material.map.image.height;
        l.scale.set(base * k * aspect, base * k, 1);
      }
    }
    const t = performance.now() / 1000;
    this.nearest.scale.setScalar(1 + 0.15 * Math.sin(t * 4));
    this.renderer.render(this.scene, this.camera);
  }
}
