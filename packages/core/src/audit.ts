import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { sha256Hex } from "./ids.js";

export interface AuditEntry {
  ts: string;
  actor: string;
  action: string;
  outcome: "allowed" | "denied" | "error";
  details?: Record<string, unknown>;
}

interface StoredEntry extends AuditEntry {
  prev: string;
  hash: string;
}

/**
 * Journal JSONL chaîné par hachage : toute modification ou suppression d'une ligne
 * antérieure est détectable par verify(). (Tamper-evident, pas tamper-proof :
 * un attaquant ayant les droits d'écriture peut recalculer toute la chaîne.)
 */
export class AuditLog {
  private last = "genesis";

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      const tail = lines.at(-1);
      if (tail) this.last = (JSON.parse(tail) as StoredEntry).hash;
    }
  }

  write(entry: Omit<AuditEntry, "ts">): void {
    const body: AuditEntry = { ts: new Date().toISOString(), ...entry };
    const hash = sha256Hex(this.last + JSON.stringify(body));
    appendFileSync(this.path, JSON.stringify({ ...body, prev: this.last, hash }) + "\n", { mode: 0o600 });
    this.last = hash;
  }

  static verify(path: string): { ok: boolean; entries: number; brokenAt?: number } {
    if (!existsSync(path)) return { ok: true, entries: 0 };
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    let prev = "genesis";
    for (let i = 0; i < lines.length; i++) {
      let parsed: StoredEntry;
      try {
        parsed = JSON.parse(lines[i]!) as StoredEntry;
      } catch {
        return { ok: false, entries: lines.length, brokenAt: i };
      }
      const { prev: p, hash, ...body } = parsed;
      if (p !== prev || sha256Hex(prev + JSON.stringify(body)) !== hash) {
        return { ok: false, entries: lines.length, brokenAt: i };
      }
      prev = hash;
    }
    return { ok: true, entries: lines.length };
  }
}
