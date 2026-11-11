import * as THREE from 'three';
import { clamp, damp, dampAngle, yawOf, type V3 } from '../core/math';
import type { Fx } from '../core/fx';

const _pivot = new THREE.Vector3();
const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** Third-person orbit camera with a lock-on mode that frames the player against a very tall target. */
export class CameraRig {
  camera: THREE.PerspectiveCamera;
  /** Direction the camera looks along, flattened: forward = (sin yaw, 0, cos yaw). */
  yaw = Math.PI;
  /** Positive looks up. */
  pitch = -0.12;
  distance = 7.2;
  fov = 58;
  /** When set, the camera is driven by a cinematic instead of the player. */
  override: { pos: V3; look: V3; fov?: number } | null = null;
  private pos = new THREE.Vector3(0, 4, 30);
  private lookAt = new THREE.Vector3();
  private dist = 7.2;
  private blocked = 7.2;
  private snap = true;
  private glideT = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.fov, aspect, 0.2, 1500);
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Jump straight to the target framing on the next update (after cinematics, respawns). */
  snapNext() {
    this.snap = true;
  }

  /** Follow more loosely for a moment, so a change of Knight reads as a pan rather than a cut. */
  glide(seconds: number) {
    this.glideT = seconds;
  }

  update(
    dt: number,
    player: V3,
    playerHeight: number,
    look: { x: number; y: number },
    lockTarget: V3 | null,
    fx: Fx,
    sprinting: boolean,
    blockers: { pos: V3; r: number }[] = [],
  ) {
    const cam = this.camera;
    if (this.override) {
      const k = this.snap ? 1 : 1 - Math.exp(-5 * dt);
      this.pos.lerp(this.override.pos, k);
      this.lookAt.lerp(this.override.look, k);
      cam.fov = damp(cam.fov, this.override.fov ?? 50, 4, dt);
      this.snap = false;
    } else {
      _pivot.set(player.x, player.y + Math.max(1.15, playerHeight * 0.82), player.z);
      let wantDist = this.distance;
      if (lockTarget) {
        const dx = lockTarget.x - player.x;
        const dz = lockTarget.z - player.z;
        const horiz = Math.hypot(dx, dz);
        const wantYaw = yawOf(dx, dz);
        // Look partway up toward high targets and pull back so the player stays in frame.
        const wantPitch = clamp(Math.atan2(lockTarget.y - _pivot.y, Math.max(4, horiz)) * 0.55 - 0.1, -0.5, 0.62);
        this.yaw = dampAngle(this.yaw, wantYaw, 7, dt);
        this.pitch = damp(this.pitch, wantPitch, 5, dt);
        wantDist += Math.max(0, this.pitch) * 5.5 + clamp(8 - horiz, 0, 6) * 0.35;
      } else {
        this.yaw -= look.x;
        this.pitch = clamp(this.pitch - look.y, -1.2, 0.85);
        wantDist += Math.max(0, this.pitch) * 4;
      }
      this.dist = damp(this.dist, wantDist, 5, dt);
      const cp = Math.cos(this.pitch);
      _dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
      // Pull the camera in front of anything huge that sits between it and the Knight.
      let reach = this.dist;
      for (const b of blockers) {
        const r = b.r + 0.6;
        _look.subVectors(_pivot, b.pos);
        if (_look.lengthSq() < r * r) continue;
        // Ray from the pivot going backwards (-dir) against the sphere.
        const bq = -_look.dot(_dir);
        const cq = _look.lengthSq() - r * r;
        const disc = bq * bq - cq;
        if (disc <= 0) continue;
        const t = -bq - Math.sqrt(disc);
        if (t > 0 && t < reach) reach = t;
      }
      reach = Math.max(1.6, reach - 0.25);
      this.blocked = damp(this.blocked, reach < this.dist ? reach : this.dist, reach < this.blocked ? 30 : 4, dt);
      const wantPos = _look.copy(_pivot).addScaledVector(_dir, -Math.min(this.dist, this.blocked));
      wantPos.y = Math.max(0.35, wantPos.y);
      this.glideT = Math.max(0, this.glideT - dt);
      const follow = this.glideT > 0 ? 5 : 14;
      const k = this.snap ? 1 : 1 - Math.exp(-follow * dt);
      this.pos.lerp(wantPos, k);
      // Aim past the player so the target side of the screen is open.
      const aim = _look.copy(_pivot).addScaledVector(_dir, 9);
      aim.y += 0.5;
      this.lookAt.lerp(aim, this.snap ? 1 : 1 - Math.exp(-(follow + 2) * dt));
      cam.fov = damp(cam.fov, this.fov + (sprinting ? 4 : 0), 4, dt);
      this.snap = false;
    }
    cam.position.copy(this.pos).add(fx.shakeOffset);
    cam.lookAt(this.lookAt);
    cam.rotateZ(fx.shakeRoll);
    cam.updateProjectionMatrix();
    fx.listener.copy(this.pos);
  }
}
