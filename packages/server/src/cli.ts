#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuditLog, sha256Hex } from "@agent-vision/core";
import { createAppContext } from "./app.js";
import { findAgentByToken, loadServerConfig } from "./config.js";
import { createGateway } from "./gateway.js";
import { createMcpHttpHandler } from "./mcp-http.js";
import { buildMcpServer } from "./mcp.js";

const [, , cmd = "help", ...rest] = process.argv;
const flag = (n: string, d?: string) => {
  const i = rest.indexOf(`--${n}`);
  return i >= 0 ? rest[i + 1] : d;
};
const configFile = () => flag("config", process.env.AGENT_VISION_CONFIG ?? "agent-vision.config.json")!;

const HELP = `agent-vision-server

  start [--config f] [--transport stdio|http]   démarre le serveur MCP (stdio : jeton dans AGENT_VISION_AGENT_TOKEN)
  new-token                                     génère un jeton aléatoire et son empreinte SHA-256 pour la config
  hash-token <jeton>                            empreinte SHA-256 d'un jeton existant
  purge [--config f]                            supprime les captures/rapports expirés
  audit-verify [--config f]                     vérifie l'intégrité de la chaîne du journal d'audit
`;

async function main() {
  switch (cmd) {
    case "new-token": {
      const t = randomBytes(32).toString("base64url");
      console.log(`token:  ${t}\nsha256: ${sha256Hex(t)}`);
      return;
    }
    case "hash-token":
      console.log(sha256Hex(rest[0] ?? ""));
      return;
    case "purge": {
      const ctx = createAppContext(loadServerConfig(configFile()));
      console.log(`${ctx.store.purgeExpired()} élément(s) purgé(s)`);
      return;
    }
    case "audit-verify": {
      const cfg = loadServerConfig(configFile());
      const r = AuditLog.verify(`${cfg.dataDir}/audit.jsonl`);
      console.log(JSON.stringify(r));
      process.exit(r.ok ? 0 : 2);
    }
    case "start": {
      const config = loadServerConfig(configFile());
      const ctx = createAppContext(config);
      setInterval(() => ctx.store.purgeExpired(), 60_000).unref();
      const transport = flag("transport", "stdio");
      const gateway = createGateway({ config, devices: ctx.devices, store: ctx.store, audit: ctx.audit, auditPath: ctx.auditPath, mcpHandler: transport === "http" ? createMcpHttpHandler(ctx) : undefined });
      const hasPush = config.devices.some((d) => d.kind === "push");
      if (transport === "http" || hasPush || config.gateway.adminTokenSha256) {
        gateway.listen(config.gateway.port, config.gateway.host, () =>
          console.error(`[agent-vision] gateway ${config.gateway.tls ? "https" : "http"}://${config.gateway.host}:${config.gateway.port}${transport === "http" ? " (MCP sur /mcp)" : ""}`),
        );
      }
      if (transport === "stdio") {
        const token = process.env.AGENT_VISION_AGENT_TOKEN;
        const agent = token ? findAgentByToken(config, token) : undefined;
        if (!agent) {
          console.error("AGENT_VISION_AGENT_TOKEN absent ou inconnu : refus de démarrer (authentification obligatoire).");
          process.exit(1);
        }
        ctx.audit.write({ actor: agent.id, action: "session_start", outcome: "allowed", details: { transport: "stdio" } });
        await buildMcpServer(ctx, agent).connect(new StdioServerTransport());
      }
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e: Error) => {
  console.error(`erreur : ${e.message}`);
  process.exit(1);
});
