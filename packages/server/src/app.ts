import { join } from "node:path";
import { AuditLog } from "@agent-vision/core";
import type { ServerConfig } from "./config.js";
import { DeviceRegistry } from "./devices.js";
import { createProvider, type VisionProvider } from "./analysis/providers.js";
import { Store } from "./store.js";

export interface AppContext {
  config: ServerConfig;
  store: Store;
  audit: AuditLog;
  auditPath: string;
  devices: DeviceRegistry;
  providers: Map<string, VisionProvider>;
}

export function createAppContext(config: ServerConfig, overrides: Partial<Pick<AppContext, "devices" | "providers">> = {}): AppContext {
  const auditPath = join(config.dataDir, "audit.jsonl");
  const providers = overrides.providers ?? new Map<string, VisionProvider>();
  if (!overrides.providers) {
    for (const [name, cfg] of Object.entries(config.providers)) providers.set(name, createProvider(name, cfg));
  }
  return {
    config,
    store: new Store(config.dataDir),
    audit: new AuditLog(auditPath),
    auditPath,
    devices: overrides.devices ?? new DeviceRegistry(config.devices, config.pushTimeoutSeconds),
    providers,
  };
}
