import {
  type DiffResult,
  type VisualReport,
  CaptureTarget,
  NormalizedRegion,
  cropPng,
  diffPng,
  toPixelRegion,
  isUniformFrame,
  newId,
  pngSize,
  redactDeep,
  redactText,
  sha256Hex,
} from "@agent-vision/core";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { analyzeCapture, describeChange } from "./analysis/engine.js";
import type { VisionProvider } from "./analysis/providers.js";
import type { AppContext } from "./app.js";
import type { AgentPolicy, ToolName } from "./config.js";
import { DeviceError } from "./devices.js";
import { SanitizeError, type SanitizeResult } from "@agent-vision/privacy";
import type { CaptureMeta } from "./store.js";
import { ObservationError } from "./observation.js";

// ------------------------------------------------------------------ schémas d'entrée (formes brutes zod)

const id = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/);

export const captureScreenInput = {
  deviceId: z.string().min(1).describe("Identifiant de l'appareil autorisé (voir la configuration du serveur)."),
  target: CaptureTarget.default("screen").describe("'screen' : écran entier ; 'window' : fenêtre active."),
  reason: z.string().max(300).optional().describe("Motif affiché à l'utilisateur sur l'appareil."),
  includeImage: z.boolean().default(false).describe("Renvoyer aussi l'image (version assainie par OCR sauf politique allowRawImages). Défaut non : utiliser analyze_screen ou la ressource agent-vision://captures/{id}."),
};

export const analyzeScreenInput = {
  captureId: id,
  provider: z.string().optional().describe("Nom du fournisseur multimodal configuré. Par défaut : celui du serveur."),
  context: z.string().max(4000).optional().describe("Contexte technique (application, version, étape de test)."),
  expectation: z.string().max(1000).optional().describe("Comportement attendu, pour repérer l'écart."),
  deleteAfter: z.boolean().default(false).describe("Supprimer la capture après l'analyse (le rapport est conservé)."),
};

export const compareScreensInput = {
  beforeCaptureId: id,
  afterCaptureId: id,
  threshold: z.number().int().min(0).max(255).default(16).describe("Écart max par canal en dessous duquel un pixel est considéré identique."),
  describe: z.boolean().default(false).describe("Demander aussi au modèle une description sémantique des changements."),
  provider: z.string().optional(),
  context: z.string().max(4000).optional(),
  expectation: z.string().max(1000).optional(),
  includeOverlay: z.boolean().default(false).describe("Renvoyer une image de superposition des différences (rouge)."),
};

export const shareVisualReportInput = {
  captureId: id,
  toAgent: z.string().min(1).describe("Identifiant de l'agent destinataire (doit être autorisé par la politique)."),
  note: z.string().max(4000).optional(),
  includeImage: z.boolean().optional().describe("Joindre l'image (version masquée). Défaut : oui si la capture a été analysée. Refusé sans analyse préalable."),
  compareWithCaptureId: id.optional().describe("Capture antérieure : inclut le diff dans le rapport."),
  technicalContext: z.record(z.string().max(2000)).optional().describe("Paires clé/valeur (version de l'app, URL, extrait de log…)."),
};

// ------------------------------------------------------------------ utilitaires

type Result = CallToolResult;
const asJson = (v: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });
const fail = (code: string, message: string): Result => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message }) }] });

async function guarded(ctx: AppContext, agent: AgentPolicy, tool: ToolName, details: Record<string, unknown>, fn: () => Promise<Result>): Promise<Result> {
  if (!agent.tools.includes(tool)) {
    ctx.audit.write({ actor: agent.id, action: tool, outcome: "denied", details: { ...details, reason: "tool not permitted" } });
    return fail("forbidden", `agent "${agent.id}" is not permitted to use ${tool}`);
  }
  try {
    const r = await fn();
    ctx.audit.write({ actor: agent.id, action: tool, outcome: r.isError ? "denied" : "allowed", details });
    return r;
  } catch (e) {
    const code = e instanceof DeviceError ? e.code : "error";
    ctx.audit.write({ actor: agent.id, action: tool, outcome: "error", details: { ...details, code } });
    return fail(code, redactText((e as Error).message).text);
  }
}

class Forbidden extends Error {}
class NotFound extends Error {}

function ownMeta(ctx: AppContext, agent: AgentPolicy, captureId: string, ownerOnly: boolean): CaptureMeta {
  const m = ctx.store.getMeta(captureId);
  // même message pour « inexistant » et « non autorisé » : pas d'oracle d'existence
  if (!m || (m.ownerAgent !== agent.id && (ownerOnly || !m.sharedWith.includes(agent.id)))) throw new NotFound("unknown capture");
  return m;
}

