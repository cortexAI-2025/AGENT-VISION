import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { AuditLog, LocalCaptureResponse, isUniformFrame, pngSize, sha256Hex } from "@agent-vision/core";
import { z } from "zod";
import type { ServerConfig } from "./config.js";
import type { DeviceRegistry } from "./devices.js";
import type { Store } from "./store.js";

const MAX_BODY = 40 * 1024 * 1024;

const Upload = z.union([
  z.object({ declined: z.literal(true), message: z.string().max(300).optional() }),
  z.object({
    declined: z.literal(false).optional(),
    capturedAt: z.string(),
    windowTitle: z.string().max(300).optional(),
    pngBase64: z.string().min(100),
  }),
]);

function json(res: ServerResponse, status: number, body: unknown): void {
  const d = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(d), "cache-control": "no-store" });
  res.end(d);
}

async function body(req: IncomingMessage): Promise<string> {
  let n = 0;
  const parts: Buffer[] = [];
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw Object.assign(new Error("too large"), { status: 413 });
    parts.push(c as Buffer);
  }
  return Buffer.concat(parts).toString("utf8");
}

function bearer(req: IncomingMessage): string | undefined {
  return /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
}

function eqHash(token: string, expected: string): boolean {
  const a = Buffer.from(sha256Hex(token), "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Passerelle HTTP du serveur : (1) appareils « push » (Android) — poll + dépôt de capture ;
 * (2) administration — suppression d'une capture, vérification du journal d'audit.
 */
export function createGateway(opts: { config: ServerConfig; devices: DeviceRegistry; store: Store; audit: AuditLog; auditPath: string; mcpHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): Server {
  const { config, devices, store, audit } = opts;
  const gw = config.gateway;
  const loop = ["127.0.0.1", "::1", "localhost"].includes(gw.host);
  if (!loop && !gw.tls) throw new Error("gateway: refusing non-loopback binding without TLS");

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (opts.mcpHandler && (req.url ?? "").split("?")[0] === "/mcp") return await opts.mcpHandler(req, res);
      const token = bearer(req);
      if (!token) return json(res, 401, { error: "unauthorized" });
      const url = new URL(req.url ?? "/", "http://x");

      // ---- administration
      if (url.pathname.startsWith("/admin/")) {
        if (!gw.adminTokenSha256 || !eqHash(token, gw.adminTokenSha256)) return json(res, 401, { error: "unauthorized" });
        const m = /^\/admin\/captures\/([\w-]+)$/.exec(url.pathname);
        if (req.method === "DELETE" && m) {
          const ok = store.deleteCapture(m[1]!);
          audit.write({ actor: "admin", action: "delete_capture", outcome: ok ? "allowed" : "error", details: { captureId: m[1] } });
          return json(res, ok ? 200 : 404, { deleted: ok });
        }
        if (req.method === "GET" && url.pathname === "/admin/audit/verify") return json(res, 200, AuditLog.verify(opts.auditPath));
        return json(res, 404, { error: "not_found" });
      }

      // ---- appareils push
      const dev = devices.pushDeviceByTokenSha(sha256Hex(token));
      if (!dev) return json(res, 401, { error: "unauthorized" });

      if (req.method === "POST" && url.pathname === "/v1/device/poll") {
        return json(res, 200, { deviceId: dev.id, requests: dev.pending() });
      }
      const m = /^\/v1\/device\/captures\/([\w-]+)$/.exec(url.pathname);
      if (req.method === "POST" && m) {
        const requestId = m[1]!;
        const parsed = Upload.safeParse(JSON.parse((await body(req)) || "{}"));
        if (!parsed.success) return json(res, 400, { error: "bad_request" });
        const u = parsed.data;
        if (u.declined) {
          audit.write({ actor: `device:${dev.id}`, action: "capture_declined", outcome: "denied", details: { requestId } });
          return json(res, dev.fail(requestId, "consent_denied", u.message ?? "declined by the device user") ? 200 : 404, { ok: true });
        }
        let png: Buffer;
        let size: { width: number; height: number };
        try {
          png = Buffer.from(u.pngBase64, "base64");
          size = pngSize(png);
        } catch {
          return json(res, 400, { error: "bad_request", message: "not a PNG" });
        }
        if (isUniformFrame(png)) {
          dev.fail(requestId, "blank_or_protected", "uniform frame (protected content or locked screen)");
          return json(res, 422, { error: "blank_or_protected" });
        }
        const out: LocalCaptureResponse = {
          deviceId: dev.id,
          capturedAt: u.capturedAt,
          target: "screen",
          backend: "android-mediaprojection",
          ...size,
          sha256: sha256Hex(png), // recalculé côté serveur : on ne fait pas confiance au client
          windowTitle: u.windowTitle,
          masksApplied: 0,
          pngBase64: u.pngBase64,
        };
        return json(res, dev.complete(requestId, out) ? 200 : 404, { ok: true });
      }
      return json(res, 404, { error: "not_found" });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      return json(res, status, { error: status === 413 ? "too_large" : "internal" });
    }
  };

  return gw.tls
    ? createHttps({ cert: readFileSync(gw.tls.certFile), key: readFileSync(gw.tls.keyFile), minVersion: "TLSv1.2" }, handler)
    : createHttp(handler);
}
