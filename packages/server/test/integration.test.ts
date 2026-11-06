import { execFileSync, spawn } from "node:child_process";
import { createServer as createHttps } from "node:https";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sha256Hex } from "@agent-vision/core";
import { AnthropicProvider, GeminiProvider, OpenAICompatProvider } from "../src/analysis/providers.js";
import { createAppContext } from "../src/app.js";
import { LocalHttpDevice, DeviceRegistry, PushDevice } from "../src/devices.js";
import { createGateway } from "../src/gateway.js";
import { createMcpHttpHandler } from "../src/mcp-http.js";
import { MockProvider } from "../src/analysis/providers.js";
// agent local RÉEL (sans mocks HTTP) pour le bout-en-bout
import { ConsentStore } from "../../local-agent/src/consent.js";
import { createLocalServer } from "../../local-agent/src/http.js";
import { LocalConfig } from "../../local-agent/src/config.js";
import { CaptureService } from "../../local-agent/src/service.js";
import { defaultAnalysis, makeConfig, makeEnv, screenA, T } from "./env.js";

const closers: Array<() => void> = [];
afterEach(() => { closers.splice(0).forEach((c) => c()); });
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => { closers.push(() => s.close()); r((s.address() as AddressInfo).port); }));

describe("adaptateurs de fournisseurs (requêtes réelles vers un faux fournisseur local)", () => {
  async function stub(reply: unknown) {
    const seen: { url?: string; headers?: any; body?: any }[] = [];
    const s = createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => { seen.push({ url: req.url, headers: req.headers, body: JSON.parse(b) }); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(reply)); });
    });
    const port = await listen(s);
    return { seen, base: `http://127.0.0.1:${port}` };
  }
  const img = screenA();
  it("Anthropic", async () => {
    const { seen, base } = await stub({ content: [{ type: "text", text: "{\"summary\":\"a\"}" }] });
    const out = await new AnthropicProvider("claude-x", "KEY", base).complete({ system: "S", prompt: "P", images: [img] });
    expect(out).toBe('{"summary":"a"}');
    expect(seen[0]!.url).toBe("/v1/messages");
    expect(seen[0]!.headers["x-api-key"]).toBe("KEY");
    expect(seen[0]!.headers["anthropic-version"]).toBeDefined();
    expect(seen[0]!.body.system).toBe("S");
    expect(seen[0]!.body.messages[0].content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
  });
  it("OpenAI-compatible (DeepSeek/Grok/Ollama via baseUrl)", async () => {
    const { seen, base } = await stub({ choices: [{ message: { content: "{\"summary\":\"b\"}" } }] });
    const out = await new OpenAICompatProvider("deepseek", "m", "K", base + "/v1", false).complete({ system: "S", prompt: "P", images: [img, img] });
    expect(out).toBe('{"summary":"b"}');
    expect(seen[0]!.url).toBe("/v1/chat/completions");
    expect(seen[0]!.headers.authorization).toBe("Bearer K");
    const parts = seen[0]!.body.messages[1].content;
    expect(parts.filter((p: any) => p.type === "image_url")).toHaveLength(2);
    expect(parts[0].image_url.url).toMatch(/^data:image\/png;base64,/);
  });
  it("Gemini (clé en en-tête, pas dans l'URL)", async () => {
    const { seen, base } = await stub({ candidates: [{ content: { parts: [{ text: "{\"summary\":\"c\"}" }] } }] });
    const out = await new GeminiProvider("gem", "K", base).complete({ system: "S", prompt: "P", images: [img] });
    expect(out).toBe('{"summary":"c"}');
    expect(seen[0]!.url).toBe("/models/gem:generateContent");
    expect(seen[0]!.url).not.toContain("K");
    expect(seen[0]!.headers["x-goog-api-key"]).toBe("K");
    expect(seen[0]!.body.contents[0].parts[0].inlineData.mimeType).toBe("image/png");
  });
  it("erreur HTTP du fournisseur : message sans fuite de clé", async () => {
    const s = createServer((_q, r) => { r.statusCode = 401; r.end("bad key=SECRETVALUE"); });
    const port = await listen(s);
    await expect(new OpenAICompatProvider("x", "m", "K", `http://127.0.0.1:${port}`).complete({ system: "", prompt: "", images: [] })).rejects.toThrow(/401/);
  });
});