/**
 * Image destinée au TRAITEMENT interne (diff, analyse). Le propriétaire a l'original ; un destinataire n'a jamais que
 * la version assainie. Ne sort jamais telle quelle vers un agent.
 */
export function loadForProcessing(ctx: AppContext, agent: AgentPolicy, m: CaptureMeta): Buffer {
  if (m.ownerAgent === agent.id) {
    const png = ctx.store.getPng(m.captureId);
    if (!png) throw new NotFound("unknown capture");
    return png;
  }
  const red = ctx.store.getPng(m.captureId, true);
  if (!red) throw new Forbidden("no sanitized image available for this capture");
  return red;
}

/** Version assainie (créée à la demande, fail-closed). Existe ⇒ OCR vérifié (ou OCR explicitement désactivé). */
export async function getSanitized(ctx: AppContext, m: CaptureMeta): Promise<Buffer> {
  const existing = ctx.store.getPng(m.captureId, true);
  if (existing) return existing;
  const orig = ctx.store.getPng(m.captureId);
  if (!orig) throw new NotFound("unknown capture");
  if (ctx.config.privacy.ocr === "off") {
    ctx.store.saveRedacted(m.captureId, orig);
    return orig;
  }
  try {
    const r = await ctx.sanitizer.sanitize(orig);
    ctx.store.saveRedacted(m.captureId, r.png);
    return r.png;
  } catch (e) {
    throw new SanitizeFailure(`image not available: local sanitization failed (${e instanceof SanitizeError ? e.reason : "error"})`);
  }
}

/** Image EXPOSÉE à un agent : brute seulement si la politique l'autorise explicitement, sinon assainie. */
export async function readImage(ctx: AppContext, agent: AgentPolicy, m: CaptureMeta): Promise<Buffer> {
  if (m.ownerAgent === agent.id && agent.allowRawImages) return loadForProcessing(ctx, agent, m);
  return getSanitized(ctx, m);
}

function pickProvider(ctx: AppContext, agent: AgentPolicy, name?: string): VisionProvider {
  const n = name ?? ctx.config.defaultProvider;
  if (!n) throw new Forbidden("no provider specified and no defaultProvider configured");
  if (!agent.providers.includes(n)) throw new Forbidden(`provider "${n}" is not permitted for this agent`);
  const p = ctx.providers.get(n);
  if (!p) throw new NotFound(`provider "${n}" is not configured`);
  return p;
}

/**
 * Pipeline de sécurité visuelle (fail-closed) : renvoie l'image à transmettre au fournisseur.
 * - fournisseur distant : si l'OCR/la vérification échoue, rien n'est transmis (SanitizeFailure).
 * - fournisseur local : en cas d'échec, l'original reste utilisable localement mais aucune version « partageable » n'existe.
 */
export class SanitizeFailure extends Error {}

export interface Prepared {
  png: Buffer;
  sanitized?: SanitizeResult;
  status: "verified" | "off" | "skipped_local_provider";
}

export async function prepareForProvider(ctx: AppContext, provider: VisionProvider, png: Buffer): Promise<Prepared> {
  if (ctx.config.privacy.ocr === "off") return { png, status: "off" };
  try {
    const r = await ctx.sanitizer.sanitize(png);
    return { png: r.png, sanitized: r, status: "verified" };
  } catch (e) {
    if (provider.local) return { png, status: "skipped_local_provider" };
    const reason = e instanceof SanitizeError ? e.reason : "error";
    throw new SanitizeFailure(`image not transmitted: local sanitization failed (${reason})`);
  }
}

function mapErr(e: unknown): Result | undefined {
  if (e instanceof ObservationError) return fail(e.code, e.message);
  if (e instanceof DeviceError) return fail(e.code, e.message);
  if (e instanceof SanitizeFailure) return fail("sanitization_failed", e.message);
  if (e instanceof Forbidden) return fail("forbidden", e.message);
  if (e instanceof NotFound) return fail("not_found", e.message);
  return undefined;
}

// ------------------------------------------------------------------ outils

