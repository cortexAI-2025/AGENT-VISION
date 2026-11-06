import type { CaptureTarget } from "@agent-vision/core";

export interface RawCapture {
  png: Buffer;
  windowTitle?: string;
}

export interface Capturer {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  /** true si la session est verrouillée (on refuse alors de capturer). */
  isLocked(): Promise<boolean>;
  capture(target: CaptureTarget): Promise<RawCapture>;
}
