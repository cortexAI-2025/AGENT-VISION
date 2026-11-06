import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AnalysisReport, VisualReport, newId } from "@agent-vision/core";

export const CaptureMeta = z.object({
  captureId: z.string(),
  ownerAgent: z.string(),
  deviceId: z.string(),
  platform: z.string().optional(),
  capturedAt: z.string(),
  storedAt: z.string(),
  expiresAt: z.string(),
  backend: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  sha256: z.string(),
  windowTitle: z.string().optional(),
  reason: z.string().optional(),
  hasRedacted: z.boolean().default(false),
  /** Agents autorisés à lire (en plus du propriétaire) — alimenté par share_visual_report. */
  sharedWith: z.array(z.string()).default([]),
});
export type CaptureMeta = z.infer<typeof CaptureMeta>;

const SAFE_ID = /^[A-Za-z0-9_-]{4,64}$/;
function assertId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error("invalid id"); // empêche toute traversée de chemin
}

/** Stockage local sur disque (aucun cloud). Les captures ont une durée de vie et sont supprimables. */
export class Store {
  private readonly caps: string;
  private readonly reports: string;

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.caps = join(dataDir, "captures");
    this.reports = join(dataDir, "reports");
    mkdirSync(this.caps, { recursive: true, mode: 0o700 });
    mkdirSync(this.reports, { recursive: true, mode: 0o700 });
  }

  saveCapture(png: Buffer, m: Omit<CaptureMeta, "captureId" | "storedAt" | "expiresAt" | "hasRedacted" | "sharedWith">, ttlSeconds: number): CaptureMeta {
    const meta: CaptureMeta = {
      ...m,
      captureId: newId("cap"),
      storedAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + ttlSeconds * 1000).toISOString(),
      hasRedacted: false,
      sharedWith: [],
    };
    writeFileSync(join(this.caps, `${meta.captureId}.png`), png, { mode: 0o600 });
    this.writeMeta(meta);
    return meta;
  }

  private writeMeta(m: CaptureMeta): void {
    writeFileSync(join(this.caps, `${m.captureId}.json`), JSON.stringify(m), { mode: 0o600 });
  }

  getMeta(id: string): CaptureMeta | undefined {
    assertId(id);
    const p = join(this.caps, `${id}.json`);
    if (!existsSync(p)) return undefined;
    const m = CaptureMeta.parse(JSON.parse(readFileSync(p, "utf8")));
    if (Date.parse(m.expiresAt) <= this.now()) {
      this.deleteCapture(id);
      return undefined;
    }
    return m;
  }

  getPng(id: string, redacted = false): Buffer | undefined {
    if (!this.getMeta(id)) return undefined;
    const p = join(this.caps, `${id}${redacted ? ".redacted" : ""}.png`);
    return existsSync(p) ? readFileSync(p) : undefined;
  }

  saveRedacted(id: string, png: Buffer): void {
    const m = this.getMeta(id);
    if (!m) throw new Error("unknown capture");
    writeFileSync(join(this.caps, `${id}.redacted.png`), png, { mode: 0o600 });
    this.writeMeta({ ...m, hasRedacted: true });
  }

  shareCapture(id: string, withAgent: string): void {
    const m = this.getMeta(id);
    if (!m) throw new Error("unknown capture");
    if (!m.sharedWith.includes(withAgent)) this.writeMeta({ ...m, sharedWith: [...m.sharedWith, withAgent] });
  }

  deleteCapture(id: string): boolean {
    assertId(id);
    let any = false;
    for (const suffix of [".png", ".redacted.png", ".json", ".analysis.json"]) {
      const p = join(this.caps, `${id}${suffix}`);
      if (existsSync(p)) {
        rmSync(p, { force: true });
        any = true;
      }
    }
    return any;
  }

  // ---- analyses attachées à une capture
  saveAnalysis(r: AnalysisReport): void {
    writeFileSync(join(this.caps, `${r.captureId}.analysis.json`), JSON.stringify(r), { mode: 0o600 });
  }
  getAnalysis(captureId: string): AnalysisReport | undefined {
    assertId(captureId);
    const p = join(this.caps, `${captureId}.analysis.json`);
    return existsSync(p) && this.getMeta(captureId) ? AnalysisReport.parse(JSON.parse(readFileSync(p, "utf8"))) : undefined;
  }

  // ---- rapports partagés
  saveReport(r: VisualReport, ttlSeconds: number): void {
    writeFileSync(join(this.reports, `${r.id}.json`), JSON.stringify({ ...r, expiresAt: new Date(this.now() + ttlSeconds * 1000).toISOString() }), { mode: 0o600 });
  }
  getReport(id: string): VisualReport | undefined {
    assertId(id);
    const p = join(this.reports, `${id}.json`);
    if (!existsSync(p)) return undefined;
    const raw = JSON.parse(readFileSync(p, "utf8")) as { expiresAt: string };
    if (Date.parse(raw.expiresAt) <= this.now()) {
      rmSync(p, { force: true });
      return undefined;
    }
    return VisualReport.parse(raw);
  }
  listReportsFor(agentId: string): VisualReport[] {
    return readdirSync(this.reports)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.getReport(f.slice(0, -5)))
      .filter((r): r is VisualReport => !!r && r.to === agentId);
  }
  deleteReport(id: string): boolean {
    assertId(id);
    const p = join(this.reports, `${id}.json`);
    if (!existsSync(p)) return false;
    rmSync(p, { force: true });
    return true;
  }

  /** Supprime tout ce qui a expiré. Retourne le nombre d'éléments purgés. */
  purgeExpired(): number {
    let n = 0;
    for (const f of readdirSync(this.caps).filter((f) => /^cap_[^.]+\.json$/.test(f))) {
      if (!this.getMeta(f.slice(0, -5))) n++; // getMeta supprime les expirés
    }
    for (const f of readdirSync(this.reports).filter((f) => f.endsWith(".json"))) {
      if (!this.getReport(f.slice(0, -5))) n++;
    }
    return n;
  }
}