describe("bout-en-bout : agent local réel → serveur MCP → analyse", () => {
  function startLocal(over: Record<string, unknown> = {}) {
    const stateDir = mkdtempSync(join(tmpdir(), "av-e2e-"));
    const config = LocalConfig.parse({ deviceId: "win-e2e", tokenSha256: sha256Hex("DEVTOKEN"), minIntervalMs: 0, notify: false, ...over });
    const consent = new ConsentStore(stateDir);
    const capturer = { name: "fake", isAvailable: async () => true, isLocked: async () => false, capture: async () => ({ png: screenA(), windowTitle: "App" }) };
    const events: string[] = [];
    const service = new CaptureService({ config, consent, capturer, stateDir, prompter: { confirmCapture: async () => true }, indicator: { begin: async () => void events.push("begin"), end: async () => void events.push("end") } });
    return { config, consent, events, server: createLocalServer({ config, service, consent, backendName: "fake" }) };
  }

  it("sans consentement local → refus remonté à l'agent ; avec consentement → rapport complet ; arrêt → refus", async () => {
    const local = startLocal();
    const port = await listen(local.server);
    const cfg = makeConfig({ devices: [{ kind: "local-http", id: "pc1", url: `http://127.0.0.1:${port}`, token: "DEVTOKEN", platform: "windows" }] });
    const mock = new MockProvider("m", () => JSON.stringify(defaultAnalysis));
    const ctx = createAppContext(cfg, { providers: new Map([["mock", mock]]) });
    const { buildMcpServer } = await import("../src/mcp.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(ctx, cfg.agents[0]!).connect(st);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(ct);
    const call = async (name: string, args: any) => { const r: any = await c.callTool({ name, arguments: args }); return { err: r.isError, j: JSON.parse(r.content[0].text) }; };

    const denied = await call("capture_screen", { deviceId: "pc1" });
    expect(denied.err).toBe(true);
    expect(denied.j.error).toBe("consent_required");

    local.consent.grant("tester", 5);
    const ok = await call("capture_screen", { deviceId: "pc1", reason: "vérifier le login" });
    expect(ok.err).toBeFalsy();
    expect(ok.j).toMatchObject({ deviceId: "pc1", backend: "fake", width: 200, height: 100, windowTitle: "App" });
    expect(local.events).toEqual(["begin", "end"]); // indicateur affiché

    const an = await call("analyze_screen", { captureId: ok.j.captureId });
    expect(an.j.observations.length).toBe(2);
    const sh = await call("share_visual_report", { captureId: ok.j.captureId, toAgent: "dev" });
    expect(sh.j.report.capture.platform).toBe("windows");

    local.consent.stop();
    const stopped = await call("capture_screen", { deviceId: "pc1" });
    expect(stopped.j.error).toBe("capture_stopped");
  });

  it("mauvais jeton d'appareil → unauthorized", async () => {
    const local = startLocal();
    const port = await listen(local.server);
    const d = new LocalHttpDevice({ kind: "local-http", id: "x", url: `http://127.0.0.1:${port}`, token: "MAUVAIS" });
    await expect(d.capture({ agentId: "a", target: "screen" })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("refuse HTTP en clair vers un hôte non loopback", () => {
    expect(() => new LocalHttpDevice({ kind: "local-http", id: "x", url: "http://192.168.1.20:7821", token: "t" })).toThrow(/https/);
  });
});

describe("TLS : épinglage du certificat", () => {
  const haveOpenssl = (() => { try { execFileSync("openssl", ["version"]); return true; } catch { return false; } })();
  it.skipIf(!haveOpenssl)("accepte l'empreinte attendue, rejette une autre", async () => {
    const dir = mkdtempSync(join(tmpdir(), "av-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });
    const fp = execFileSync("openssl", ["x509", "-in", join(dir, "c.pem"), "-noout", "-fingerprint", "-sha256"]).toString().split("=")[1]!.trim().replace(/:/g, "").toLowerCase();
    let hits = 0;
    const s = createHttps({ cert: readFileSync(join(dir, "c.pem")), key: readFileSync(join(dir, "k.pem")) }, (_q, r) => { hits++; r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ deviceId: "d", capturedAt: "now", target: "screen", backend: "b", width: 1, height: 1, sha256: "x", pngBase64: "AA==" })); });
    const port = await listen(s);
    const url = `https://127.0.0.1:${port}`;
    const good = new LocalHttpDevice({ kind: "local-http", id: "g", url, token: "t", tlsFingerprint256: fp });
    expect((await good.capture({ agentId: "a", target: "screen" })).deviceId).toBe("d");
    const before = hits;
    const bad = new LocalHttpDevice({ kind: "local-http", id: "b", url, token: "t", tlsFingerprint256: "00".repeat(32) });
    await expect(bad.capture({ agentId: "a", target: "screen" })).rejects.toThrow(/fingerprint/);
    expect(hits).toBe(before); // rien envoyé (ni jeton) au serveur non épinglé
    // sans épinglage, un certificat auto-signé est rejeté par défaut
    const unpinned = new LocalHttpDevice({ kind: "local-http", id: "u", url, token: "t" });
    await expect(unpinned.capture({ agentId: "a", target: "screen" })).rejects.toMatchObject({ code: "backend_unavailable" });
  });
});

describe("appareil « push » (prototype Android) via la passerelle", () => {
  function setup() {
    const cfg = makeConfig({
      devices: [{ kind: "push", id: "phone", platform: "android", tokenSha256: sha256Hex("PHONETOKEN") }],
      gateway: { adminTokenSha256: sha256Hex("ADMIN") },
      pushTimeoutSeconds: 5,
      agents: [{ id: "tester", tokenSha256: sha256Hex(T.tester), devices: ["phone"], providers: ["mock"] }],
    });
    const ctx = createAppContext(cfg, { providers: new Map([["mock", new MockProvider()]]) });
    return { cfg, ctx };
  }
  async function gw() {
    const s = setup();
    const server = createGateway({ config: s.cfg, devices: s.ctx.devices, store: s.ctx.store, audit: s.ctx.audit, auditPath: s.ctx.auditPath });
    const port = await listen(server);
    const post = (path: string, token: string, body: any = {}, method = "POST") =>
      fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body) });
    return { ...s, post };
  }
  const { tools } = { tools: async () => import("../src/tools.js") };

  it("poll → l'utilisateur accepte → dépôt → capture_screen aboutit", async () => {
    const g = await gw();
    const { captureScreen } = await tools();
    const pending = captureScreen(g.ctx, g.cfg.agents[0]!, { deviceId: "phone", target: "screen", reason: "test android", includeImage: false });
    await new Promise((r) => setTimeout(r, 50));
    const poll = await (await g.post("/v1/device/poll", "PHONETOKEN")).json();
    expect(poll.requests).toHaveLength(1);
    expect(poll.requests[0]).toMatchObject({ agentId: "tester", reason: "test android" });
    const up = await g.post(`/v1/device/captures/${poll.requests[0].requestId}`, "PHONETOKEN", { capturedAt: new Date().toISOString(), pngBase64: screenA().toString("base64") });
    expect(up.status).toBe(200);
    const res = await pending;
    const meta = JSON.parse((res.content[0] as any).text);
    expect(meta).toMatchObject({ backend: "android-mediaprojection", platform: "android", width: 200 });
  });

  it("l'utilisateur refuse → consent_denied", async () => {
    const g = await gw();
    const { captureScreen } = await tools();
    const pending = captureScreen(g.ctx, g.cfg.agents[0]!, { deviceId: "phone", target: "screen", includeImage: false });
    await new Promise((r) => setTimeout(r, 50));
    const poll = await (await g.post("/v1/device/poll", "PHONETOKEN")).json();
    await g.post(`/v1/device/captures/${poll.requests[0].requestId}`, "PHONETOKEN", { declined: true });
    const res = await pending;
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content[0] as any).text).error).toBe("consent_denied");
  });

  it("image noire (FLAG_SECURE / contenu protégé) refusée ; jeton invalide refusé ; requête inconnue 404", async () => {
    const g = await gw();
    const { captureScreen } = await tools();
    const pending = captureScreen(g.ctx, g.cfg.agents[0]!, { deviceId: "phone", target: "screen", includeImage: false });
    await new Promise((r) => setTimeout(r, 50));
    expect((await g.post("/v1/device/poll", "MAUVAIS")).status).toBe(401);
    const poll = await (await g.post("/v1/device/poll", "PHONETOKEN")).json();
    const { png } = await import("./env.js");
    const black = png(40, 40, () => [0, 0, 0]).toString("base64");
    expect((await g.post(`/v1/device/captures/${poll.requests[0].requestId}`, "PHONETOKEN", { capturedAt: "x", pngBase64: black.padEnd(200, "A") })).status).toBe(422);
    expect(JSON.parse(((await pending).content[0] as any).text).error).toBe("blank_or_protected");
    expect((await g.post("/v1/device/captures/req_inexistant", "PHONETOKEN", { declined: true })).status).toBe(404);
  });

  it("expiration si personne ne répond", async () => {
    const reg = new DeviceRegistry([{ kind: "push", id: "p", tokenSha256: sha256Hex("x") }], 1);
    await expect(reg.get("p")!.capture({ agentId: "a", target: "screen" })).rejects.toMatchObject({ code: "timeout" });
    expect((reg.get("p") as PushDevice).pending()).toHaveLength(0);
  });

  it("administration : suppression d'une capture sur demande + vérification d'audit", async () => {
    const g = await gw();
    const meta = g.ctx.store.saveCapture(screenA(), { ownerAgent: "tester", deviceId: "phone", capturedAt: "t", backend: "b", width: 200, height: 100, sha256: "s" }, 600);
    expect((await g.post(`/admin/captures/${meta.captureId}`, "PHONETOKEN", {}, "DELETE")).status).toBe(401);
    expect((await g.post(`/admin/captures/${meta.captureId}`, "ADMIN", {}, "DELETE")).status).toBe(200);
    expect(g.ctx.store.getMeta(meta.captureId)).toBeUndefined();
    expect(existsSync(join(g.cfg.dataDir, "captures", `${meta.captureId}.png`))).toBe(false);
    expect((await g.post(`/admin/captures/${meta.captureId}`, "ADMIN", {}, "DELETE")).status).toBe(404);
    expect((await (await g.post("/admin/audit/verify", "ADMIN", {}, "GET")).json()).ok).toBe(true);
  });

  it("la passerelle refuse un binding réseau sans TLS", () => {
    const s = setup();
    s.cfg.gateway.host = "0.0.0.0";
    expect(() => createGateway({ config: s.cfg, devices: s.ctx.devices, store: s.ctx.store, audit: s.ctx.audit, auditPath: s.ctx.auditPath })).toThrow(/TLS/);
  });
});

