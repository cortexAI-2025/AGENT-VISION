import { randomBytes } from "node:crypto";
import type { CaptureTarget, LocalCaptureResponse } from "@agent-vision/core";
import { z } from "zod";
import type { ConsentStore } from "./consent.js";
import { CaptureError, type CaptureService } from "./service.js";

export const ObserveStartRequest = z.object({
  agentId: z.string().min(1).max(128),
  target: z.enum(["screen", "window"]).default("screen"),
  intervalMs: z.number().int().min(250).max(3_600_000),
  maxDurationSec: z.number().int().min(1).max(8 * 3600),
  maxCaptures: z.number().int().min(1).max(2000),
  reason: z.string().max(300).optional(),
});
export type ObserveStartRequest = z.infer<typeof ObserveStartRequest>;

interface Session {
  id: string;
  agentId: string;
  target: CaptureTarget;
  intervalMs: number;
  expiresAt: number;
  maxCaptures: number;
  captures: number;
  lastAt: number;
  reason?: string;
}

/**
 * Sessions d'observation côté appareil. Point d'application des limites : même si le serveur MCP est compromis ou
 * bogué, l'appareil refuse de dépasser le consentement local (grant d'observation) : durée, nombre, intervalle.
 * Les sessions vivent en mémoire : un redémarrage du service les invalide (échec fermé), les grants restent sur disque.
 */
export class ObservationManager {
  private sessions = new Map<string, Session>();

  constructor(
    private readonly consent: ConsentStore,
    private readonly service: CaptureService,
    private readonly now: () => number = Date.now,
  ) {}

  start(req: ObserveStartRequest): { sessionId: string; expiresAt: string; maxCaptures: number; intervalMs: number } {
    if (this.consent.isStopped()) throw new CaptureError("capture_stopped", "capture is stopped on this device");
    const g = this.consent.getObservationGrant(req.agentId);
    if (!g) throw new CaptureError("consent_required", `no active observation consent for agent "${req.agentId}" (run \`agent-vision-local grant-observation --agent ${req.agentId}\`)`);
    if (!g.targets.includes(req.target)) throw new CaptureError("consent_denied", `observation of "${req.target}" is not granted`);
    if (req.intervalMs < g.minIntervalMs) throw new CaptureError("consent_denied", `interval below the granted minimum (${g.minIntervalMs} ms)`);
    for (const s of this.sessions.values()) if (s.agentId === req.agentId && this.alive(s)) throw new CaptureError("rate_limited", "an observation session is already running for this agent");
    // les bornes demandées sont plafonnées par le consentement
    const expiresAt = Math.min(this.now() + req.maxDurationSec * 1000, Date.parse(g.expiresAt));
    const s: Session = {
      id: `obs_${randomBytes(9).toString("base64url")}`,
      agentId: req.agentId, target: req.target, intervalMs: req.intervalMs, expiresAt,
      maxCaptures: Math.min(req.maxCaptures, g.maxCaptures), captures: 0, lastAt: 0, reason: req.reason,
    };
    this.sessions.set(s.id, s);
    void this.service.indicator.begin(req.agentId, `observation (${req.target})`, req.reason);
    return { sessionId: s.id, expiresAt: new Date(expiresAt).toISOString(), maxCaptures: s.maxCaptures, intervalMs: s.intervalMs };
  }

  private alive(s: Session): boolean {
    return this.sessions.has(s.id) && s.expiresAt > this.now() && s.captures < s.maxCaptures;
  }

  private end(s: Session): void {
    if (this.sessions.delete(s.id)) void this.service.indicator.end();
  }

  async capture(sessionId: string, agentId: string): Promise<LocalCaptureResponse> {
    const s = this.sessions.get(sessionId);
    if (!s || s.agentId !== agentId) throw new CaptureError("consent_required", "unknown or ended observation session");
    const fail = (code: ConstructorParameters<typeof CaptureError>[0], msg: string): never => {
      this.end(s);
      throw new CaptureError(code, msg);
    };
    if (this.consent.isStopped()) fail("capture_stopped", "capture stopped by the local user");
    if (s.expiresAt <= this.now()) fail("timeout", "observation session expired");
    if (s.captures >= s.maxCaptures) fail("rate_limited", "observation capture budget exhausted");
    const g = this.consent.getObservationGrant(agentId);
    if (!g) fail("consent_required", "observation consent revoked or expired");
    if (this.now() - s.lastAt < s.intervalMs * 0.8) throw new CaptureError("rate_limited", "captures too frequent for this session");
    s.lastAt = this.now();
    s.captures++;
    return this.service.capture({ agentId, target: s.target, reason: s.reason }, { preAuthorized: true, quiet: true });
  }

  stop(sessionId: string, agentId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || s.agentId !== agentId) return false;
    this.end(s);
    return true;
  }

  /** Arrêt d'urgence : ferme toutes les sessions. */
  stopAll(): void {
    for (const s of [...this.sessions.values()]) this.end(s);
  }

  active(): number {
    return [...this.sessions.values()].filter((s) => this.alive(s)).length;
  }
}
