import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { makeEnv, png, screenA } from "./env.js";

async function cap(env: ReturnType<typeof makeEnv>, agent = "tester") {
  return (await env.call(agent, "capture_screen", { deviceId: "pc1" })).json.captureId as string;
}

describe("list_available_devices / get_device_capabilities", () => {
  it("ne liste que les appareils autorisés pour l'agent", async () => {
    const env = makeEnv();
    expect((await env.call("tester", "list_available_devices", {})).json.devices).toEqual([{ deviceId: "pc1", platform: "test-os" }]);
    expect((await env.call("intruder", "list_available_devices", {})).json.devices).toEqual([]);
  });
  it("capacités réelles pour un appareil autorisé ; not_found indistinct sinon", async () => {
    const env = makeEnv();
    const ok = await env.call("tester", "get_device_capabilities", { deviceId: "pc1" });
    expect(ok.json).toMatchObject({ deviceId: "pc1", observation: true, targets: ["screen", "window"], online: true });
    const denied = await env.call("intruder", "get_device_capabilities", { deviceId: "pc1" });
    const unknown = await env.call("tester", "get_device_capabilities", { deviceId: "nope" });
    expect(denied.json).toEqual(unknown.json); // pas d'oracle d'existence
    expect(denied.json.error).toBe("not_found");
  });
  it("appareil push : observation non prise en charge, consentement par capture", async () => {
    const { PushDevice } = await import("../src/devices.js");
    const d = new PushDevice({ kind: "push", id: "phone", platform: "android", tokenSha256: "0".repeat(64) }, 1000);
    expect(await d.capabilities()).toMatchObject({ observation: false, perCaptureUserConsent: true, targets: ["screen"] });
    await expect(d.observeStart()).rejects.toMatchObject({ code: "backend_unavailable" });
  });
});

describe("images brutes inaccessibles par défaut", () => {
  it("la ressource et includeImage renvoient la version assainie, pas l'original", async () => {
    const env = makeEnv();
    // image avec un marqueur : le faux OCR ne masque rien ⇒ identique, donc on vérifie via le moteur : OCR qui « voit » un e-mail
    let n = 0;
    const eng = { name: "x", recognize: async () => (n++ % 2 === 0 ? [{ text: "a@b.com", confidence: 90, box: { x: 0, y: 0, width: 60, height: 20 }, line: 0 }] : []) };
    const env2 = makeEnv({ ocr: eng });
    const id = await cap(env2);
    const t = await env2.client("tester");
    const blob = Buffer.from(((await t.readResource({ uri: `agent-vision://captures/${id}` })).contents[0] as any).blob, "base64");
    expect(blob.equals(env2.ctx.store.getPng(id)!)).toBe(false);
    const dec = PNG.sync.read(blob);
    expect(dec.data[(10 * 200 + 30) * 4]).toBe(0); // zone masquée
    void env;
  });
  it("includeImage sans allowRawImages ⇒ image assainie + note ; avec allowRawImages ⇒ brute", async () => {
    let n = 0;
    const eng = { name: "x", recognize: async () => (n++ % 2 === 0 ? [{ text: "a@b.com", confidence: 90, box: { x: 0, y: 0, width: 60, height: 20 }, line: 0 }] : []) };
    const env = makeEnv({ ocr: eng });
    const safe = await env.call("tester", "capture_screen", { deviceId: "pc1", includeImage: true });
    const img = Buffer.from(safe.content.find((c) => c.type === "image").data, "base64");
    expect(PNG.sync.read(img).data[(10 * 200 + 30) * 4]).toBe(0);
    expect(safe.content.some((c) => c.type === "text" && /sanitized/.test(c.text))).toBe(true);
    const raw = await env.call("raw", "capture_screen", { deviceId: "pc1", includeImage: true });
    const rawImg = Buffer.from(raw.content.find((c) => c.type === "image").data, "base64");
    expect(rawImg.equals(screenA())).toBe(true);
  });
  it("sanitisation en échec ⇒ aucune image renvoyée", async () => {
    const env = makeEnv({ ocr: { name: "x", recognize: async () => { throw new Error("down"); } } });
    const r = await env.call("tester", "capture_screen", { deviceId: "pc1", includeImage: true });
    expect(r.content.some((c) => c.type === "image")).toBe(false);
    expect(JSON.stringify(r.content)).toMatch(/Image not returned/);
  });
  it("le diff n'expose pas les pixels de l'image brute (superposition sans fond)", async () => {
    const env = makeEnv();
    const a = await cap(env);
    env.device.next = () => png(200, 100, (x, y) => (x > 100 ? [255, 0, 0] : [x, y * 2, 120]));
    const b = await cap(env);
    const r = await env.call("tester", "compare_screens", { beforeCaptureId: a, afterCaptureId: b, includeOverlay: true });
    const ov = PNG.sync.read(Buffer.from(r.content.find((c) => c.type === "image").data, "base64"));
    expect([ov.data[0], ov.data[1], ov.data[2]]).toEqual([0, 0, 0]); // pixel inchangé ⇒ noir, pas l'image
  });
});

