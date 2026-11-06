import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import tls from "node:tls";
import { URL } from "node:url";
import {
  type CaptureTarget,
  type ErrorCode,
  ErrorBody,
  LocalCaptureResponse,
  newId,
} from "@agent-vision/core";
import { type DeviceConfig, resolveSecret } from "./config.js";

export class DeviceError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
  }
}

export interface CaptureRequest {
  agentId: string;
  target: CaptureTarget;
  reason?: string;
}

export interface DeviceCapabilities {
  deviceId: string;
  kind: "local-http" | "push";
  platform?: string;
  backend?: string;
  targets: CaptureTarget[];
  observation: boolean;
  perCaptureUserConsent: boolean;
  lockedScreenDetection: boolean;
  ocrMaskingOnDevice: boolean;
  tls: boolean;
  online: boolean;
  stopped?: boolean;
  note?: string;
}

export interface ObserveStart {
  agentId: string;
  target: CaptureTarget;
  intervalMs: number;
  maxDurationSec: number;
  maxCaptures: number;
  reason?: string;
}

export interface DeviceClient {
  capabilities(): Promise<DeviceCapabilities>;
  observeStart(r: ObserveStart): Promise<{ sessionId: string; expiresAt: string; maxCaptures: number; intervalMs: number }>;
  observeCapture(sessionId: string, agentId: string): Promise<LocalCaptureResponse>;
  observeStop(sessionId: string, agentId: string): Promise<void>;
  readonly id: string;
  readonly platform?: string;
  capture(req: CaptureRequest): Promise<LocalCaptureResponse>;
  /** Demande l'arrêt immédiat côté appareil (best-effort). */
  stop?(): Promise<void>;
}

// ------------------------------------------------------------------ local HTTP(S) device

/** Ouvre une connexion TLS et vérifie l'empreinte du certificat AVANT d'envoyer quoi que ce soit. */
export function connectPinned(host: string, port: number, fingerprint256: string): Promise<tls.TLSSocket> {
  const want = fingerprint256.replace(/:/g, "").toLowerCase();
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: false, servername: isIP(host) ? undefined : host, minVersion: "TLSv1.2" }, () => {
      const got = sock.getPeerCertificate().fingerprint256?.replace(/:/g, "").toLowerCase();
      if (got !== want) {
        sock.destroy();
        reject(new DeviceError("unauthorized", "TLS certificate fingerprint mismatch (pinning)"));
      } else resolve(sock);
    });
    sock.once("error", reject);
  });
}

export class LocalHttpDevice implements DeviceClient {
  readonly id: string;
  readonly platform?: string;
  private readonly base: URL;
  private readonly token: string;
  private readonly pin?: string;

