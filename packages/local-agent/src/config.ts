import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { NormalizedRegion } from "@agent-vision/core";

export const LocalConfig = z.object({
  deviceId: z.string().min(1),
  /** SHA-256 hex du jeton d'appareil (le jeton en clair n'est jamais stocké ici). */
  tokenSha256: z.string().length(64),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(7821),
  tls: z.object({ certFile: z.string(), keyFile: z.string() }).optional(),
  /** "grant" : autorisation préalable via `agent-vision-local grant`. "prompt" : boîte de dialogue à chaque capture. */
  consentMode: z.enum(["grant", "prompt"]).default("grant"),
  /** Régions (0..1) toujours masquées en noir avant envoi (barre de mots de passe, notifications, etc.). */
  maskRegions: z.array(NormalizedRegion).default([]),
  minIntervalMs: z.number().int().min(0).default(1000),
  /** Si non vide, seuls ces agents peuvent être autorisés. */
  allowedAgents: z.array(z.string()).default([]),
  notify: z.boolean().default(true),
});
export type LocalConfig = z.infer<typeof LocalConfig>;

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_VISION_LOCAL_HOME ?? join(homedir(), ".agent-vision", "local");
}

export function configPath(stateDir: string): string {
  return join(stateDir, "config.json");
}

export function loadConfig(stateDir: string): LocalConfig {
  const p = configPath(stateDir);
  if (!existsSync(p)) throw new Error(`config not found: ${p} (run \`agent-vision-local init\`)`);
  return LocalConfig.parse(JSON.parse(readFileSync(p, "utf8")));
}

export function saveConfig(stateDir: string, cfg: LocalConfig): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const p = configPath(stateDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows */
  }
}
