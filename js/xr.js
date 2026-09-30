// ARCore mode through WebXR (Chrome on Android): 6-DoF motion tracking and
// ground hit-testing. The design model lives in a "world" frame (x = east,
// y = up, z = -north, metres around the scene origin); XR tracking has its own
// local frame. `this.M` maps world -> XR local and is solved from the compass
// and GPS at start, then refined with control points (occupy / sight).

import * as THREE from 'three';

const Y = new THREE.Vector3(0, 1, 0);

// Heading (radians, clockwise from -Z) of a horizontal direction.
const headingOf = (dx, dz) => Math.atan2(dx, -dz);

export class XRMode {
  constructor(ar) {
    this.ar = ar;
    this.renderer = ar.renderer;
    this.session = null;
    this.M = new THREE.Matrix4(); // world -> XR local
    this.Minv = new THREE.Matrix4();
    this.aligned = false;
    this.pairs = []; // [{name, world: Vector3, xr: Vector3}]
    this.pose = null; // {position: Vector3, quaternion: Quaternion, emulated: bool} in XR local
    this.hit = null; // Vector3 (XR local) of the ground/surface under the crosshair
    this.tracking = 'none';
    this._photoRequest = null;
    this.cameraAccess = false;
  }

  static async supported() {
    try {
      return !!(navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar')));
    } catch {
      return false;
    }
  }

  get active() {
    return !!this.session;
  }

  async start(overlayRoot) {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local'],
      optionalFeatures: ['dom-overlay', 'hit-test', 'camera-access', 'light-estimation'],
      domOverlay: { root: overlayRoot },
    });
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local');
    await this.renderer.xr.setSession(session);
    this.session = session;
    this.cameraAccess = Array.isArray(session.enabledFeatures) ? session.enabledFeatures.includes('camera-access') : false;
    try {
      const viewer = await session.requestReferenceSpace('viewer');
      this.hitSource = await session.requestHitTestSource({ space: viewer });
    } catch {
      this.hitSource = null;
    }
    this.aligned = false;
    this.pairs = [];
    session.addEventListener('end', () => this._ended());
    return session;
  }

  async stop() {
    if (this.session) await this.session.end().catch(() => {});
  }

  _ended() {
    if (this.hitSource) this.hitSource.cancel?.();
    this.hitSource = null;
    this.session = null;
    this.pose = null;
    this.hit = null;
    this.renderer.xr.enabled = false;
    this.ar.world.matrixAutoUpdate = true;
    this.ar.world.matrix.identity();
    this.ar.world.updateMatrix();
    this.ar.xrReticle.visible = false;
    this.onEnd?.();
  }

  // Called every XR frame, before rendering.
  update(frame) {
    const ref = this.renderer.xr.getReferenceSpace();
    const vp = frame && ref ? frame.getViewerPose(ref) : null;
    if (!vp) {
      this.pose = null;
      this.tracking = 'lost';
      return;
    }
    const t = vp.transform;
    this.pose = {
      position: new THREE.Vector3(t.position.x, t.position.y, t.position.z),
      quaternion: new THREE.Quaternion(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w),
      emulated: vp.emulatedPosition,
      view: vp.views[0],
    };
    this.tracking = vp.emulatedPosition ? 'limited' : 'tracking';
    this.hit = null;
    if (this.hitSource) {
      const res = frame.getHitTestResults(this.hitSource);
      if (res.length) {
        const p = res[0].getPose(ref);
        if (p) this.hit = new THREE.Vector3(p.transform.position.x, p.transform.position.y, p.transform.position.z);
      }
    }
    const r = this.ar.xrReticle;
    r.visible = !!this.hit;
    if (this.hit) r.position.copy(this.hit);
  }

  // Initial placement from compass heading + GPS position (world camera position cw).
  initFromSensors(cw, worldHeadingRad) {
    if (!this.pose) return false;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.pose.quaternion);
    const phi = worldHeadingRad - headingOf(f.x, f.z);
    this._set(phi, cw, this.pose.position);
    this.aligned = true;
    return true;
  }

  // M = T(xrRef) * Ry(phi) * T(-worldRef)
  _set(phi, worldRef, xrRef) {
    const R = new THREE.Matrix4().makeRotationAxis(Y, phi);
    const a = new THREE.Matrix4().makeTranslation(-worldRef.x, -worldRef.y, -worldRef.z);
    const b = new THREE.Matrix4().makeTranslation(xrRef.x, xrRef.y, xrRef.z);
    this.phi = phi;
    this.M.copy(b).multiply(R).multiply(a);
    this.Minv.copy(this.M).invert();
    const w = this.ar.world;
    w.matrixAutoUpdate = false;
    w.matrix.copy(this.M);
    w.matrixWorldNeedsUpdate = true;
  }

  // XR local -> world
  toWorld(v) {
    return v.clone().applyMatrix4(this.Minv);
  }

  toXR(v) {
    return v.clone().applyMatrix4(this.M);
  }

  // Camera position and quaternion in the world frame.
  cameraWorld() {
    if (!this.pose) return null;
    const pos = this.toWorld(this.pose.position);
    const q = new THREE.Quaternion().setFromAxisAngle(Y, -this.phi).multiply(this.pose.quaternion);
    return { position: pos, quaternion: q };
  }

  // Add a control correspondence and re-solve.
  // useHeight: whether the pair's vertical should drive the model height.
  addPair(name, world, xr, useHeight = true) {
    this.pairs = this.pairs.filter((p) => p.name !== name);
    this.pairs.push({ name, world: world.clone(), xr: xr.clone(), useHeight });
    return this.solve();
  }

  // Similarity (rotation about the vertical + translation) from the pairs.
  solve() {
    const P = this.pairs;
    if (!P.length) return null;
    let phi = this.phi ?? 0;
    let used = 1;
    if (P.length >= 2) {
      // The two most recent points that are far enough apart define the heading.
      const b = P[P.length - 1];
      let a = null;
      for (let i = P.length - 2; i >= 0; i--) {
        if (Math.hypot(P[i].world.x - b.world.x, P[i].world.z - b.world.z) > 1) { a = P[i]; break; }
      }
      if (a) {
        const hw = headingOf(b.world.x - a.world.x, b.world.z - a.world.z);
        const hx = headingOf(b.xr.x - a.xr.x, b.xr.z - a.xr.z);
        phi = hw - hx;
        used = 2;
      }
    }
    const pts = used === 2 ? P.slice(-2) : P.slice(-1);
    // Horizontal centroids
    const cw = new THREE.Vector3(), cx = new THREE.Vector3();
    for (const p of pts) { cw.add(p.world); cx.add(p.xr); }
    cw.multiplyScalar(1 / pts.length);
    cx.multiplyScalar(1 / pts.length);
    // Vertical from the pairs that carry elevation, else keep the current one.
    const hp = pts.filter((p) => p.useHeight);
    if (hp.length) {
      cw.y = hp.reduce((s, p) => s + p.world.y, 0) / hp.length;
      cx.y = hp.reduce((s, p) => s + p.xr.y, 0) / hp.length;
    } else {
      const cur = this.toXR(new THREE.Vector3(cw.x, cw.y, cw.z));
      cx.y = cur.y;
    }
    const prevPhi = this.phi ?? phi;
    this._set(phi, cw, cx);
    this.aligned = true;
    const residual = pts.map((p) => this.toXR(p.world).distanceTo(p.xr));
    return { usedPoints: used, headingChangeDeg: THREE.MathUtils.radToDeg(phi - prevPhi), residual: Math.max(...residual) };
  }

  // Shift the model vertically so that `worldPoint` lands at XR height `xrY`.
  zeroHeightAt(worldPoint, xrY) {
    const cur = this.toXR(worldPoint);
    const dy = xrY - cur.y;
    const T = new THREE.Matrix4().makeTranslation(0, dy, 0);
    this.M.premultiply(T);
    this.Minv.copy(this.M).invert();
    this.ar.world.matrix.copy(this.M);
    this.ar.world.matrixWorldNeedsUpdate = true;
    return dy;
  }

  // Photo: render the ARCore camera image plus the model into an offscreen target
  // during the next XR frame. Resolves to a canvas.
  capture() {
    return new Promise((resolve, reject) => {
      this._photoRequest = { resolve, reject };
    });
  }

  // Called after the frame's normal render.
  afterRender(frame) {
    const req = this._photoRequest;
    if (!req || !this.pose) return;
    this._photoRequest = null;
    const renderer = this.renderer;
    const xrCam = renderer.xr.getCamera();
    const cam = xrCam.cameras[0] || xrCam;
    const view = this.pose.view;
    try {
      const w = (view && view.camera && view.camera.width) || renderer.domElement.width;
      const h = (view && view.camera && view.camera.height) || renderer.domElement.height;
      const rt = new THREE.WebGLRenderTarget(w, h);
      const camTex = view && view.camera ? renderer.xr.getCameraTexture(view.camera) : null;
      renderer.xr.enabled = false;
      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      if (camTex) {
        const bg = new THREE.Scene();
        const quad = new THREE.Mesh(
          new THREE.PlaneGeometry(2, 2),
          new THREE.ShaderMaterial({
            uniforms: { map: { value: camTex } },
            vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
            fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main(){ gl_FragColor = texture2D(map, vUv); }',
            depthTest: false,
            depthWrite: false,
          }),
        );
        bg.add(quad);
        renderer.render(bg, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
        quad.geometry.dispose();
        quad.material.dispose();
      }
      renderer.autoClear = false;
      renderer.render(this.ar.scene, cam);
      renderer.autoClear = true;
      const px = new Uint8Array(w * h * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.xr.enabled = true;
      rt.dispose();
      // WebGL rows are bottom-up.
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      ctx.putImageData(img, 0, 0);
      req.resolve({ canvas: c, hasCamera: !!camTex });
    } catch (e) {
      renderer.xr.enabled = true;
      req.reject(e);
    }
  }
}
