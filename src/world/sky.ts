import * as THREE from 'three';
import { TAU, rand, setSeed } from '../core/math';

/**
 * How the night looks. `pole` is the axis the galaxy's band turns about (so the band is the
 * great circle square to it); `coreAt` is how far along the band, from where it rises, its
 * bright heart sits.
 */
export const SKY_LOOK = {
  galaxy: 1,
  stars: 1,
  /** Seconds between shooting stars, least and most. */
  meteors: [5, 13] as [number, number],
};

const POLE = new THREE.Vector3(0.62, 0.45, 0.64).normalize();
const CORE_AT = 0.61;

const NOISE = /* glsl */ `
  float hash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float noise(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float fbm(vec3 p, int octaves) {
    float a = 0.5; float s = 0.0; float n = 0.0;
    for (int i = 0; i < 6; i++) {
      if (i >= octaves) break;
      s += a * noise(p); n += a;
      p = p * 2.03 + vec3(17.1, 3.7, 9.2);
      a *= 0.5;
    }
    return s / n;
  }
`;

/**
 * The galaxy itself: far too much arithmetic to do for every pixel of every frame, so it is
 * drawn once into a cube map. Colour is stored as its square root (to keep the faint parts
 * from banding in eight bits); alpha says how thickly stars crowd there.
 */
const GALAXY_FS = /* glsl */ `
  uniform vec3 uPole; uniform vec3 uNode; uniform vec3 uRise; uniform float uCore;
  uniform vec3 uFar; uniform vec3 uFarX; uniform vec3 uFarY;
  varying vec3 vDir;
  ${NOISE}
  void main() {
    vec3 d = normalize(vDir);
    // Where this piece of sky lies on the galaxy: along its band, and off to one side of it.
    float lon = atan(dot(d, uRise), dot(d, uNode));
    float warp = fbm(d * 2.4 + 5.0, 3) - 0.5;
    float fray = fbm(d * 10.0 + 8.0, 3) - 0.5;
    float lat = asin(clamp(dot(d, uPole), -1.0, 1.0)) + warp * 0.12 + fray * 0.014;
    float dl = lon - uCore;
    dl = atan(sin(dl), cos(dl));
    float bulge = exp(-dl * dl / 0.16);
    float along = 0.34 + 0.66 * exp(-dl * dl / 1.8);
    float width = 0.07 + 0.075 * bulge;
    float band = exp(-lat * lat / (width * width));
    float wide = exp(-lat * lat / 0.11);

    // Star clouds: big shapes, broken up by smaller ones so nothing in them is smooth.
    vec3 q = d * 10.0;
    vec3 swirl = vec3(fbm(q, 3), fbm(q + 19.0, 3), fbm(q + 43.0, 3)) - 0.5;
    float clouds = fbm(d * 5.5 + vec3(1.7, 9.2, 3.1) + swirl * 0.9, 6);
    float knots = fbm(d * 23.0 + 4.0, 4);
    float dens = band * along * (0.26 + 1.9 * pow(clouds, 1.7) * sqrt(band)) * (0.78 + 0.44 * knots);
    // Lanes of dust: long threads that gather along the middle of the band and split it.
    float seam = lat + 0.01 + 0.022 * sin(lon * 5.0 + 1.0);
    float near = exp(-seam * seam / pow(0.045 + 0.045 * bulge, 2.0));
    float r1 = 1.0 - abs(2.0 * fbm(d * 6.0 + vec3(13.0, 2.0, 5.0), 5) - 1.0);
    float r2 = 1.0 - abs(2.0 * fbm(d * 17.0 + vec3(3.0, 31.0, 11.0), 4) - 1.0);
    float lanes = smoothstep(0.6, 0.97, r1) * 0.95 + pow(r2, 5.0) * 0.5;
    float rift = exp(-seam * seam / 0.0005) * smoothstep(0.34, 0.6, fbm(d * 9.0 + 30.0, 3));
    float dust = clamp((lanes * near + rift * 0.8), 0.0, 0.95);

    vec3 warm = vec3(1.0, 0.8, 0.58);
    vec3 cool = vec3(0.4, 0.58, 1.0);
    vec3 tint = mix(cool, warm, clamp(bulge * 1.25, 0.0, 1.0));
    tint = mix(tint, vec3(0.62, 0.48, 1.0), (1.0 - bulge) * smoothstep(0.45, 0.7, fbm(d * 3.0 + 50.0, 3)) * 0.6);
    // Glowing gas: small rose knots where the dust is thick, a teal wash out along the arms.
    float rose = smoothstep(0.64, 0.82, fbm(d * 27.0 + 21.0, 3)) * near * band;
    float teal = smoothstep(0.58, 0.8, fbm(d * 6.5 + 40.0, 3)) * band * (1.0 - bulge);

    vec3 gal = tint * dens * (1.0 - dust) * 0.31;
    gal += warm * exp(-(dl * dl + lat * lat * 6.0) / 0.02) * 0.15 * (1.0 - dust * 0.9);
    gal += vec3(1.0, 0.26, 0.46) * rose * along * 0.42;
    gal += vec3(0.2, 0.8, 0.78) * teal * along * 0.08;
    // A wide faint glow, so the band has no edge.
    gal += mix(cool, vec3(0.6, 0.5, 1.0), 0.4) * wide * along * (0.02 + 0.03 * clouds);
    // Dust does not only hide: its edges catch the light behind them and go rust-red.
    gal += vec3(0.55, 0.22, 0.12) * dust * (1.0 - dust) * band * along * 0.4;

    // Far from the band: two drifts of thin gas, and a small galaxy seen from outside.
    float veil = smoothstep(0.5, 0.78, fbm(d * 1.9 + 70.0, 4)) * (1.0 - wide);
    gal += mix(vec3(0.22, 0.3, 0.8), vec3(0.6, 0.22, 0.6), fbm(d * 1.3 + 90.0, 2)) * veil * (0.03 + 0.05 * fbm(d * 8.0 + 3.0, 3));
    vec3 e = d - uFar;
    float ex = dot(e, uFarX); float ey = dot(e, uFarY);
    float disc = exp(-(ex * ex / 0.0034 + ey * ey / 0.0006));
    float arms = 0.55 + 0.45 * sin(atan(ey * 2.4, ex) * 2.0 + log(ex * ex / 0.0034 + ey * ey / 0.0006 + 0.02) * 2.2);
    gal += (vec3(0.6, 0.7, 1.0) * disc * arms * 0.3 + vec3(1.0, 0.86, 0.66) * exp(-(ex * ex + ey * ey) / 0.00012) * 0.5);
    gl_FragColor = vec4(sqrt(clamp(gal, 0.0, 1.0)), clamp(band * along * (1.0 - dust) + 0.25 * wide * along, 0.0, 1.0));
  }`;

