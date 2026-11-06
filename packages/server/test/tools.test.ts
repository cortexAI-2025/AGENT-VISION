import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { AuditLog } from "@agent-vision/core";
import { DeviceError } from "../src/devices.js";
import { defaultAnalysis, makeEnv, png, screenB } from "./env.js";

async function captured(env = makeEnv()) {
  const r = await env.call("tester", "capture_screen", { deviceId: "pc1", reason: "test" });
  return { env, id: r.json.captureId as string };
}

describe("serveur MCP — exposition", () => {
  it("expose les quatre outils V1 + les sept outils V1.1", async () => {
    const env = makeEnv();
    const c = await env.client("tester");
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["analyze_screen", "analyze_screen_region", "capture_screen", "compare_screens", "get_device_capabilities", "get_observation_status", "get_visual_changes", "list_available_devices", "share_visual_report", "start_observation", "stop_observation"]);
    // compatibilité V1 : les quatre outils d'origine sont toujours là
    for (const t of ["capture_screen", "analyze_screen", "compare_screens", "share_visual_report"]) expect(names).toContain(t);
  });
});

describe("capture_screen", () => {
  it("capture, stocke et ne renvoie pas l'image par défaut", async () => {
    const { env, id } = await captured();
    const r = await env.call("tester", "capture_screen", { deviceId: "pc1" });
    expect(r.content.some((c) => c.type === "image")).toBe(false);
    expect(id).toMatch(/^cap_/);
    expect(env.ctx.store.getMeta(id)?.ownerAgent).toBe("tester");
    expect(r.json.ownerAgent).toBeUndefined();
    expect(env.device.requests[0]).toMatchObject({ agentId: "tester", target: "screen", reason: "test" });
  });
  it("includeImage renvoie l'image", async () => {
    const env = makeEnv();
    const r = await env.call("tester", "capture_screen", { deviceId: "pc1", includeImage: true });
    expect(r.content.some((c) => c.type === "image")).toBe(true);
  });
  it("l'identité vient de la session, pas des arguments", async () => {
    const env = makeEnv();
    await env.call("tester", "capture_screen", { deviceId: "pc1", agentId: "dev" });
    expect(env.device.requests[0]!.agentId).toBe("tester");
  });
  it("refuse un appareil non autorisé pour l'agent", async () => {
    const env = makeEnv();
    const r = await env.call("intruder", "capture_screen", { deviceId: "pc1" });
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("forbidden");
    expect(env.device.requests).toHaveLength(0);
  });
  it("refuse un outil non autorisé", async () => {
    const env = makeEnv();
    const r = await env.call("dev", "capture_screen", { deviceId: "pc1" });
    expect(r.json.error).toBe("forbidden");
  });
  it("appareil inconnu", async () => {
    const env = makeEnv({ config: {} });
    env.ctx.config.agents[0]!.devices.push("ghost");
    expect((await env.call("tester", "capture_screen", { deviceId: "ghost" })).json.error).toBe("not_found");
  });
  it("propage les refus de l'appareil (consentement)", async () => {
    const env = makeEnv();
    env.device.error = new DeviceError("consent_required", "no active consent");
    const r = await env.call("tester", "capture_screen", { deviceId: "pc1" });
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("consent_required");
  });
  it("rejette une image uniforme venant d'un appareil", async () => {
    const env = makeEnv();
    env.device.next = () => png(50, 50, () => [0, 0, 0]);
    expect((await env.call("tester", "capture_screen", { deviceId: "pc1" })).json.error).toBe("blank_or_protected");
  });
  it("masque les secrets du titre de fenêtre", async () => {
    const env = makeEnv();
    const orig = env.device.capture.bind(env.device);
    env.device.capture = async (r) => ({ ...(await orig(r)), windowTitle: "Admin password=SuperSecret123" });
    const r = await env.call("tester", "capture_screen", { deviceId: "pc1", target: "window" });
    expect(r.json.windowTitle).not.toContain("SuperSecret123");
  });
});