describe("analyze_screen_region", () => {
  it("n'envoie au fournisseur que la région, découpée dans l'image assainie", async () => {
    const env = makeEnv();
    const id = await cap(env);
    const r = await env.call("tester", "analyze_screen_region", { captureId: id, region: { x: 0.5, y: 0, width: 0.5, height: 0.5 } });
    expect(r.isError).toBeFalsy();
    const sent = PNG.sync.read(env.provider.calls[0]!.images[0]!);
    expect(sent.width).toBe(100);
    expect(sent.height).toBe(50);
    expect(r.json.region.pixels).toEqual({ x: 100, y: 0, width: 100, height: 50 });
  });
  it("fail-closed avec fournisseur distant", async () => {
    const env = makeEnv({ ocr: { name: "x", recognize: async () => { throw new Error("down"); } }, remote: true });
    const id = await cap(env);
    const r = await env.call("tester", "analyze_screen_region", { captureId: id, region: { x: 0, y: 0, width: 1, height: 1 } });
    expect(r.json.error).toBe("sanitization_failed");
    expect(env.provider.calls).toHaveLength(0);
  });
  it("capture d'autrui inaccessible ; région invalide rejetée", async () => {
    const env = makeEnv();
    const id = await cap(env);
    expect((await env.call("intruder", "analyze_screen_region", { captureId: id, region: { x: 0, y: 0, width: 1, height: 1 } })).json.error).toBe("not_found");
    const c = await env.client("tester");
    const bad: any = await c.callTool({ name: "analyze_screen_region", arguments: { captureId: id, region: { x: 0, y: 0, width: 0, height: 1 } } });
    expect(bad.isError).toBe(true);
  });
});

describe("révocation et isolation", () => {
  it("après révocation de l'autorisation d'appareil, l'agent ne peut plus rien capturer", async () => {
    const env = makeEnv();
    expect((await env.call("tester", "capture_screen", { deviceId: "pc1" })).isError).toBeFalsy();
    env.ctx.config.agents.find((a) => a.id === "tester")!.devices = []; // changement de politique à chaud
    const r = await env.call("tester", "capture_screen", { deviceId: "pc1" });
    expect(r.json.error).toBe("forbidden");
  });
  it("captures concurrentes de plusieurs agents : chacun ne voit que les siennes", async () => {
    const env = makeEnv();
    const [a, b] = await Promise.all([cap(env, "tester"), cap(env, "raw")]);
    expect(a).not.toBe(b);
    expect((await env.call("raw", "analyze_screen", { captureId: a })).json.error).toBe("not_found");
    expect((await env.call("tester", "analyze_screen", { captureId: b })).json.error).toBe("not_found");
  });
  it("une capture expirée ne peut plus être analysée", async () => {
    const env = makeEnv();
    const id = await cap(env);
    const { Store } = await import("../src/store.js");
    const later = new Store(env.ctx.config.dataDir, () => Date.now() + 7200_000);
    expect(later.getMeta(id)).toBeUndefined();
    expect((await env.call("tester", "analyze_screen", { captureId: id })).json.error).toBe("not_found");
  });
  it("identifiants malformés ou hostiles", async () => {
    const env = makeEnv();
    const c = await env.client("tester");
    for (const captureId of ["../x", "a b", "", "x".repeat(200), "cap_\u0000"]) {
      const r: any = await c.callTool({ name: "analyze_screen", arguments: { captureId } });
      expect(r.isError).toBe(true);
    }
  });
});
