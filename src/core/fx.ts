import * as THREE from 'three';
import { TAU, clamp, ease, rand, type V3 } from './math';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _c = new THREE.Color();

export interface EmitOpts {
  speed?: [number, number];
  /** Preferred direction; combined with `spread` (0 = tight beam, 1 = full sphere). */
  dir?: V3;
  spread?: number;
  color?: THREE.ColorRepresentation;
  color2?: THREE.ColorRepresentation;
  /** HDR multiplier so bloom picks the particles up. */
  intensity?: number;
  size?: [number, number];
  life?: [number, number];
  gravity?: number;
  drag?: number;
  radius?: number;
  grow?: number;
}

class Particles {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size0: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private grow: Float32Array;
  private base: Float32Array;
  private cursor = 0;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;

  constructor(private max: number, additive: boolean, private sizeScale = 1) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    this.size0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.base = new Float32Array(max * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute vec4 aColor; attribute float aSize; varying vec4 vColor; uniform float uScale;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.0, r);
          gl_FragColor = vec4(vColor.rgb, vColor.a * a * a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 12 : 11;
  }

  setScale(s: number) {
    this.mat.uniforms.uScale.value = s;
  }

  emit(n: number, at: V3, o: EmitOpts) {
    const speed = o.speed ?? [1, 3];
    const size = o.size ?? [0.1, 0.25];
    const life = o.life ?? [0.3, 0.7];
    const spread = o.spread ?? 1;
    const inten = o.intensity ?? 1;
    const c1 = _c.set(o.color ?? 0xffffff).clone();
    const c2 = o.color2 !== undefined ? new THREE.Color(o.color2) : c1;
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      // Random unit vector, blended toward the preferred direction.
      const u = rand(-1, 1);
      const th = rand(TAU);
      const s = Math.sqrt(1 - u * u);
      _v.set(s * Math.cos(th), u, s * Math.sin(th));
      if (o.dir) _v.multiplyScalar(spread).addScaledVector(o.dir, 1 - spread * 0.5).normalize();
      const sp = rand(speed[0], speed[1]);
      const rad = o.radius ? rand(o.radius) : 0;
      this.pos[i * 3] = at.x + _v.x * rad;
      this.pos[i * 3 + 1] = at.y + _v.y * rad;
      this.pos[i * 3 + 2] = at.z + _v.z * rad;
      this.vel[i * 3] = _v.x * sp;
      this.vel[i * 3 + 1] = _v.y * sp;
      this.vel[i * 3 + 2] = _v.z * sp;
      const t = rand();
      this.base[i * 3] = (c1.r + (c2.r - c1.r) * t) * inten;
      this.base[i * 3 + 1] = (c1.g + (c2.g - c1.g) * t) * inten;
      this.base[i * 3 + 2] = (c1.b + (c2.b - c1.b) * t) * inten;
      this.size0[i] = rand(size[0], size[1]) * this.sizeScale;
      this.maxLife[i] = this.life[i] = rand(life[0], life[1]);
      this.grav[i] = o.gravity ?? 0;
      this.drag[i] = o.drag ?? 0;
      this.grow[i] = o.grow ?? 0;
    }
  }

  update(dt: number) {
    const { pos, vel, life, maxLife, col, size, size0, base } = this;
    for (let i = 0; i < this.max; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) {
        size[i] = 0;
        col[i * 4 + 3] = 0;
        continue;
      }
      const d = Math.max(0, 1 - this.drag[i] * dt);
      vel[i * 3] *= d;
      vel[i * 3 + 1] = vel[i * 3 + 1] * d - this.grav[i] * dt;
      vel[i * 3 + 2] *= d;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      if (pos[i * 3 + 1] < 0.02 && this.grav[i] > 0) {
        pos[i * 3 + 1] = 0.02;
        vel[i * 3 + 1] *= -0.3;
      }
      const k = life[i] / maxLife[i];
      size[i] = size0[i] * (1 + this.grow[i] * (1 - k));
      col[i * 4] = base[i * 3];
      col[i * 4 + 1] = base[i * 3 + 1];
      col[i * 4 + 2] = base[i * 3 + 2];
      col[i * 4 + 3] = Math.min(1, k * 2.2);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
  }
}

interface FxItem {
  obj: THREE.Object3D;
  /** Return false when finished. */
  update(dt: number): boolean;
  dispose?(): void;
}

