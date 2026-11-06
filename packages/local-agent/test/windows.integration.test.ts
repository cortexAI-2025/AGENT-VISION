// Test d'intégration Windows RÉEL — exécuté uniquement sur Windows avec AGENT_VISION_WIN_TEST=1 (voir .github/workflows/windows.yml).
// Il valide la capture sur le runner CI (bureau virtuel), PAS sur un ordinateur physique.
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { WindowsCapturer } from "../src/backends/windows.js";
import { CaptureService } from "../src/service.js";
import { setup } from "./helpers.js";

const enabled = process.platform === "win32" && process.env.AGENT_VISION_WIN_TEST === "1";

describe.skipIf(!enabled)("Windows réel (runner CI)", () => {
  const cap = new WindowsCapturer();

  it("backend disponible, session non verrouillée", async () => {
    expect(await cap.isAvailable()).toBe(true);
    expect(await cap.isLocked()).toBe(false);
  });

  it("capture de l'écran virtuel : PNG valide de taille cohérente", async () => {
    const r = await cap.capture("screen");
    const p = PNG.sync.read(r.png);
    expect(p.width).toBeGreaterThanOrEqual(640);
    expect(p.height).toBeGreaterThanOrEqual(480);
  });

  it("capture de la fenêtre au premier plan", async () => {
    const r = await cap.capture("window");
    const p = PNG.sync.read(r.png);
    expect(p.width).toBeGreaterThan(0);
    expect(p.height).toBeGreaterThan(0);
  });

  it("aucun fichier temporaire de capture n'est laissé", async () => {
    const before = readdirSync(tmpdir()).filter((f) => /av-|agent-vision/i.test(f)).length;
    await cap.capture("screen");
    expect(readdirSync(tmpdir()).filter((f) => /av-|agent-vision/i.test(f)).length).toBe(before);
  });

  it("service complet : refus sans consentement, capture avec, refus après stop", async () => {
    const s = setup();
    const service = new CaptureService({ config: s.config, consent: s.consent, prompter: s.prompter, indicator: s.indicator, stateDir: s.stateDir, capturer: cap });
    await expect(service.capture({ agentId: "t", target: "screen" })).rejects.toMatchObject({ code: "consent_required" });
    s.consent.grant("t", 5);
    // le bureau du runner peut être uniforme : on accepte "ok" ou "blank_or_protected" mais jamais une autre erreur
    const out = await service.capture({ agentId: "t", target: "screen" }).then(() => "ok", (e) => e.code);
    expect(["ok", "blank_or_protected"]).toContain(out);
    s.consent.stop();
    await expect(service.capture({ agentId: "t", target: "screen" })).rejects.toMatchObject({ code: "capture_stopped" });
  });

  it("erreur PowerShell : message concis, sans la commande encodée", async () => {
    const { defaultExec } = await import("../src/exec.js");
    const err = await defaultExec("powershell.exe", ["-NoProfile", "-Command", "throw 'boom'"]).catch((e) => e as Error);
    expect(String(err.message)).toContain("boom");
    expect(String(err.message).length).toBeLessThan(500);
  });
});
