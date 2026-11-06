import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { AuditLog, detectSecrets, diffPng, isUniformFrame, maskRegions, redactDeep, redactText, toPixelRegion } from "../src/index.js";

function png(w: number, h: number, fn: (x: number, y: number) => [number, number, number]): Buffer {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y); const i = (y * w + x) * 4;
    p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = 255;
  }
  return PNG.sync.write(p);
}

describe("secrets", () => {
  const samples: Record<string, string> = {
    aws_access_key: "key AKIAIOSFODNN7EXAMPLE end",
    github_token: "ghp_" + "a".repeat(36),
    api_key: "sk-ant-" + "x".repeat(30),
    jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
    bearer_token: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
    password_assignment: 'password = "hunter2hunter2"',
    private_key: "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
    credit_card: "carte 4111 1111 1111 1111 ok",
    email: "contact: jean.dupont@example.com",
  };
  for (const [kind, text] of Object.entries(samples)) {
    it(`détecte ${kind}`, () => {
      expect(detectSecrets(text).map((m) => m.kind)).toContain(kind);
      expect(redactText(text).text).toContain("[REDACTED:");
    });
  }
  it("ne signale pas un nombre quelconque ni du texte banal", () => {
    expect(detectSecrets("Total: 1234567890123 articles (non Luhn)").filter((m) => m.kind === "credit_card")).toHaveLength(0);
    expect(redactText("Le bouton Valider est décalé de 4px").kinds).toEqual([]);
  });
  it("redactDeep traverse les structures", () => {
    const r = redactDeep({ a: ["token=abcdefghijkl"], b: { c: 1 } });
    expect(JSON.stringify(r.value)).not.toContain("abcdefghijkl");
    expect(r.kinds).toContain("password_assignment");
  });
});

describe("image", () => {
  it("diff identique", () => {
    const a = png(64, 64, () => [10, 20, 30]);
    const { result, overlay } = diffPng(a, a);
    expect(result.verdict).toBe("identical");
    expect(result.regions).toEqual([]);
    expect(overlay).toBeUndefined();
  });
  it("diff localise le changement", () => {
    const a = png(128, 128, () => [10, 20, 30]);
    const b = png(128, 128, (x, y) => (x >= 64 && x < 96 && y >= 32 && y < 64 ? [250, 0, 0] : [10, 20, 30]));
    const { result, overlay } = diffPng(a, b, { cell: 16 });
    expect(result.changedPixels).toBe(32 * 32);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]).toEqual({ x: 64, y: 32, width: 32, height: 32 });
    expect(result.verdict).toBe("significant_changes");
    expect(overlay).toBeDefined();
  });
  it("sépare deux zones distinctes", () => {
    const a = png(200, 100, () => [0, 0, 0]);
    const b = png(200, 100, (x, y) => ((x < 10 && y < 10) || (x > 180 && y > 80) ? [255, 255, 255] : [0, 0, 0]));
    expect(diffPng(a, b, { cell: 16 }).result.regions).toHaveLength(2);
  });
  it("tolère un bruit sous le seuil", () => {
    const a = png(32, 32, () => [100, 100, 100]);
    const b = png(32, 32, () => [105, 100, 100]);
    expect(diffPng(a, b, { pixelThreshold: 16 }).result.verdict).toBe("identical");
    expect(diffPng(a, b, { pixelThreshold: 2 }).result.verdict).toBe("significant_changes");
  });
  it("dimensions différentes → incomparable", () => {
    expect(diffPng(png(10, 10, () => [0, 0, 0]), png(11, 10, () => [0, 0, 0])).result.verdict).toBe("incomparable");
  });
  it("masque irréversiblement une région", () => {
    const a = png(20, 20, () => [200, 100, 50]);
    const out = PNG.sync.read(maskRegions(a, [{ x: 5, y: 5, width: 5, height: 5 }]));
    expect(out.data[(5 * 20 + 5) * 4]).toBe(0);
    expect(out.data[0]).toBe(200);
  });
  it("toPixelRegion borne dans l'image", () => {
    expect(toPixelRegion({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, 100, 100)).toEqual({ x: 90, y: 90, width: 10, height: 10 });
  });
  it("détecte une trame uniforme", () => {
    expect(isUniformFrame(png(50, 50, () => [0, 0, 0]))).toBe(true);
    expect(isUniformFrame(png(50, 50, (x) => [x * 5, 0, 0]))).toBe(false);
  });
});

describe("audit", () => {
  it("chaîne valide puis falsification détectée", () => {
    const f = join(mkdtempSync(join(tmpdir(), "av-audit-")), "a.jsonl");
    const log = new AuditLog(f);
    log.write({ actor: "a", action: "capture_screen", outcome: "allowed" });
    log.write({ actor: "b", action: "analyze_screen", outcome: "denied" });
    log.write({ actor: "a", action: "share_visual_report", outcome: "allowed" });
    expect(AuditLog.verify(f)).toEqual({ ok: true, entries: 3 });
    // reprise sur un fichier existant
    new AuditLog(f).write({ actor: "a", action: "x", outcome: "allowed" });
    expect(AuditLog.verify(f).ok).toBe(true);
    const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
    lines[1] = lines[1]!.replace('"denied"', '"allowed"');
    writeFileSync(f, lines.join("\n") + "\n");
    expect(AuditLog.verify(f)).toMatchObject({ ok: false, brokenAt: 1 });
  });
  it("suppression d'une ligne détectée", () => {
    const f = join(mkdtempSync(join(tmpdir(), "av-audit-")), "a.jsonl");
    const log = new AuditLog(f);
    for (let i = 0; i < 4; i++) log.write({ actor: "a", action: `t${i}`, outcome: "allowed" });
    const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
    lines.splice(1, 1);
    writeFileSync(f, lines.join("\n") + "\n");
    expect(AuditLog.verify(f).ok).toBe(false);
  });
});
