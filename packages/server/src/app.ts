import { join } from "node:path";
import { AuditLog, buildCustomPatterns } from "@agent-vision/core";
import { OcrSanitizer, TesseractEngine, type ImageSanitizer } from "@agent-vision/privacy";
import type { ServerConfig } from "./config.js";
import { DeviceRegistry } from "./devices.js";
import { createProvider, type VisionProvider } from "./analysis/providers.js";
import { Store } from "./store.js";
import { ObservationManager } from "./observation.js";

export interface AppContext {
  config: ServerConfig;
  store: Store;
  audit: AuditLog;
  auditPath: string;
  devices: DeviceRegistry;
  providers: Map<string, VisionProvider>;
  sanitizer: ImageSanitizer;
  observations: ObservationManager;
}

export function createAppContext(config: ServerConfig, overrides: Partial<Pick<AppContext, "devices" | "providers" | "sanitizer">> = {}): AppContext {
  const auditPath = join(config.dataDir, "audit.jsonl");
  const providers = overrides.providers ?? new Map<string, VisionProvider>();
  if (!overrides.providers) {
    for (const [name, cfg] of Object.entries(config.providers)) providers.set(name, createProvider(name, cfg));
  }
  const ctx: AppContext = {
    config,
    store: new Store(config.dataDir),
    audit: new AuditLog(auditPath),
    auditPath,
    devices: overrides.devices ?? new DeviceRegistry(config.devices, config.pushTimeoutSeconds),
    providers,
    sanitizer:
      overrides.sanitizer ??
      new OcrSanitizer(new TesseractEngine(), {
        custom: buildCustomPatterns({ literals: config.privacy.customLiterals, regexes: config.privacy.customRegexes }),
        timeoutMs: config.privacy.timeoutMs,
      }),
    observations: undefined as unknown as ObservationManager,
  };
  ctx.observations = new ObservationManager(ctx);
  return ctx;
}
