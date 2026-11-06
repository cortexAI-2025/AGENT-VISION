// Test d'intégration RÉEL sur un serveur X virtuel (Xvfb). Lancer : npm run test:x11
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it, afterAll } from "vitest";
import { PNG } from "pngjs";
import { X11Capturer } from "../src/backends/x11.js";
import { detectCapturer } from "../src/backends/index.js";
import { CaptureService } from "../src/service.js";
import { setup } from "./helpers.js";

const enabled = process.env.AGENT_VISION_X11_TEST === "1" && !!process.env.DISPLAY;
let win: ChildProcess | undefined;
const procs: ChildProcess[] = [];
afterAll(() => { win?.kill(); procs.forEach((p) => p.kill()); });

describe.skipIf(!enabled)("X11 réel (Xvfb)", () => {
  it("capture l'écran virtuel et reflète son contenu", async () => {
    // fenêtre visible non uniforme : ImageMagick `display` sur le motif intégré
    win = spawn("sh", ["-c", "convert rose: png:- | display -geometry +0+0 -"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1500));
    const cap = await detectCapturer();
    expect(cap?.name).toBe("x11");
    const raw = await new X11Capturer().capture("screen");
    const png = PNG.sync.read(raw.png);
    expect(png.width).toBeGreaterThan(100);
    const colors = new Set<number>();
    for (let i = 0; i < png.data.length; i += 4 * 97) colors.add((png.data[i]! << 16) | (png.data[i + 1]! << 8) | png.data[i + 2]!);
    expect(colors.size).toBeGreaterThan(5); // l'image `rose:` a bien été capturée
  });

  it("service complet : consentement requis puis capture réelle", async () => {
    const s = setup();
    const service = new CaptureService({ ...{ config: s.config, consent: s.consent, prompter: s.prompter, indicator: s.indicator, stateDir: s.stateDir }, capturer: new X11Capturer() });
    await expect(service.capture({ agentId: "t", target: "screen" })).rejects.toMatchObject({ code: "consent_required" });
    s.consent.grant("t", 5);
    const r = await service.capture({ agentId: "t", target: "screen" });
    expect(r.backend).toBe("x11");
    expect(Buffer.from(r.pngBase64, "base64").subarray(1, 4).toString()).toBe("PNG");
  });

  it("capture de la FENÊTRE ACTIVE (openbox + xterm) : taille réduite et titre récupéré", async () => {
    procs.push(spawn("openbox", [], { stdio: "ignore" }));
    await new Promise((r) => setTimeout(r, 800));
    procs.push(spawn("xterm", ["-T", "AV-TEST-WINDOW", "-geometry", "60x15+50+50", "-e", "sh", "-c", "echo hello; sleep 30"], { stdio: "ignore" }));
    await new Promise((r) => setTimeout(r, 1500));
    const cap = new X11Capturer();
    const full = PNG.sync.read((await cap.capture("screen")).png);
    const raw = await cap.capture("window");
    const w = PNG.sync.read(raw.png);
    expect(w.width).toBeLessThan(full.width);
    expect(w.height).toBeLessThan(full.height);
    expect(raw.windowTitle).toBe("AV-TEST-WINDOW");
  });

  it("refus : après `stop`, le service X11 réel ne capture plus", async () => {
    const s = setup();
    const service = new CaptureService({ config: s.config, consent: s.consent, prompter: s.prompter, indicator: s.indicator, stateDir: s.stateDir, capturer: new X11Capturer() });
    s.consent.grant("t", 5);
    s.consent.stop();
    await expect(service.capture({ agentId: "t", target: "screen" })).rejects.toMatchObject({ code: "capture_stopped" });
  });

  it("consentement expiré : refus", async () => {
    let t = Date.now();
    const s = setup();
    const { ConsentStore } = await import("../src/consent.js");
    const consent = new ConsentStore(s.stateDir, () => t);
    consent.grant("t", 1);
    const service = new CaptureService({ config: s.config, consent, prompter: s.prompter, indicator: s.indicator, stateDir: s.stateDir, capturer: new X11Capturer(), now: () => t });
    t += 120_000;
    await expect(service.capture({ agentId: "t", target: "screen" })).rejects.toMatchObject({ code: "consent_required" });
  });
});
