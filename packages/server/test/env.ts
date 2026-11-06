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
import { DeviceRegistry } from "../src/devices.js";
import { MockProvider, type VisionProvider } from "../src/analysis/providers.js";
import { buildMcpServer } from "../src/mcp.js";

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
      { id: "tester", tokenSha256: sha256Hex(T.tester), devices: ["pc1"], providers: ["mock"], shareTo: ["dev"] },
      { id: "dev", tokenSha256: sha256Hex(T.dev), tools: ["compare_screens"], providers: ["mock"] },
      { id: "intruder", tokenSha256: sha256Hex(T.intruder), tools: ["capture_screen", "analyze_screen", "compare_screens", "share_visual_report"], devices: [], providers: [] },
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

export function makeEnv(opts: { respond?: (i: any) => string; config?: Record<string, unknown> } = {}): TestEnv {
  const config = makeConfig(opts.config);
  const device = new FakeDevice("pc1");
  const provider = new MockProvider("mock-1", opts.respond ?? (() => JSON.stringify(defaultAnalysis)));
  const registry = new DeviceRegistry([], 30);
  registry.set(device);
  const ctx = createAppContext(config, { devices: registry, providers: new Map<string, VisionProvider>([["mock", provider]]) });
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

export const defaultAnalysis = {
  summary: "Page de connexion avec un message d'erreur.",
  observations: [
    { id: "o1", category: "error_message", severity: "high", description: "Un bandeau rouge indique « Erreur 500 »", evidence: "Erreur 500" },
    { id: "o2", category: "layout", severity: "low", description: "Le bouton Valider déborde du cadre", region: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } },
  ],
  hypotheses: [{ id: "h1", statement: "L'API d'authentification renvoie une erreur serveur", confidence: 0.6, basedOn: ["o1", "inconnu"], suggestedChecks: ["Consulter les logs de l'API"] }],
  sensitiveRegions: [{ kind: "password", region: { x: 0, y: 0, width: 0.25, height: 0.25 } }],
};
