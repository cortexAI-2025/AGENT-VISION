import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalServer } from "../src/http.js";
import { ObservationManager } from "../src/observe.js";
import { CaptureError, CaptureService } from "../src/service.js";
import { ConsentStore } from "../src/consent.js";
import { setup, TOKEN, testPng } from "./helpers.js";

const code = async (p: Promise<unknown> | (() => unknown)) => {
  try { await (typeof p === "function" ? p() : p); return "ok"; } catch (e) { return e instanceof CaptureError ? e.code : "other"; }
};
const req = (over = {}) => ({ agentId: "tester", target: "screen" as const, intervalMs: 1000, maxDurationSec: 60, maxCaptures: 5, ...over });

function mgr(over = {}) {
  const s = setup(over);
  let t = 1_000_000;
  const consent = new ConsentStore(s.stateDir, () => t);
  const service = new CaptureService({ config: s.config, consent, capturer: s.capturer, prompter: s.prompter, indicator: s.indicator, stateDir: s.stateDir, now: () => t });
  const m = new ObservationManager(consent, service, () => t);
  return { ...s, consent, service, m, advance: (ms: number) => (t += ms) };
}

describe("observation locale — consentement et bornes", () => {
  it("sans grant d'observation ⇒ consent_required (un grant de capture ponctuelle ne suffit pas)", () => {
    const x = mgr();
    x.consent.grant("tester", 10);
    expect(() => x.m.start(req())).toThrowError(/observation consent/);
  });
  it("les bornes demandées sont plafonnées par le consentement", () => {
    const x = mgr();
    x.consent.grantObservation("tester", 10, 3, 2000);
    const s = x.m.start(req({ maxCaptures: 100, maxDurationSec: 99999, intervalMs: 2000 }));
    expect(s.maxCaptures).toBe(3);
    expect(Date.parse(s.expiresAt) - 1_000_000).toBeLessThanOrEqual(10 * 60_000);
  });
  it("intervalle inférieur au minimum accordé ⇒ refus", async () => {
    const x = mgr();
    x.consent.grantObservation("tester", 10, 10, 5000);
    expect(await code(() => x.m.start(req({ intervalMs: 1000 })))).toBe("consent_denied");
  });
  it("cible non accordée ⇒ refus", async () => {
    const x = mgr();
    x.consent.grantObservation("tester", 10, 10, 1000, ["screen"]);
    expect(await code(() => x.m.start(req({ target: "window" })))).toBe("consent_denied");
  });
  it("une seule session par agent", async () => {
    const x = mgr();
    x.consent.grantObservation("tester", 10, 10, 1000);
    x.m.start(req());
    expect(await code(() => x.m.start(req()))).toBe("rate_limited");
  });
  it("captures successives : intervalle respecté, budget épuisé, puis plus rien", async () => {
    const x = mgr();
    x.consent.grantObservation("tester", 10, 2, 1000);
    const { sessionId } = x.m.start(req());
    x.advance(1000);
    expect((await x.m.capture(sessionId, "tester")).width).toBe(200);
    expect(await code(x.m.capture(sessionId, "tester"))).toBe("rate_limited"); // trop tôt
    x.advance(1000);
    await x.m.capture(sessionId, "tester");
    x.advance(1000);
    expect(await code(x.m.capture(sessionId, "tester"))).toBe("rate_limited"); // budget
    expect(await code(x.m.capture(sessionId, "tester"))).toBe("consent_required"); // session fermée
    expect(x.capturer.calls).toBe(2);
  });
  it("session expirée ⇒ timeout puis fermée ; impossible de la prolonger", async () => {
    const x = mgr();
    x.consent.grantObservation("tester", 10, 10, 1000);
    const { sessionId } = x.m.start(req({ maxDurationSec: 5 }));
    x.advance(6000);
    expect(await code(x.m.capture(sessionId, "tester"))).toBe("timeout");
    expect(await code(x.m.capture(sessionId, "tester"))).toBe("consent_required");
    expect(x.capturer.calls).toBe(0);
  });
  it("révocation du consentement en cours de session ⇒ la capture suivante est refusée", async () => {
    const x = mgr();
    x.consent.grantObservation("tester", 10, 10, 1000);
    const { sessionId } = x.m.start(req());
    x.advance(1000);
    await x.m.capture(sessionId, "tester");
    x.consent.revoke("tester");
    x.advance(1000);
    expect(await code(x.m.capture(sessionId, "tester"))).toBe("consent_required");
    expect(x.capturer.calls).toBe(1);
  });
  it("arrêt d'urgence ⇒ capture_stopped, y compris après resume la session n'est pas relancée", async () => {
    const x = mgr();
    x.consent.grantObservation("tester", 10, 10, 1000);
    const { sessionId } = x.m.start(req());
    x.consent.stop();
    x.advance(1000);
    expect(await code(x.m.capture(sessionId, "tester"))).toBe("capture_stopped");
    x.consent.resume();
    expect(await code(x.m.capture(sessionId, "tester"))).toBe("consent_required"); // session morte
  });
  it("un autre agent ne peut ni capturer ni arrêter la session", async () => {
    const x = mgr();
    x.consent.grantObservation("tester", 10, 10, 1000);
    const { sessionId } = x.m.start(req());
    x.advance(1000);
    expect(await code(x.m.capture(sessionId, "autre"))).toBe("consent_required");
    expect(x.m.stop(sessionId, "autre")).toBe(false);
    expect(x.m.active()).toBe(1);
  });
  it("redémarrage du service : les sessions (mémoire) sont perdues, les consentements (disque) subsistent", async () => {
    const x = mgr();
    x.consent.grantObservation("tester", 10, 10, 1000);
    const { sessionId } = x.m.start(req());
    const y = new ObservationManager(new ConsentStore(x.stateDir, () => 1_000_000), x.service, () => 1_000_000);
    expect(await code(y.capture(sessionId, "tester"))).toBe("consent_required");
    expect(y.start(req()).sessionId).toMatch(/^obs_/); // un grant valide permet d'ouvrir une NOUVELLE session
  });
  it("captures concurrentes sur le même appareil : sérialisées par le verrou, jamais deux en parallèle", async () => {
    const x = mgr();
    x.consent.grantObservation("tester", 10, 10, 250);
    x.consent.grantObservation("autre", 10, 10, 250);
    const a = x.m.start(req({ intervalMs: 250 }));
    const b = x.m.start(req({ agentId: "autre", intervalMs: 250 }));
    let running = 0, maxRunning = 0;
    x.capturer.capture = async () => { running++; maxRunning = Math.max(maxRunning, running); await new Promise((r) => setTimeout(r, 30)); running--; return { png: testPng(), windowTitle: undefined }; };
    x.advance(1000);
    const results = await Promise.all([code(x.m.capture(a.sessionId, "tester")), code(x.m.capture(b.sessionId, "autre"))]);
    expect(maxRunning).toBe(1);
    expect(results.sort()).toEqual(["ok", "rate_limited"]);
  });
  it("écran verrouillé et image noire pendant l'observation sont refusés", async () => {
    const x = mgr();
    x.consent.grantObservation("tester", 10, 10, 250);
    const { sessionId } = x.m.start(req({ intervalMs: 250 }));
    x.capturer.locked = true;
    x.advance(1000);
    expect(await code(x.m.capture(sessionId, "tester"))).toBe("screen_locked");
  });
});