export async function captureScreen(ctx: AppContext, agent: AgentPolicy, a: z.infer<z.ZodObject<typeof captureScreenInput>>): Promise<Result> {
  return guarded(ctx, agent, "capture_screen", { deviceId: a.deviceId, target: a.target }, async () => {
    if (!agent.devices.includes(a.deviceId)) return fail("forbidden", `agent "${agent.id}" has no permission on device "${a.deviceId}"`);
    const dev = ctx.devices.get(a.deviceId);
    if (!dev) return fail("not_found", `unknown device "${a.deviceId}"`);

    const res = await dev.capture({ agentId: agent.id, target: a.target, reason: a.reason });
    const png = Buffer.from(res.pngBase64, "base64");
    // validation côté serveur : on ne fait pas confiance à l'appareil
    const size = pngSize(png);
    if (isUniformFrame(png)) return fail("blank_or_protected", "uniform frame rejected");

    const meta = ctx.store.saveCapture(
      png,
      {
        ownerAgent: agent.id,
        deviceId: dev.id,
        platform: dev.platform,
        capturedAt: res.capturedAt,
        backend: res.backend,
        ...size,
        sha256: sha256Hex(png),
        windowTitle: res.windowTitle ? redactText(res.windowTitle).text : undefined,
        reason: a.reason,
      },
      ctx.config.retention.captureSeconds,
    );
    const { ownerAgent: _o, sharedWith: _s, ...pub } = meta;
    const out: Result = { content: [{ type: "text", text: JSON.stringify({ ...pub, masksApplied: res.masksApplied, resource: `agent-vision://captures/${meta.captureId}` }, null, 2) }] };
    if (a.includeImage) {
      try {
        const shown = agent.allowRawImages ? png : await getSanitized(ctx, meta);
        out.content.push({ type: "image", data: shown.toString("base64"), mimeType: "image/png" });
        if (!agent.allowRawImages) out.content.push({ type: "text", text: "Note: the image returned is the sanitized version (OCR-masked); raw images require allowRawImages." });
      } catch (e) {
        out.content.push({ type: "text", text: `Image not returned: ${(e as Error).message}` });
      }
    }
    return out;
  });
}

export async function analyzeScreen(ctx: AppContext, agent: AgentPolicy, a: z.infer<z.ZodObject<typeof analyzeScreenInput>>): Promise<Result> {
  return guarded(ctx, agent, "analyze_screen", { captureId: a.captureId, provider: a.provider ?? ctx.config.defaultProvider }, async () => {
    try {
      const meta = ownMeta(ctx, agent, a.captureId, true);
      const provider = pickProvider(ctx, agent, a.provider);
      const png = loadForProcessing(ctx, agent, meta);
      const prep = await prepareForProvider(ctx, provider, png);
      const { report, redactedPng } = await analyzeCapture({ provider, captureId: meta.captureId, png: prep.png, context: a.context, expectation: a.expectation });
      report.privacy.ocr = { status: prep.status, engine: prep.sanitized?.engine, regionsMasked: prep.sanitized?.regions.length ?? 0, kinds: prep.sanitized?.kinds ?? [] };
      // invariant : une version « masquée » n'existe que si l'image a passé le pipeline (OCR vérifié ou désactivé explicitement)
      if (prep.status !== "skipped_local_provider") ctx.store.saveRedacted(meta.captureId, redactedPng);
      ctx.store.saveAnalysis(report);
      if (a.deleteAfter) ctx.store.deleteCapture(meta.captureId);
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    } catch (e) {
      const m = mapErr(e);
      if (m) return m;
      throw e;
    }
  });
}

export async function compareScreens(ctx: AppContext, agent: AgentPolicy, a: z.infer<z.ZodObject<typeof compareScreensInput>>): Promise<Result> {
  return guarded(ctx, agent, "compare_screens", { before: a.beforeCaptureId, after: a.afterCaptureId, describe: a.describe }, async () => {
    try {
      const mb = ownMeta(ctx, agent, a.beforeCaptureId, false);
      const ma = ownMeta(ctx, agent, a.afterCaptureId, false);
      const before = loadForProcessing(ctx, agent, mb);
      const after = loadForProcessing(ctx, agent, ma);
      const { result, overlay } = diffPng(before, after, { pixelThreshold: a.threshold, overlayBase: agent.allowRawImages ? "image" : "none" });
      let description: unknown;
      if (a.describe) {
        if (result.verdict === "incomparable") return fail("incomparable", "captures have different dimensions; semantic description skipped");
        const provider = pickProvider(ctx, agent, a.provider);
        const pb = await prepareForProvider(ctx, provider, before);
        const pa = await prepareForProvider(ctx, provider, after);
        description = await describeChange({ provider, before: pb.png, after: pa.png, diff: result, context: a.context, expectation: a.expectation });
      }
      const out: Result = { content: [{ type: "text", text: JSON.stringify({ before: a.beforeCaptureId, after: a.afterCaptureId, diff: result, description }, null, 2) }] };
      if (a.includeOverlay && overlay) out.content.push({ type: "image", data: overlay.toString("base64"), mimeType: "image/png" });
      return out;
    } catch (e) {
      const m = mapErr(e);
      if (m) return m;
      throw e;
    }
  });
}

