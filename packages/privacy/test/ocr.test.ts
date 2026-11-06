import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { TesseractEngine } from "../src/ocr.js";
import { OcrSanitizer, SanitizeError, findSensitiveWords, looksLikeToken } from "../src/sanitizer.js";
import type { OcrEngine, OcrWord } from "../src/ocr.js";

const fx = (n: string) => readFileSync(join(__dirname, "fixtures", n));
const engine = new TesseractEngine();
afterAll(() => engine.close());

const texts = async (png: Buffer) => (await engine.recognize(png)).map((w) => w.text).join(" ");

describe("OCR local réel (Tesseract, modèle embarqué) sur images synthétiques", () => {
  it("e-mail et téléphone sont masqués, le reste de l'écran reste lisible", async () => {
    const s = new OcrSanitizer(engine);
    const r = await s.sanitize(fx("email-phone.png"));
    expect(r.kinds).toEqual(expect.arrayContaining(["email", "phone"]));
    expect(r.verified).toBe(true);
    const after = await texts(r.png);
    expect(after).not.toMatch(/example\.com|dupont/i);
    expect(after).not.toMatch(/12 34 56/);
    expect(after).toMatch(/Welcome/); // le texte non sensible est conservé
  }, 120_000);

  it("clé d'API, jeton Bearer et mot de passe sont masqués", async () => {
    const r = await new OcrSanitizer(engine).sanitize(fx("api-token.png"));
    expect(r.kinds.length).toBeGreaterThanOrEqual(2);
    const after = await texts(r.png);
    expect(after).not.toMatch(/ABCDEFGH|abcdef1234|hunter2/i);
  }, 120_000);

  it("IBAN, carte bancaire et identifiant de session sont masqués", async () => {
    const r = await new OcrSanitizer(engine).sanitize(fx("bank-session.png"));
    expect(r.kinds).toEqual(expect.arrayContaining(["credit_card"]));
    const after = await texts(r.png);
    expect(after).not.toMatch(/4111|3456|A1B2C3/);
  }, 120_000);

  it("un écran sans secret n'est pas modifié", async () => {
    const input = fx("clean.png");
    const r = await new OcrSanitizer(engine).sanitize(input);
    expect(r.regions).toHaveLength(0);
    expect(r.png.equals(input)).toBe(true);
  }, 120_000);

  it("motif personnalisé (littéral utilisateur)", async () => {
    const { buildCustomPatterns } = await import("@agent-vision/core");
    const r = await new OcrSanitizer(engine).sanitize(fx("clean.png"), { custom: buildCustomPatterns({ literals: ["Welcome back"] }) });
    expect(r.kinds).toContain("custom");
    expect(await texts(r.png)).not.toMatch(/Welcome/);
  }, 120_000);
});

describe("politique fail-closed (moteur simulé)", () => {
  const png = (() => { const p = new PNG({ width: 300, height: 100 }); p.data.fill(255); return PNG.sync.write(p); })();
  const word = (text: string, x: number, line = 0): OcrWord => ({ text, confidence: 90, box: { x, y: 10, width: 80, height: 20 }, line });

  it("erreur OCR ⇒ SanitizeError(ocr_failed), aucune image renvoyée", async () => {
    const bad: OcrEngine = { name: "x", recognize: async () => { throw new Error("boom"); } };
    await expect(new OcrSanitizer(bad).sanitize(png)).rejects.toMatchObject({ reason: "ocr_failed" });
  });
  it("timeout OCR ⇒ SanitizeError(timeout)", async () => {
    const slow: OcrEngine = { name: "x", recognize: () => new Promise(() => {}) };
    await expect(new OcrSanitizer(slow).sanitize(png, { timeoutMs: 50 })).rejects.toMatchObject({ reason: "timeout" });
  });
  it("secret toujours lisible après masquage ⇒ verification_failed", async () => {
    // moteur qui « voit » toujours le secret au même endroit, même sur l'image masquée
    const stubborn: OcrEngine = { name: "x", recognize: async () => [word("a@b.com", 10)] };
    await expect(new OcrSanitizer(stubborn).sanitize(png)).rejects.toBeInstanceOf(SanitizeError);
    await expect(new OcrSanitizer(stubborn).sanitize(png)).rejects.toMatchObject({ reason: "verification_failed" });
  });
  it("secret masqué ⇒ succès et pixels noirs", async () => {
    let calls = 0;
    const eng: OcrEngine = { name: "x", recognize: async () => (calls++ === 0 ? [word("a@b.com", 10)] : []) };
    const r = await new OcrSanitizer(eng).sanitize(png);
    const dec = PNG.sync.read(r.png);
    expect(dec.data[((20) * 300 + 50) * 4]).toBe(0);
    expect(r.regions).toHaveLength(1);
  });
  it("mots d'un secret éclatés sur plusieurs mots (IBAN) tous masqués", () => {
    const hits = findSensitiveWords([word("IBAN", 0), word("FR76", 90), word("3000", 180), word("6000", 270), word("0112", 360), word("3456", 450), word("7890", 540), word("189", 630)]);
    const iban = hits.find((h) => h.kind === "iban");
    expect(iban?.words.length).toBeGreaterThanOrEqual(6);
  });
  it("heuristique de jeton à forte entropie", () => {
    expect(looksLikeToken("x9Kd82JfLq0PzmW3vTb7RyNc41")).toBe(true);
    expect(looksLikeToken("internationalization")).toBe(false);
    expect(looksLikeToken("https://example.com/aaaaaaaa11111111bbbbbbbb2222")).toBe(false);
  });
  it("le texte du secret n'apparaît ni dans l'erreur ni dans le résultat", async () => {
    const stubborn: OcrEngine = { name: "x", recognize: async () => [word("topsecret@corp.io", 10)] };
    try { await new OcrSanitizer(stubborn).sanitize(png); } catch (e) { expect(String(e)).not.toContain("topsecret"); }
  });
});
