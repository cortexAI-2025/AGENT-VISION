import { describe, expect, it } from "vitest";
import { DeviceError } from "../src/devices.js";
import { makeEnv, screenA, screenB, screenTiny, until, wait, png } from "./env.js";

const obsCfg = { observation: { minIntervalMs: 10, minAnalysisIntervalMs: 0, keepCaptures: 3, maxAnalysesPerSession: 20 } };
const start = (env: ReturnType<typeof makeEnv>, args: Record<string, unknown> = {}, agent = "tester") =>
  env.call(agent, "start_observation", { deviceId: "pc1", intervalSeconds: 0.1, maxDurationSeconds: 30, maxCaptures: 50, ...args });
const status = async (env: ReturnType<typeof makeEnv>, id: string, agent = "tester") => (await env.call(agent, "get_observation_status", { observationId: id })).json;

describe("observation — détection de changements", () => {
  it("identiques dédupliquées, micro-variations ignorées, vrai changement retenu et analysé", async () => {
    const env = makeEnv({ config: obsCfg });
    env.device.frames = [screenA(), screenA(), screenTiny(), screenB(), screenB()];
    const r = await start(env, { analyzeChanges: false });
    expect(r.json.state).toBe("running");
    const id = r.json.observationId;
    await until(async () => (await status(env, id)).counters.captures >= 5);
    const st = await status(env, id);
    expect(st.counters).toMatchObject({ captures: expect.any(Number), identical: expect.any(Number), minor: 1, significant: 1 });
    expect(st.counters.identical).toBeGreaterThanOrEqual(2); // A=A et B=B
    const ch = (await env.call("tester", "get_visual_changes", { observationId: id })).json;
    expect(ch.changes).toHaveLength(1);
    expect(ch.changes[0].diff.verdict).toBe("significant_changes");
    expect(ch.changes[0].diff.regions[0].x).toBeGreaterThanOrEqual(96);
    expect(env.provider.calls).toHaveLength(0); // analyzeChanges:false ⇒ aucun appel LLM
    await env.call("tester", "stop_observation", { observationId: id });
  });

  it("la dérive lente est détectée (la référence ne bouge pas sur les variations mineures)", async () => {
    const env = makeEnv({ config: obsCfg });
    // chaque image diffère de la précédente de ~0.6 % des pixels mais de >1 % de la référence au bout de 2 pas
    const step = (n: number) => png(200, 100, (x, y) => (y < n * 2 ? [255, 255, 255] : [x, y * 2, 120]));
    env.device.frames = [step(0), step(1), step(2), step(3), step(3)];
    const id = (await start(env, { analyzeChanges: false, changeThreshold: 0.015 })).json.observationId;
    await until(async () => (await status(env, id)).counters.captures >= 5);
    expect((await status(env, id)).counters.significant).toBeGreaterThanOrEqual(1);
    await env.call("tester", "stop_observation", { observationId: id });
  });

  it("zones ignorées (horloge) : un changement dans la zone n'est pas retenu", async () => {
    const env = makeEnv({ config: obsCfg });
    env.device.frames = [screenA(), screenB(), screenB()];
    // screenB change le quart bas-droit ; on l'ignore
    const id = (await start(env, { analyzeChanges: false, ignoreRegions: [{ x: 0.45, y: 0.45, width: 0.55, height: 0.55 }] })).json.observationId;
    await until(async () => (await status(env, id)).counters.captures >= 3);
    expect((await status(env, id)).counters.significant).toBe(0);
    await env.call("tester", "stop_observation", { observationId: id });
  });

  it("analyse IA : description structurée, dédupliquée par hash perceptuel, un seul appel pour un même changement", async () => {
    const env = makeEnv({ config: obsCfg, respond: () => JSON.stringify({ summary: "Un carré rouge est apparu", observations: [], hypotheses: [] }) });
    env.device.frames = [screenA(), screenB(), screenA(), screenB(), screenB()];
    const id = (await start(env)).json.observationId;
    await until(async () => (await status(env, id)).counters.captures >= 5);
    await until(async () => !(await status(env, id)).analysisInFlight);
    const ch = (await env.call("tester", "get_visual_changes", { observationId: id })).json.changes;
    expect(ch.length).toBe(3); // A→B, B→A, A→B
    expect(ch[0].analysis.status).toBe("done");
    expect(ch[0].analysis.description.summary).toMatch(/rouge/);
    expect(ch[2].analysis.status).toBe("deduplicated"); // même rendu que le changement n°1
    expect(ch[2].analysis.reusedFromChange).toBe(1);
    expect(env.provider.calls.length).toBeLessThan(3);
    await env.call("tester", "stop_observation", { observationId: id });
  });

  it("backpressure : une seule analyse en vol, les changements suivants ne déclenchent pas d'appel", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const env = makeEnv({ config: obsCfg, respond: () => JSON.stringify({ summary: "x" }) });
    const slow = env.provider.complete.bind(env.provider);
    env.provider.complete = async (i) => { await gate; return slow(i); };
    const bars = (n: number) => png(200, 100, (x, y) => (x < n * 40 ? [255, 0, 0] : [x, y * 2, 120]));
    env.device.frames = [bars(0), bars(1), bars(2), bars(3), bars(4), bars(4)];
    const id = (await start(env)).json.observationId;
    await until(async () => (await status(env, id)).counters.captures >= 6);
    const ch = (await env.call("tester", "get_visual_changes", { observationId: id })).json.changes;
    const statuses = ch.map((c: any) => c.analysis.status);
    expect(statuses.filter((s: string) => s === "pending").length).toBe(1);
    expect(statuses.filter((s: string) => s === "skipped_backpressure").length).toBeGreaterThanOrEqual(2);
    release();
    await until(async () => !(await status(env, id)).analysisInFlight);
    expect(env.provider.calls.length).toBe(1);
    await env.call("tester", "stop_observation", { observationId: id });
  });

  it("fournisseur distant + OCR en échec : changements enregistrés mais RIEN transmis", async () => {
    const failing = { name: "x", recognize: async () => { throw new Error("down"); } };
    const env = makeEnv({ config: obsCfg, ocr: failing, remote: true });
    env.device.frames = [screenA(), screenB(), screenB()];
    const id = (await start(env)).json.observationId;
    await until(async () => (await status(env, id)).counters.captures >= 3);
    await until(async () => !(await status(env, id)).analysisInFlight);
    const ch = (await env.call("tester", "get_visual_changes", { observationId: id })).json.changes;
    expect(ch[0].analysis.status).toBe("sanitization_failed");
    expect(env.provider.calls).toHaveLength(0);
    await env.call("tester", "stop_observation", { observationId: id });
  });
});

