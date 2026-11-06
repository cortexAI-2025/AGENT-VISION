import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { sha256Hex } from "@agent-vision/core";

export const ToolName = z.enum([
  "capture_screen", "analyze_screen", "compare_screens", "share_visual_report",
  "list_available_devices", "get_device_capabilities", "analyze_screen_region",
  "start_observation", "stop_observation", "get_observation_status", "get_visual_changes",
]);
export type ToolName = z.infer<typeof ToolName>;

export const AgentPolicy = z.object({
  id: z.string().min(1),
  /** SHA-256 hex du jeton de l'agent. Générer avec `agent-vision-server hash-token`. */
  tokenSha256: z.string().length(64),
  /** Par défaut : les 4 outils V1 + lecture seule (appareils, régions). Les outils d'observation doivent être listés explicitement. */
  tools: z
    .array(ToolName)
    .default(["capture_screen", "analyze_screen", "compare_screens", "share_visual_report", "list_available_devices", "get_device_capabilities", "analyze_screen_region"]),
  /** Autorise cet agent à relire l'image BRUTE de ses propres captures. Par défaut non : seule la version assainie est accessible. */
  allowRawImages: z.boolean().default(false),
  /** Appareils que cet agent peut capturer. Vide = aucun. */
  devices: z.array(z.string()).default([]),
  /** Fournisseurs d'analyse autorisés (l'image quitte la machine vers ce fournisseur). */
  providers: z.array(z.string()).default([]),
  /** Agents destinataires autorisés pour share_visual_report. */
  shareTo: z.array(z.string()).default([]),
});
export type AgentPolicy = z.infer<typeof AgentPolicy>;

export const DeviceConfig = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local-http"),
    id: z.string(),
    platform: z.string().optional(),
    url: z.string().url(),
    /** Jeton d'appareil en clair (fichier de config en 0600) ou `env:NOM_VARIABLE`. */
    token: z.string(),
    /** Empreinte SHA-256 du certificat (hex) pour épingler un certificat auto-signé. */
    tlsFingerprint256: z.string().optional(),
  }),
  z.object({
    kind: z.literal("push"), // Android : l'appareil interroge le serveur et dépose la capture
    id: z.string(),
    platform: z.string().optional(),
    tokenSha256: z.string().length(64),
  }),
]);
export type DeviceConfig = z.infer<typeof DeviceConfig>;

export const ProviderConfig = z.object({
  type: z.enum(["anthropic", "openai", "gemini", "mock"]),
  model: z.string(),
  /** `env:NOM` ou clé en clair. Inutile pour un serveur local compatible OpenAI. */
  apiKey: z.string().optional(),
  /** Pour `openai` : DeepSeek, Grok (xAI), Ollama, vLLM, LM Studio… (API compatible OpenAI). */
  baseUrl: z.string().url().optional(),
  /** Vrai si le fournisseur tourne en local (aucune donnée ne quitte la machine). */
  local: z.boolean().default(false),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const ServerConfig = z.object({
  dataDir: z.string().default(join(homedir(), ".agent-vision", "server")),
  agents: z.array(AgentPolicy),
  devices: z.array(DeviceConfig).default([]),
  providers: z.record(z.string(), ProviderConfig).default({}),
  defaultProvider: z.string().optional(),
  retention: z
    .object({
      /** Durée de conservation des captures (secondes). 0 = suppression immédiate après usage non autorisée ; défaut 1 h. */
      captureSeconds: z.number().int().min(60).default(3600),
      reportSeconds: z.number().int().min(60).default(86400),
    })
    .prefault({}),
  gateway: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().default(7822),
      tls: z.object({ certFile: z.string(), keyFile: z.string() }).optional(),
      /** SHA-256 hex du jeton d'administration (suppression de captures, lecture d'audit). */
      adminTokenSha256: z.string().length(64).optional(),
    })
    .prefault({}),
  observation: z
    .object({
      minIntervalMs: z.number().int().min(10).default(2000),
      maxDurationSeconds: z.number().int().min(1).default(3600),
      maxCaptures: z.number().int().min(1).default(500),
      maxSessionsPerAgent: z.number().int().min(1).default(1),
      maxSessionsTotal: z.number().int().min(1).default(4),
      maxAnalysesPerSession: z.number().int().min(0).default(20),
      minAnalysisIntervalMs: z.number().int().min(0).default(10000),
      keepCaptures: z.number().int().min(2).default(20),
      /** Distance de Hamming maximale (sur 64 bits) pour considérer deux images comme « la même » pour la déduplication des analyses. */
      phashDedupDistance: z.number().int().min(0).max(32).default(4),
    })
    .prefault({}),
  privacy: z
    .object({
      /** "on" : pipeline OCR avant toute analyse et pour toute image partageable (fail-closed pour les fournisseurs distants). "off" : désactivé explicitement. */
      ocr: z.enum(["on", "off"]).default("on"),
      customLiterals: z.array(z.string().min(1)).default([]),
      customRegexes: z.array(z.string()).default([]),
      timeoutMs: z.number().int().min(1000).default(60000),
    })
    .prefault({}),
  /** Délai d'attente d'une capture « push » (consentement humain sur le téléphone). */
  pushTimeoutSeconds: z.number().int().min(5).default(90),
});
export type ServerConfig = z.infer<typeof ServerConfig>;

export function loadServerConfig(path: string): ServerConfig {
  return ServerConfig.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function resolveSecret(v: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (v === undefined) return undefined;
  if (v.startsWith("env:")) {
    const val = env[v.slice(4)];
    if (!val) throw new Error(`environment variable ${v.slice(4)} is not set`);
    return val;
  }
  return v;
}

export function findAgentByToken(cfg: ServerConfig, token: string): AgentPolicy | undefined {
  const h = sha256Hex(token);
  return cfg.agents.find((a) => a.tokenSha256 === h);
}
