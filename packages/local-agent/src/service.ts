import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type CaptureTarget,
  type ErrorCode,
  type LocalCaptureRequest,
  type LocalCaptureResponse,
  isUniformFrame,
  maskRegions,
  pngSize,
  redactText,
  sha256Hex,
  toPixelRegion,
} from "@agent-vision/core";
import type { Capturer } from "./backends/types.js";
import type { LocalConfig } from "./config.js";
import type { ConsentStore } from "./consent.js";
import type { Indicator, Prompter } from "./ui.js";

export class CaptureError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
  }
}

export interface ServiceDeps {
  config: LocalConfig;
  consent: ConsentStore;
  capturer: Capturer;
  prompter: Prompter;
  indicator: Indicator;
  stateDir: string;
  now?: () => number;
}

export class CaptureService {
  private lastCaptureAt = new Map<string, number>();
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly d: ServiceDeps) {
    this.now = d.now ?? Date.now;
    mkdirSync(d.stateDir, { recursive: true, mode: 0o700 });
  }

  private log(agentId: string, outcome: string, extra: Record<string, unknown> = {}): void {
    appendFileSync(
      join(this.d.stateDir, "capture-log.jsonl"),
      JSON.stringify({ ts: new Date(this.now()).toISOString(), agentId, outcome, ...extra }) + "\n",
      { mode: 0o600 },
    );
  }

  async capture(req: LocalCaptureRequest): Promise<LocalCaptureResponse> {
    const { config, consent, capturer } = this.d;
    const fail = (code: ErrorCode, msg: string): never => {
      this.log(req.agentId, code, { target: req.target });
      throw new CaptureError(code, msg);
    };

    if (consent.isStopped()) fail("capture_stopped", "capture is stopped on this device (run `agent-vision-local resume`)");
    if (config.allowedAgents.length && !config.allowedAgents.includes(req.agentId)) {
      fail("consent_denied", `agent "${req.agentId}" is not in allowedAgents`);
    }
    if (this.busy) fail("rate_limited", "a capture is already in progress");

    const last = this.lastCaptureAt.get(req.agentId) ?? 0;
    if (this.now() - last < config.minIntervalMs) fail("rate_limited", "captures too frequent for this agent");

    // --- consentement
    if (config.consentMode === "prompt") {
      if (!(await this.d.prompter.confirmCapture(req.agentId, req.target, req.reason))) {
        fail("consent_denied", "the local user declined the capture");
      }
    } else if (!consent.isAllowed(req.agentId, req.target)) {
      fail("consent_required", `no active consent for agent "${req.agentId}" (run \`agent-vision-local grant --agent ${req.agentId}\`)`);
    }

    this.busy = true;
    try {
      if (await capturer.isLocked()) fail("screen_locked", "the session is locked; capture refused");
      // re-vérifie l'arrêt d'urgence juste avant la capture (la boîte de dialogue peut durer)
      if (consent.isStopped()) fail("capture_stopped", "capture was stopped");

      await this.d.indicator.begin(req.agentId, req.target, req.reason);
      let raw;
      try {
        raw = await capturer.capture(req.target as CaptureTarget);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "screen_locked" || code === "consent_denied" || code === "backend_unavailable") {
          return fail(code, (e as Error).message);
        }
        return fail("capture_failed", (e as Error).message);
      } finally {
        await this.d.indicator.end();
      }

      if (isUniformFrame(raw.png)) {
        fail("blank_or_protected", "captured frame is uniform (locked screen or system-protected content); discarded");
      }

      const { width, height } = pngSize(raw.png);
      const regions = config.maskRegions.map((r) => toPixelRegion(r, width, height));
      const png = maskRegions(raw.png, regions);
      this.lastCaptureAt.set(req.agentId, this.now());

      const title = raw.windowTitle ? redactText(raw.windowTitle).text : undefined;
      this.log(req.agentId, "captured", { target: req.target, backend: capturer.name, width, height, masks: regions.length });
      return {
        deviceId: config.deviceId,
        capturedAt: new Date(this.now()).toISOString(),
        target: req.target,
        backend: capturer.name,
        width,
        height,
        sha256: sha256Hex(png),
        windowTitle: title,
        masksApplied: regions.length,
        pngBase64: png.toString("base64"),
      };
    } finally {
      this.busy = false;
    }
  }
}
