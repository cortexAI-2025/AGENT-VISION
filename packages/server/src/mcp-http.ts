import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppContext } from "./app.js";
import { findAgentByToken } from "./config.js";
import { buildMcpServer } from "./mcp.js";

/** MCP « Streamable HTTP » sans session : chaque requête est authentifiée (Bearer) et liée à un agent. */
export function createMcpHttpHandler(ctx: AppContext) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const agent = token ? findAgentByToken(ctx.config, token) : undefined;
    if (!agent) {
      ctx.audit.write({ actor: "unknown", action: "mcp_auth", outcome: "denied" });
      return send(401, { error: "unauthorized" });
    }
    if (req.method !== "POST") return send(405, { error: "method_not_allowed" });

    let raw = "";
    for await (const c of req) {
      raw += c;
      if (raw.length > 1024 * 1024) return send(413, { error: "too_large" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return send(400, { error: "bad_json" });
    }

    const server = buildMcpServer(ctx, agent);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  };
}
