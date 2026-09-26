// 2D plan view (grid coordinates) with the user's position and view cone.
// Drag to pan, wheel/pinch to zoom, double-tap to recentre.

import { PALETTE } from './ar.js';
import { staText } from './units.js';

export class PlanView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.model = null;
    this.visible = null;
    this.user = null; // {x, y, bearing (grid, rad), accuracy (file units)}
    this.nearest = null;
    this.follow = true;
    this.units = 1; // metres per file unit (for station labels)
    this.view = { cx: 0, cy: 0, scale: 1 }; // pixels per unit
    this._pointers = new Map();
    this._bind();
  }

  setModel(model, visible) {
    this.model = model;
    this.visible = visible;
    this.fit();
  }

  fit() {
    if (!this.model) return;
    const b = this.model.bbox;
    const { w, h } = this._size();
    this.view.cx = b.cx;
    this.view.cy = b.cy;
    const sx = (w * 0.85) / Math.max(1e-6, b.maxX - b.minX);
    const sy = (h * 0.85) / Math.max(1e-6, b.maxY - b.minY);
    this.view.scale = Math.min(sx, sy, 50);
    this.follow = false;
  }

  _size() {
    const r = this.canvas.getBoundingClientRect();
    return { w: r.width || 300, h: r.height || 300 };
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.follow = false;
    });
    c.addEventListener('pointermove', (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      const prev = this._pointers.get(e.pointerId);
      if (this._pointers.size === 1) {
        this.view.cx -= (e.clientX - prev.x) / this.view.scale;
        this.view.cy += (e.clientY - prev.y) / this.view.scale;
      } else if (this._pointers.size === 2) {
        const [a, b] = [...this._pointers.values()];
        const other = a === prev ? b : a;
        const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
        const d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (d0 > 0) this.view.scale *= d1 / d0;
      }
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    const end = (e) => this._pointers.delete(e.pointerId);
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.view.scale *= Math.exp(-e.deltaY * 0.0015);
    }, { passive: false });
    c.addEventListener('dblclick', () => { this.follow = true; });
  }

  draw() {
    const { w, h } = this._size();
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#10151c';
    ctx.fillRect(0, 0, w, h);
    if (this.follow && this.user) {
      this.view.cx = this.user.x;
      this.view.cy = this.user.y;
    }
    const { cx, cy, scale } = this.view;
    const X = (x) => w / 2 + (x - cx) * scale;
    const Y = (y) => h / 2 - (y - cy) * scale;

    this._grid(ctx, w, h, X, Y);
    if (!this.model) return;

    this.model.alignments.forEach((al, i) => {
      if (this.visible && this.visible[i] === false) return;
      const col = al.color || PALETTE[i % PALETTE.length];
      ctx.strokeStyle = col;
      ctx.lineWidth = 3;
      ctx.beginPath();
      al.pts.forEach((p, k) => (k ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
      ctx.stroke();
      // Station labels at a density suited to the zoom level
      const px = 90 / scale;
      const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000].find((v) => v >= px) || 10000;
      ctx.fillStyle = col;
      ctx.font = '11px system-ui, sans-serif';
      let j = 0;
      for (let s = Math.ceil(al.sta[0] / nice) * nice; s <= al.sta[al.sta.length - 1]; s += nice) {
        while (j < al.sta.length - 2 && al.sta[j + 1] < s) j++;
        const a = al.pts[j], b = al.pts[j + 1];
        const t = (s - al.sta[j]) / (al.sta[j + 1] - al.sta[j] || 1);
        const x = X(a.x + t * (b.x - a.x)), y = Y(a.y + t * (b.y - a.y));
        if (x < -50 || y < -20 || x > w + 50 || y > h + 20) continue;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(staText(s, this.units, 0), x + 5, y - 5);
      }
    });

    ctx.fillStyle = '#fff';
    ctx.font = '11px system-ui, sans-serif';
    for (const p of this.model.points.slice(0, 2000)) {
      const x = X(p.x), y = Y(p.y);
      if (x < 0 || y < 0 || x > w || y > h) continue;
      ctx.fillRect(x - 2, y - 2, 4, 4);
      if (scale > 0.5) ctx.fillText(p.name, x + 4, y + 12);
    }

    if (this.nearest && this.user) {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(X(this.user.x), Y(this.user.y));
      ctx.lineTo(X(this.nearest.x), Y(this.nearest.y));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.user) {
      const ux = X(this.user.x), uy = Y(this.user.y);
      if (this.user.accuracy) {
        ctx.fillStyle = 'rgba(66,160,255,0.18)';
        ctx.beginPath();
        ctx.arc(ux, uy, Math.max(4, this.user.accuracy * scale), 0, Math.PI * 2);
        ctx.fill();
      }
      if (this.user.bearing !== null && this.user.bearing !== undefined) {
        const b = this.user.bearing;
        const half = ((this.user.fov || 50) / 2) * (Math.PI / 180);
        const r = 60;
        ctx.fillStyle = 'rgba(66,160,255,0.35)';
        ctx.beginPath();
        ctx.moveTo(ux, uy);
        ctx.arc(ux, uy, r, b - half - Math.PI / 2, b + half - Math.PI / 2);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = '#42a0ff';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ux, uy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // North arrow (grid north)
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText('N', w - 22, 20);
    ctx.beginPath();
    ctx.moveTo(w - 18, 24);
    ctx.lineTo(w - 23, 38);
    ctx.lineTo(w - 13, 38);
    ctx.closePath();
    ctx.fill();
  }

  _grid(ctx, w, h, X, Y) {
    const { cx, cy, scale } = this.view;
    const target = 100 / scale;
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000].find((v) => v >= target) || 50000;
    const x0 = cx - w / 2 / scale, x1 = cx + w / 2 / scale;
    const y0 = cy - h / 2 / scale, y1 = cy + h / 2 / scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
      ctx.moveTo(X(x), 0);
      ctx.lineTo(X(x), h);
    }
    for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) {
      ctx.moveTo(0, Y(y));
      ctx.lineTo(w, Y(y));
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(`grid ${step} u`, 8, h - 8);
  }
}
