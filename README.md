# Agent Vision

Infrastructure open source (Apache 2.0) de **perception visuelle** pour agents IA : capturer, comprendre, comparer et partager le contenu des écrans réels **que l'utilisateur a autorisés**, avec n'importe quel modèle multimodal (Claude, GPT, Gemini, Grok, DeepSeek, modèles locaux…).

> Agent Vision **regarde**, il ne **contrôle** pas : aucun accès souris, clavier ou tactile, aucun contournement des permissions système.

```
 Agent IA (MCP) ──► Serveur MCP ──► Agent Vision Local ──► écran (Windows / Linux)
                        │  ▲            (consentement, arrêt,        
                        │  └─ push ◄── App Android (MediaProjection, accord à chaque capture)
                        └──► Moteur d'analyse ──► Claude / GPT / Gemini / Grok / DeepSeek / Ollama…
```

## Outils MCP

V1 (contrats inchangés) : `capture_screen`, `analyze_screen`, `compare_screens`, `share_visual_report`.
V1.1 : `list_available_devices`, `get_device_capabilities`, `analyze_screen_region`, `start_observation`, `stop_observation`, `get_observation_status`, `get_visual_changes`. Détail : [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md).

Principes V1.1 : **OCR local fail-closed** avant toute transmission à un modèle ([docs/OCR-PRIVACY.md](docs/OCR-PRIVACY.md)) · **images brutes inaccessibles par défaut** (version assainie seulement, sauf `allowRawImages`) · **observation périodique bornée**, consentie localement, révocable ([docs/OBSERVATION.md](docs/OBSERVATION.md)) · application **Android Compose** ([docs/ANDROID.md](docs/ANDROID.md)) · observation d'applications **Expo** sans les contrôler ([docs/EXPO.md](docs/EXPO.md)).

## État réel

Le statut exact des validations (CI, appareils physiques) est consigné dans [docs/TESTING.md](docs/TESTING.md) et [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md). Résumé :

| Composant | État |
|---|---|
| Serveur MCP, 11 outils, politiques, audit, rétention | ✅ testé (vrai client MCP, stdio, HTTP) |
| OCR local + masquage + fail-closed | ✅ testé (Tesseract réel sur images synthétiques) — **pas une garantie absolue** |
| Observation (appareil + serveur) | ✅ testée (simulations d'appareil + service HTTP réel) |
| Linux X11 (écran, fenêtre active, refus, expiration) | ✅ testé sous Xvfb |
| Windows | ⚠️ testé sur **runner CI** `windows-latest`, **pas sur ordinateur physique** |
| Wayland (portail) | ⚠️ analyseur testé ; **jamais exécuté** sur un compositeur |
| Android | ⚠️ compile, tests JVM, lint, APK debug (CI) ; **jamais exécuté sur appareil/émulateur** |
| Fournisseurs IA réels | ⚠️ requêtes vérifiées contre un faux serveur ; **aucun appel réel** |
| macOS, iOS | ❌ non réalisé |

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

### 3. Android

Voir [docs/ANDROID.md](docs/ANDROID.md). APK debug : artefact `agent-vision-debug-apk` du workflow Android. L'appareil s'enregistre côté serveur comme appareil `push` ; **chaque** demande d'agent déclenche une notification, un écran d'accord, puis la boîte de dialogue système MediaProjection.

### 4. Observation périodique (optionnelle)

`agent-vision-local grant-observation --agent tester --minutes 15 --max-captures 60`, puis l'agent appelle `start_observation`. Voir [docs/OBSERVATION.md](docs/OBSERVATION.md).

## Sécurité en bref

Consentement explicite et local · OCR local avant tout envoi distant (fail-closed) · aucune capture clandestine (notification + log à chaque capture) · aucun contrôle de l'appareil · permissions par agent **et** par appareil · image brute jamais transmise à un autre agent (seule la version masquée) · détection de secrets dans les textes · rétention configurable, suppression à la demande · pas de cloud obligatoire (fournisseur local possible) · journal d'audit chaîné par hachage. Modèle de menaces et **limites connues** : [docs/SECURITY.md](docs/SECURITY.md).

## Licence

Apache 2.0 — voir [LICENSE](LICENSE).