describe("transport MCP HTTP authentifié", () => {
  it("401 sans jeton valide ; client MCP réel avec jeton → 4 outils", async () => {
    const env = makeEnv();
    const server = createGateway({ config: env.ctx.config, devices: env.ctx.devices, store: env.ctx.store, audit: env.ctx.audit, auditPath: env.ctx.auditPath, mcpHandler: createMcpHttpHandler(env.ctx) });
    const port = await listen(server);
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    const bad = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope" }, body: "{}" });
    expect(bad.status).toBe(401);
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);

    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${T.tester}` } } }));
    expect((await c.listTools()).tools).toHaveLength(4);
    const r: any = await c.callTool({ name: "capture_screen", arguments: { deviceId: "pc1" } });
    expect(JSON.parse(r.content[0].text).captureId).toMatch(/^cap_/);
    await c.close();
  });
});

describe("transport stdio (processus réel)", () => {
  const cli = join(__dirname, "../dist/cli.js");
  it.skipIf(!existsSync(cli))("refuse de démarrer sans jeton ; démarre et liste les outils avec un jeton valide", async () => {
    const cfg = makeConfig();
    const file = join(cfg.dataDir, "cfg.json");
    writeFileSync(file, JSON.stringify(cfg));
    const noTok = spawn(process.execPath, [cli, "start", "--config", file], { env: { ...process.env, AGENT_VISION_AGENT_TOKEN: "" }, stdio: "pipe" });
    const code = await new Promise<number | null>((r) => noTok.on("exit", r));
    expect(code).toBe(1);

    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "start", "--config", file], env: { ...process.env, AGENT_VISION_AGENT_TOKEN: T.tester } as Record<string, string> }));
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["analyze_screen", "capture_screen", "compare_screens", "share_visual_report"]);
    await c.close();
  });
});
