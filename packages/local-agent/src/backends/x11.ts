import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureTarget } from "@agent-vision/core";
import { commandExists, defaultExec, type Exec } from "../exec.js";
import type { Capturer, RawCapture } from "./types.js";

export function parseActiveWindow(xpropOut: string): string | undefined {
  return /window id # (0x[0-9a-fA-F]+)/.exec(xpropOut)?.[1];
}

export function parseWmName(xpropOut: string): string | undefined {
  const m = /=\s*"((?:[^"\\]|\\.)*)"/.exec(xpropOut);
  return m?.[1]?.replace(/\\"/g, '"');
}

/** Linux / X11 : maim, ImageMagick `import` ou scrot (premier disponible). */
export class X11Capturer implements Capturer {
  name = "x11";
  readonly targets: CaptureTarget[] = ["screen", "window"];
  private tool?: "maim" | "import" | "scrot";
  constructor(private readonly exec: Exec = defaultExec, private readonly env: NodeJS.ProcessEnv = process.env) {}

  private async pickTool(): Promise<"maim" | "import" | "scrot" | undefined> {
    if (this.tool) return this.tool;
    for (const t of ["maim", "import", "scrot"] as const) {
      if (await commandExists(this.exec, t)) return (this.tool = t);
    }
    return undefined;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.env.DISPLAY && !!(await this.pickTool());
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

  private async activeWindow(): Promise<{ id: string; title?: string } | undefined> {
    try {
      const root = await this.exec("xprop", ["-root", "_NET_ACTIVE_WINDOW"], { timeoutMs: 3000 });
      const id = parseActiveWindow(root.stdout.toString());
      if (!id || id === "0x0") return undefined;
      let title: string | undefined;
      try {
        title = parseWmName((await this.exec("xprop", ["-id", id, "_NET_WM_NAME", "WM_NAME"], { timeoutMs: 3000 })).stdout.toString());
      } catch {
        /* titre facultatif */
      }
      return { id, title };
    } catch {
      return undefined;
    }
  }

  async capture(target: CaptureTarget): Promise<RawCapture> {
    const tool = await this.pickTool();
    if (!tool) throw Object.assign(new Error("no X11 capture tool (install maim, imagemagick or scrot)"), { code: "backend_unavailable" });
    let win: { id: string; title?: string } | undefined;
    if (target === "window") {
      win = await this.activeWindow();
      if (!win) throw Object.assign(new Error("no active window found"), { code: "capture_failed" });
    }
    const id = win?.id;
    if (tool === "maim") {
      const { stdout } = await this.exec("maim", id ? ["-i", id, "--format=png"] : ["--format=png"]);
      return { png: stdout, windowTitle: win?.title };
    }
    if (tool === "import") {
      const { stdout } = await this.exec("import", ["-window", id ?? "root", "png:-"]);
      return { png: stdout, windowTitle: win?.title };
    }
    const dir = mkdtempSync(join(tmpdir(), "av-scrot-"));
    try {
      const file = join(dir, "s.png");
      await this.exec("scrot", id ? ["-u", file] : [file]);
      return { png: readFileSync(file), windowTitle: win?.title };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