describe("observation — budget d'analyses", () => {
  it("maxAnalysesPerSession plafonne les appels au modèle", async () => {
    const env = makeEnv({ config: { observation: { ...obsCfg.observation, maxAnalysesPerSession: 1 } }, respond: () => JSON.stringify({ summary: "x" }) });
    const bars = (n: number) => png(200, 100, (x, y) => (x < n * 40 ? [255, 0, 0] : [x, y * 2, 120]));
    env.device.frames = [bars(0), bars(1), bars(2), bars(3), bars(4), bars(4)];
    const id = (await start(env)).json.observationId;
    await until(async () => (await status(env, id)).counters.captures >= 6);
    await until(async () => !(await status(env, id)).analysisInFlight);
    expect(env.provider.calls.length).toBe(1);
    const ch = (await env.call("tester", "get_visual_changes", { observationId: id })).json.changes;
    expect(ch.some((c: any) => c.analysis.status === "skipped_budget")).toBe(true);
    await env.call("tester", "stop_observation", { observationId: id });
  });
});

describe("observation — limites, arrêt, expiration", () => {
  it("budget de captures épuisé ⇒ état exhausted et plus aucune capture", async () => {
    const env = makeEnv({ config: obsCfg });
    const id = (await start(env, { maxCaptures: 3, analyzeChanges: false })).json.observationId;
    await until(async () => (await status(env, id)).state === "exhausted");
    const n = env.device.observeCalls.capture;
    await wait(300);
    expect(env.device.observeCalls.capture).toBe(n);
    expect((await status(env, id)).counters.captures).toBe(3);
    expect(env.device.observeCalls.stop).toBe(1); // la session locale est fermée
  });

  it("durée dépassée ⇒ expired, non prolongeable", async () => {
    const env = makeEnv({ config: obsCfg });
    const id = (await start(env, { maxDurationSeconds: 1, analyzeChanges: false })).json.observationId;
    await until(async () => (await status(env, id)).state === "expired", 4000);
    const n = env.device.observeCalls.capture;
    await wait(300);
    expect(env.device.observeCalls.capture).toBe(n);
    // aucun outil ne permet de prolonger ni de relancer : stop sur session expirée reste expired
    expect((await env.call("tester", "stop_observation", { observationId: id })).json.state).toBe("expired");
  }, 10000);

  it("stop_observation arrête immédiatement et la session ne repart pas", async () => {
    const env = makeEnv({ config: obsCfg });
    const id = (await start(env, { analyzeChanges: false })).json.observationId;
    await until(async () => (await status(env, id)).counters.captures >= 1);
    expect((await env.call("tester", "stop_observation", { observationId: id })).json.state).toBe("stopped");
    const n = env.device.observeCalls.capture;
    await wait(400);
    expect(env.device.observeCalls.capture).toBe(n);
    expect((await status(env, id)).state).toBe("stopped");
  });

  it("l'appareil arrête (arrêt d'urgence local) ⇒ stopped_by_device", async () => {
    const env = makeEnv({ config: obsCfg });
    const id = (await start(env, { analyzeChanges: false })).json.observationId;
    await until(async () => (await status(env, id)).counters.captures >= 1);
    env.device.captureError = new DeviceError("capture_stopped", "stopped locally");
    await until(async () => (await status(env, id)).state === "stopped_by_device");
    expect((await status(env, id)).stopReason).toMatch(/capture_stopped/);
  });

  it("erreurs réseau répétées ⇒ state error après 3 échecs consécutifs", async () => {
    const env = makeEnv({ config: obsCfg });
    env.device.captureError = new DeviceError("backend_unavailable", "unreachable");
    const id = (await start(env, { analyzeChanges: false })).json.observationId;
    await until(async () => (await status(env, id)).state === "error");
    expect((await status(env, id)).counters.errors).toBe(3);
  });

  it("deleteOnStop supprime les captures ; keepCaptures borne le stockage", async () => {
    const env = makeEnv({ config: obsCfg });
    const bars = (n: number) => png(200, 100, (x, y) => (x < n * 15 ? [255, 0, 0] : [x, y * 2, 120]));
    env.device.frames = Array.from({ length: 8 }, (_, i) => bars(i));
    const id = (await start(env, { analyzeChanges: false, deleteOnStop: true, changeThreshold: 0.01 })).json.observationId;
    await until(async () => (await status(env, id)).counters.captures >= 8);
    const ch = (await env.call("tester", "get_visual_changes", { observationId: id })).json.changes;
    const alive = ch.filter((c: any) => env.ctx.store.getMeta(c.captureId)).length;
    expect(alive).toBeLessThanOrEqual(3); // keepCaptures = 3
    await env.call("tester", "stop_observation", { observationId: id });
    expect(ch.filter((c: any) => env.ctx.store.getMeta(c.captureId)).length).toBe(0);
  });
});

