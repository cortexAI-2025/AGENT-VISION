import { PNG } from "pngjs";
import type { DiffResult, NormalizedRegion, PixelRegion } from "./schemas.js";

export function decodePng(buf: Buffer): PNG {
  return PNG.sync.read(buf);
}

export function encodePng(png: PNG): Buffer {
  return PNG.sync.write(png);
}

export function pngSize(buf: Buffer): { width: number; height: number } {
  // lecture de l'en-tête IHDR sans décoder toute l'image
  if (buf.length < 24 || buf.toString("ascii", 1, 4) !== "PNG") throw new Error("not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function toPixelRegion(r: NormalizedRegion, width: number, height: number): PixelRegion {
  const x = Math.max(0, Math.min(width - 1, Math.floor(r.x * width)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(r.y * height)));
  const w = Math.max(1, Math.min(width - x, Math.ceil(r.width * width)));
  const h = Math.max(1, Math.min(height - y, Math.ceil(r.height * height)));
  return { x, y, width: w, height: h };
}

/** Remplit les régions par un aplat noir (irréversible). Retourne un nouveau PNG. */
export function maskRegions(buf: Buffer, regions: PixelRegion[]): Buffer {
  if (regions.length === 0) return buf;
  const png = decodePng(buf);
  for (const r of regions) {
    const x1 = Math.min(png.width, r.x + r.width);
    const y1 = Math.min(png.height, r.y + r.height);
    for (let y = Math.max(0, r.y); y < y1; y++) {
      for (let x = Math.max(0, r.x); x < x1; x++) {
        const i = (y * png.width + x) * 4;
        png.data[i] = 0;
        png.data[i + 1] = 0;
        png.data[i + 2] = 0;
        png.data[i + 3] = 255;
      }
    }
  }
  return encodePng(png);
}

/** Vrai si l'image est d'une seule couleur (écran noir : verrouillé, contenu protégé, échec de capture). */
export function isUniformFrame(buf: Buffer, tolerance = 2): boolean {
  const png = decodePng(buf);
  const d = png.data;
  if (d.length < 4) return true;
  const [r0, g0, b0] = [d[0]!, d[1]!, d[2]!];
  // échantillonnage : pas de ~1 pixel sur 7 pour rester rapide sur du 4K
  for (let i = 0; i < d.length; i += 28) {
    if (
      Math.abs(d[i]! - r0) > tolerance ||
      Math.abs(d[i + 1]! - g0) > tolerance ||
      Math.abs(d[i + 2]! - b0) > tolerance
    ) {
      return false;
    }
  }
  return true;
}

export interface DiffOptions {
  /** Écart max par canal (0..255) en dessous duquel un pixel est considéré identique. */
  pixelThreshold?: number;
  /** Taille de la grille servant à regrouper les différences en régions. */
  cell?: number;
  /** Ratio de pixels modifiés au-dessus duquel le verdict est "significant_changes". */
  significantRatio?: number;
}

export function diffPng(
  beforeBuf: Buffer,
  afterBuf: Buffer,
  opts: DiffOptions = {},
): { result: DiffResult; overlay?: Buffer } {
  const { pixelThreshold = 16, cell = 32, significantRatio = 0.02 } = opts;
  const a = decodePng(beforeBuf);
  const b = decodePng(afterBuf);
  const base = {
    before: { width: a.width, height: a.height },
    after: { width: b.width, height: b.height },
  };
  if (a.width !== b.width || a.height !== b.height) {
    return {
      result: {
        identicalDimensions: false,
        ...base,
        changedPixelRatio: 1,
        changedPixels: 0,
        verdict: "incomparable",
        regions: [],
      },
    };
  }
  const { width, height } = a;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const cellHits = new Uint32Array(cols * rows);
  const overlay = new PNG({ width, height });
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const dr = Math.abs(a.data[i]! - b.data[i]!);
      const dg = Math.abs(a.data[i + 1]! - b.data[i + 1]!);
      const db = Math.abs(a.data[i + 2]! - b.data[i + 2]!);
      const diff = Math.max(dr, dg, db) > pixelThreshold;
      if (diff) {
        changed++;
        cellHits[Math.floor(y / cell) * cols + Math.floor(x / cell)]!++;
        overlay.data[i] = 255;
        overlay.data[i + 1] = 0;
        overlay.data[i + 2] = 0;
        overlay.data[i + 3] = 255;
      } else {
        overlay.data[i] = b.data[i]! >> 1;
        overlay.data[i + 1] = b.data[i + 1]! >> 1;
        overlay.data[i + 2] = b.data[i + 2]! >> 1;
        overlay.data[i + 3] = 255;
      }
    }
  }
  const regions = clusterCells(cellHits, cols, rows, cell, width, height);
  const ratio = changed / (width * height);
  const verdict = changed === 0 ? "identical" : ratio >= significantRatio ? "significant_changes" : "minor_changes";
  return {
    result: {
      identicalDimensions: true,
      ...base,
      changedPixelRatio: ratio,
      changedPixels: changed,
      verdict,
      regions,
    },
    overlay: changed > 0 ? encodePng(overlay) : undefined,
  };
}

/** Composantes connexes (8-voisinage) des cellules touchées → boîtes englobantes. */
function clusterCells(
  hits: Uint32Array,
  cols: number,
  rows: number,
  cell: number,
  width: number,
  height: number,
): PixelRegion[] {
  const seen = new Uint8Array(hits.length);
  const out: PixelRegion[] = [];
  for (let start = 0; start < hits.length; start++) {
    if (!hits[start] || seen[start]) continue;
    let minC = cols,
      minR = rows,
      maxC = 0,
      maxR = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const idx = stack.pop()!;
      const c = idx % cols;
      const r = Math.floor(idx / cols);
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const n = nr * cols + nc;
          if (hits[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    const x = minC * cell;
    const y = minR * cell;
    out.push({
      x,
      y,
      width: Math.min(width, (maxC + 1) * cell) - x,
      height: Math.min(height, (maxR + 1) * cell) - y,
    });
  }
  return out.sort((p, q) => q.width * q.height - p.width * p.height);
}
