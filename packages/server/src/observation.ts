import {
  type DiffResult,
  type NormalizedRegion,
  diffPng,
  hammingHex,
  maskRegions,
  newId,
  perceptualHash,
  pngSize,
  isUniformFrame,
  sha256Hex,
  toPixelRegion,
} from "@agent-vision/core";
import { describeChange, type CompareDescription } from "./analysis/engine.js";
import type { VisionProvider } from "./analysis/providers.js";
import type { AppContext } from "./app.js";
import type { AgentPolicy } from "./config.js";
import { DeviceError } from "./devices.js";
import type { DeviceClient } from "./devices.js";
import { SanitizeFailure, prepareForProvider } from "./tools.js";

export type ObservationState = "running" | "stopped" | "expired" | "exhausted" | "stopped_by_device" | "error";
export type AnalysisStatus = "none" | "pending" | "done" | "deduplicated" | "skipped_budget" | "skipped_rate_limit" | "skipped_backpressure" | "failed" | "sanitization_failed";

export interface VisualChange {
  changeId: number;
  at: string;
  captureId: string;
  previousCaptureId: string;
  diff: DiffResult;
  analysis: { status: AnalysisStatus; description?: CompareDescription; reusedFromChange?: number; error?: string };
}

export interface ObservationParams {
  deviceId: string;
  target: "screen" | "window";
  intervalSeconds: number;
  maxDurationSeconds: number;
  maxCaptures: number;
  changeThreshold: number;
  ignoreRegions: NormalizedRegion[];
  analyzeChanges: boolean;
  provider?: string;
  context?: string;
  expectation?: string;
  retentionSeconds: number;
  deleteOnStop: boolean;
  reason?: string;
}

export class ObservationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

interface Session {
  id: string;
  agent: AgentPolicy;
  p: ObservationParams;
  device: DeviceClient;
  provider?: VisionProvider;
  localSessionId: string;
  startedAt: number;
  expiresAt: number;
  state: ObservationState;
  stopReason?: string;
  timer?: NodeJS.Timeout;
  counters: { captures: number; identical: number; minor: number; significant: number; skipped: number; errors: number; analyses: number; dedupedAnalyses: number };
  baselineId?: string;
  baselinePng?: Buffer;
  lastCaptureAt?: string;
  lastCaptureId?: string;
  changes: VisualChange[];
  retained: string[];
  analysisInFlight: boolean;
  lastAnalysisAt: number;
  hashes: Array<{ hash: string; changeId: number; description: CompareDescription }>;
  consecutiveErrors: number;
  endedAt?: number;
}

const MAX_CHANGES = 200;

export class ObservationManager {
  private sessions = new Map<string, Session>();
  constructor(private readonly ctx: AppContext) {}

  private cfg() {
    return this.ctx.config.observation;
  }

  private audit(agent: string, action: string, outcome: "allowed" | "denied" | "error", details: Record<string, unknown>) {
    this.ctx.audit.write({ actor: agent, action, outcome, details });
  }

  async start(agent: AgentPolicy, p: ObservationParams, provider?: VisionProvider): Promise<Session> {
    const c = this.cfg();
    this.sweep();
    const mine = [...this.sessions.values()].filter((s) => s.agent.id === agent.id && s.state === "running");
    if (mine.length >= c.maxSessionsPerAgent) throw new ObservationError("rate_limited", `at most ${c.maxSessionsPerAgent} concurrent observation(s) per agent`);
    if ([...this.sessions.values()].filter((s) => s.state === "running").length >= c.maxSessionsTotal) throw new ObservationError("rate_limited", "server observation capacity reached");
    if (p.intervalSeconds * 1000 < c.minIntervalMs) throw new ObservationError("bad_request", `intervalSeconds must be ≥ ${c.minIntervalMs / 1000}`);
    if (p.maxDurationSeconds > c.maxDurationSeconds) throw new ObservationError("bad_request", `maxDurationSeconds must be ≤ ${c.maxDurationSeconds}`);
    if (p.maxCaptures > c.maxCaptures) throw new ObservationError("bad_request", `maxCaptures must be ≤ ${c.maxCaptures}`);
    const device = this.ctx.devices.get(p.deviceId);
    if (!device) throw new ObservationError("not_found", `unknown device "${p.deviceId}"`);

    // le consentement local est vérifié (et appliqué) par l'appareil lui-même
    const local = await device.observeStart({ agentId: agent.id, target: p.target, intervalMs: p.intervalSeconds * 1000, maxDurationSec: p.maxDurationSeconds, maxCaptures: p.maxCaptures, reason: p.reason });
    const s: Session = {
      id: newId("obs"), agent, p, device, provider, localSessionId: local.sessionId,
      startedAt: Date.now(), expiresAt: Math.min(Date.parse(local.expiresAt), Date.now() + p.maxDurationSeconds * 1000),
      state: "running",
      counters: { captures: 0, identical: 0, minor: 0, significant: 0, skipped: 0, errors: 0, analyses: 0, dedupedAnalyses: 0 },
      changes: [], retained: [], analysisInFlight: false, lastAnalysisAt: 0, hashes: [], consecutiveErrors: 0,
    };
    s.p = { ...p, maxCaptures: Math.min(p.maxCaptures, local.maxCaptures) };
    this.sessions.set(s.id, s);
    this.audit(agent.id, "observation_start", "allowed", { observationId: s.id, deviceId: p.deviceId, intervalSeconds: p.intervalSeconds, maxCaptures: s.p.maxCaptures });
    s.timer = setTimeout(() => void this.tick(s), 0);
    return s;
  }