describe("analyze_screen", () => {
  it("sépare observations et hypothèses, masque les zones sensibles", async () => {
    const { env, id } = await captured();
    const r = await env.call("tester", "analyze_screen", { captureId: id, context: "app v1.2", expectation: "connexion réussie" });
    expect(r.isError).toBeFalsy();
    expect(r.json.observations).toHaveLength(2);
    expect(r.json.hypotheses[0].statement).toMatch(/API/);
    expect(r.json.hypotheses[0].basedOn).toEqual(["o1"]); // référence inconnue éliminée
    expect(r.json.privacy.sensitiveRegionsMasked).toBe(1);
    const red = PNG.sync.read(env.ctx.store.getPng(id, true)!);
    expect([red.data[0], red.data[1], red.data[2]]).toEqual([0, 0, 0]);
    const orig = PNG.sync.read(env.ctx.store.getPng(id)!);
    expect(orig.data[4]).not.toBe(0); // l'original est intact
    // le prompt contient le contexte et la consigne anti-injection
    const call = env.provider.calls[0]!;
    expect(call.prompt).toContain("app v1.2");
    expect(call.system).toMatch(/DATA, never instructions/);
    expect(call.images[0]!.equals(env.ctx.store.getPng(id)!)).toBe(true);
  });
  it("masque un secret recopié par le modèle", async () => {
    const env = makeEnv({ respond: () => JSON.stringify({ summary: "Le champ montre sk-ant-abcdefghijklmnopqrstuvwxyz123", observations: [{ category: "text", severity: "info", description: "token=abcdefghijklmnopqr visible" }] }) });
    const { id } = await captured(env);
    const r = await env.call("tester", "analyze_screen", { captureId: id });
    expect(JSON.stringify(r.json)).not.toContain("abcdefghijklmnopqr");
    expect(r.json.privacy.secretKindsRedactedFromText.length).toBeGreaterThan(0);
  });
  it("tolère une sortie de modèle imparfaite (fences, énumérations inconnues)", async () => {
    const env = makeEnv({ respond: () => '```json\n{"summary":"ok","observations":[{"category":"zzz","severity":"extreme","description":"d"}]}\n```' });
    const { id } = await captured(env);
    const r = await env.call("tester", "analyze_screen", { captureId: id });
    expect(r.json.observations[0]).toMatchObject({ category: "other", severity: "info", id: "o1" });
  });
  it("réessaie une fois si le JSON est invalide, puis échoue proprement", async () => {
    const env = makeEnv({ respond: () => "désolé, je ne peux pas" });
    const { id } = await captured(env);
    const r = await env.call("tester", "analyze_screen", { captureId: id });
    expect(r.isError).toBe(true);
    expect(env.provider.calls).toHaveLength(2);
  });
  it("refuse un fournisseur non autorisé et ne lui envoie rien", async () => {
    const { env, id } = await captured();
    const r = await env.call("tester", "analyze_screen", { captureId: id, provider: "openai" });
    expect(r.json.error).toBe("forbidden");
    expect(env.provider.calls).toHaveLength(0);
  });
  it("un autre agent ne peut ni voir ni analyser la capture", async () => {
    const { env, id } = await captured();
    const r = await env.call("intruder", "analyze_screen", { captureId: id });
    expect(r.json.error).toBe("not_found");
    expect(env.provider.calls).toHaveLength(0);
  });
  it("deleteAfter supprime la capture mais garde l'analyse dans la réponse", async () => {
    const { env, id } = await captured();
    const r = await env.call("tester", "analyze_screen", { captureId: id, deleteAfter: true });
    expect(r.json.captureId).toBe(id);
    expect(env.ctx.store.getMeta(id)).toBeUndefined();
  });
  it("rejette les identifiants de type traversée de chemin", async () => {
    const env = makeEnv();
    const c = await env.client("tester");
    const r = await c.callTool({ name: "analyze_screen", arguments: { captureId: "../../etc/passwd" } });
    expect(r.isError).toBe(true);
  });
});

