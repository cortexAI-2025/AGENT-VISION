import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { sha256Hex } from "@agent-vision/core";

export const ToolName = z.enum(["capture_screen", "analyze_screen", "compare_screens", "share_visual_report"]);
export type ToolName = z.infer<typeof ToolName>;

export const AgentPolicy = z.object({
  id: z.string().min(1),
  /** SHA-256 hex du jeton de l'agent. Générer avec `agent-vision-server hash-token`. */
  tokenSha256: z.string().length(64),
  tools: z.array(ToolName).default(["capture_screen", "analyze_screen", "compare_screens", "share_visual_report"]),
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
  providers: z.record(ProviderConfig).default({}),
  defaultProvider: z.string().optional(),
  retention: z
    .object({
      /** Durée de conservation des captures (secondes). 0 = suppression immédiate après usage non autorisée ; défaut 1 h. */
      captureSeconds: z.number().int().min(60).default(3600),
      reportSeconds: z.number().int().min(60).default(86400),
    })
    .default({}),
  gateway: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().default(7822),
      tls: z.object({ certFile: z.string(), keyFile: z.string() }).optional(),
      /** SHA-256 hex du jeton d'administration (suppression de captures, lecture d'audit). */
      adminTokenSha256: z.string().length(64).optional(),
    })
    .default({}),
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
