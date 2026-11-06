import type { CaptureTarget } from "@agent-vision/core";
import { defaultExec, type Exec } from "../exec.js";
import type { Capturer, RawCapture } from "./types.js";

/**
 * Windows 10/11 : API GDI officielles (Graphics.CopyFromScreen) via PowerShell.
 * Aucun contournement : les fenêtres protégées (DRM / SetWindowDisplayAffinity) et l'écran
 * verrouillé produisent une image noire, détectée en amont (blank_or_protected).
 */
export function buildWindowsScript(target: CaptureTarget): string {
  if (target !== "screen" && target !== "window") throw new Error("invalid target");
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class AV {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[void][AV]::SetProcessDPIAware()
if (Get-Process -Name LogonUI -ErrorAction SilentlyContinue) { Write-Output '{"locked":true}'; exit 0 }
$title = ''
if ('${target}' -eq 'window') {
  $h = [AV]::GetForegroundWindow()
  $r = New-Object AV+RECT
  [void][AV]::GetWindowRect($h, [ref]$r)
  $sb = New-Object System.Text.StringBuilder 512
  [void][AV]::GetWindowText($h, $sb, 512)
  $title = $sb.ToString()
  $x = $r.L; $y = $r.T; $w = $r.R - $r.L; $ht = $r.B - $r.T
} else {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $x = $b.X; $y = $b.Y; $w = $b.Width; $ht = $b.Height
}
if ($w -le 0 -or $ht -le 0) { throw 'empty capture area' }
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
@{ locked = $false; title = $title; png = [Convert]::ToBase64String($ms.ToArray()) } | ConvertTo-Json -Compress
`;
}

export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function parseWindowsOutput(stdout: string): { locked: boolean; title?: string; png?: Buffer } {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  const j = JSON.parse(line) as { locked?: boolean; title?: string; png?: string };
  return { locked: !!j.locked, title: j.title || undefined, png: j.png ? Buffer.from(j.png, "base64") : undefined };
}

export class WindowsCapturer implements Capturer {
  readonly name = "windows-gdi";
  private lockedCache = false;
  constructor(private readonly exec: Exec = defaultExec) {}

  async isAvailable(): Promise<boolean> {
    return process.platform === "win32";
  }

  async isLocked(): Promise<boolean> {
    try {
      const { stdout } = await this.exec("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "if (Get-Process -Name LogonUI -ErrorAction SilentlyContinue) { 'locked' } else { 'unlocked' }",
      ]);
      this.lockedCache = stdout.toString().trim() === "locked";
    } catch {
      this.lockedCache = true; // dans le doute, on refuse
    }
    return this.lockedCache;
  }

  async capture(target: CaptureTarget): Promise<RawCapture> {
    const { stdout } = await this.exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(buildWindowsScript(target))],
      { timeoutMs: 30000 },
    );
    const out = parseWindowsOutput(stdout.toString("utf8"));
    if (out.locked || !out.png) throw Object.assign(new Error("screen locked"), { code: "screen_locked" });
    return { png: out.png, windowTitle: out.title };
  }
}
