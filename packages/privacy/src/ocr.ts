import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { PixelRegion } from "@agent-vision/core";

export interface OcrWord {
  text: string;
  /** 0..100 */
  confidence: number;
  box: PixelRegion;
  /** Index de ligne (les mots d'une même ligne partagent le même index). */
  line: number;
}

export interface OcrEngine {
  readonly name: string;
  recognize(png: Buffer): Promise<OcrWord[]>;
  close?(): Promise<void>;
}

/**
 * OCR local Tesseract (tesseract.js, WASM) avec le modèle anglais embarqué
 * (@tesseract.js-data/eng) : aucun téléchargement, aucun service distant.
 */
export class TesseractEngine implements OcrEngine {
  readonly name = "tesseract.js";
  private worker?: Promise<import("tesseract.js").Worker>;

  private getWorker() {
    this.worker ??= (async () => {
      const { createWorker } = await import("tesseract.js");
      const req = createRequire(import.meta.url);
      const langPath = join(dirname(req.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
      return createWorker("eng", 1, { langPath, gzip: true, cacheMethod: "none" });
    })();
    return this.worker;
  }

  async recognize(png: Buffer): Promise<OcrWord[]> {
    const w = await this.getWorker();
    const { data } = await w.recognize(png, {}, { blocks: true });
    const words: OcrWord[] = [];
    let line = 0;
    for (const b of data.blocks ?? [])
      for (const p of b.paragraphs)
        for (const l of p.lines) {
          for (const x of l.words) {
            words.push({
              text: x.text,
              confidence: x.confidence,
              box: { x: x.bbox.x0, y: x.bbox.y0, width: Math.max(1, x.bbox.x1 - x.bbox.x0), height: Math.max(1, x.bbox.y1 - x.bbox.y0) },
              line,
            });
          }
          line++;
        }
    return words;
  }

  async close(): Promise<void> {
    if (this.worker) await (await this.worker).terminate();
    this.worker = undefined;
  }
}