  private get(agent: AgentPolicy, id: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.agent.id !== agent.id) throw new ObservationError("not_found", "unknown observation");
    return s;
  }

  status(agent: AgentPolicy, id: string) {
    const s = this.get(agent, id);
    return this.describe(s);
  }

  describe(s: Session) {
    return {
      observationId: s.id, state: s.state, stopReason: s.stopReason, deviceId: s.p.deviceId, target: s.p.target,
      startedAt: new Date(s.startedAt).toISOString(), expiresAt: new Date(s.expiresAt).toISOString(),
      secondsRemaining: s.state === "running" ? Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000)) : 0,
      limits: { intervalSeconds: s.p.intervalSeconds, maxCaptures: s.p.maxCaptures, changeThreshold: s.p.changeThreshold, maxAnalyses: this.cfg().maxAnalysesPerSession },
      counters: s.counters, lastCaptureAt: s.lastCaptureAt, lastCaptureId: s.lastCaptureId, changesRecorded: s.changes.length,
      analysisInFlight: s.analysisInFlight,
    };
  }

  changes(agent: AgentPolicy, id: string, sinceChangeId = 0, limit = 50) {
    const s = this.get(agent, id);
    return { observationId: id, state: s.state, changes: s.changes.filter((c) => c.changeId > sinceChangeId).slice(0, limit), latestChangeId: s.changes.at(-1)?.changeId ?? 0 };
  }

  async stop(agent: AgentPolicy, id: string, reason = "stopped by agent") {
    const s = this.get(agent, id);
    if (s.state === "running") await this.finish(s, "stopped", reason);
    return this.describe(s);
  }

  async stopAll(reason = "server shutdown") {
    for (const s of [...this.sessions.values()]) if (s.state === "running") await this.finish(s, "stopped", reason);
  }

  private async finish(s: Session, state: ObservationState, reason: string) {
    if (s.state !== "running") return;
    s.state = state;
    s.stopReason = reason;
    s.endedAt = Date.now();
    if (s.timer) clearTimeout(s.timer);
    try {
      await s.device.observeStop(s.localSessionId, s.agent.id);
    } catch {
      /* l'appareil a déjà fermé la session */
    }
    if (s.p.deleteOnStop) {
      for (const id of new Set([...s.retained, s.baselineId].filter(Boolean) as string[])) this.ctx.store.deleteCapture(id);
      s.retained = [];
    }
    this.audit(s.agent.id, "observation_end", "allowed", { observationId: s.id, state, reason, counters: s.counters });
  }

  /** Nettoie la mémoire des sessions terminées depuis plus d'une heure. */
  private sweep() {
    for (const [id, s] of this.sessions) if (s.endedAt && Date.now() - s.endedAt > 3600_000) this.sessions.delete(id);
  }

  private schedule(s: Session) {
    if (s.state !== "running") return;
    s.timer = setTimeout(() => void this.tick(s), s.p.intervalSeconds * 1000);
  }

  private maskedForDiff(png: Buffer, s: Session): Buffer {
    if (!s.p.ignoreRegions.length) return png;
    const { width, height } = pngSize(png);
    return maskRegions(png, s.p.ignoreRegions.map((r) => toPixelRegion(r, width, height)));
  }

  private async tick(s: Session) {
    if (s.state !== "running") return;
    if (Date.now() >= s.expiresAt) return this.finish(s, "expired", "duration elapsed");
    if (s.counters.captures >= s.p.maxCaptures) return this.finish(s, "exhausted", "capture budget exhausted");
    try {
      const res = await s.device.observeCapture(s.localSessionId, s.agent.id);
      s.consecutiveErrors = 0;
      const png = Buffer.from(res.pngBase64, "base64");
      pngSize(png);
      if (isUniformFrame(png)) {
        s.counters.skipped++;
        return this.schedule(s);
      }
      s.counters.captures++;
      s.lastCaptureAt = res.capturedAt;
      await this.process(s, png, res);
    } catch (e) {
      const code = e instanceof DeviceError ? e.code : "error";
      if (["capture_stopped", "consent_required", "consent_denied", "timeout"].includes(code)) {
        return this.finish(s, code === "timeout" ? "expired" : "stopped_by_device", `${code}: ${(e as Error).message}`);
      }
      s.counters.errors++;
      if (++s.consecutiveErrors >= 3) return this.finish(s, "error", `${code}: ${(e as Error).message}`);
    }
    this.schedule(s);
  }

  private async process(s: Session, png: Buffer, res: { capturedAt: string; deviceId: string; backend: string; width: number; height: number; windowTitle?: string }) {
    const ttl = Math.min(s.p.retentionSeconds, this.ctx.config.retention.captureSeconds);
    if (!s.baselinePng) {
      const m = this.save(s, png, res, ttl);
      s.baselineId = m;
      s.baselinePng = png;
      s.lastCaptureId = m;
      return;
    }
    // 1) identique (octet pour octet) → déduplication immédiate, rien n'est stocké
    if (sha256Hex(png) === sha256Hex(s.baselinePng)) {
      s.counters.identical++;
      return;
    }
    const { result: diff } = diffPng(this.maskedForDiff(s.baselinePng, s), this.maskedForDiff(png, s));
    if (diff.verdict === "identical") {
      s.counters.identical++;
      return;
    }
    if (diff.verdict !== "incomparable" && diff.changedPixelRatio < s.p.changeThreshold) {
      s.counters.minor++; // sous le seuil : compté, non stocké, la référence ne bouge pas (pas de dérive silencieuse)
      return;
    }
    const prevId = s.baselineId!;
    const prevPng = s.baselinePng;
    const id = this.save(s, png, res, ttl);
    s.lastCaptureId = id;
    s.counters.significant++;
    const change: VisualChange = { changeId: (s.changes.at(-1)?.changeId ?? 0) + 1, at: res.capturedAt, captureId: id, previousCaptureId: prevId, diff, analysis: { status: "none" } };
    s.changes.push(change);
    if (s.changes.length > MAX_CHANGES) s.changes.shift();
    s.baselineId = id;
    s.baselinePng = png;
    this.cleanup(s);
    if (s.p.analyzeChanges && s.provider) this.maybeAnalyze(s, change, prevPng, png);
  }

  private save(s: Session, png: Buffer, res: { capturedAt: string; deviceId: string; backend: string; width: number; height: number; windowTitle?: string }, ttl: number): string {
    const meta = this.ctx.store.saveCapture(
      png,
      { ownerAgent: s.agent.id, deviceId: res.deviceId, platform: s.device && (s.device as any).platform, capturedAt: res.capturedAt, backend: res.backend, width: res.width, height: res.height, sha256: sha256Hex(png), windowTitle: res.windowTitle, reason: `observation ${s.id}` },
      ttl,
    );
    s.retained.push(meta.captureId);
    return meta.captureId;
  }

  /** Conserve les `keepCaptures` plus récentes captures ; la référence courante est toujours conservée. */
  private cleanup(s: Session) {
    const keep = this.cfg().keepCaptures;
    while (s.retained.length > keep) {
      const old = s.retained.find((id) => id !== s.baselineId);
      if (!old) break;
      s.retained.splice(s.retained.indexOf(old), 1);
      this.ctx.store.deleteCapture(old);
    }
  }

  private maybeAnalyze(s: Session, change: VisualChange, before: Buffer, after: Buffer) {
    const c = this.cfg();
    const hash = perceptualHash(this.maskedForDiff(after, s));
    const dup = s.hashes.find((h) => hammingHex(h.hash, hash) <= c.phashDedupDistance);
    if (dup) {
      change.analysis = { status: "deduplicated", description: dup.description, reusedFromChange: dup.changeId };
      s.counters.dedupedAnalyses++;
      return;
    }
    if (s.counters.analyses >= c.maxAnalysesPerSession) return void (change.analysis = { status: "skipped_budget" });
    if (Date.now() - s.lastAnalysisAt < c.minAnalysisIntervalMs) return void (change.analysis = { status: "skipped_rate_limit" });
    if (s.analysisInFlight) return void (change.analysis = { status: "skipped_backpressure" });
    s.analysisInFlight = true;
    s.counters.analyses++;
    s.lastAnalysisAt = Date.now();
    change.analysis = { status: "pending" };
    void (async () => {
      try {
        const provider = s.provider!;
        const pb = await prepareForProvider(this.ctx, provider, before);
        const pa = await prepareForProvider(this.ctx, provider, after);
        const description = await describeChange({ provider, before: pb.png, after: pa.png, diff: change.diff, context: s.p.context, expectation: s.p.expectation });
        change.analysis = { status: "done", description };
        s.hashes.push({ hash, changeId: change.changeId, description });
        if (s.hashes.length > 50) s.hashes.shift();
      } catch (e) {
        change.analysis = e instanceof SanitizeFailure ? { status: "sanitization_failed", error: e.message } : { status: "failed", error: (e as Error).message.slice(0, 200) };
      } finally {
        s.analysisInFlight = false;
      }
    })();
  }
}
