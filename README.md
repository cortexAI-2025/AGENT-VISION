# Agent Vision

Infrastructure open source (Apache 2.0) de **perception visuelle** pour agents IA : capturer, comprendre, comparer et partager le contenu des écrans réels **que l'utilisateur a autorisés**, avec n'importe quel modèle multimodal (Claude, GPT, Gemini, Grok, DeepSeek, modèles locaux…).

> Agent Vision **regarde**, il ne **contrôle** pas : aucun accès souris, clavier ou tactile, aucun contournement des permissions système.

```
 Agent IA (MCP) ──► Serveur MCP ──► Agent Vision Local ──► écran (Windows / Linux)
                        │  ▲            (consentement, arrêt,        
                        │  └─ push ◄── App Android (MediaProjection, accord à chaque capture)
                        └──► Moteur d'analyse ──► Claude / GPT / Gemini / Grok / DeepSeek / Ollama…
```

## Les quatre outils MCP

| Outil | Rôle |
|---|---|
| `capture_screen` | Une capture de l'écran ou de la fenêtre active d'un appareil autorisé → `captureId` |
| `analyze_screen` | Analyse par un modèle multimodal → rapport JSON **observations (faits) / hypothèses (causes supposées)** séparées, zones sensibles masquées |
| `compare_screens` | Diff avant/après calculé **localement** (régions modifiées) + description sémantique optionnelle |
| `share_visual_report` | Rapport structuré (image masquée, diagnostic, diff, contexte technique) transmis à un autre agent via les ressources MCP `agent-vision://inbox` et `agent-vision://reports/{id}` |

Chaque outil est utilisable indépendamment. Détails : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## État réel (ce qui a été testé, et ce qui ne l'a pas été)

| Composant | État | Vérification effectuée |
|---|---|---|
| Serveur MCP (stdio + HTTP authentifié), 4 outils, ressources, audit chaîné, rétention, politiques par agent/appareil | ✅ testé | tests Vitest avec un **vrai client MCP**, un vrai processus stdio, un vrai transport HTTP |
| Moteur d'analyse + adaptateurs Anthropic / OpenAI-compatible / Gemini | ✅ testé contre un **faux fournisseur HTTP local** | forme des requêtes vérifiée ; **aucun appel à une API réelle n'a été fait** (pas de clé) |
| Agent local : consentement, arrêt d'urgence, API HTTP, masques, rejet des images noires/écran verrouillé | ✅ testé | tests unitaires + HTTP |
| Capture **Linux X11** | ✅ testée en réel | Xvfb + ImageMagick (`npm run test:x11`) ; la cible `window` (via `xprop`) n'a **pas** pu être testée (outil absent) |
| Capture **Windows 10/11** (GDI via PowerShell) | ⚠️ **non exécutée** | seule la génération du script et l'analyse de sa sortie sont testées ; **à valider sur une machine Windows** |
| Capture **Linux Wayland** (portail xdg-desktop-portal) | ⚠️ **non exécutée** | seul l'analyseur de réponse du portail est testé |
| **Android** (Kotlin, MediaProjection) | ⚠️ **non compilé, non exécuté** | pas de SDK Android ici ; le protocole côté serveur (poll/dépôt/refus/image noire) est testé avec un client simulé |
| Épinglage TLS du certificat de l'appareil | ✅ testé | certificat auto-signé réel (openssl) : empreinte correcte acceptée, mauvaise rejetée sans rien envoyer |
| macOS, iOS, Expo/React Native, captures événementielles/périodiques | ❌ non réalisé | prévus après le MVP |

## Démarrage rapide

Prérequis : Node.js ≥ 20.

```bash
npm install && npm run build && npm test
```

### 1. Appareil à observer (Windows ou Linux)

```bash
node packages/local-agent/dist/cli.js init --device-id win-pc   # affiche le jeton d'appareil UNE fois
node packages/local-agent/dist/cli.js start                      # écoute sur 127.0.0.1:7821
# dans un autre terminal, l'utilisateur donne son consentement (action locale uniquement) :
node packages/local-agent/dist/cli.js grant --agent tester --minutes 30
# arrêt immédiat à tout moment :
node packages/local-agent/dist/cli.js stop
```

Linux X11 : installer `maim`, `imagemagick` ou `scrot`. Wayland : `gdbus` + un portail (`xdg-desktop-portal-gnome/kde/wlr`).

### 2. Serveur MCP

```bash
node packages/server/dist/cli.js new-token        # un jeton par agent ; mettre le sha256 dans la config
cp examples/agent-vision.config.json agent-vision.config.json   # puis l'adapter
export AGENT_VISION_WIN_PC_TOKEN=<jeton d'appareil>  ANTHROPIC_API_KEY=...
AGENT_VISION_AGENT_TOKEN=<jeton de l'agent> node packages/server/dist/cli.js start      # stdio
node packages/server/dist/cli.js start --transport http                                 # HTTP : POST /mcp, Authorization: Bearer
```

Brancher un agent : [docs/AGENT-GUIDE.md](docs/AGENT-GUIDE.md) et [examples/](examples/).

### 3. Android (prototype)

Voir [android/README.md](android/README.md). L'appareil s'enregistre côté serveur comme appareil `push` ; **chaque** demande d'agent déclenche une notification, un écran d'accord, puis la boîte de dialogue système MediaProjection.

## Sécurité en bref

Consentement explicite et local · aucune capture clandestine (notification + log à chaque capture) · aucun contrôle de l'appareil · permissions par agent **et** par appareil · image brute jamais transmise à un autre agent (seule la version masquée) · détection de secrets dans les textes · rétention configurable, suppression à la demande · pas de cloud obligatoire (fournisseur local possible) · journal d'audit chaîné par hachage. Modèle de menaces et **limites connues** : [docs/SECURITY.md](docs/SECURITY.md).

## Licence

Apache 2.0 — voir [LICENSE](LICENSE).
