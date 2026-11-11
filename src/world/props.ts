import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

interface PropEntry {
  file: string;
  /** Degrees about x, y, z that stand the model upright, facing +z. */
  turn?: [number, number, number];
}

export interface FitOpts {
  /**
   * 'fill' stretches the model to the box on every axis (the default); 'height' and 'width'
   * scale it evenly so that one dimension matches and the proportions stay as modelled.
   */
  mode?: 'fill' | 'height' | 'width';
  /** Flip left for right, to make the other one of a pair. */
  mirror?: boolean;
  /** Extra turn in degrees about x, y, z, applied before fitting. */
  turn?: [number, number, number];
}

const loader = new GLTFLoader();
const RAD = Math.PI / 180;

/**
 * The generated scenery (the boss's armour pieces, the arena's ruins): static models made by
 * `tools/tripo.mjs prop` and listed in public/models/props.json. Anything not on disk is
 * simply absent, and whoever asked for it falls back to its procedural shape.
 */
export class Props {
  private models = new Map<string, THREE.Object3D>();

  async load() {
    let manifest: Record<string, PropEntry> = {};
    try {
      const res = await fetch('/models/props.json');
      if (res.ok) manifest = (await res.json()) as Record<string, PropEntry>;
    } catch {
      return;
    }
    await Promise.all(
      Object.entries(manifest).map(async ([name, entry]) => {
        try {
          const gltf = await loader.loadAsync(`/models/${entry.file}`);
          const root = gltf.scene;
          const [x, y, z] = entry.turn ?? [0, 0, 0];
          root.rotation.set(x * RAD, y * RAD, z * RAD);
          root.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            m.castShadow = true;
            m.receiveShadow = true;
            // Shared by every copy: owners must not dispose it.
            m.geometry.userData.shared = true;
          });
          this.models.set(name, root);
        } catch (err) {
          console.warn(`[props] ${name}: failed to load, using the procedural shape`, err);
        }
      }),
    );
  }

  has(name: string) {
    return this.models.has(name);
  }

  get count() {
    return this.models.size;
  }

  /**
   * A copy of a model sized to a box `w` x `h` x `d` and centred on the origin of the group
   * returned. Geometry and materials are shared between copies.
   */
  fit(name: string, w: number, h: number, d: number, opts: FitOpts = {}): THREE.Group | null {
    const src = this.models.get(name);
    if (!src) return null;
    const turned = new THREE.Group();
    turned.add(src.clone());
    if (opts.turn) turned.rotation.set(opts.turn[0] * RAD, opts.turn[1] * RAD, opts.turn[2] * RAD);
    turned.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(turned);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const scaled = new THREE.Group();
    scaled.add(turned);
    turned.position.sub(centre);
    if (opts.mode === 'height') scaled.scale.setScalar(h / size.y);
    else if (opts.mode === 'width') scaled.scale.setScalar(w / size.x);
    else scaled.scale.set(w / size.x, h / size.y, d / size.z);
    if (opts.mirror) scaled.scale.x *= -1;
    const out = new THREE.Group();
    out.add(scaled);
    out.userData.size = size.multiply(new THREE.Vector3(Math.abs(scaled.scale.x), scaled.scale.y, scaled.scale.z));
    return out;
  }

  /** The materials a model uses, for owners that restyle them. */
  static materials(root: THREE.Object3D, fn: (m: THREE.MeshStandardMaterial, mesh: THREE.Mesh) => THREE.Material) {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = fn(mesh.material as THREE.MeshStandardMaterial, mesh);
    });
  }
}
