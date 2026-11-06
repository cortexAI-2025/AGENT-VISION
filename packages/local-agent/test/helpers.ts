import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { Capturer } from "../src/backends/types.js";
import { LocalConfig } from "../src/config.js";
import { ConsentStore } from "../src/consent.js";
import { CaptureService } from "../src/service.js";
import { sha256Hex } from "@agent-vision/core";

export function testPng(w = 200, h = 100, fn?: (x: number, y: number) => [number, number, number]): Buffer {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn ? fn(x, y) : [(x * 255) / w, (y * 255) / h, 128];
      const i = (y * w + x) * 4;
      p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = 255;
    }
  return PNG.sync.write(p);
}

export class FakeCapturer implements Capturer {
  name = "fake";
  locked = false;
  calls = 0;
  png = testPng();
  title: string | undefined = "Mon app";
  async isAvailable() { return true; }
  async isLocked() { return this.locked; }
  async capture() { this.calls++; return { png: this.png, windowTitle: this.title }; }
}

export const TOKEN = "device-token-for-tests";

export function setup(over: Partial<LocalConfig> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "av-local-"));
  const config = LocalConfig.parse({ deviceId: "dev1", tokenSha256: sha256Hex(TOKEN), minIntervalMs: 0, notify: false, ...over });
  const consent = new ConsentStore(stateDir);
  const capturer = new FakeCapturer();
  const events: string[] = [];
  const prompter = { answer: true, async confirmCapture() { events.push("prompt"); return this.answer; } };
  const indicator = { async begin() { events.push("begin"); }, async end() { events.push("end"); } };
  const service = new CaptureService({ config, consent, capturer, prompter, indicator, stateDir });
  return { stateDir, config, consent, capturer, prompter, indicator, service, events };
}
