import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "./app.js";
import type { AgentPolicy } from "./config.js";
import {
  analyzeScreen, analyzeScreenInput, captureScreen, captureScreenInput,
  compareScreens, compareScreensInput, readImage, shareVisualReport, shareVisualReportInput,
} from "./tools.js";

export const SERVER_VERSION = "0.1.0";

/** Une instance par agent authentifié : l'identité est liée à la session, jamais fournie par les arguments. */
export function buildMcpServer(ctx: AppContext, agent: AgentPolicy): McpServer {
  const s = new McpServer({ name: "agent-vision", version: SERVER_VERSION });

  s.registerTool("capture_screen", {
    title: "Capturer l'écran d'un appareil autorisé",
    description: "Prend UNE capture de l'écran (ou de la fenêtre active) d'un appareil sur lequel l'utilisateur a donné son consentement. Lecture seule : aucun contrôle de la souris, du clavier ou du tactile. Retourne un captureId.",
    inputSchema: captureScreenInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (a) => captureScreen(ctx, agent, a as never));

  s.registerTool("analyze_screen", {
    title: "Analyser une capture avec un modèle multimodal",
    description: "Envoie la capture au fournisseur multimodal choisi et renvoie un rapport JSON qui sépare les OBSERVATIONS (faits visibles) des HYPOTHÈSES (causes supposées). Les zones sensibles détectées sont masquées dans la version partageable.",
    inputSchema: analyzeScreenInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (a) => analyzeScreen(ctx, agent, a as never));

  s.registerTool("compare_screens", {
    title: "Comparer deux captures",
    description: "Compare deux captures (avant/après) : différences de pixels et régions modifiées calculées localement, plus une description sémantique optionnelle par un modèle.",
    inputSchema: compareScreensInput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, (a) => compareScreens(ctx, agent, a as never));

  s.registerTool("share_visual_report", {
    title: "Partager un rapport visuel avec un autre agent",
    description: "Crée un rapport structuré (capture masquée, diagnostic, diff, contexte technique) et le met à disposition d'un autre agent autorisé via les ressources MCP agent-vision://reports/{id} et agent-vision://inbox.",
    inputSchema: shareVisualReportInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (a) => shareVisualReport(ctx, agent, a as never));

  // ---- ressources (lecture de ce qui est partagé avec cet agent)
  s.registerResource("inbox", "agent-vision://inbox", { title: "Rapports reçus", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(ctx.store.listReportsFor(agent.id).map((r) => ({ id: r.id, from: r.from, createdAt: r.createdAt, note: r.note, resource: `agent-vision://reports/${r.id}` })), null, 2) }],
  }));

  s.registerResource("report", new ResourceTemplate("agent-vision://reports/{id}", { list: undefined }), { title: "Rapport visuel", mimeType: "application/json" }, async (uri, vars) => {
    const r = ctx.store.getReport(String(vars.id));
    if (!r || (r.to !== agent.id && r.from !== agent.id)) throw new Error("report not found");
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(r, null, 2) }] };
  });

  s.registerResource("capture", new ResourceTemplate("agent-vision://captures/{id}", { list: undefined }), { title: "Capture (PNG)", mimeType: "image/png" }, async (uri, vars) => {
    const m = ctx.store.getMeta(String(vars.id));
    if (!m || (m.ownerAgent !== agent.id && !m.sharedWith.includes(agent.id))) throw new Error("capture not found");
    ctx.audit.write({ actor: agent.id, action: "read_capture", outcome: "allowed", details: { captureId: m.captureId, redacted: m.ownerAgent !== agent.id } });
    return { contents: [{ uri: uri.href, mimeType: "image/png", blob: readImage(ctx, agent, m).toString("base64") }] };
  });

  return s;
}
