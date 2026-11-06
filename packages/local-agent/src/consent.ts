import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CaptureTarget } from "@agent-vision/core";

const Grant = z.object({
  agentId: z.string(),
  targets: z.array(CaptureTarget),
  grantedAt: z.string(),
  expiresAt: z.string(),
});
type Grant = z.infer<typeof Grant>;
const GrantFile = z.object({ grants: z.array(Grant) });

const ObserveGrant = z.object({
  agentId: z.string(),
  targets: z.array(CaptureTarget),
  grantedAt: z.string(),
  expiresAt: z.string(),
  maxCaptures: z.number().int().positive(),
  minIntervalMs: z.number().int().min(250),
});
export type ObserveGrant = z.infer<typeof ObserveGrant>;
const ObserveFile = z.object({ grants: z.array(ObserveGrant) });

/**
 * Consentement et arrêt d'urgence, persistés sur disque (le CLI local et le service
 * en cours d'exécution partagent le même état). Le consentement ne peut être donné
 * QUE par le CLI local : aucune route réseau ne permet de l'accorder ou de lever l'arrêt.
 */
export class ConsentStore {
  private readonly dir: string;
  private readonly grantsFile: string;
  private readonly stopFile: string;

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.dir = stateDir;
    this.grantsFile = join(stateDir, "consent.json");
    this.stopFile = join(stateDir, "STOP");
  }

  private read(): Grant[] {
    if (!existsSync(this.grantsFile)) return [];
    try {
      return GrantFile.parse(JSON.parse(readFileSync(this.grantsFile, "utf8"))).grants;
    } catch {
      return []; // fichier corrompu → aucun consentement (échec fermé)
    }
  }

  private write(grants: Grant[]): void {
    writeFileSync(this.grantsFile, JSON.stringify({ grants }, null, 2), { mode: 0o600 });
  }

  grant(agentId: string, minutes: number, targets: CaptureTarget[] = ["screen", "window"]): Grant {
    if (!(minutes > 0 && minutes <= 24 * 60)) throw new Error("minutes must be in (0, 1440]");
    const g: Grant = {
      agentId,
      targets,
      grantedAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + minutes * 60_000).toISOString(),
    };
    this.write([...this.read().filter((x) => x.agentId !== agentId), g]);
    return g;
  }

  revoke(agentId?: string): number {
    this.revokeObservation(agentId);
    const all = this.read();
    const kept = agentId ? all.filter((g) => g.agentId !== agentId) : [];
    this.write(kept);
    return all.length - kept.length;
  }

  list(): Grant[] {
    return this.read().filter((g) => Date.parse(g.expiresAt) > this.now());
  }

  isAllowed(agentId: string, target: CaptureTarget): boolean {
    return this.list().some((g) => g.agentId === agentId && g.targets.includes(target));
  }

  // ---- observation périodique : consentement distinct, borné dans le temps et en nombre
  private get observeFile() {
    return join(this.dir, "observe-consent.json");
  }
  private readObserve(): ObserveGrant[] {
    if (!existsSync(this.observeFile)) return [];
    try {
      return ObserveFile.parse(JSON.parse(readFileSync(this.observeFile, "utf8"))).grants;
    } catch {
      return [];
    }
  }
  grantObservation(agentId: string, minutes: number, maxCaptures: number, minIntervalMs: number, targets: CaptureTarget[] = ["screen", "window"]): ObserveGrant {
    if (!(minutes > 0 && minutes <= 8 * 60)) throw new Error("minutes must be in (0, 480]");
    if (!(maxCaptures > 0 && maxCaptures <= 2000)) throw new Error("maxCaptures must be in (0, 2000]");
    const g: ObserveGrant = {
      agentId, targets, maxCaptures, minIntervalMs: Math.max(250, minIntervalMs),
      grantedAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + minutes * 60_000).toISOString(),
    };
    writeFileSync(this.observeFile, JSON.stringify({ grants: [...this.readObserve().filter((x) => x.agentId !== agentId), g] }, null, 2), { mode: 0o600 });
    return g;
  }
  revokeObservation(agentId?: string): number {
    const all = this.readObserve();
    const kept = agentId ? all.filter((g) => g.agentId !== agentId) : [];
    writeFileSync(this.observeFile, JSON.stringify({ grants: kept }), { mode: 0o600 });
    return all.length - kept.length;
  }
  getObservationGrant(agentId: string): ObserveGrant | undefined {
    return this.readObserve().find((g) => g.agentId === agentId && Date.parse(g.expiresAt) > this.now());
  }

  // ---- arrêt immédiat
  stop(): void {
    writeFileSync(this.stopFile, new Date(this.now()).toISOString(), { mode: 0o600 });
  }
  resume(): void {
    rmSync(this.stopFile, { force: true });
  }
  isStopped(): boolean {
    return existsSync(this.stopFile);
  }
}