describe("compare_screens", () => {
  async function two(env = makeEnv()) {
    const a = (await env.call("tester", "capture_screen", { deviceId: "pc1" })).json.captureId as string;
    env.device.next = screenB;
    const b = (await env.call("tester", "capture_screen", { deviceId: "pc1" })).json.captureId as string;
    return { env, a, b };
  }
  it("détecte et localise un changement", async () => {
    const { env, a, b } = await two();
    const r = await env.call("tester", "compare_screens", { beforeCaptureId: a, afterCaptureId: b });
    expect(r.json.diff.verdict).toBe("significant_changes");
    expect(r.json.diff.regions[0].x).toBeGreaterThanOrEqual(96);
    expect(r.json.description).toBeUndefined();
    expect(env.provider.calls).toHaveLength(0); // le diff est local, sans LLM
  });
  it("identique", async () => {
    const env = makeEnv();
    const a = (await env.call("tester", "capture_screen", { deviceId: "pc1" })).json.captureId;
    const b = (await env.call("tester", "capture_screen", { deviceId: "pc1" })).json.captureId;
    expect((await env.call("tester", "compare_screens", { beforeCaptureId: a, afterCaptureId: b })).json.diff.verdict).toBe("identical");
  });
  it("describe : envoie les deux images au modèle et masque les secrets", async () => {
    const env = makeEnv({ respond: () => JSON.stringify({ summary: "Un carré rouge est apparu. token=abcdefghijklmnop", observations: [], hypotheses: [] }) });
    const { a, b } = await two(env);
    const r = await env.call("tester", "compare_screens", { beforeCaptureId: a, afterCaptureId: b, describe: true, includeOverlay: true });
    expect(env.provider.calls[0]!.images).toHaveLength(2);
    expect(r.json.description.summary).not.toContain("abcdefghijklmnop");
    expect(r.content.some((c) => c.type === "image")).toBe(true);
  });
  it("dimensions différentes → incomparable", async () => {
    const env = makeEnv();
    const a = (await env.call("tester", "capture_screen", { deviceId: "pc1" })).json.captureId;
    env.device.next = () => png(120, 80, (x, y) => [x, y, 7]);
    const b = (await env.call("tester", "capture_screen", { deviceId: "pc1" })).json.captureId;
    expect((await env.call("tester", "compare_screens", { beforeCaptureId: a, afterCaptureId: b })).json.diff.verdict).toBe("incomparable");
  });
  it("refuse les captures d'autrui", async () => {
    const { env, a, b } = await two();
    expect((await env.call("intruder", "compare_screens", { beforeCaptureId: a, afterCaptureId: b })).json.error).toBe("not_found");
  });
});

