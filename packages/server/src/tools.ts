import {
  type DiffResult,
  type VisualReport,
  CaptureTarget,
  diffPng,
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
import type { CaptureMeta } from "./store.js";

// ------------------------------------------------------------------ schémas d'entrée (formes brutes zod)

const id = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/);

export const captureScreenInput = {
  deviceId: z.string().min(1).describe("Identifiant de l'appareil autorisé (voir la configuration du serveur)."),
  target: CaptureTarget.default("screen").describe("'screen' : écran entier ; 'window' : fenêtre active."),
  reason: z.string().max(300).optional().describe("Motif affiché à l'utilisateur sur l'appareil."),
  includeImage: z.boolean().default(false).describe("Renvoyer aussi l'image dans la réponse. Par défaut non (minimisation des données) : utiliser analyze_screen ou la ressource agent-vision://captures/{id}."),
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

/** Le propriétaire lit l'original ; un destinataire ne lit jamais que la version masquée. */
export function readImage(ctx: AppContext, agent: AgentPolicy, m: CaptureMeta): Buffer {
  if (m.ownerAgent === agent.id) {
    const png = ctx.store.getPng(m.captureId);
    if (!png) throw new NotFound("unknown capture");
    return png;
  }
  const red = ctx.store.getPng(m.captureId, true);
  if (!red) throw new Forbidden("no redacted image available for this capture");
  return red;
}

function pickProvider(ctx: AppContext, agent: AgentPolicy, name?: string): VisionProvider {
  const n = name ?? ctx.config.defaultProvider;
  if (!n) throw new Forbidden("no provider specified and no defaultProvider configured");
  if (!agent.providers.includes(n)) throw new Forbidden(`provider "${n}" is not permitted for this agent`);
  const p = ctx.providers.get(n);
  if (!p) throw new NotFound(`provider "${n}" is not configured`);
  return p;
}

function mapErr(e: unknown): Result | undefined {
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
    if (a.includeImage) out.content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
    return out;
  });
}

export async function analyzeScreen(ctx: AppContext, agent: AgentPolicy, a: z.infer<z.ZodObject<typeof analyzeScreenInput>>): Promise<Result> {
  return guarded(ctx, agent, "analyze_screen", { captureId: a.captureId, provider: a.provider ?? ctx.config.defaultProvider }, async () => {
    try {
      const meta = ownMeta(ctx, agent, a.captureId, true);
      const provider = pickProvider(ctx, agent, a.provider);
      const png = readImage(ctx, agent, meta);
      const { report, redactedPng } = await analyzeCapture({ provider, captureId: meta.captureId, png, context: a.context, expectation: a.expectation });
      // invariant : une version « masquée » n'existe que si une analyse a eu lieu
      ctx.store.saveRedacted(meta.captureId, redactedPng);
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
      const before = readImage(ctx, agent, mb);
      const after = readImage(ctx, agent, ma);
      const { result, overlay } = diffPng(before, after, { pixelThreshold: a.threshold });
      let description: unknown;
      if (a.describe) {
        if (result.verdict === "incomparable") return fail("incomparable", "captures have different dimensions; semantic description skipped");
        const provider = pickProvider(ctx, agent, a.provider);
        description = await describeChange({ provider, before, after, diff: result, context: a.context, expectation: a.expectation });
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
        diff = diffPng(readImage(ctx, agent, prev), readImage(ctx, agent, meta)).result;
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
