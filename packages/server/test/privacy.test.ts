import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TesseractEngine, type OcrEngine } from "@agent-vision/privacy";
import { makeEnv, screenA } from "./env.js";

const failing: OcrEngine = { name: "broken", recognize: async () => { throw new Error("ocr down"); } };
const fixture = readFileSync(join(__dirname, "../../privacy/test/fixtures/email-phone.png"));
const engine = new TesseractEngine();
afterAll(() => engine.close());

async function capture(env: ReturnType<typeof makeEnv>, png = screenA()) {
  env.device.next = () => png;
  return (await env.call("tester", "capture_screen", { deviceId: "pc1" })).json.captureId as string;
}

describe("pipeline OCR intégré aux outils", () => {
  it("fournisseur DISTANT + OCR en échec ⇒ rien n'est transmis (fail-closed)", async () => {
    const env = makeEnv({ ocr: failing, remote: true });
    const id = await capture(env);
    const r = await env.call("tester", "analyze_screen", { captureId: id });
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("sanitization_failed");
    expect(env.provider.calls).toHaveLength(0);
    expect(env.ctx.store.getPng(id, true)).toBeUndefined();
  });

  it("compare_screens(describe) avec fournisseur distant + OCR en échec ⇒ rien transmis", async () => {
    const env = makeEnv({ ocr: failing, remote: true });
    const a = await capture(env);
    const b = await capture(env);
    const r = await env.call("tester", "compare_screens", { beforeCaptureId: a, afterCaptureId: b, describe: true });
    expect(r.json.error).toBe("sanitization_failed");
    expect(env.provider.calls).toHaveLength(0);
    // le diff purement local reste disponible
    expect((await env.call("tester", "compare_screens", { beforeCaptureId: a, afterCaptureId: b })).json.diff.verdict).toBe("identical");
  });

  it("fournisseur LOCAL + OCR en échec ⇒ analyse possible mais aucune image partageable", async () => {
    const env = makeEnv({ ocr: failing });
    const id = await capture(env);
    const r = await env.call("tester", "analyze_screen", { captureId: id });
    expect(r.isError).toBeFalsy();
    expect(r.json.privacy.ocr.status).toBe("skipped_local_provider");
    expect((await env.call("tester", "share_visual_report", { captureId: id, toAgent: "dev", includeImage: true })).json.error).toBe("analysis_required");
  });

  it("OCR réel : l'image reçue par le fournisseur distant ne contient plus l'e-mail", async () => {
    const env = makeEnv({ ocr: engine, remote: true });
    const id = await capture(env, fixture);
    const r = await env.call("tester", "analyze_screen", { captureId: id });
    expect(r.isError).toBeFalsy();
    expect(r.json.privacy.ocr).toMatchObject({ status: "verified" });
    expect(r.json.privacy.ocr.kinds).toEqual(expect.arrayContaining(["email"]));
    const sent = env.provider.calls[0]!.images[0]!;
    expect(sent.equals(fixture)).toBe(false);
    const words = (await engine.recognize(sent)).map((w) => w.text).join(" ");
    expect(words).not.toMatch(/dupont|example\.com/i);
    // l'original reste intact pour son propriétaire, mais le destinataire ne reçoit que la version assainie
    expect(env.ctx.store.getPng(id)!.equals(fixture)).toBe(true);
    const shared = (await env.call("tester", "share_visual_report", { captureId: id, toAgent: "dev" })).json.report;
    expect(shared.capture.imageIsRedacted).toBe(true);
    const dev = await env.client("dev");
    const blob = Buffer.from(((await dev.readResource({ uri: `agent-vision://captures/${id}` })).contents[0] as any).blob, "base64");
    expect((await engine.recognize(blob)).map((w) => w.text).join(" ")).not.toMatch(/dupont/i);
  }, 120_000);

  it("ocr: off (désactivation explicite) laisse passer l'image telle quelle et le consigne dans le rapport", async () => {
    const env = makeEnv({ ocr: failing, remote: true, config: { privacy: { ocr: "off" } } });
    const id = await capture(env);
    const r = await env.call("tester", "analyze_screen", { captureId: id });
    expect(r.json.privacy.ocr.status).toBe("off");
  });
});
