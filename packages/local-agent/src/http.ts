import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { type ErrorBody, type ErrorCode, LocalCaptureRequest, sha256Hex } from "@agent-vision/core";
import type { LocalConfig } from "./config.js";
import type { ConsentStore } from "./consent.js";
import { CaptureError, type CaptureService } from "./service.js";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401, consent_required: 403, consent_denied: 403, capture_stopped: 409, screen_locked: 409,
  blank_or_protected: 422, backend_unavailable: 503, capture_failed: 500, bad_request: 400, rate_limited: 429, timeout: 504,
};

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function tokenMatches(token: string, expectedSha256: string): boolean {
  const a = Buffer.from(sha256Hex(token), "hex");
  const b = Buffer.from(expectedSha256, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data), "cache-control": "no-store" });
  res.end(data);
}

function sendError(res: ServerResponse, code: ErrorCode, message: string): void {
  send(res, STATUS[code], { error: code, message } satisfies ErrorBody);
}

async function readBody(req: IncomingMessage, limit = 16 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new CaptureError("bad_request", "body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createLocalServer(opts: {
  config: LocalConfig;
  service: CaptureService;
  consent: ConsentStore;
  backendName: string;
}): Server {
  const { config, service, consent } = opts;
  if (!isLoopback(config.host) && !config.tls) {
    throw new Error(`refusing to listen on ${config.host} without TLS (configure "tls" or bind to 127.0.0.1)`);
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
      if (!m || !tokenMatches(m[1]!, config.tokenSha256)) return sendError(res, "unauthorized", "invalid or missing device token");

      if (req.method === "GET" && req.url === "/v1/health") {
        return send(res, 200, { deviceId: config.deviceId, backend: opts.backendName, stopped: consent.isStopped(), platform: process.platform });
      }
      if (req.method === "POST" && req.url === "/v1/stop") {
        consent.stop(); // l'arrêt peut être demandé à distance ; la reprise, jamais
        return send(res, 200, { stopped: true });
      }
      if (req.method === "POST" && req.url === "/v1/capture") {
        let parsed: unknown;
        try {
          parsed = JSON.parse((await readBody(req)) || "{}");
        } catch (e) {
          if (e instanceof CaptureError) throw e;
          return sendError(res, "bad_request", "invalid JSON");
        }
        const r = LocalCaptureRequest.safeParse(parsed);
        if (!r.success) return sendError(res, "bad_request", r.error.issues.map((i) => i.message).join("; "));
        return send(res, 200, await service.capture(r.data));
      }
      return send(res, 404, { error: "bad_request", message: "not found" });
    } catch (e) {
      if (e instanceof CaptureError) return sendError(res, e.code, e.message);
      return sendError(res, "capture_failed", "internal error");
    }
  };

  return config.tls
    ? createHttps({ cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile), minVersion: "TLSv1.2" }, handler)
    : createHttp(handler);
}