export async function shareVisualReport(ctx: AppContext, agent: AgentPolicy, a: z.infer<z.ZodObject<typeof shareVisualReportInput>>): Promise<Result> {
  return guarded(ctx, agent, "share_visual_report", { captureId: a.captureId, to: a.toAgent }, async () => {
    try {
      if (!agent.shareTo.includes(a.toAgent) || !ctx.config.agents.some((x) => x.id === a.toAgent)) {
        return fail("forbidden", `agent "${agent.id}" may not share with "${a.toAgent}"`);
      }
      const meta = ownMeta(ctx, agent, a.captureId, true);
      const analysis = ctx.store.getAnalysis(meta.captureId);
      const hasRedacted = !!ctx.store.getPng(meta.captureId, true);
      if (a.includeImage === true && !hasRedacted) {
        return fail("analysis_required", "run analyze_screen first: only the masked version of an image can be shared");
      }
      const includeImage = a.includeImage ?? hasRedacted;

      let diff: DiffResult | undefined;
      if (a.compareWithCaptureId) {
        const prev = ownMeta(ctx, agent, a.compareWithCaptureId, true);
        diff = diffPng(loadForProcessing(ctx, agent, prev), loadForProcessing(ctx, agent, meta)).result;
      }
      const ctxRedacted = redactDeep({ note: a.note, technicalContext: a.technicalContext ?? {} });
      const technicalContext: Record<string, string> = {
        ...ctxRedacted.value.technicalContext,
        ...(meta.windowTitle ? { windowTitle: meta.windowTitle } : {}),
      };
      const report: VisualReport = {
        schemaVersion: "1",
        id: newId("vr"),
        createdAt: new Date().toISOString(),
        from: agent.id,
        to: a.toAgent,
        note: ctxRedacted.value.note,
        capture: {
          captureId: meta.captureId,
          capturedAt: meta.capturedAt,
          deviceId: meta.deviceId,
          platform: meta.platform,
          backend: meta.backend,
          width: meta.width,
          height: meta.height,
          sha256: meta.sha256,
          imageIncluded: includeImage,
          imageIsRedacted: includeImage,
        },
        analysis,
        diff,
        technicalContext,
      };
      ctx.store.saveReport(report, ctx.config.retention.reportSeconds);
      if (includeImage) ctx.store.shareCapture(meta.captureId, a.toAgent);
      const out = {
        reportId: report.id,
        resource: `agent-vision://reports/${report.id}`,
        imageResource: includeImage ? `agent-vision://captures/${meta.captureId}` : undefined,
        report,
      };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    } catch (e) {
      const m = mapErr(e);
      if (m) return m;
      throw e;
    }
  });
}


// ------------------------------------------------------------------ outils V1.1

const normRegion = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.001).max(1), height: z.number().min(0.001).max(1) });

export const listDevicesInput = {};
export const deviceCapabilitiesInput = { deviceId: z.string().min(1).max(128) };
export const analyzeRegionInput = {
  captureId: id,
  region: normRegion.describe("Région normalisée (0..1, origine en haut à gauche)."),
  provider: z.string().optional(),
  context: z.string().max(4000).optional(),
  expectation: z.string().max(1000).optional(),
};
export const startObservationInput = {
  deviceId: z.string().min(1).max(128),
  target: CaptureTarget.default("screen"),
  intervalSeconds: z.number().min(0.1).max(3600).default(5),
  maxDurationSeconds: z.number().int().min(1).max(8 * 3600).default(300),
  maxCaptures: z.number().int().min(1).max(2000).default(60),
  changeThreshold: z.number().min(0).max(1).default(0.01).describe("Part de pixels modifiés (0..1) au-delà de laquelle un changement est retenu."),
  ignoreRegions: z.array(normRegion).max(20).default([]).describe("Zones ignorées pour la comparaison (horloge, barre d'état)."),
  analyzeChanges: z.boolean().default(true).describe("Décrire les changements retenus avec un modèle (limité, dédupliqué)."),
  provider: z.string().optional(),
  context: z.string().max(4000).optional(),
  expectation: z.string().max(1000).optional(),
  retentionSeconds: z.number().int().min(60).max(86400).default(3600),
  deleteOnStop: z.boolean().default(false).describe("Supprimer les captures de la session à son arrêt."),
  reason: z.string().max(300).optional(),
};
export const observationIdInput = { observationId: id };
export const visualChangesInput = { observationId: id, sinceChangeId: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) };

