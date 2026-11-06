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
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
# DPI : per-monitor v2 (Windows 10 1703+), sinon system-aware — nécessaire pour des coordonnées physiques correctes en multi-écrans
try { [void][AV]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { [void][AV]::SetProcessDPIAware() }
# Session verrouillée / bureau sécurisé : LogonUI actif, ou bureau d'entrée inaccessible
$desk = [AV]::OpenInputDesktop(0, $false, 0x0001)
if ($desk -eq [IntPtr]::Zero -or (Get-Process -Name LogonUI -ErrorAction SilentlyContinue)) { Write-Output '{"locked":true}'; exit 0 }
[void][AV]::CloseDesktop($desk)
$title = ''
$hwnd = [IntPtr]::Zero
if ('${target}' -eq 'window') {
  $hwnd = [AV]::GetForegroundWindow()
  if ($hwnd -eq [IntPtr]::Zero) { throw 'no foreground window' }
  if ([AV]::IsIconic($hwnd)) { throw 'foreground window is minimized' }
  $r = New-Object AV+RECT
  [void][AV]::GetWindowRect($hwnd, [ref]$r)
  $sb = New-Object System.Text.StringBuilder 512
  [void][AV]::GetWindowText($hwnd, $sb, 512)
  $title = $sb.ToString()
  $x = $r.L; $y = $r.T; $w = $r.R - $r.L; $ht = $r.B - $r.T
} else {
  # écran virtuel = tous les moniteurs (origine éventuellement négative)
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $x = $b.X; $y = $b.Y; $w = $b.Width; $ht = $b.Height
}
if ($w -le 0 -or $ht -le 0) { throw 'empty capture area' }
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$ms = New-Object System.IO.MemoryStream
try {
  $done = $false
  if ($hwnd -ne [IntPtr]::Zero) {
    # PW_RENDERFULLCONTENT (2) : contenu réel de la fenêtre même partiellement masquée ; contenu protégé => noir (rejeté en aval)
    $hdc = $g.GetHdc()
    try { $done = [AV]::PrintWindow($hwnd, $hdc, 2) } finally { $g.ReleaseHdc($hdc) }
  }
  if (-not $done) { $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size) }
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  @{ locked = $false; title = $title; png = [Convert]::ToBase64String($ms.ToArray()) } | ConvertTo-Json -Compress
} finally {
  $ms.Dispose(); $g.Dispose(); $bmp.Dispose()   # aucun fichier temporaire : tout transite en mémoire
}
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
  readonly targets: CaptureTarget[] = ["screen", "window"];
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