/** What is drawn every frame: the gradient, the baked galaxy, and its countless faint stars. */
const SKY_FS = /* glsl */ `
  uniform vec3 uTop; uniform vec3 uHorizon;
  uniform samplerCube uMap; uniform float uBaked;
  uniform float uTime; uniform float uEclipse; uniform float uGalaxy; uniform float uStars;
  varying vec3 vDir;
  float hash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y, -0.2, 1.0);
    vec3 col = mix(uHorizon, uTop, pow(smoothstep(-0.05, 0.75, h), 0.6));
    if (d.y > -0.05) {
      vec4 baked = textureCube(uMap, d) * uBaked;
      vec3 gal = baked.rgb * baked.rgb;
      float crowd = baked.a;
      // Stars too faint and too many to place one by one; they crowd toward the band.
      for (int layer = 0; layer < 2; layer++) {
        float grain = layer == 0 ? 190.0 : 410.0;
        vec3 sp = d * grain + float(layer) * 37.0;
        vec3 cell = floor(sp);
        float pick = hash(cell);
        float many = (layer == 0 ? 0.014 + 0.1 * crowd : 0.2 * crowd * crowd) * uStars;
        if (pick < many) {
          vec3 o = vec3(hash(cell + 11.0), hash(cell + 23.0), hash(cell + 37.0));
          float dd = length(fract(sp) - (0.3 + 0.4 * o));
          float tw = 0.72 + 0.28 * sin(uTime * (0.8 + 2.6 * o.x) + 6.283 * o.y);
          float s = smoothstep(0.32, 0.0, dd) * tw * (layer == 0 ? 0.25 + 1.5 * o.z * o.z : 0.5);
          gal += mix(vec3(0.62, 0.76, 1.0), vec3(1.0, 0.84, 0.66), o.x) * s;
        }
      }
      // The eclipse stains it all the colour of the moon's ring.
      float lum = dot(gal, vec3(0.3, 0.5, 0.2));
      gal = mix(gal, lum * vec3(1.9, 0.52, 0.42), uEclipse * 0.78);
      // Thick air near the ground swallows it.
      col += gal * uGalaxy * smoothstep(-0.03, 0.2, d.y);
    }
    gl_FragColor = vec4(col, 1.0);
  }`;

