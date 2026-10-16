import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import { createNoise2D, smoothstep, clamp } from '../core/math';

export interface TerrainOptions {
  size: number;
  segments: number;
  seed: number;
}

/**
 * Low-poly heightfield. Heights are generated once into a grid; `heightAt` interpolates
 * the exact same triangles that are rendered, so the character never floats or sinks.
 */
export class Terrain {
  readonly mesh: Mesh;
  readonly size: number;
  readonly half: number;
  private readonly n: number;
  private readonly cell: number;
  private readonly heights: Float32Array;

  constructor({ size, segments, seed }: TerrainOptions) {
    this.size = size;
    this.half = size / 2;
    this.n = segments;
    this.cell = size / segments;
    this.heights = new Float32Array((segments + 1) * (segments + 1));

    const base = createNoise2D(seed);
    const detail = createNoise2D(seed + 1);
    const warp = createNoise2D(seed + 2);

    for (let j = 0; j <= segments; j++) {
      for (let i = 0; i <= segments; i++) {
        const x = -this.half + i * this.cell;
        const z = -this.half + j * this.cell;
        this.heights[j * (segments + 1) + i] = this.generate(x, z, base, detail, warp);
      }
    }

    this.mesh = new Mesh(this.buildGeometry(seed), new MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.95,
      metalness: 0,
    }));
    this.mesh.receiveShadow = true;
    this.mesh.name = 'terrain';
  }

  private generate(
    x: number,
    z: number,
    base: (x: number, y: number) => number,
    detail: (x: number, y: number) => number,
    warp: (x: number, y: number) => number,
  ) {
    // Domain-warped fBm: rolling hills with a few bigger mounds.
    const wx = x + warp(x * 0.01, z * 0.01) * 12;
    const wz = z + warp(x * 0.01 + 50, z * 0.01 + 50) * 12;
    let h = 0;
    let amp = 1;
    let freq = 0.011;
    for (let o = 0; o < 4; o++) {
      h += base(wx * freq, wz * freq) * amp;
      amp *= 0.45;
      freq *= 2.1;
    }
    h = h * 7.5 + Math.pow(Math.max(0, base(wx * 0.006 + 9, wz * 0.006 - 4)), 2) * 18;
    h += detail(x * 0.18, z * 0.18) * 0.25;

    // Flat spawn arena, gently blended into the hills.
    const r = Math.hypot(x, z);
    const arena = smoothstep(16, 34, r);
    h = h * arena + 0.0 * (1 - arena);

    // Raise the rim so the world feels enclosed.
    const edge = smoothstep(this.half * 0.72, this.half * 0.98, Math.max(Math.abs(x), Math.abs(z)));
    h += edge * 22;
    return h;
  }

  private buildGeometry(seed: number) {
    const n = this.n;
    const tris = n * n * 2;
    const pos = new Float32Array(tris * 9);
    const col = new Float32Array(tris * 9);
    const tint = createNoise2D(seed + 7);

    const grassA = new Color('#5d7a3a');
    const grassB = new Color('#7b8a45');
    const dry = new Color('#9a8a55');
    const dirt = new Color('#6b5a40');
    const rock = new Color('#6e6a64');
    const rockDark = new Color('#4f4c49');
    const arena = new Color('#7d7464');

    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const e1 = new Vector3();
    const e2 = new Vector3();
    const nrm = new Vector3();
    const tmp = new Color();
    let p = 0;

    const vert = (i: number, j: number, out: Vector3) =>
      out.set(-this.half + i * this.cell, this.heights[j * (n + 1) + i], -this.half + j * this.cell);

    const pushTri = () => {
      e1.subVectors(b, a);
      e2.subVectors(c, a);
      nrm.crossVectors(e2, e1).normalize();
      if (nrm.y < 0) nrm.negate();
      const cx = (a.x + b.x + c.x) / 3;
      const cy = (a.y + b.y + c.y) / 3;
      const cz = (a.z + b.z + c.z) / 3;
      const slope = 1 - nrm.y; // 0 flat .. 1 vertical
      const t = tint(cx * 0.04, cz * 0.04) * 0.5 + 0.5;

      tmp.copy(grassA).lerp(grassB, t);
      tmp.lerp(dry, smoothstep(6, 16, cy) * 0.7);
      const r = Math.hypot(cx, cz);
      tmp.lerp(arena, (1 - smoothstep(9, 15, r)) * 0.85);
      tmp.lerp(dirt, smoothstep(0.12, 0.22, slope) * 0.8);
      tmp.lerp(t > 0.5 ? rock : rockDark, smoothstep(0.22, 0.38, slope));
      // tiny per-face jitter gives the faceted look some life
      const jit = 0.94 + ((Math.sin(cx * 12.9898 + cz * 78.233) * 43758.5453) % 1) * 0.06;
      tmp.multiplyScalar(clamp(jit, 0.88, 1.06));

      for (const v of [a, b, c]) {
        pos[p] = v.x; pos[p + 1] = v.y; pos[p + 2] = v.z;
        col[p] = tmp.r; col[p + 1] = tmp.g; col[p + 2] = tmp.b;
        p += 3;
      }
    };

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        // Triangle split must match heightAt().
        vert(i, j, a); vert(i, j + 1, b); vert(i + 1, j, c); pushTri();
        vert(i + 1, j, a); vert(i, j + 1, b); vert(i + 1, j + 1, c); pushTri();
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('color', new BufferAttribute(col, 3));
    geo.computeVertexNormals();
    // Winding: make sure faces point up.
    const idx = geo.getAttribute('normal');
    if (idx.getY(0) < 0) {
      for (let k = 0; k < pos.length; k += 9) {
        for (let q = 0; q < 3; q++) {
          const t = pos[k + 3 + q]; pos[k + 3 + q] = pos[k + 6 + q]; pos[k + 6 + q] = t;
          const u = col[k + 3 + q]; col[k + 3 + q] = col[k + 6 + q]; col[k + 6 + q] = u;
        }
      }
      geo.computeVertexNormals();
    }
    geo.computeBoundingSphere();
    return geo;
  }

  /** Exact surface height at world (x, z). */
  heightAt(x: number, z: number): number {
    const n = this.n;
    const gx = clamp((x + this.half) / this.cell, 0, n - 1e-4);
    const gz = clamp((z + this.half) / this.cell, 0, n - 1e-4);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const h = this.heights;
    const w = n + 1;
    const h00 = h[j * w + i];
    const h10 = h[j * w + i + 1];
    const h01 = h[(j + 1) * w + i];
    const h11 = h[(j + 1) * w + i + 1];
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  normalAt(x: number, z: number, out = new Vector3()): Vector3 {
    const e = 0.3;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }
}