describe("observation locale — API HTTP", () => {
  const servers: { close(): void }[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));
  it("start → capture → stop, authentifié ; routes sans jeton refusées", async () => {
    const s = setup();
    s.consent.grantObservation("tester", 10, 5, 250);
    const server = createLocalServer({ config: s.config, service: s.service, consent: s.consent, backendName: "fake", capturer: s.capturer });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (p: string, body: unknown, token: string | null = TOKEN) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

    expect((await call("/v1/observe/start", req({ intervalMs: 250 }), null)).status).toBe(401);
    expect((await call("/v1/observe/start", { agentId: "tester" })).status).toBe(400);
    const st = await (await call("/v1/observe/start", req({ intervalMs: 250 }))).json();
    expect(st.sessionId).toMatch(/^obs_/);
    await new Promise((r) => setTimeout(r, 300));
    const c = await call("/v1/observe/capture", { sessionId: st.sessionId, agentId: "tester" });
    expect(c.status).toBe(200);
    expect((await call("/v1/observe/stop", { sessionId: st.sessionId, agentId: "tester" })).status).toBe(200);
    expect((await call("/v1/observe/capture", { sessionId: st.sessionId, agentId: "tester" })).status).toBe(403);

    const health = await (await fetch(base + "/v1/health", { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    expect(health.capabilities).toMatchObject({ observation: true, targets: ["screen"] });
  });
  it("/v1/stop ferme aussi les sessions d'observation", async () => {
    const s = setup();
    s.consent.grantObservation("tester", 10, 5, 250);
    const server = createLocalServer({ config: s.config, service: s.service, consent: s.consent, backendName: "fake", capturer: s.capturer });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const h = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
    const st = await (await fetch(base + "/v1/observe/start", { method: "POST", headers: h, body: JSON.stringify(req({ intervalMs: 250 })) })).json();
    await fetch(base + "/v1/stop", { method: "POST", headers: h, body: "{}" });
    await new Promise((r) => setTimeout(r, 300));
    const c = await fetch(base + "/v1/observe/capture", { method: "POST", headers: h, body: JSON.stringify({ sessionId: st.sessionId, agentId: "tester" }) });
    expect(c.status).toBe(403); // session fermée par l'arrêt d'urgence (échec fermé)
    expect(s.capturer.calls).toBe(0);
  });
});
