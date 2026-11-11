import * as THREE from 'three';
import { TAU, damp, rand, setSeed } from '../core/math';
import { makeGlowTexture } from '../core/fx';
import type { Props } from './props';
import { Sky } from './sky';

export const ARENA_RADIUS = 40;

/** Moonlit ruin: a zodiac wheel floor ringed by broken pillars, under the galaxy and a moon that eclipses in phase 2. */
export class Arena {
  group = new THREE.Group();
  moonLight: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private floorMat: THREE.MeshStandardMaterial;
  private moon: THREE.Mesh;
  private moonGlow: THREE.Sprite;
  private shade: THREE.Mesh;
  private corona: THREE.Sprite;
  readonly sky = new Sky();
  private fog: THREE.FogExp2;
  private eclipse = 0;
  private eclipseTarget = 0;
  private time = 0;
  private braziers: { light: THREE.PointLight; flame: THREE.Mesh; phase: number }[] = [];
  /** The ruins as rough spheres, so the camera can keep out from behind (or inside) them. */
  readonly solids: { pos: THREE.Vector3; r: number }[] = [];
  /** Columns, statues and fire bowls around the rim. */
  private ruins = new THREE.Group();
  private moonDir = new THREE.Vector3(-0.42, 0.56, -0.71).normalize();

  private cool = {
    moon: new THREE.Color(0x9db8ff),
    fog: new THREE.Color(0x070a16),
    glyph: new THREE.Color(0x3d6cff),
    skyTop: new THREE.Color(0x02030a),
    skyHorizon: new THREE.Color(0x121a3a),
  };
  private hot = {
    moon: new THREE.Color(0xff5a3c),
    fog: new THREE.Color(0x14060a),
    glyph: new THREE.Color(0xff3320),
    skyTop: new THREE.Color(0x050103),
    skyHorizon: new THREE.Color(0x3a0d14),
  };

