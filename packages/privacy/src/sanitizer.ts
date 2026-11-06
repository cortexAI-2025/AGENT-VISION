import {
  type CustomPattern,
  type PixelRegion,
  decodePng,
  detectSecrets,
  maskRegions,
  pngSize,
  sha256Hex,
} from "@agent-vision/core";
import type { OcrEngine, OcrWord } from "./ocr.js";

/** Échec de la chaîne de sécurité : l'image NE DOIT PAS être transmise (fail-closed). */
export class SanitizeError extends Error {
  constructor(public readonly reason: "ocr_failed" | "verification_failed" | "timeout", message: string) {
    super(message);
  }
}

export interface SanitizeOptions {
  custom?: CustomPattern[];
  /** Marge (px) autour des mots masqués. */
  padding?: number;
  /** Les mots sous ce seuil de confiance dans une ligne contenant un secret sont masqués quand même. */
  timeoutMs?: number;
  /** Détection heuristique des chaînes à forte entropie (jetons inconnus). */
  highEntropy?: boolean;
}

export interface SanitizeResult {
  png: Buffer;
  regions: PixelRegion[];
  kinds: string[];
  wordsRead: number;
  verified: true;
  engine: string;
  /** Empreinte de l'image d'entrée : permet la déduplication sans conserver l'image. */
  inputSha256: string;
}

export interface ImageSanitizer {
  sanitize(png: Buffer, opts?: SanitizeOptions): Promise<SanitizeResult>;
}

const entropy = (s: string) => {
  const f = new Map<string, number>();
  for (const c of s) f.set(c, (f.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of f.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
};

/** Chaînes longues, mélange lettres/chiffres, entropie élevée : probable jeton ou clé. */
export function looksLikeToken(w: string): boolean {
  const t = w.replace(/^[^\w]+|[^\w]+$/g, "");
  return t.length >= 24 && /[A-Za-z]/.test(t) && /\d/.test(t) && !/^https?:/i.test(w) && entropy(t) >= 3.5;
}

interface Hit {
  kind: string;
  words: OcrWord[];
}

/** Regroupe les mots par ligne, détecte les secrets sur le texte de la ligne et retrouve les mots concernés. */
export function findSensitiveWords(words: OcrWord[], opts: SanitizeOptions = {}): Hit[] {
  const hits: Hit[] = [];
  const byLine = new Map<number, OcrWord[]>();
  for (const w of words) {
    if (!w.text.trim()) continue;
    byLine.set(w.line, [...(byLine.get(w.line) ?? []), w]);
  }
  for (const lineWords of byLine.values()) {
    let text = "";
    const spans = lineWords.map((w) => {
      const start = text.length;
      text += (text ? " " : "") + w.text;
      return { w, start: text.length - w.text.length, end: text.length };
    });
    for (const m of detectSecrets(text, opts.custom)) {
      const ws = spans.filter((s) => s.start < m.end && s.end > m.start).map((s) => s.w);
      if (ws.length) hits.push({ kind: m.kind, words: ws });
    }
    if (opts.highEntropy !== false) {
      for (const w of lineWords) if (looksLikeToken(w.text)) hits.push({ kind: "high_entropy_token", words: [w] });
    }
  }
  return hits;
}

export class OcrSanitizer implements ImageSanitizer {
  constructor(private readonly engine: OcrEngine, private readonly defaults: SanitizeOptions = {}) {}

  private async read(png: Buffer, timeoutMs: number): Promise<OcrWord[]> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.engine.recognize(png),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new SanitizeError("timeout", "OCR timeout")), timeoutMs);
        }),
      ]);
    } catch (e) {
      if (e instanceof SanitizeError) throw e;
      throw new SanitizeError("ocr_failed", `OCR failed: ${(e as Error).message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async sanitize(png: Buffer, o: SanitizeOptions = {}): Promise<SanitizeResult> {
    const opts = { ...this.defaults, ...o };
    const { width, height } = pngSize(png);
    const words = await this.read(png, opts.timeoutMs ?? 60_000);
    const pad = opts.padding ?? 3;

    const hits = findSensitiveWords(words, opts);
    const regions: PixelRegion[] = [];
    const kinds = new Set<string>();
    for (const h of hits) {
      kinds.add(h.kind);
      for (const w of h.words) {
        const x = Math.max(0, w.box.x - pad);
        const y = Math.max(0, w.box.y - pad);
        regions.push({ x, y, width: Math.min(width - x, w.box.width + 2 * pad), height: Math.min(height - y, w.box.height + 2 * pad) });
      }
    }
    const out = regions.length ? maskRegions(png, regions) : png;

    // --- vérification : (1) les pixels masqués sont noirs ; (2) une seconde lecture OCR ne retrouve plus aucun secret
    if (regions.length) {
      const dec = decodePng(out);
      for (const r of regions) {
        const i = (Math.min(height - 1, r.y + (r.height >> 1)) * dec.width + Math.min(width - 1, r.x + (r.width >> 1))) * 4;
        if (dec.data[i] !== 0 || dec.data[i + 1] !== 0 || dec.data[i + 2] !== 0) {
          throw new SanitizeError("verification_failed", "mask was not applied");
        }
      }
      const again = findSensitiveWords(await this.read(out, opts.timeoutMs ?? 60_000), opts);
      if (again.length) {
        throw new SanitizeError("verification_failed", `${again.length} sensitive item(s) still readable after masking`);
      }
    }
    return { png: out, regions, kinds: [...kinds], wordsRead: words.length, verified: true, engine: this.engine.name, inputSha256: sha256Hex(png) };
  }
}
