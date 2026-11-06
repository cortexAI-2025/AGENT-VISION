import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { CaptureError } from "../src/service.js";
import { testPng, setup } from "./helpers.js";

const req = { agentId: "tester", target: "screen" as const };

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return "ok"; } catch (e) { return e instanceof CaptureError ? e.code : "other"; }
}

describe("CaptureService — consentement", () => {
  it("refuse sans consentement et ne touche pas l'écran", async () => {
    const s = setup();
    expect(await code(s.service.capture(req))).toBe("consent_required");
    expect(s.capturer.calls).toBe(0);
  });

  it("capture après un grant local, avec indicateur", async () => {
    const s = setup();
    s.consent.grant("tester", 5);
    const r = await s.service.capture(req);
    expect(r.width).toBe(200);
    expect(r.deviceId).toBe("dev1");
    expect(s.events).toEqual(["begin", "end"]);
  });

  it("le consentement expire", async () => {
    let t = 1_000_000;
    const s = setup();
    const { ConsentStore } = await import("../src/consent.js");
    const c = new ConsentStore(s.stateDir, () => t);
    c.grant("tester", 1);
    expect(c.isAllowed("tester", "screen")).toBe(true);
    t += 61_000;
    expect(c.isAllowed("tester", "screen")).toBe(false);
  });

  it("le consentement est par agent", async () => {
    const s = setup();
    s.consent.grant("autre", 5);
    expect(await code(s.service.capture(req))).toBe("consent_required");
  });

  it("le consentement est par cible", async () => {
    const s = setup();
    s.consent.grant("tester", 5, ["window"]);
    expect(await code(s.service.capture(req))).toBe("consent_required");
  });

  it("allowedAgents restreint les agents", async () => {
    const s = setup({ allowedAgents: ["seul"] });
    s.consent.grant("tester", 5);
    expect(await code(s.service.capture(req))).toBe("consent_denied");
  });

  it("mode prompt : refus utilisateur", async () => {
    const s = setup({ consentMode: "prompt" });
    s.prompter.answer = false;
    expect(await code(s.service.capture(req))).toBe("consent_denied");
    expect(s.capturer.calls).toBe(0);
  });

  it("mode prompt : acceptation", async () => {
    const s = setup({ consentMode: "prompt" });
    expect(await code(s.service.capture(req))).toBe("ok");
  });

  it("révocation", async () => {
    const s = setup();
    s.consent.grant("tester", 5);
    s.consent.revoke("tester");
    expect(await code(s.service.capture(req))).toBe("consent_required");
  });
});

describe("CaptureService — arrêt, verrouillage, protections", () => {
  it("arrêt immédiat prioritaire sur tout consentement", async () => {
    const s = setup();
    s.consent.grant("tester", 5);
    s.consent.stop();
    expect(await code(s.service.capture(req))).toBe("capture_stopped");
    expect(s.capturer.calls).toBe(0);
    s.consent.resume();
    expect(await code(s.service.capture(req))).toBe("ok");
  });

  it("refuse un écran verrouillé", async () => {
    const s = setup();
    s.consent.grant("tester", 5);
    s.capturer.locked = true;
    expect(await code(s.service.capture(req))).toBe("screen_locked");
    expect(s.capturer.calls).toBe(0);
  });

  it("rejette une image uniformément noire (contenu protégé)", async () => {
    const s = setup();
    s.consent.grant("tester", 5);
    s.capturer.png = testPng(50, 50, () => [0, 0, 0]);
    expect(await code(s.service.capture(req))).toBe("blank_or_protected");
  });

  it("limite la fréquence par agent", async () => {
    const s = setup({ minIntervalMs: 60_000 });
    s.consent.grant("tester", 5);
    expect(await code(s.service.capture(req))).toBe("ok");
    expect(await code(s.service.capture(req))).toBe("rate_limited");
  });
});

describe("CaptureService — confidentialité", () => {
  it("applique les masques configurés avant l'envoi", async () => {
    const s = setup({ maskRegions: [{ x: 0, y: 0, width: 0.5, height: 0.5 }] });
    s.consent.grant("tester", 5);
    const r = await s.service.capture(req);
    const png = PNG.sync.read(Buffer.from(r.pngBase64, "base64"));
    expect(r.masksApplied).toBe(1);
    expect([png.data[0], png.data[1], png.data[2]]).toEqual([0, 0, 0]);
    const i = ((png.height - 1) * png.width + (png.width - 1)) * 4;
    expect(png.data[i]).toBeGreaterThan(100); // coin non masqué intact
  });

  it("masque les secrets dans le titre de fenêtre", async () => {
    const s = setup();
    s.consent.grant("tester", 5);
    s.capturer.title = "login token=abcdefghijklmnop1234";
    const r = await s.service.capture({ ...req, target: "window" });
    expect(r.windowTitle).not.toContain("abcdefghijklmnop1234");
    expect(r.windowTitle).toContain("REDACTED");
  });
});
