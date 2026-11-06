import { describe, expect, it } from "vitest";
import { buildWindowsScript, encodePowerShell, parseWindowsOutput } from "../src/backends/windows.js";
import { parsePortalResponse } from "../src/backends/wayland.js";
import { parseActiveWindow, parseWmName, X11Capturer } from "../src/backends/x11.js";
import type { Exec } from "../src/exec.js";

describe("Windows (unitaire — non exécuté sur Windows ici)", () => {
  it("le script cible l'écran ou la fenêtre et utilise CopyFromScreen", () => {
    expect(buildWindowsScript("screen")).toContain("if ('screen' -eq 'window')");
    expect(buildWindowsScript("window")).toContain("if ('window' -eq 'window')");
    expect(buildWindowsScript("window")).toContain("CopyFromScreen");
  });
  it("refuse une cible inattendue (pas d'injection)", () => {
    expect(() => buildWindowsScript("x'; calc; '" as never)).toThrow();
  });
  it("le script gère DPI per-monitor, session verrouillée, fenêtre minimisée, libération GDI, aucun fichier temporaire", () => {
    const sc = buildWindowsScript("window");
    expect(sc).toContain("SetProcessDpiAwarenessContext");
    expect(sc).toContain("OpenInputDesktop");
    expect(sc).toContain("LogonUI");
    expect(sc).toContain("IsIconic");
    expect(sc).toContain("PrintWindow");
    expect(sc).toMatch(/\$bmp\.Dispose\(\)/);
    expect(sc).not.toMatch(/Out-File|\[IO\.File\]|\.Save\(\$[a-z]*[Pp]ath|GetTempPath/);
    expect(sc).not.toMatch(/SendKeys|mouse_event|SendInput|keybd_event|SetCursorPos/); // perception seule
  });
  it("encode en UTF-16LE base64", () => {
    expect(Buffer.from(encodePowerShell("ab"), "base64").toString("utf16le")).toBe("ab");
  });
  it("parse la sortie JSON", () => {
    const png = Buffer.from("hello");
    const out = parseWindowsOutput(`noise\n${JSON.stringify({ locked: false, title: "T", png: png.toString("base64") })}\n`);
    expect(out.png?.toString()).toBe("hello");
    expect(out.title).toBe("T");
    expect(parseWindowsOutput('{"locked":true}').locked).toBe(true);
  });
});

describe("parseurs Linux", () => {
  it("portail Wayland : Response avec uri", () => {
    const text = `/org/freedesktop/portal/desktop/request/1_23/av1: org.freedesktop.portal.Request.Response (uint32 0, {'uri': <'file:///tmp/Screenshot.png'>})`;
    expect(parsePortalResponse(text)).toEqual({ code: 0, uri: "file:///tmp/Screenshot.png" });
  });
  it("portail Wayland : annulation", () => {
    expect(parsePortalResponse("x: org.freedesktop.portal.Request.Response (uint32 1, {})")).toEqual({ code: 1, uri: undefined });
    expect(parsePortalResponse("bruit")).toBeUndefined();
  });
  it("xprop", () => {
    expect(parseActiveWindow("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x4a00007")).toBe("0x4a00007");
    expect(parseWmName('_NET_WM_NAME(UTF8_STRING) = "Terminal \\"x\\""')).toBe('Terminal "x"');
  });
  it("X11 : cible window sans fenêtre active → erreur claire", async () => {
    const exec: Exec = async (cmd) => {
      if (cmd === "sh") return { stdout: Buffer.from("/usr/bin/maim"), stderr: "" };
      if (cmd === "xprop") throw new Error("no xprop");
      return { stdout: Buffer.alloc(0), stderr: "" };
    };
    const c = new X11Capturer(exec, { DISPLAY: ":0" });
    await expect(c.capture("window")).rejects.toThrow(/active window/);
  });
});