  constructor(private scene: THREE.Scene) {
    scene.add(this.group);
    this.fog = new THREE.FogExp2(this.cool.fog.getHex(), 0.011);
    scene.fog = this.fog;
    scene.background = new THREE.Color(0x02030a);

    this.sky.top.copy(this.cool.skyTop);
    this.sky.horizon.copy(this.cool.skyHorizon);
    this.group.add(this.sky.group);

    // Moon, its glow, and the disc that eclipses it
    const moonDir = this.moonDir;
    const moonPos = moonDir.clone().multiplyScalar(520);
    const glowTex = makeGlowTexture();
    this.moon = new THREE.Mesh(
      new THREE.CircleGeometry(46, 64),
      new THREE.MeshBasicMaterial({ map: makeMoonTexture(), color: new THREE.Color(1.6, 1.7, 2.0), fog: false, depthWrite: false }),
    );
    this.moon.position.copy(moonPos);
    this.moon.lookAt(0, 0, 0);
    this.moon.renderOrder = -8;
    this.moonGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTex, color: 0x6f8cff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.55 }),
    );
    this.moonGlow.position.copy(moonPos);
    this.moonGlow.scale.setScalar(330);
    this.moonGlow.renderOrder = -8;
    this.shade = new THREE.Mesh(
      new THREE.CircleGeometry(45, 64),
      new THREE.MeshBasicMaterial({ color: 0x030106, fog: false, depthWrite: false }),
    );
    this.shade.renderOrder = -7;
    this.corona = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTex, color: 0xff3a22, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0 }),
    );
    this.corona.position.copy(moonPos);
    this.corona.scale.setScalar(250);
    this.corona.renderOrder = -8;
    this.group.add(this.moonGlow, this.corona, this.moon, this.shade);

    // Lights
    this.moonLight = new THREE.DirectionalLight(this.cool.moon, 2.4);
    this.moonLight.position.copy(moonDir).multiplyScalar(90);
    this.moonLight.castShadow = true;
    this.moonLight.shadow.mapSize.set(2048, 2048);
    const cam = this.moonLight.shadow.camera;
    cam.left = cam.bottom = -46;
    cam.right = cam.top = 46;
    cam.near = 10;
    cam.far = 220;
    this.moonLight.shadow.bias = -0.0006;
    this.moonLight.shadow.normalBias = 0.06;
    this.hemi = new THREE.HemisphereLight(0x5b72c8, 0x16121f, 0.75);
    this.group.add(this.moonLight, this.moonLight.target, this.hemi);

    // Floor
    const { map, glow } = makeFloorTextures();
    this.floorMat = new THREE.MeshStandardMaterial({
      map,
      emissiveMap: glow,
      emissive: this.cool.glyph.clone(),
      emissiveIntensity: 1.4,
      roughness: 0.82,
      metalness: 0.15,
    });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(ARENA_RADIUS + 6, 96), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.group.add(floor);
    // Rim wall under the floor edge so the platform has thickness.
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(ARENA_RADIUS + 6, ARENA_RADIUS + 2, 30, 96, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x0c0e18, roughness: 0.95 }),
    );
    skirt.position.y = -15;
    this.group.add(skirt);

    this.group.add(this.ruins);
    this.buildRuins();
    this.buildDistance();
  }

  /**
   * Rebuild the rim from the generated models, once they have loaded: a column on every
   * line between two signs of the floor's wheel, a hooded star-watcher over each sign,
   * and a smashed plinth over the thirteenth. With no models on disk the plain ruin stays.
   */
  dress(props: Props) {
    if (!props.count) return;
    this.ruins.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
    });
    this.ruins.clear();
    this.braziers.length = 0;
    this.solids.length = 0;
    setSeed(4242);
    const stone = new THREE.MeshStandardMaterial({ color: 0x2a2f45, roughness: 0.9, metalness: 0.05, flatShading: true });
    const R = ARENA_RADIUS + 3.5;
    /** A model sized to a box, or a plain block of the same size when it is missing. */
    const make = (name: string, w: number, h: number, d: number, mode: 'fill' | 'height' | 'width' = 'fill') => {
      const o = props.fit(name, w, h, d, { mode });
      if (o) {
        const size = o.userData.size as THREE.Vector3;
        return { o, h: size.y, w: Math.max(size.x, size.z) };
      }
      const block = new THREE.Mesh(new THREE.CylinderGeometry(w / 2.4, w / 2.2, h, 8), stone);
      block.castShadow = block.receiveShadow = true;
      return { o: block as THREE.Object3D, h, w: Math.max(w, d) };
    };
    const put = (item: { o: THREE.Object3D; h: number; w: number }, angle: number, r: number, yaw: number) => {
      item.o.position.set(Math.cos(angle) * r, item.h / 2, Math.sin(angle) * r);
      item.o.rotation.y = yaw;
      this.ruins.add(item.o);
      this.solids.push({ pos: new THREE.Vector3(item.o.position.x, Math.min(item.h / 2, 1.8), item.o.position.z), r: item.w / 2 });
    };
    /** The yaw that turns a model's front toward the middle of the arena. */
    const inward = (angle: number) => Math.atan2(-Math.cos(angle), -Math.sin(angle));
    const SIGNS = 13;
    for (let i = 0; i < SIGNS; i++) {
      // The same angles the floor's sectors are drawn at.
      const edge = (i / SIGNS) * TAU - Math.PI / 2;
      const mid = edge + TAU / SIGNS / 2;

      if (rand() < 0.38) {
        put(make('arena_stump', 3.7, rand(6, 9.5), 3.7), edge, R, rand(TAU));
        if (rand() < 0.8) {
          // The drum that fell from it, lying nearer the middle.
          const len = rand(3, 4.4);
          const drum = make('arena_drum', len, 2.5, 2.5);
          put(drum, edge + rand(-0.07, 0.07), R - rand(3.6, 5), rand(TAU));
        }
      } else put(make('arena_pillar', 3.7, rand(15.5, 18.5), 3.7), edge, R, inward(edge) + Math.floor(rand(4)) * (Math.PI / 2));

      if (i < SIGNS - 1) put(make('arena_statue', 4, 11.5, 4, 'height'), mid, R + 0.4, inward(mid));
      else put(make('arena_plinth', 5.4, 2.6, 5.4, 'width'), mid, R + 0.4, inward(mid));

      // A bowl of cold starfire before every other watcher, and before the empty plinth.
      if (i % 2 === 0) {
        const bowl = make('arena_brazier', 2.3, 1.7, 2.3, 'width');
        put(bowl, mid, R - 3.9, rand(TAU));
        const { x, z } = bowl.o.position;
        const flame = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 1.2, 3.2) }));
        flame.position.set(x, bowl.h + 0.35, z);
        const light = new THREE.PointLight(0x5f8dff, 22, 22, 1.8);
        light.position.set(x, bowl.h + 0.9, z);
        this.ruins.add(flame, light);
        this.braziers.push({ light, flame, phase: rand(TAU) });
      }
    }
  }

  private buildRuins() {
    setSeed(4242);
    const stone = new THREE.MeshStandardMaterial({ color: 0x2a2f45, roughness: 0.9, metalness: 0.05, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: 0x191c2b, roughness: 0.95, flatShading: true });
    const count = 26;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + rand(-0.03, 0.03);
      const r = ARENA_RADIUS + 3.2;
      const broken = rand() < 0.45;
      const h = broken ? rand(3, 9) : rand(13, 17);
      const base = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.2, 3.4), dark);
      base.position.set(Math.sin(a) * r, 0.6, Math.cos(a) * r);
      base.rotation.y = a;
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.25, h, 10), stone);
      shaft.position.set(Math.sin(a) * r, 1.2 + h / 2, Math.cos(a) * r);
      shaft.rotation.set(broken ? rand(-0.06, 0.06) : 0, rand(TAU), broken ? rand(-0.06, 0.06) : 0);
      for (const m of [base, shaft]) {
        m.castShadow = true;
        m.receiveShadow = true;
        this.ruins.add(m);
      }
      if (!broken) {
        const cap = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.1, 3.2), dark);
        cap.position.set(Math.sin(a) * r, 1.2 + h + 0.55, Math.cos(a) * r);
        cap.rotation.y = a;
        cap.castShadow = true;
        this.ruins.add(cap);
      } else if (rand() < 0.7) {
        // Fallen drum beside the stump
        const drum = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, rand(2, 4), 10), stone);
        const rr = r - rand(2.5, 4.5);
        const aa = a + rand(-0.06, 0.06);
        drum.position.set(Math.sin(aa) * rr, 1.0, Math.cos(aa) * rr);
        drum.rotation.set(Math.PI / 2, 0, rand(TAU));
        drum.castShadow = true;
        drum.receiveShadow = true;
        this.ruins.add(drum);
      }
      // A brazier of cold starfire on every other standing pillar base
      if (i % 4 === 0) {
        const bx = Math.sin(a) * (r - 3.4);
        const bz = Math.cos(a) * (r - 3.4);
        const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.45, 1.5, 8), dark);
        bowl.position.set(bx, 0.75, bz);
        bowl.castShadow = true;
        const flame = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.55, 0),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 1.2, 3.2) }),
        );
        flame.position.set(bx, 1.95, bz);
        const light = new THREE.PointLight(0x5f8dff, 22, 22, 1.8);
        light.position.set(bx, 2.4, bz);
        this.ruins.add(bowl, flame, light);
        this.braziers.push({ light, flame, phase: rand(TAU) });
      }
    }
  }

  private buildDistance() {
    setSeed(99);
    const mat = new THREE.MeshBasicMaterial({ color: 0x05070f, fog: true });
    for (let i = 0; i < 34; i++) {
      const a = rand(TAU);
      const r = rand(120, 260);
      const h = rand(30, 120);
      const spire = new THREE.Mesh(new THREE.ConeGeometry(rand(10, 34), h, 5), mat);
      spire.position.set(Math.sin(a) * r, h / 2 - 34, Math.cos(a) * r);
      spire.rotation.y = rand(TAU);
      this.group.add(spire);
    }
  }

  /** 0 = moonlit, 1 = full eclipse. */
  setEclipse(k: number) {
    this.eclipseTarget = k;
  }

  reset() {
    this.eclipse = this.eclipseTarget = 0;
  }

  update(dt: number, focus: THREE.Vector3) {
    this.time += dt;
    this.eclipse = damp(this.eclipse, this.eclipseTarget, 1.2, dt);
    const k = this.eclipse;
    this.moonLight.color.lerpColors(this.cool.moon, this.hot.moon, k);
    this.moonLight.intensity = 2.4 - 0.7 * k;
    this.fog.color.lerpColors(this.cool.fog, this.hot.fog, k);
    (this.scene.background as THREE.Color).copy(this.fog.color);
    this.sky.top.lerpColors(this.cool.skyTop, this.hot.skyTop, k);
    this.sky.horizon.lerpColors(this.cool.skyHorizon, this.hot.skyHorizon, k);
    this.sky.update(dt, k);
    this.floorMat.emissive.lerpColors(this.cool.glyph, this.hot.glyph, k);
    this.floorMat.emissiveIntensity = 1.3 + Math.sin(this.time * 1.3) * 0.25 + k * 0.9;
    this.hemi.intensity = 0.75 - 0.2 * k;
    this.hemi.color.set(0x5b72c8).lerp(new THREE.Color(0xa84a5a), k);

    // The shade slides across the moon.
    const off = (1 - k) * 100;
    this.shade.position.copy(this.moon.position).multiplyScalar(0.995);
    this.shade.lookAt(0, 0, 0);
    this.shade.translateX(off);
    this.shade.visible = k > 0.01;
    (this.moonGlow.material as THREE.SpriteMaterial).opacity = 0.55 * (1 - k);
    (this.corona.material as THREE.SpriteMaterial).opacity = k * 0.9;

    for (const b of this.braziers) {
      const f = 0.8 + 0.2 * Math.sin(this.time * 9 + b.phase) + 0.1 * Math.sin(this.time * 23 + b.phase * 2);
      b.light.intensity = 22 * f;
      b.light.color.set(0x5f8dff).lerp(new THREE.Color(0xff5030), k);
      b.flame.scale.set(1, 1.2 + 0.5 * f, 1);
      b.flame.rotation.y += dt * 2;
      (b.flame.material as THREE.MeshBasicMaterial).color.setRGB(0.6 + 2.6 * k, 1.2 - 0.6 * k, 3.2 - 2.8 * k);
    }

    // Keep the shadow frustum centred on the action.
    this.moonLight.target.position.set(focus.x * 0.5, 0, focus.z * 0.5);
    this.moonLight.position.copy(this.moonLight.target.position).addScaledVector(this.moonDir, 90);
  }
}

function makeMoonTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(110, 100, 10, 128, 128, 128);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.7, '#dfe6ff');
  grad.addColorStop(1, '#aab6e6');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(128, 128, 127, 0, TAU);
  g.fill();
  setSeed(5);
  for (let i = 0; i < 26; i++) {
    const a = rand(TAU);
    const r = rand(110);
    g.fillStyle = `rgba(120,135,190,${rand(0.06, 0.2)})`;
    g.beginPath();
    g.arc(128 + Math.cos(a) * r, 128 + Math.sin(a) * r, rand(5, 26), 0, TAU);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Stone slabs plus an emissive layer: concentric rings, 12 constellation sectors and a broken 13th. */
function makeFloorTextures() {
  const S = 2048;
  const stone = document.createElement('canvas');
  const glow = document.createElement('canvas');
  stone.width = stone.height = glow.width = glow.height = S;
  const g = stone.getContext('2d')!;
  const e = glow.getContext('2d')!;
  const cx = S / 2;
  const R = S / 2; // texture radius == ARENA_RADIUS + 6 metres
  const m = R / (ARENA_RADIUS + 6); // pixels per metre

  g.fillStyle = '#1b1e2c';
  g.fillRect(0, 0, S, S);
  setSeed(31);
  // Mottling
  for (let i = 0; i < 5000; i++) {
    const v = Math.floor(rand(18, 50));
    g.fillStyle = `rgba(${v},${v + 3},${v + 16},${rand(0.05, 0.25)})`;
    const s = rand(4, 40);
    g.fillRect(rand(S), rand(S), s, s * rand(0.5, 1.5));
  }
  // Slab seams: rings and staggered radial joints
  g.strokeStyle = 'rgba(4,5,10,0.85)';
  g.lineWidth = 3;
  const rings = [4, 8, 13, 18, 24, 30, 36, 40, 46];
  for (let i = 0; i < rings.length; i++) {
    g.beginPath();
    g.arc(cx, cx, rings[i] * m, 0, TAU);
    g.stroke();
    if (i === 0) continue;
    const segs = 6 + i * 5;
    const off = rand(TAU);
    for (let s = 0; s < segs; s++) {
      const a = off + (s / segs) * TAU;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * rings[i - 1] * m, cx + Math.sin(a) * rings[i - 1] * m);
      g.lineTo(cx + Math.cos(a) * rings[i] * m, cx + Math.sin(a) * rings[i] * m);
      g.stroke();
    }
  }
  // Cracks
  g.strokeStyle = 'rgba(2,2,6,0.7)';
  for (let i = 0; i < 46; i++) {
    let x = rand(S);
    let y = rand(S);
    let a = rand(TAU);
    g.lineWidth = rand(1, 2.5);
    g.beginPath();
    g.moveTo(x, y);
    for (let s = 0; s < 14; s++) {
      a += rand(-0.7, 0.7);
      x += Math.cos(a) * rand(10, 34);
      y += Math.sin(a) * rand(10, 34);
      g.lineTo(x, y);
    }
    g.stroke();
  }
  // Edge darkening
  const vg = g.createRadialGradient(cx, cx, R * 0.55, cx, cx, R);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.6)');
  g.fillStyle = vg;
  g.fillRect(0, 0, S, S);

  // Emissive layer
  e.fillStyle = '#000';
  e.fillRect(0, 0, S, S);
  e.strokeStyle = '#fff';
  e.fillStyle = '#fff';
  e.lineCap = 'round';
  const ringGlow = (r: number, w: number, alpha: number) => {
    e.globalAlpha = alpha;
    e.lineWidth = w;
    e.beginPath();
    e.arc(cx, cx, r * m, 0, TAU);
    e.stroke();
  };
  ringGlow(39.2, 5, 0.9);
  ringGlow(37.8, 2, 0.5);
  ringGlow(26, 3, 0.7);
  ringGlow(24.6, 1.5, 0.4);
  ringGlow(9, 3, 0.8);
  ringGlow(7.6, 1.5, 0.4);
  // Thirteen sectors between the middle and outer rings; the 13th is narrower and "scratched out".
  const sectors = 13;
  for (let i = 0; i < sectors; i++) {
    const a0 = (i / sectors) * TAU - Math.PI / 2;
    e.globalAlpha = 0.5;
    e.lineWidth = 2;
    e.beginPath();
    e.moveTo(cx + Math.cos(a0) * 26 * m, cx + Math.sin(a0) * 26 * m);
    e.lineTo(cx + Math.cos(a0) * 37.8 * m, cx + Math.sin(a0) * 37.8 * m);
    e.stroke();
    // Constellation: a random walk of stars joined by lines
    const am = a0 + TAU / sectors / 2;
    const pts: [number, number][] = [];
    const count = 4 + Math.floor(rand(4));
    for (let s = 0; s < count; s++) {
      const rr = rand(27.5, 36.3);
      const aa = am + rand(-0.17, 0.17);
      pts.push([cx + Math.cos(aa) * rr * m, cx + Math.sin(aa) * rr * m]);
    }
    pts.sort((p, q) => Math.hypot(p[0] - cx, p[1] - cx) - Math.hypot(q[0] - cx, q[1] - cx));
    e.globalAlpha = 0.55;
    e.lineWidth = 2;
    e.beginPath();
    pts.forEach(([x, y], s) => (s ? e.lineTo(x, y) : e.moveTo(x, y)));
    e.stroke();
    for (const [x, y] of pts) {
      e.globalAlpha = 1;
      e.beginPath();
      e.arc(x, y, rand(4, 8), 0, TAU);
      e.fill();
    }
    if (i === sectors - 1) {
      // The exiled sign: struck through
      e.globalAlpha = 0.9;
      e.lineWidth = 5;
      for (const d of [-1, 1]) {
        e.beginPath();
        e.moveTo(cx + Math.cos(am - 0.18 * d) * 27.5 * m, cx + Math.sin(am - 0.18 * d) * 27.5 * m);
        e.lineTo(cx + Math.cos(am + 0.18 * d) * 36.5 * m, cx + Math.sin(am + 0.18 * d) * 36.5 * m);
        e.stroke();
      }
    }
  }
  // Inner star: a 13-pointed figure
  e.globalAlpha = 0.6;
  e.lineWidth = 2;
  e.beginPath();
  for (let i = 0; i <= 13; i++) {
    const a = ((i * 5) / 13) * TAU - Math.PI / 2;
    const x = cx + Math.cos(a) * 24.6 * m;
    const y = cx + Math.sin(a) * 24.6 * m;
    if (i) e.lineTo(x, y);
    else e.moveTo(x, y);
  }
  e.stroke();
  // Radial ticks in the centre ring
  for (let i = 0; i < 52; i++) {
    const a = (i / 52) * TAU;
    e.globalAlpha = i % 4 === 0 ? 0.8 : 0.35;
    e.lineWidth = i % 4 === 0 ? 3 : 1.5;
    e.beginPath();
    e.moveTo(cx + Math.cos(a) * 7.6 * m, cx + Math.sin(a) * 7.6 * m);
    e.lineTo(cx + Math.cos(a) * 9 * m, cx + Math.sin(a) * 9 * m);
    e.stroke();
  }
  e.globalAlpha = 1;

  const map = new THREE.CanvasTexture(stone);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const glowTex = new THREE.CanvasTexture(glow);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  glowTex.anisotropy = 8;
  return { map, glow: glowTex };
}