export interface Telegraph {
  setPos(p: V3): void;
  cancel(): void;
}

const TELEGRAPH_VS = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const TELEGRAPH_FS = /* glsl */ `
  uniform float uProgress; uniform vec3 uColor; uniform float uAlpha; varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    if (r > 1.0) discard;
    float rim = smoothstep(0.90, 0.96, r);
    float fill = step(r, uProgress) * (0.07 + 0.2 * uProgress);
    float edge = smoothstep(0.05, 0.0, abs(r - uProgress)) * 0.9;
    float a = (rim * 0.9 + fill + edge) * uAlpha;
    gl_FragColor = vec4(uColor * (1.0 + rim * 1.5 + edge * 2.0), a);
  }`;

const ARC_VS = /* glsl */ `varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const ARC_FS = /* glsl */ `
  uniform float uHead; uniform float uFade; uniform vec3 uColor; uniform float uStart; uniform float uLen;
  uniform float uInner; uniform float uOuter; varying vec2 vP;
  void main() {
    float ang = atan(vP.y, vP.x);
    if (ang < uStart - 0.02) ang += 6.2831853;
    float u = (ang - uStart) / uLen;
    float r = (length(vP) - uInner) / (uOuter - uInner);
    float trail = smoothstep(uHead - 0.75, uHead, u) * step(u, uHead + 0.001);
    float radial = smoothstep(0.0, 0.55, r) * smoothstep(1.0, 0.85, r);
    float a = trail * trail * radial * uFade;
    gl_FragColor = vec4(uColor * (1.0 + 2.5 * r * trail), a);
  }`;

/** One-shot visual effects: particles, rings, ground telegraphs, slash arcs, flashes, camera shake. */
export class Fx {
  group = new THREE.Group();
  sparks = new Particles(5000, true, 0.62);
  smoke = new Particles(1500, false);
  trauma = 0;
  shakeOffset = new THREE.Vector3();
  shakeRoll = 0;
  /** Point the camera listens from, for distance falloff of shakes. */
  listener = new THREE.Vector3();
  private items: FxItem[] = [];
  private time = 0;
  private ringGeo = new THREE.RingGeometry(0.88, 1, 72);
  private circleGeo = new THREE.CircleGeometry(1, 56);
  private cylGeo = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true);
  private sphereGeo = new THREE.SphereGeometry(1, 20, 14);
  readonly glowTex: THREE.Texture;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    this.group.add(this.sparks.points, this.smoke.points);
    this.glowTex = makeGlowTexture();
  }

  setView(heightPx: number, fovDeg: number) {
    const s = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.sparks.setScale(s);
    this.smoke.setScale(s);
  }

  private add(item: FxItem) {
    this.group.add(item.obj);
    this.items.push(item);
  }

  update(dt: number) {
    this.time += dt;
    this.sparks.update(dt);
    this.smoke.update(dt);
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (!it.update(dt)) {
        this.group.remove(it.obj);
        it.dispose?.();
        this.items.splice(i, 1);
      }
    }
  }

  /** Camera shake uses real time so it still reads during hit-stop. */
  updateShake(dtReal: number) {
    this.trauma = Math.max(0, this.trauma - dtReal * 1.5);
    const t = performance.now() * 0.001;
    const s = this.trauma * this.trauma;
    this.shakeOffset.set(
      (Math.sin(t * 47.1) + Math.sin(t * 81.7)) * 0.5 * s * 0.55,
      (Math.sin(t * 53.3 + 1.3) + Math.sin(t * 91.9)) * 0.5 * s * 0.55,
      0,
    );
    this.shakeRoll = Math.sin(t * 39.7 + 0.5) * s * 0.035;
  }

  shake(amount: number, at?: V3, falloff = 45) {
    let k = amount;
    if (at) k *= clamp(1 - at.distanceTo(this.listener) / falloff, 0.15, 1);
    this.trauma = Math.min(1, this.trauma + k);
  }

  burst(at: V3, n: number, o: EmitOpts = {}) {
    this.sparks.emit(n, at, o);
  }

  puff(at: V3, n: number, o: EmitOpts = {}) {
    this.smoke.emit(n, at, {
      color: 0x59607a,
      color2: 0x2a2e3f,
      size: [0.8, 1.8],
      life: [0.6, 1.4],
      speed: [0.6, 3],
      drag: 1.6,
      grow: 1.2,
      ...o,
    });
  }

  /** Expanding ground ring. */
  ring(at: V3, o: { r0?: number; r1: number; life: number; color?: THREE.ColorRepresentation; intensity?: number; y?: number }) {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(o.color ?? 0xffffff).multiplyScalar(o.intensity ?? 2),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.ringGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(at.x, o.y ?? 0.08, at.z);
    mesh.renderOrder = 8;
    const r0 = o.r0 ?? 0.2;
    let t = 0;
    this.add({
      obj: mesh,
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / o.life);
        mesh.scale.setScalar(r0 + (o.r1 - r0) * ease.out(k));
        mat.opacity = 1 - k * k;
        return k < 1;
      },
      dispose: () => mat.dispose(),
    });
  }

  /** Ground warning circle that fills as the impact approaches. */
  telegraph(at: V3, radius: number, duration: number, color: THREE.ColorRepresentation = 0xff3b2e): Telegraph {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uProgress: { value: 0 }, uColor: { value: new THREE.Color(color) }, uAlpha: { value: 0 } },
      vertexShader: TELEGRAPH_VS,
      fragmentShader: TELEGRAPH_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(this.circleGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(at.x, 0.06, at.z);
    mesh.scale.setScalar(radius);
    mesh.renderOrder = 7;
    let t = 0;
    let cancelled = false;
    this.add({
      obj: mesh,
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / duration);
        mat.uniforms.uProgress.value = k;
        mat.uniforms.uAlpha.value = cancelled ? 0 : Math.min(1, t * 6) * (0.55 + 0.45 * k);
        return k < 1 && !cancelled;
      },
      dispose: () => mat.dispose(),
    });
    return {
      setPos: (p) => mesh.position.set(p.x, 0.06, p.z),
      cancel: () => {
        cancelled = true;
      },
    };
  }

  /**
   * Weapon swing arc. With tilt 0 the arc sweeps right -> front -> left of `yaw`;
   * `mirror` reverses it; tilt -PI/2 turns it into an overhead (up -> front -> down).
   */
  slashArc(o: {
    pos: V3;
    yaw: number;
    radius: number;
    inner?: number;
    color: THREE.ColorRepresentation;
    duration: number;
    tilt?: number;
    pitch?: number;
    mirror?: boolean;
    sweep?: number;
    intensity?: number;
  }) {
    const sweep = o.sweep ?? Math.PI * 1.1;
    const start = Math.PI * 1.5 - sweep / 2;
    const inner = o.radius * (o.inner ?? 0.45);
    const geo = new THREE.RingGeometry(inner, o.radius, 40, 1, start, sweep);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uHead: { value: 0 },
        uFade: { value: 1 },
        uColor: { value: new THREE.Color(o.color).multiplyScalar(o.intensity ?? 1.6) },
        uStart: { value: start },
        uLen: { value: sweep },
        uInner: { value: inner },
        uOuter: { value: o.radius },
      },
      vertexShader: ARC_VS,
      fragmentShader: ARC_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    const tiltNode = new THREE.Group();
    tiltNode.rotation.z = o.tilt ?? 0;
    tiltNode.rotation.x = o.pitch ?? 0;
    tiltNode.scale.x = o.mirror ? -1 : 1;
    tiltNode.add(mesh);
    const root = new THREE.Group();
    root.position.copy(o.pos);
    root.rotation.y = o.yaw;
    root.add(tiltNode);
    mesh.renderOrder = 10;
    let t = 0;
    const total = o.duration * 2.2;
    this.add({
      obj: root,
      update: (dt) => {
        t += dt;
        mat.uniforms.uHead.value = Math.min(1.05, (t / o.duration) * 1.05);
        mat.uniforms.uFade.value = 1 - clamp((t - o.duration) / (total - o.duration), 0, 1);
        return t < total;
      },
      dispose: () => {
        geo.dispose();
        mat.dispose();
      },
    });
  }

  /** Soft additive glow that pops and fades. */
  flash(at: V3, color: THREE.ColorRepresentation, size: number, life = 0.25, intensity = 2) {
    const mat = new THREE.SpriteMaterial({
      map: this.glowTex,
      color: new THREE.Color(color).multiplyScalar(intensity),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(at);
    sprite.renderOrder = 13;
    let t = 0;
    this.add({
      obj: sprite,
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / life);
        sprite.scale.setScalar(size * (0.5 + 0.8 * ease.out(k)));
        mat.opacity = 1 - k;
        return k < 1;
      },
      dispose: () => mat.dispose(),
    });
  }

  /** Straight beam between two points that thins out as it fades. */
  line(a: V3, b: V3, color: THREE.ColorRepresentation, width: number, life: number, intensity = 3) {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(intensity),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.cylGeo, mat);
    const len = a.distanceTo(b);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(Y_AXIS, _v.subVectors(b, a).normalize());
    mesh.renderOrder = 12;
    let t = 0;
    this.add({
      obj: mesh,
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / life);
        mesh.scale.set(width * (1 - k * 0.8), len, width * (1 - k * 0.8));
        mat.opacity = 1 - k;
        return k < 1;
      },
      dispose: () => mat.dispose(),
    });
  }

  /** Vertical column of light. */
  pillar(at: V3, radius: number, height: number, color: THREE.ColorRepresentation, life: number, intensity = 2.2) {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(intensity),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.cylGeo, mat);
    mesh.position.set(at.x, height / 2, at.z);
    mesh.renderOrder = 12;
    let t = 0;
    this.add({
      obj: mesh,
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / life);
        const r = radius * (k < 0.15 ? ease.out(k / 0.15) : 1 - ease.in((k - 0.15) / 0.85) * 0.7);
        mesh.scale.set(r, height, r);
        mat.opacity = (1 - k) * 0.75;
        return k < 1;
      },
      dispose: () => mat.dispose(),
    });
  }

  /** Expanding translucent sphere (explosions). */
  blast(at: V3, radius: number, color: THREE.ColorRepresentation, life: number, intensity = 2.5) {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(intensity),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.sphereGeo, mat);
    mesh.position.copy(at);
    mesh.renderOrder = 12;
    let t = 0;
    this.add({
      obj: mesh,
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / life);
        mesh.scale.setScalar(radius * (0.2 + 0.8 * ease.outCubic(k)));
        mat.opacity = (1 - k) * (1 - k) * 0.8;
        return k < 1;
      },
      dispose: () => mat.dispose(),
    });
  }

  /** Linear-growth ring that matches a moving shockwave hazard exactly. */
  shockwave(at: V3, r0: number, r1: number, life: number, color: THREE.ColorRepresentation, intensity = 3) {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(intensity),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const group = new THREE.Group();
    group.position.set(at.x, 0, at.z);
    const flat = new THREE.Mesh(this.ringGeo, mat);
    flat.rotation.x = -Math.PI / 2;
    flat.position.y = 0.1;
    // A low wall of light so the wave reads from a third-person camera.
    const wall = new THREE.Mesh(this.cylGeo, mat);
    wall.scale.set(0.94, 1.1, 0.94);
    wall.position.y = 0.55;
    group.add(flat, wall);
    group.renderOrder = 9;
    let t = 0;
    this.add({
      obj: group,
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / life);
        const r = r0 + (r1 - r0) * k;
        group.scale.set(r, 1, r);
        mat.opacity = Math.min(1, (1 - k) * 2.5) * 0.85;
        return k < 1;
      },
      dispose: () => mat.dispose(),
    });
  }

  /** A falling star that lands on `target` after `duration`. */
  meteor(target: V3, duration: number, color: THREE.ColorRepresentation) {
    const mat = new THREE.SpriteMaterial({
      map: this.glowTex,
      color: new THREE.Color(color).multiplyScalar(4),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.setScalar(5);
    sprite.renderOrder = 13;
    const start = new THREE.Vector3(target.x + 9, 70, target.z - 6);
    const p = new THREE.Vector3();
    let t = 0;
    this.add({
      obj: sprite,
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / duration);
        p.lerpVectors(start, target, k * k);
        sprite.position.copy(p);
        this.sparks.emit(3, p, { color, intensity: 3, speed: [0.5, 3], size: [0.4, 0.9], life: [0.2, 0.5] });
        return k < 1;
      },
      dispose: () => mat.dispose(),
    });
  }

  clear() {
    for (const it of this.items) {
      this.group.remove(it.obj);
      it.dispose?.();
    }
    this.items.length = 0;
  }
}

export function makeGlowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
