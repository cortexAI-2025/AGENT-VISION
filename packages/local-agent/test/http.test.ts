import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalServer } from "../src/http.js";
import { setup, TOKEN } from "./helpers.js";

const servers: { close(): void }[] = [];
afterEach(() => { servers.splice(0).forEach((s) => s.close()); });

async function start(over = {}) {
  const s = setup(over);
  const server = createLocalServer({ config: s.config, service: s.service, consent: s.consent, backendName: "fake" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    fetch(base + path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" } });
  return { s, call };
}

describe("API HTTP de l'agent local", () => {
  it("401 sans jeton ou avec mauvais jeton", async () => {
    const { call } = await start();
    expect((await call("/v1/health", {}, null)).status).toBe(401);
    expect((await call("/v1/health", {}, "mauvais")).status).toBe(401);
    expect((await call("/v1/health")).status).toBe(200);
  });

  it("capture : 403 sans consentement, 200 avec", async () => {
    const { s, call } = await start();
    const body = JSON.stringify({ agentId: "tester", target: "screen" });
    const denied = await call("/v1/capture", { method: "POST", body });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toBe("consent_required");
    s.consent.grant("tester", 5);
    const ok = await call("/v1/capture", { method: "POST", body });
    expect(ok.status).toBe(200);
    expect((await ok.json()).pngBase64.length).toBeGreaterThan(100);
  });

  it("valide le corps de requête", async () => {
    const { call } = await start();
    expect((await call("/v1/capture", { method: "POST", body: "{pas du json" })).status).toBe(400);
    expect((await call("/v1/capture", { method: "POST", body: JSON.stringify({ target: "screen" }) })).status).toBe(400);
    expect((await call("/v1/capture", { method: "POST", body: JSON.stringify({ agentId: "a", target: "keyboard" }) })).status).toBe(400);
  });

  it("/v1/stop arrête, et aucune route ne permet de reprendre ni d'accorder un consentement", async () => {
    const { s, call } = await start();
    s.consent.grant("tester", 5);
    expect((await call("/v1/stop", { method: "POST" })).status).toBe(200);
    const r = await call("/v1/capture", { method: "POST", body: JSON.stringify({ agentId: "tester" }) });
    expect(r.status).toBe(409);
    for (const p of ["/v1/resume", "/v1/grant", "/v1/consent"]) {
      expect((await call(p, { method: "POST", body: "{}" })).status).toBe(404);
    }
    expect(s.consent.isStopped()).toBe(true);
  });

  it("refuse d'écouter hors loopback sans TLS", () => {
    const s = setup({ host: "0.0.0.0" });
    expect(() => createLocalServer({ config: s.config, service: s.service, consent: s.consent, backendName: "x" })).toThrow(/TLS/);
  });

  it("refuse un corps trop gros", async () => {
    const { call } = await start();
    const r = await call("/v1/capture", { method: "POST", body: JSON.stringify({ agentId: "a", reason: "x".repeat(40_000) }) });
    expect(r.status).toBe(400);
  });
});
