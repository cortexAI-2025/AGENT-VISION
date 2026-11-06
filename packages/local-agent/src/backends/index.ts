import { WaylandPortalCapturer } from "./wayland.js";
import { WindowsCapturer } from "./windows.js";
import { X11Capturer } from "./x11.js";
import type { Capturer } from "./types.js";

export * from "./types.js";
export { WindowsCapturer, X11Capturer, WaylandPortalCapturer };

export async function detectCapturer(env: NodeJS.ProcessEnv = process.env): Promise<Capturer | undefined> {
  const candidates: Capturer[] = [];
  if (process.platform === "win32") candidates.push(new WindowsCapturer());
  else if (process.platform === "linux") {
    const wayland = env.XDG_SESSION_TYPE === "wayland" || (!!env.WAYLAND_DISPLAY && !env.DISPLAY);
    candidates.push(...(wayland ? [new WaylandPortalCapturer(), new X11Capturer()] : [new X11Capturer(), new WaylandPortalCapturer()]));
  }
  for (const c of candidates) if (await c.isAvailable()) return c;
  return undefined;
}