describe("observation — permissions et isolation", () => {
  it("refus de consentement local ⇒ erreur, aucune session, aucune capture", async () => {
    const env = makeEnv({ config: obsCfg });
    env.device.observeConsent = false;
    const r = await start(env);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("consent_required");
    expect(env.device.observeCalls.capture).toBe(0);
  });

  it("appareil non autorisé, outil non autorisé", async () => {
    const env = makeEnv({ config: obsCfg });
    expect((await start(env, {}, "intruder")).json.error).toBe("forbidden");
    expect((await start(env, {}, "dev")).json.error).toBe("forbidden");
    expect(env.device.observeCalls.start).toBe(0);
  });

  it("un autre agent ne peut ni lire, ni arrêter, ni voir les changements d'une observation", async () => {
    const env = makeEnv({ config: obsCfg });
    const id = (await start(env, { analyzeChanges: false })).json.observationId;
    for (const [tool, args] of [["get_observation_status", {}], ["stop_observation", {}], ["get_visual_changes", {}]] as const) {
      const r = await env.call("intruder", tool, { observationId: id, ...args });
      expect(r.json.error).toBe("not_found");
    }
    expect((await status(env, id)).state).toBe("running");
    await env.call("tester", "stop_observation", { observationId: id });
  });

  it("plafonds serveur : intervalle, durée, captures, sessions concurrentes", async () => {
    const env = makeEnv({ config: { observation: { ...obsCfg.observation, minIntervalMs: 1000, maxDurationSeconds: 60, maxCaptures: 10 } } });
    expect((await start(env, { intervalSeconds: 0.2 })).json.error).toBe("bad_request");
    expect((await start(env, { intervalSeconds: 1, maxDurationSeconds: 61 })).json.error).toBe("bad_request");
    expect((await start(env, { intervalSeconds: 1, maxCaptures: 11 })).json.error).toBe("bad_request");
    const first = await start(env, { intervalSeconds: 1, maxCaptures: 5, analyzeChanges: false });
    expect(first.json.state).toBe("running");
    expect((await start(env, { intervalSeconds: 1, analyzeChanges: false })).json.error).toBe("rate_limited");
    await env.call("tester", "stop_observation", { observationId: first.json.observationId });
  });

  it("entrées malformées rejetées avant tout traitement", async () => {
    const env = makeEnv({ config: obsCfg });
    const c = await env.client("tester");
    for (const args of [{ deviceId: "pc1", intervalSeconds: -1 }, { deviceId: "pc1", maxCaptures: 0 }, { deviceId: "pc1", ignoreRegions: [{ x: 2, y: 0, width: 1, height: 1 }] }, { deviceId: "" }, { deviceId: "pc1", target: "keyboard" }]) {
      const r: any = await c.callTool({ name: "start_observation", arguments: args });
      expect(r.isError).toBe(true);
    }
    expect(env.device.observeCalls.start).toBe(0);
  });

  it("l'audit consigne démarrage et fin", async () => {
    const env = makeEnv({ config: obsCfg });
    const id = (await start(env, { analyzeChanges: false })).json.observationId;
    await env.call("tester", "stop_observation", { observationId: id });
    const { readFileSync } = await import("node:fs");
    const actions = readFileSync(env.ctx.auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l).action);
    expect(actions).toEqual(expect.arrayContaining(["observation_start", "observation_end"]));
  });
});
