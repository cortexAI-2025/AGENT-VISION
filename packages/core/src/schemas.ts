import { z } from "zod";

/** Région rectangulaire en pixels. */
export const PixelRegion = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type PixelRegion = z.infer<typeof PixelRegion>;

/** Région normalisée (0..1) telle que renvoyée par un modèle multimodal. */
export const NormalizedRegion = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});
export type NormalizedRegion = z.infer<typeof NormalizedRegion>;

export const CaptureTarget = z.enum(["screen", "window"]);
export type CaptureTarget = z.infer<typeof CaptureTarget>;

// ---------------------------------------------------------------- local agent API

export const LocalCaptureRequest = z.object({
  agentId: z.string().min(1).max(128),
  target: CaptureTarget.default("screen"),
  reason: z.string().max(500).optional(),
});
export type LocalCaptureRequest = z.infer<typeof LocalCaptureRequest>;

export const LocalCaptureResponse = z.object({
  deviceId: z.string(),
  capturedAt: z.string(), // ISO 8601
  target: CaptureTarget,
  backend: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  sha256: z.string(),
  windowTitle: z.string().optional(),
  masksApplied: z.number().int().default(0),
  pngBase64: z.string(),
});
export type LocalCaptureResponse = z.infer<typeof LocalCaptureResponse>;

export const ErrorCode = z.enum([
  "unauthorized",
  "consent_required",
  "consent_denied",
  "capture_stopped",
  "screen_locked",
  "blank_or_protected",
  "backend_unavailable",
  "capture_failed",
  "bad_request",
  "rate_limited",
  "timeout",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({ error: ErrorCode, message: z.string() });
export type ErrorBody = z.infer<typeof ErrorBody>;

// ---------------------------------------------------------------- analysis

export const Severity = z.enum(["info", "low", "medium", "high", "critical"]);

/** Ce qui est directement visible sur la capture. */
export const Observation = z.object({
  id: z.string(),
  category: z.enum(["error_message", "layout", "rendering", "text", "state", "accessibility", "other"]),
  severity: Severity,
  description: z.string(),
  region: NormalizedRegion.optional(),
  /** Texte visible cité tel quel, si pertinent. */
  evidence: z.string().optional(),
});
export type Observation = z.infer<typeof Observation>;

/** Cause supposée : jamais présentée comme un fait. */
export const Hypothesis = z.object({
  id: z.string(),
  statement: z.string(),
  confidence: z.number().min(0).max(1),
  basedOn: z.array(z.string()).default([]), // ids d'observations
  suggestedChecks: z.array(z.string()).default([]),
});
export type Hypothesis = z.infer<typeof Hypothesis>;

export const SensitiveRegion = z.object({
  kind: z.string(),
  region: NormalizedRegion,
});
export type SensitiveRegion = z.infer<typeof SensitiveRegion>;

/** Sortie brute attendue du fournisseur de modèle (avant normalisation). */
export const ModelAnalysis = z.object({
  summary: z.string(),
  observations: z.array(Observation.omit({ id: true }).extend({ id: z.string().optional() })).default([]),
  hypotheses: z.array(Hypothesis.omit({ id: true }).extend({ id: z.string().optional() })).default([]),
  sensitiveRegions: z.array(SensitiveRegion).default([]),
});
export type ModelAnalysis = z.infer<typeof ModelAnalysis>;

export const AnalysisReport = z.object({
  schemaVersion: z.literal("1"),
  reportId: z.string(),
  captureId: z.string(),
  createdAt: z.string(),
  provider: z.object({ name: z.string(), model: z.string() }),
  summary: z.string(),
  /** Faits observés. */
  observations: z.array(Observation),
  /** Causes supposées, séparées des faits. */
  hypotheses: z.array(Hypothesis),
  privacy: z.object({
    sensitiveRegionsMasked: z.number().int(),
    secretKindsRedactedFromText: z.array(z.string()),
    /** Résultat du pipeline OCR local appliqué avant toute transmission. */
    ocr: z
      .object({
        status: z.enum(["verified", "off", "skipped_local_provider"]),
        engine: z.string().optional(),
        regionsMasked: z.number().int().default(0),
        kinds: z.array(z.string()).default([]),
      })
      .optional(),
  }),
  context: z.string().optional(),
});
export type AnalysisReport = z.infer<typeof AnalysisReport>;

// ---------------------------------------------------------------- compare / share

export const DiffResult = z.object({
  identicalDimensions: z.boolean(),
  before: z.object({ width: z.number().int(), height: z.number().int() }),
  after: z.object({ width: z.number().int(), height: z.number().int() }),
  changedPixelRatio: z.number(),
  changedPixels: z.number().int(),
  verdict: z.enum(["identical", "minor_changes", "significant_changes", "incomparable"]),
  regions: z.array(PixelRegion),
});
export type DiffResult = z.infer<typeof DiffResult>;

export const VisualReport = z.object({
  schemaVersion: z.literal("1"),
  id: z.string(),
  createdAt: z.string(),
  from: z.string(),
  to: z.string(),
  note: z.string().optional(),
  capture: z.object({
    captureId: z.string(),
    capturedAt: z.string(),
    deviceId: z.string(),
    platform: z.string().optional(),
    backend: z.string(),
    width: z.number().int(),
    height: z.number().int(),
    sha256: z.string(),
    imageIncluded: z.boolean(),
    imageIsRedacted: z.boolean(),
  }),
  analysis: AnalysisReport.optional(),
  diff: DiffResult.optional(),
  technicalContext: z.record(z.string(), z.string()).default({}),
});
export type VisualReport = z.infer<typeof VisualReport>;
