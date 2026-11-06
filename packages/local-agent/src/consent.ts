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

/**
 * Consentement et arrêt d'urgence, persistés sur disque (le CLI local et le service
 * en cours d'exécution partagent le même état). Le consentement ne peut être donné
 * QUE par le CLI local : aucune route réseau ne permet de l'accorder ou de lever l'arrêt.
 */
export class ConsentStore {
  private readonly grantsFile: string;
  private readonly stopFile: string;

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
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
