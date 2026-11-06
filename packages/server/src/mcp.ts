import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "./app.js";
import type { AgentPolicy } from "./config.js";
import {
  analyzeScreen, analyzeScreenInput, captureScreen, captureScreenInput,
  compareScreens, compareScreensInput, readImage, shareVisualReport, shareVisualReportInput,
  analyzeRegionInput, analyzeScreenRegion, deviceCapabilitiesInput, getDeviceCapabilities, getObservationStatus, getVisualChanges,
  listAvailableDevices, listDevicesInput, observationIdInput, startObservation, startObservationInput, stopObservation, visualChangesInput,
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

  s.registerTool("list_available_devices", {
    title: "Lister les appareils accessibles",
    description: "Liste uniquement les appareils sur lesquels CET agent a une permission. Ne révèle rien sur les autres.",
    inputSchema: listDevicesInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => listAvailableDevices(ctx, agent));

  s.registerTool("get_device_capabilities", {
    title: "Capacités réelles d'un appareil",
    description: "Cibles de capture prises en charge, observation, détection d'écran verrouillé, mode de consentement, état d'arrêt. Interroge l'appareil.",
    inputSchema: deviceCapabilitiesInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (a) => getDeviceCapabilities(ctx, agent, a as never));

  s.registerTool("analyze_screen_region", {
    title: "Analyser une région d'une capture",
    description: "Analyse une région précise (coordonnées normalisées) de la version ASSAINIE d'une capture par un modèle multimodal.",
    inputSchema: analyzeRegionInput,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, (a) => analyzeScreenRegion(ctx, agent, a as never));

  s.registerTool("start_observation", {
    title: "Démarrer une session d'observation",
    description: "Démarre une observation périodique BORNÉE (durée, nombre de captures, intervalle). Exige le consentement local explicite de l'utilisateur sur l'appareil (`agent-vision-local grant-observation`). Seuls les changements significatifs sont retenus ; l'analyse par modèle est limitée et dédupliquée.",
    inputSchema: startObservationInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (a) => startObservation(ctx, agent, a as never));

  s.registerTool("stop_observation", {
    title: "Arrêter une session d'observation",
    description: "Arrête immédiatement la session (la reprise exige une nouvelle session et un consentement valide).",
    inputSchema: observationIdInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (a) => stopObservation(ctx, agent, a as never));

  s.registerTool("get_observation_status", {
    title: "État d'une session d'observation",
    description: "État, compteurs (captures, identiques, mineures, significatives, analyses), temps restant.",
    inputSchema: observationIdInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (a) => getObservationStatus(ctx, agent, a as never));

  s.registerTool("get_visual_changes", {
    title: "Changements visuels détectés",
    description: "Liste les changements retenus (diff par régions + description structurée si analysée). Utiliser sinceChangeId pour ne lire que les nouveautés.",
    inputSchema: visualChangesInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (a) => getVisualChanges(ctx, agent, a as never));

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
    ctx.audit.write({ actor: agent.id, action: "read_capture", outcome: "allowed", details: { captureId: m.captureId, raw: m.ownerAgent === agent.id && agent.allowRawImages } });
    return { contents: [{ uri: uri.href, mimeType: "image/png", blob: (await readImage(ctx, agent, m)).toString("base64") }] };
  });

  return s;
}