const DOME_VS = /* glsl */ `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const STAR_VS = /* glsl */ `
  attribute float aSize; attribute float aPhase; attribute vec3 aColor;
  uniform float uTime; uniform float uScale; uniform float uGain;
  varying vec3 vColor; varying float vBig;
  void main() {
    float tw = 0.8 + 0.2 * sin(uTime * (0.7 + fract(aPhase * 7.3) * 2.6) + aPhase * 6.283);
    vColor = aColor * tw * uGain;
    vBig = smoothstep(4.5, 7.0, aSize);
    gl_PointSize = max(1.5, aSize * uScale);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const STAR_FS = /* glsl */ `
  varying vec3 vColor; varying float vBig;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = length(p);
    float core = exp(-r * r * mix(5.0, 22.0, vBig));
    float halo = exp(-r * 3.2) * 0.22 * vBig;
    // The brightest few throw four thin rays.
    float rays = (exp(-abs(p.x) * 30.0 - abs(p.y) * 3.0) + exp(-abs(p.y) * 30.0 - abs(p.x) * 3.0)) * 0.7 * vBig;
    gl_FragColor = vec4(vColor * (core + halo + rays) * smoothstep(1.0, 0.75, r), 1.0);
  }`;

interface Meteor {
  mesh: THREE.Mesh;
  from: THREE.Vector3;
  axis: THREE.Vector3;
  arc: number;
  t: number;
  life: number;
  length: number;
}

const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * The night over the arena: a dome carrying the galaxy's band, a few thousand stars that
 * can be told apart, and the odd shooting star. All of it is drawn behind everything else.
 */
export class Sky {
  group = new THREE.Group();
  top = new THREE.Color();
  horizon = new THREE.Color();
  private domeMat: THREE.ShaderMaterial;
  private frame: Record<string, THREE.IUniform>;
  private map: THREE.WebGLCubeRenderTarget | null = null;
  private starMat: THREE.ShaderMaterial;
  private meteors: Meteor[] = [];
  private meteorMat: THREE.MeshBasicMaterial;
  private nextMeteor = 3;
  private time = 0;

  constructor() {
    // The band's own axes: where it rises from the horizon, and the way it climbs from there.
    const node = new THREE.Vector3(POLE.z, 0, -POLE.x).normalize();
    const rise = new THREE.Vector3().crossVectors(POLE, node).normalize();

    // A second, far smaller galaxy hangs on the other side of the sky, tilted.
    const far = new THREE.Vector3(-0.58, 0.52, 0.63).normalize();
    const farX = new THREE.Vector3(0.75, 0.2, 0.52).projectOnPlane(far).normalize();
    const farY = new THREE.Vector3().crossVectors(far, farX);

    this.frame = { uPole: { value: POLE }, uNode: { value: node }, uRise: { value: rise }, uCore: { value: CORE_AT }, uFar: { value: far }, uFarX: { value: farX }, uFarY: { value: farY } };
    this.domeMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: this.top },
        uHorizon: { value: this.horizon },
        uMap: { value: null },
        uBaked: { value: 0 },
        uTime: { value: 0 },
        uEclipse: { value: 0 },
        uGalaxy: { value: 1 },
        uStars: { value: 1 },
      },
      vertexShader: DOME_VS,
      fragmentShader: SKY_FS,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(600, 48, 24), this.domeMat);
    dome.renderOrder = -10;
    this.group.add(dome);

    // Stars bright enough to have a place of their own. Close to half of them keep to the band.
    setSeed(77);
    const n = 4200;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const phase = new Float32Array(n);
    const gauss = () => (rand() + rand() + rand() - 1.5) / 1.5;
    for (let i = 0; i < n; i++) {
      const d = _p;
      do {
        if (rand() < 0.45) {
          const lon = CORE_AT + gauss() * 2.2;
          const lat = gauss() * 0.2;
          d.copy(node).multiplyScalar(Math.cos(lon) * Math.cos(lat)).addScaledVector(rise, Math.sin(lon) * Math.cos(lat)).addScaledVector(POLE, Math.sin(lat));
        } else {
          const u = rand(0.02, 1);
          const th = rand(TAU);
          const s = Math.sqrt(1 - u * u);
          d.set(s * Math.cos(th), u, s * Math.sin(th));
        }
      } while (d.y < 0.02);
      pos.set([d.x * 560, d.y * 560, d.z * 560], i * 3);
      // Most are small and faint; a handful are lamps.
      const m = rand();
      const big = m > 0.994;
      size[i] = big ? rand(7, 10) : 1.5 + Math.pow(m, 5) * 3.6;
      const b = big ? rand(1.8, 2.6) : 0.35 + Math.pow(rand(), 3) * 1.9;
      // Blue-white through yellow to the occasional ember.
      const heat = rand();
      const c = heat < 0.55 ? [0.72, 0.84, 1.0] : heat < 0.82 ? [1.0, 0.97, 0.9] : heat < 0.95 ? [1.0, 0.84, 0.58] : [1.0, 0.56, 0.4];
      col.set([c[0] * b, c[1] * b, c[2] * b], i * 3);
      phase[i] = rand();
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    sg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    sg.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 1 }, uGain: { value: 1 } },
      vertexShader: STAR_VS,
      fragmentShader: STAR_FS,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const stars = new THREE.Points(sg, this.starMat);
    stars.renderOrder = -9;
    stars.frustumCulled = false;
    this.group.add(stars);

    // Shooting stars: a short streak, bright at the head.
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 16;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 256, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.75, 'rgba(190,215,255,0.45)');
    grad.addColorStop(0.97, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 16);
    // Soften the streak's edges across its width.
    const fade = g.createLinearGradient(0, 0, 0, 16);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(0.5, 'rgba(0,0,0,0)');
    fade.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = fade;
    g.fillRect(0, 0, 256, 16);
    this.meteorMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
  }

  /** Draw the galaxy into its cube map. Until this has run the sky is only stars. */
  bake(renderer: THREE.WebGLRenderer, size = 1024) {
    this.map?.dispose();
    this.map = new THREE.WebGLCubeRenderTarget(size, { type: THREE.UnsignedByteType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const mat = new THREE.ShaderMaterial({ uniforms: this.frame, vertexShader: DOME_VS, fragmentShader: GALAXY_FS, side: THREE.BackSide, depthTest: false, depthWrite: false });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), mat);
    const scene = new THREE.Scene();
    scene.add(ball);
    new THREE.CubeCamera(0.1, 100, this.map).update(renderer, scene);
    ball.geometry.dispose();
    mat.dispose();
    this.domeMat.uniforms.uMap.value = this.map.texture;
    this.domeMat.uniforms.uBaked.value = 1;
  }

  /** Star sizes are in screen pixels, so they follow the height of the picture. */
  setView(pixelHeight: number) {
    this.starMat.uniforms.uScale.value = pixelHeight / 1000;
  }

  private shoot() {
    // Somewhere well above the horizon, travelling down and across.
    const az = rand(TAU);
    const el = rand(0.5, 1.15);
    const from = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    const heading = rand(-0.9, 0.9);
    // Turning about this axis carries the star down the sky, slanted by `heading`.
    _t.set(Math.cos(az), 0, -Math.sin(az));
    const axis = _t.clone().applyAxisAngle(from, heading).normalize();
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(-0.5, 0, 0);
    const mesh = new THREE.Mesh(geo, this.meteorMat.clone());
    mesh.renderOrder = -8;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.meteors.push({ mesh, from, axis, arc: rand(0.22, 0.42), t: 0, life: rand(0.5, 0.95), length: rand(34, 70) });
  }

  /** `eclipse`: 0 moonlit, 1 the moon covered. */
  update(dt: number, eclipse: number) {
    this.time += dt;
    const u = this.domeMat.uniforms;
    u.uTime.value = this.time;
    u.uEclipse.value = eclipse;
    u.uGalaxy.value = SKY_LOOK.galaxy;
    u.uStars.value = SKY_LOOK.stars;
    this.starMat.uniforms.uTime.value = this.time;
    this.starMat.uniforms.uGain.value = SKY_LOOK.stars;

    this.nextMeteor -= dt;
    if (this.nextMeteor <= 0) {
      this.nextMeteor = rand(SKY_LOOK.meteors[0], SKY_LOOK.meteors[1]);
      this.shoot();
    }
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.t += dt / m.life;
      if (m.t >= 1) {
        this.group.remove(m.mesh);
        m.mesh.geometry.dispose();
        (m.mesh.material as THREE.Material).dispose();
        this.meteors.splice(i, 1);
        continue;
      }
      const k = m.t;
      _p.copy(m.from).applyAxisAngle(m.axis, m.arc * k);
      // Its tail lies back along the way it came.
      _t.crossVectors(m.axis, _p).normalize();
      _n.crossVectors(_p, _t);
      _m.makeBasis(_t, _n, _p);
      m.mesh.quaternion.setFromRotationMatrix(_m);
      m.mesh.position.copy(_p).multiplyScalar(545);
      m.mesh.scale.set(m.length * Math.min(1, k * 4), 1.5, 1);
      const mat = m.mesh.material as THREE.MeshBasicMaterial;
      const a = Math.sin(Math.PI * Math.min(1, k * 1.15)) ** 0.6;
      mat.color.setRGB(2.4 * a, 2.6 * a, 3.0 * a);
      if (eclipse > 0.5) mat.color.setRGB(3.0 * a, 1.5 * a, 1.2 * a);
    }
  }
}
