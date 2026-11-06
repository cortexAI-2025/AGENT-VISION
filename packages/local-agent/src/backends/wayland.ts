import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CaptureTarget } from "@agent-vision/core";
import { commandExists, defaultExec, type Exec } from "../exec.js";
import type { Capturer, RawCapture } from "./types.js";

/** Extrait (code de réponse, uri) d'un bloc `gdbus monitor` de signal Response. */
export function parsePortalResponse(text: string): { code: number; uri?: string } | undefined {
  if (!text.includes("org.freedesktop.portal.Request.Response")) return undefined;
  const code = /Response\s*\(uint32\s+(\d+)/.exec(text)?.[1];
  if (code === undefined) return undefined;
  const uri = /'uri':\s*<'([^']+)'>/.exec(text)?.[1];
  return { code: Number(code), uri };
}

/**
 * Linux / Wayland : portail xdg-desktop-portal `org.freedesktop.portal.Screenshot`.
 * C'est le mécanisme officiel : le compositeur/portail gère lui-même le consentement.
 * Pour la cible "window" on active le mode interactif (l'utilisateur choisit lui-même).
 */
export class WaylandPortalCapturer implements Capturer {
  readonly name = "wayland-portal";
  /** "window" = mode interactif du portail : l'utilisateur choisit lui-même la zone. */
  readonly targets: CaptureTarget[] = ["screen", "window"];
  constructor(private readonly exec: Exec = defaultExec, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async isAvailable(): Promise<boolean> {
    return !!this.env.WAYLAND_DISPLAY && (await commandExists(this.exec, "gdbus"));
  }

  async isLocked(): Promise<boolean> {
    const sid = this.env.XDG_SESSION_ID;
    if (!sid) return false;
    try {
      const { stdout } = await this.exec("loginctl", ["show-session", sid, "-p", "LockedHint", "--value"], { timeoutMs: 3000 });
      return stdout.toString().trim() === "yes";
    } catch {
      return false;
    }
  }

  async capture(target: CaptureTarget): Promise<RawCapture> {
    const token = `av${Date.now().toString(36)}`;
    const interactive = target === "window";
    const monitor = spawn("gdbus", ["monitor", "--session", "--dest", "org.freedesktop.portal.Desktop"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      let buf = "";
      const response = new Promise<{ code: number; uri?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("portal timeout")), interactive ? 120_000 : 30_000);
        monitor.stdout.on("data", (d: Buffer) => {
          buf += d.toString();
          const r = parsePortalResponse(buf);
          if (r) {
            clearTimeout(timer);
            resolve(r);
          }
        });
        monitor.on("error", (e) => reject(e));
      });
      await new Promise((r) => setTimeout(r, 200)); // laisse le moniteur s'abonner
      await this.exec("gdbus", [
        "call", "--session",
        "--dest", "org.freedesktop.portal.Desktop",
        "--object-path", "/org/freedesktop/portal/desktop",
        "--method", "org.freedesktop.portal.Screenshot.Screenshot",
        "", `{'handle_token': <'${token}'>, 'interactive': <${interactive}>}`,
      ]);
      const r = await response;
      if (r.code !== 0 || !r.uri) {
        throw Object.assign(new Error("screenshot refused or cancelled in the portal"), { code: "consent_denied" });
      }
      const file = fileURLToPath(r.uri);
      try {
        return { png: readFileSync(file) };
      } finally {
        rmSync(file, { force: true });
      }
    } finally {
      monitor.kill();
    }
  }
}
