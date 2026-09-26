// Rear camera stream, field-of-view model, torch/zoom and frame capture.

export class CameraFeed {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.capabilities = {};
    this.torch = false;
    this.zoom = 1;
    this.fovLong = 66; // horizontal FOV across the long side of the sensor (deg), user-calibratable
  }

  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Camera API not available (HTTPS required)');
    const tries = [
      { video: { facingMode: { exact: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
      { video: true, audio: false },
    ];
    let lastErr;
    for (const c of tries) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(c);
        break;
      } catch (e) {
        lastErr = e;
        if (e.name === 'NotAllowedError') break;
      }
    }
    if (!this.stream) throw lastErr || new Error('Could not open camera');
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    this.track = this.stream.getVideoTracks()[0];
    try { this.capabilities = this.track.getCapabilities ? this.track.getCapabilities() : {}; } catch { this.capabilities = {}; }
    if (this.capabilities.zoom) this.zoom = this.track.getSettings().zoom || 1;
    await new Promise((r) => (this.video.videoWidth ? r() : this.video.addEventListener('loadedmetadata', r, { once: true })));
    return this.track.getSettings ? this.track.getSettings() : {};
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  get active() {
    return !!this.stream && this.video.videoWidth > 0;
  }

  get hasTorch() {
    return !!this.capabilities.torch;
  }

  get zoomRange() {
    const z = this.capabilities.zoom;
    return z ? { min: z.min, max: z.max, step: z.step || 0.1 } : null;
  }

  async setTorch(on) {
    if (!this.track || !this.hasTorch) return false;
    await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
    this.torch = !!on;
    return true;
  }

  async setZoom(z) {
    if (!this.track || !this.capabilities.zoom) return false;
    await this.track.applyConstraints({ advanced: [{ zoom: z }] });
    this.zoom = z;
    return true;
  }

  // Region of the video frame visible on screen with object-fit: cover.
  visibleRect(viewW, viewH) {
    const vw = this.video.videoWidth || viewW, vh = this.video.videoHeight || viewH;
    const s = Math.max(viewW / vw, viewH / vh);
    const w = viewW / s, h = viewH / s;
    return { sx: (vw - w) / 2, sy: (vh - h) / 2, sw: w, sh: h, scale: s, vw, vh };
  }

  // Vertical field of view (deg) of the visible viewport.
  verticalFov(viewW, viewH) {
    const r = this.visibleRect(viewW, viewH);
    const longSide = Math.max(r.vw, r.vh);
    // Hardware zoom narrows the effective FOV.
    const f = longSide / 2 / Math.tan(((this.fovLong / 2) * Math.PI) / 180) * (this.zoom || 1);
    return (2 * Math.atan(r.sh / 2 / f) * 180) / Math.PI;
  }
}
