import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LocalCaptureResponse, sha256Hex } from "@agent-vision/core";
import { createAppContext, type AppContext } from "../src/app.js";
import { ServerConfig } from "../src/config.js";
import type { CaptureRequest, DeviceClient } from "../src/devices.js";
import { DeviceError, DeviceRegistry } from "../src/devices.js";
import { MockProvider, type VisionProvider } from "../src/analysis/providers.js";
import { buildMcpServer } from "../src/mcp.js";
import { OcrSanitizer, type OcrEngine } from "@agent-vision/privacy";

/** OCR simulé rapide : les tests d'outils n'ont pas besoin du vrai Tesseract (couvert dans packages/privacy). */
export const noopOcr: OcrEngine = { name: "noop", recognize: async () => [] };

export function png(w: number, h: number, fn: (x: number, y: number) => [number, number, number]): Buffer {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y); const i = (y * w + x) * 4;
    p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = 255;
  }
  return PNG.sync.write(p);
}

/** Écran de test non uniforme : fond dégradé + « mot de passe » dans le quart haut-gauche. */
export const screenA = () => png(200, 100, (x, y) => [x, y * 2, 120]);
export const screenB = () => png(200, 100, (x, y) => (x > 100 && y > 50 ? [255, 0, 0] : [x, y * 2, 120]));

export class FakeDevice implements DeviceClient {
  platform = "test-os";
  // --- observation simulée
  frames: Buffer[] = [];
  frameIdx = 0;
  observeConsent = true;
  observeCalls = { start: 0, capture: 0, stop: 0 };
  captureError?: Error;
  async capabilities() {
    return { deviceId: this.id, kind: "local-http" as const, platform: this.platform, backend: "fake", targets: ["screen" as const, "window" as const], observation: true, perCaptureUserConsent: false, lockedScreenDetection: true, ocrMaskingOnDevice: false, tls: false, online: true };
  }
  async observeStart(r: any) {
    this.observeCalls.start++;
    if (!this.observeConsent) throw new DeviceError("consent_required", "no active observation consent");
    return { sessionId: `obs_local_${this.observeCalls.start}`, expiresAt: new Date(Date.now() + r.maxDurationSec * 1000).toISOString(), maxCaptures: r.maxCaptures, intervalMs: r.intervalMs };
  }
  async observeCapture(_s: string, _agentId: string) {
    this.observeCalls.capture++;
    if (this.captureError) throw this.captureError;
    const b = this.frames[Math.min(this.frameIdx++, this.frames.length - 1)] ?? screenA();
    return { deviceId: this.id, capturedAt: new Date().toISOString(), target: "screen" as const, backend: "fake", width: 200, height: 100, sha256: sha256Hex(b), masksApplied: 0, pngBase64: b.toString("base64") };
  }
  async observeStop() { this.observeCalls.stop++; }
  next: () => Buffer = screenA;
  requests: CaptureRequest[] = [];
  error?: Error;
  constructor(readonly id: string) {}
  async capture(r: CaptureRequest): Promise<LocalCaptureResponse> {
    this.requests.push(r);
    if (this.error) throw this.error;
    const b = this.next();
    return { deviceId: this.id, capturedAt: new Date().toISOString(), target: r.target, backend: "fake", width: 200, height: 100, sha256: sha256Hex(b), masksApplied: 0, pngBase64: b.toString("base64") };
  }
}

export const T = { tester: "tok-tester", dev: "tok-dev", intruder: "tok-intruder" };

export function makeConfig(over: Record<string, unknown> = {}) {
  return ServerConfig.parse({
    dataDir: mkdtempSync(join(tmpdir(), "av-server-")),
    agents: [
      { id: "tester", tokenSha256: sha256Hex(T.tester), devices: ["pc1"], providers: ["mock"], shareTo: ["dev"], tools: ["capture_screen", "analyze_screen", "compare_screens", "share_visual_report", "list_available_devices", "get_device_capabilities", "analyze_screen_region", "start_observation", "stop_observation", "get_observation_status", "get_visual_changes"] },
      { id: "raw", tokenSha256: sha256Hex("tok-raw"), devices: ["pc1"], providers: ["mock"], allowRawImages: true },
      { id: "dev", tokenSha256: sha256Hex(T.dev), tools: ["compare_screens"], providers: ["mock"] },
      { id: "intruder", tokenSha256: sha256Hex(T.intruder), tools: ["capture_screen", "analyze_screen", "compare_screens", "share_visual_report", "list_available_devices", "get_device_capabilities", "analyze_screen_region", "start_observation", "stop_observation", "get_observation_status", "get_visual_changes"], devices: [], providers: [] },
    ],
    devices: [],
    providers: {},
    defaultProvider: "mock",
    ...over,
  });
}

export interface TestEnv {
  ctx: AppContext;
  device: FakeDevice;
  provider: MockProvider;
  client: (agentId: string) => Promise<Client>;
  call: (agentId: string, tool: string, args: Record<string, unknown>) => Promise<{ isError?: boolean; json: any; content: any[] }>;
}

export function makeEnv(opts: { respond?: (i: any) => string; config?: Record<string, unknown>; ocr?: OcrEngine; remote?: boolean } = {}): TestEnv {
  const config = makeConfig(opts.config);
  const device = new FakeDevice("pc1");
  const provider = new MockProvider("mock-1", opts.respond ?? (() => JSON.stringify(defaultAnalysis)), !opts.remote);
  const registry = new DeviceRegistry([], 30);
  registry.set(device);
  const ctx = createAppContext(config, { devices: registry, providers: new Map<string, VisionProvider>([["mock", provider]]), sanitizer: new OcrSanitizer(opts.ocr ?? noopOcr) });
  const clients = new Map<string, Client>();
  const client = async (agentId: string) => {
    if (clients.has(agentId)) return clients.get(agentId)!;
    const agent = config.agents.find((a) => a.id === agentId)!;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(ctx, agent).connect(st);
    const c = new Client({ name: "test", version: "0" });
    await c.connect(ct);
    clients.set(agentId, c);
    return c;
  };
  const call: TestEnv["call"] = async (agentId, tool, args) => {
    const c = await client(agentId);
    const r = (await c.callTool({ name: tool, arguments: args })) as any;
    const text = r.content.find((x: any) => x.type === "text")?.text;
    return { isError: r.isError, json: text ? JSON.parse(text) : undefined, content: r.content };
  };
  return { ctx, device, provider, client, call };
}

/** Petite variation (4 pixels) : sous le seuil de changement par défaut. */
export const screenTiny = () => png(200, 100, (x, y) => (x < 2 && y < 2 ? [255, 255, 255] : [x, y * 2, 120]));
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(fn: () => boolean | Promise<boolean>, ms = 5000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return; await wait(20); }
  throw new Error("timeout waiting for condition");
}

export const defaultAnalysis = {
  summary: "Page de connexion avec un message d'erreur.",
  observations: [
    { id: "o1", category: "error_message", severity: "high", description: "Un bandeau rouge indique « Erreur 500 »", evidence: "Erreur 500" },
    { id: "o2", category: "layout", severity: "low", description: "Le bouton Valider déborde du cadre", region: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } },
  ],
  hypotheses: [{ id: "h1", statement: "L'API d'authentification renvoie une erreur serveur", confidence: 0.6, basedOn: ["o1", "inconnu"], suggestedChecks: ["Consulter les logs de l'API"] }],
  sensitiveRegions: [{ kind: "password", region: { x: 0, y: 0, width: 0.25, height: 0.25 } }],
};