  constructor(cfg: Extract<DeviceConfig, { kind: "local-http" }>, private readonly timeoutMs = 120_000) {
    this.id = cfg.id;
    this.platform = cfg.platform;
    this.base = new URL(cfg.url);
    this.token = resolveSecret(cfg.token)!;
    this.pin = cfg.tlsFingerprint256;
    if (this.base.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(this.base.hostname)) {
      throw new Error(`device ${cfg.id}: plain HTTP is only allowed for loopback; use https`);
    }
    if (this.base.protocol !== "http:" && this.base.protocol !== "https:") throw new Error("bad device url");
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const isTls = this.base.protocol === "https:";
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const port = Number(this.base.port || (isTls ? 443 : 80));
    const opts: https.RequestOptions = {
      method,
      host: this.base.hostname,
      port,
      path,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
      },
      timeout: this.timeoutMs,
    };
    if (isTls && this.pin) {
      const sock = await connectPinned(this.base.hostname, port, this.pin);
      // pas d'`agent` : Node utilise alors createConnection (avec agent:false il l'ignorerait et re-vérifierait la chaîne)
      opts.createConnection = () => sock;
    }
    const mod = isTls ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request(opts, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 64 * 1024 * 1024) req.destroy(new DeviceError("capture_failed", "response too large"));
          else chunks.push(c);
        });
        res.on("end", () => {
          let json: unknown;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return reject(new DeviceError("capture_failed", `non-JSON response (HTTP ${res.statusCode})`));
          }
          if ((res.statusCode ?? 500) >= 400) {
            const e = ErrorBody.safeParse(json);
            return reject(e.success ? new DeviceError(e.data.error, e.data.message) : new DeviceError("capture_failed", `HTTP ${res.statusCode}`));
          }
          resolve(json);
        });
      });
      req.on("timeout", () => req.destroy(new DeviceError("timeout", "device timeout")));
      req.on("error", (e) => reject(e instanceof DeviceError ? e : new DeviceError("backend_unavailable", `device unreachable: ${e.message}`)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  async capture(r: CaptureRequest): Promise<LocalCaptureResponse> {
    const json = await this.request("POST", "/v1/capture", r);
    const parsed = LocalCaptureResponse.safeParse(json);
    if (!parsed.success) throw new DeviceError("capture_failed", "malformed capture response from device");
    return parsed.data;
  }

  async stop(): Promise<void> {
    await this.request("POST", "/v1/stop", {});
  }

  async capabilities(): Promise<DeviceCapabilities> {
    const base = { deviceId: this.id, kind: "local-http" as const, platform: this.platform, tls: this.base.protocol === "https:" };
    try {
      const h = (await this.request("GET", "/v1/health")) as any;
      const c = h.capabilities ?? {};
      return {
        ...base, platform: h.platform ?? this.platform, backend: h.backend, targets: c.targets ?? ["screen"], observation: !!c.observation,
        perCaptureUserConsent: c.consentMode === "prompt", lockedScreenDetection: !!c.lockedScreenDetection, ocrMaskingOnDevice: !!c.ocrMasking,
        online: true, stopped: !!h.stopped,
      };
    } catch (e) {
      return { ...base, targets: [], observation: false, perCaptureUserConsent: false, lockedScreenDetection: false, ocrMaskingOnDevice: false, online: false, note: (e as Error).message };
    }
  }

  async observeStart(r: ObserveStart) {
    return (await this.request("POST", "/v1/observe/start", r)) as { sessionId: string; expiresAt: string; maxCaptures: number; intervalMs: number };
  }
  async observeCapture(sessionId: string, agentId: string): Promise<LocalCaptureResponse> {
    const parsed = LocalCaptureResponse.safeParse(await this.request("POST", "/v1/observe/capture", { sessionId, agentId }));
    if (!parsed.success) throw new DeviceError("capture_failed", "malformed capture response from device");
    return parsed.data;
  }
  async observeStop(sessionId: string, agentId: string): Promise<void> {
    await this.request("POST", "/v1/observe/stop", { sessionId, agentId });
  }
}

// ------------------------------------------------------------------ push device (Android)

export interface PendingRequest {
  requestId: string;
  agentId: string;
  target: CaptureTarget;
  reason?: string;
  expiresAt: string;
}

interface Waiter {
  req: PendingRequest;
  resolve: (r: LocalCaptureResponse) => void;
  reject: (e: DeviceError) => void;
  timer: NodeJS.Timeout;
}

/**
 * Appareil qui interroge le serveur (poll) : la demande reste en attente jusqu'à ce que
 * l'utilisateur l'accepte sur l'appareil (consentement MediaProjection) et dépose la capture.
 */
export class PushDevice implements DeviceClient {
  readonly id: string;
  readonly platform?: string;
  private waiters = new Map<string, Waiter>();

  constructor(cfg: Extract<DeviceConfig, { kind: "push" }>, private readonly timeoutMs: number) {
    this.id = cfg.id;
    this.platform = cfg.platform;
  }

  capture(r: CaptureRequest): Promise<LocalCaptureResponse> {
    const requestId = newId("req");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new DeviceError("timeout", "no response from the device user in time"));
      }, this.timeoutMs);
      this.waiters.set(requestId, {
        req: { requestId, agentId: r.agentId, target: r.target, reason: r.reason, expiresAt: new Date(Date.now() + this.timeoutMs).toISOString() },
        resolve,
        reject,
        timer,
      });
    });
  }

  async capabilities(): Promise<DeviceCapabilities> {
    return {
      deviceId: this.id, kind: "push", platform: this.platform, backend: "android-mediaprojection", targets: ["screen"],
      observation: false, perCaptureUserConsent: true, lockedScreenDetection: false, ocrMaskingOnDevice: false, tls: true, online: true,
      note: "Chaque capture exige l'accord de l'utilisateur sur l'appareil ; les images protégées (FLAG_SECURE) arrivent noires et sont rejetées. L'observation périodique n'est pas prise en charge.",
    };
  }
  async observeStart(): Promise<never> { throw new DeviceError("backend_unavailable", "observation is not supported on push devices (user consent is required for every capture)"); }
  async observeCapture(): Promise<never> { throw new DeviceError("backend_unavailable", "observation is not supported on push devices"); }
  async observeStop(): Promise<void> {}

  pending(): PendingRequest[] {
    return [...this.waiters.values()].map((w) => w.req);
  }

  complete(requestId: string, res: LocalCaptureResponse): boolean {
    const w = this.waiters.get(requestId);
    if (!w) return false;
    clearTimeout(w.timer);
    this.waiters.delete(requestId);
    w.resolve(res);
    return true;
  }

  fail(requestId: string, code: ErrorCode, message: string): boolean {
    const w = this.waiters.get(requestId);
    if (!w) return false;
    clearTimeout(w.timer);
    this.waiters.delete(requestId);
    w.reject(new DeviceError(code, message));
    return true;
  }

  async stop(): Promise<void> {
    for (const id of [...this.waiters.keys()]) this.fail(id, "capture_stopped", "stopped");
  }
}

export class DeviceRegistry {
  private clients = new Map<string, DeviceClient>();
  private pushConfigs = new Map<string, Extract<DeviceConfig, { kind: "push" }>>();

  constructor(devices: DeviceConfig[], pushTimeoutSeconds: number) {
    for (const d of devices) {
      if (d.kind === "local-http") this.clients.set(d.id, new LocalHttpDevice(d));
      else {
        this.clients.set(d.id, new PushDevice(d, pushTimeoutSeconds * 1000));
        this.pushConfigs.set(d.id, d);
      }
    }
  }
  get(id: string): DeviceClient | undefined {
    return this.clients.get(id);
  }
  set(client: DeviceClient): void {
    this.clients.set(client.id, client);
  }
  pushDeviceByTokenSha(sha: string): PushDevice | undefined {
    for (const [id, c] of this.pushConfigs) if (c.tokenSha256 === sha) return this.clients.get(id) as PushDevice;
    return undefined;
  }
}