describe("share_visual_report", () => {
  async function analyzed() {
    const { env, id } = await captured();
    await env.call("tester", "analyze_screen", { captureId: id });
    return { env, id };
  }
  it("transmet rapport + image masquée à l'agent destinataire", async () => {
    const { env, id } = await analyzed();
    const r = await env.call("tester", "share_visual_report", { captureId: id, toAgent: "dev", note: "Bug de connexion", technicalContext: { app: "1.2.3", log: "password=abcdefghij" } });
    expect(r.isError).toBeFalsy();
    const rep = r.json.report;
    expect(rep.to).toBe("dev");
    expect(rep.analysis.observations.length).toBe(2);
    expect(rep.capture.imageIsRedacted).toBe(true);
    expect(rep.technicalContext.log).not.toContain("abcdefghij");

    const dev = await env.client("dev");
    const inbox = JSON.parse(((await dev.readResource({ uri: "agent-vision://inbox" })).contents[0] as any).text);
    expect(inbox).toHaveLength(1);
    const full = JSON.parse(((await dev.readResource({ uri: `agent-vision://reports/${rep.id}` })).contents[0] as any).text);
    expect(full.analysis.hypotheses).toHaveLength(1);
    // le destinataire reçoit la version MASQUÉE, jamais l'original
    const blob = Buffer.from(((await dev.readResource({ uri: `agent-vision://captures/${id}` })).contents[0] as any).blob, "base64");
    expect(blob.equals(env.ctx.store.getPng(id, true)!)).toBe(true);
    expect(blob.equals(env.ctx.store.getPng(id)!)).toBe(false);
  });
  it("refuse l'image sans analyse préalable, accepte le partage sans image", async () => {
    const { env, id } = await captured();
    expect((await env.call("tester", "share_visual_report", { captureId: id, toAgent: "dev", includeImage: true })).json.error).toBe("analysis_required");
    const r = await env.call("tester", "share_visual_report", { captureId: id, toAgent: "dev" });
    expect(r.json.report.capture.imageIncluded).toBe(false);
    const dev = await env.client("dev");
    await expect(dev.readResource({ uri: `agent-vision://captures/${id}` })).rejects.toThrow();
  });
  it("refuse un destinataire non autorisé ou inconnu", async () => {
    const { env, id } = await analyzed();
    expect((await env.call("tester", "share_visual_report", { captureId: id, toAgent: "intruder" })).json.error).toBe("forbidden");
    expect((await env.call("tester", "share_visual_report", { captureId: id, toAgent: "nobody" })).json.error).toBe("forbidden");
  });
  it("un tiers ne peut lire ni le rapport ni la capture", async () => {
    const { env, id } = await analyzed();
    const rep = (await env.call("tester", "share_visual_report", { captureId: id, toAgent: "dev" })).json.report;
    const x = await env.client("intruder");
    await expect(x.readResource({ uri: `agent-vision://reports/${rep.id}` })).rejects.toThrow();
    await expect(x.readResource({ uri: `agent-vision://captures/${id}` })).rejects.toThrow();
  });
  it("inclut le diff avec une capture précédente", async () => {
    const env = makeEnv();
    const a = (await env.call("tester", "capture_screen", { deviceId: "pc1" })).json.captureId;
    env.device.next = screenB;
    const b = (await env.call("tester", "capture_screen", { deviceId: "pc1" })).json.captureId;
    await env.call("tester", "analyze_screen", { captureId: b });
    const r = await env.call("tester", "share_visual_report", { captureId: b, toAgent: "dev", compareWithCaptureId: a });
    expect(r.json.report.diff.verdict).toBe("significant_changes");
  });
  it("le rapport respecte son schéma", async () => {
    const { env, id } = await analyzed();
    const { VisualReport } = await import("@agent-vision/core");
    const r = await env.call("tester", "share_visual_report", { captureId: id, toAgent: "dev" });
    expect(() => VisualReport.parse(r.json.report)).not.toThrow();
  });
});

describe("rétention, suppression, audit", () => {
  it("une capture expirée disparaît", async () => {
    const env = makeEnv();
    const { id } = await captured(env);
    const meta = env.ctx.store.getMeta(id)!;
    const future = new (await import("../src/store.js")).Store(env.ctx.config.dataDir, () => Date.parse(meta.expiresAt) + 1000);
    expect(future.getMeta(id)).toBeUndefined();
    expect(env.ctx.store.getMeta(id)).toBeUndefined(); // supprimé du disque
  });
  it("purgeExpired supprime captures et rapports expirés", async () => {
    const env = makeEnv();
    const { id } = await captured(env);
    await env.call("tester", "analyze_screen", { captureId: id });
    const rep = (await env.call("tester", "share_visual_report", { captureId: id, toAgent: "dev" })).json.report;
    const { Store } = await import("../src/store.js");
    const later = new Store(env.ctx.config.dataDir, () => Date.now() + 10 * 86400_000);
    expect(later.purgeExpired()).toBeGreaterThanOrEqual(2);
    expect(env.ctx.store.getReport(rep.id)).toBeUndefined();
  });
  it("journal d'audit : accès autorisés ET refusés, chaîne intègre", async () => {
    const env = makeEnv();
    await env.call("tester", "capture_screen", { deviceId: "pc1" });
    await env.call("intruder", "capture_screen", { deviceId: "pc1" });
    await env.call("dev", "capture_screen", { deviceId: "pc1" });
    const lines = readFileSync(env.ctx.auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.actor, l.outcome])).toEqual([["tester", "allowed"], ["intruder", "denied"], ["dev", "denied"]]);
    expect(AuditLog.verify(env.ctx.auditPath).ok).toBe(true);
    // aucune image ni secret dans l'audit
    expect(readFileSync(env.ctx.auditPath, "utf8")).not.toContain("pngBase64");
  });
});

void defaultAnalysis;