export async function listAvailableDevices(ctx: AppContext, agent: AgentPolicy): Promise<Result> {
  return guarded(ctx, agent, "list_available_devices", {}, async () => {
    // uniquement les appareils déclarés ET autorisés pour cet agent ; rien sur les autres
    const devices = agent.devices.map((d) => ctx.devices.get(d)).filter((d): d is NonNullable<typeof d> => !!d).map((d) => ({ deviceId: d.id, platform: d.platform }));
    return asJson({ devices });
  });
}

export async function getDeviceCapabilities(ctx: AppContext, agent: AgentPolicy, a: { deviceId: string }): Promise<Result> {
  return guarded(ctx, agent, "get_device_capabilities", { deviceId: a.deviceId }, async () => {
    const dev = agent.devices.includes(a.deviceId) ? ctx.devices.get(a.deviceId) : undefined;
    if (!dev) return fail("not_found", "unknown or unauthorized device"); // réponse identique : pas d'oracle d'existence
    return asJson(await dev.capabilities());
  });
}

export async function analyzeScreenRegion(ctx: AppContext, agent: AgentPolicy, a: { captureId: string; region: NormalizedRegion; provider?: string; context?: string; expectation?: string }): Promise<Result> {
  return guarded(ctx, agent, "analyze_screen_region", { captureId: a.captureId, region: a.region }, async () => {
    try {
      const meta = ownMeta(ctx, agent, a.captureId, false);
      const provider = pickProvider(ctx, agent, a.provider);
      // la région est découpée dans l'image ASSAINIE (jamais dans l'original) puis transmise
      const sanitized = meta.ownerAgent === agent.id ? (await prepareForProvider(ctx, provider, loadForProcessing(ctx, agent, meta))).png : loadForProcessing(ctx, agent, meta);
      const { width, height } = pngSize(sanitized);
      const px = toPixelRegion(a.region, width, height);
      const crop = cropPng(sanitized, px);
      const { report } = await analyzeCapture({ provider, captureId: meta.captureId, png: crop, context: `Region ${JSON.stringify(px)} of a ${width}x${height} screenshot.${a.context ? " " + a.context : ""}`, expectation: a.expectation });
      return asJson({ region: { normalized: a.region, pixels: px }, report });
    } catch (e) {
      const m = mapErr(e);
      if (m) return m;
      throw e;
    }
  });
}

export async function startObservation(ctx: AppContext, agent: AgentPolicy, a: z.infer<z.ZodObject<typeof startObservationInput>>): Promise<Result> {
  return guarded(ctx, agent, "start_observation", { deviceId: a.deviceId, intervalSeconds: a.intervalSeconds, maxDurationSeconds: a.maxDurationSeconds, maxCaptures: a.maxCaptures }, async () => {
    try {
      if (!agent.devices.includes(a.deviceId)) return fail("forbidden", `agent "${agent.id}" has no permission on device "${a.deviceId}"`);
      const provider = a.analyzeChanges ? pickProvider(ctx, agent, a.provider) : undefined;
      const s = await ctx.observations.start(agent, a, provider);
      return asJson(ctx.observations.describe(s));
    } catch (e) {
      const m = mapErr(e);
      if (m) return m;
      throw e;
    }
  });
}

export async function stopObservation(ctx: AppContext, agent: AgentPolicy, a: { observationId: string }): Promise<Result> {
  return guarded(ctx, agent, "stop_observation", { observationId: a.observationId }, async () => {
    try {
      return asJson(await ctx.observations.stop(agent, a.observationId));
    } catch (e) {
      const m = mapErr(e);
      if (m) return m;
      throw e;
    }
  });
}

export async function getObservationStatus(ctx: AppContext, agent: AgentPolicy, a: { observationId: string }): Promise<Result> {
  return guarded(ctx, agent, "get_observation_status", { observationId: a.observationId }, async () => {
    try {
      return asJson(ctx.observations.status(agent, a.observationId));
    } catch (e) {
      const m = mapErr(e);
      if (m) return m;
      throw e;
    }
  });
}

export async function getVisualChanges(ctx: AppContext, agent: AgentPolicy, a: { observationId: string; sinceChangeId: number; limit: number }): Promise<Result> {
  return guarded(ctx, agent, "get_visual_changes", { observationId: a.observationId }, async () => {
    try {
      return asJson(ctx.observations.changes(agent, a.observationId, a.sinceChangeId, a.limit));
    } catch (e) {
      const m = mapErr(e);
      if (m) return m;
      throw e;
    }
  });
}
