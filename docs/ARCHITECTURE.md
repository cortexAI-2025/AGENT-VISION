# Architecture

## 1. Audit de faisabilité par plateforme

| Plateforme | API retenue | Consentement | Limites constatées |
|---|---|---|---|
| Windows 10/11 | GDI `Graphics.CopyFromScreen` (PowerShell, DPI-aware) | Local : `grant` CLI ou boîte de dialogue par capture | Contenu protégé (DRM, `SetWindowDisplayAffinity`) et écran verrouillé → image noire : détectée et rejetée (`blank_or_protected`, `screen_locked` via `LogonUI`). Windows Graphics Capture (WinRT) serait plus performant mais nécessite un binaire natif : prévu après le MVP. |
| Linux X11 | `maim` / ImageMagick `import` / `scrot` | Local (CLI/prompt) | Sous X11 toute application cliente peut lire l'écran : le consentement est celui d'Agent Vision, pas de l'OS. Fenêtre active via `xprop`. |
| Linux Wayland | Portail `org.freedesktop.portal.Screenshot` (D-Bus via `gdbus`) | **Le portail** demande lui-même l'accord ; cible `window` ⇒ mode `interactive` (l'utilisateur choisit) | Dépend du portail installé. Aucun usage de `wlr-screencopy`/`grim` (pas de contournement du portail). |
| Android | `MediaProjection` + `VirtualDisplay` + `ImageReader` | Accord Agent Vision **à chaque demande** + dialogue système (jeton non réutilisé, obligatoire Android 14+) | Service de premier plan `mediaProjection` obligatoire ; `FLAG_SECURE` ⇒ image noire (rejetée côté serveur). Pas d'accessibilité, pas d'injection. |
| macOS / iOS | — | — | Hors MVP (ScreenCaptureKit + permission « Enregistrement de l'écran » ; iOS : ReplayKit limité à l'app ou à une extension de diffusion). |

## 2. Arborescence

```
packages/
  privacy/      OCR local (Tesseract) + assainissement vérifié des images (fail-closed)
  core/         contrats (zod), détection de secrets, masquage/diff PNG, journal d'audit chaîné
  local-agent/  Agent Vision Local : consentement, arrêt, API HTTP(S), backends de capture
  server/       Serveur MCP + moteur d'analyse (adaptateurs) + stockage + passerelle appareils/admin
android/        prototype Kotlin (appareil « push »)
docs/ examples/
```

## 3. Composants

**A. Agent Vision Local** (`packages/local-agent`) — API HTTP(S) sur `127.0.0.1` par défaut (écoute réseau refusée sans TLS).
`GET /v1/health` · `POST /v1/capture {agentId, target, reason?}` · `POST /v1/stop`. Authentification : `Authorization: Bearer <jeton d'appareil>` (seul le SHA-256 est stocké, comparaison à temps constant).
Le consentement (`grant`, `revoke`, `resume`) n'est modifiable **que par le CLI local** : aucune route réseau ne l'accorde ni ne lève l'arrêt. Ordre des contrôles : arrêt → agent autorisé → fréquence → consentement → écran verrouillé → arrêt (re-vérifié) → indicateur → capture → rejet image uniforme → masques → réponse.

**B. Serveur MCP** (`packages/server`) — une instance `McpServer` **par agent authentifié** (identité liée à la session, jamais lue dans les arguments).
- stdio : jeton dans `AGENT_VISION_AGENT_TOKEN`, refus de démarrer sinon.
- HTTP : `POST /mcp` (Streamable HTTP sans session), Bearer par requête.
- Politique par agent : `tools`, `devices`, `providers`, `shareTo`.
- Passerelle (`gateway`) : appareils `push` (`/v1/device/poll`, `/v1/device/captures/{id}`), administration (`DELETE /admin/captures/{id}`, `GET /admin/audit/verify`).
- Stockage disque local (`dataDir`), TTL par capture, purge périodique, suppression sur demande.

**C. Visual Analysis Engine** (`packages/server/src/analysis`) — interface `VisionProvider.complete({system, prompt, images})`. Adaptateurs : `anthropic`, `openai` (compatible : OpenAI, DeepSeek, xAI/Grok, Ollama, vLLM, LM Studio via `baseUrl`), `gemini`, `mock`. Sortie normalisée en JSON : `observations[]` (faits visibles) et `hypotheses[]` (causes supposées, `confidence`, `basedOn` = ids d'observations, `suggestedChecks`) toujours séparées ; énumérations inconnues ramenées à `other`/`info` ; une relance si le JSON est invalide.

## 4. Interfaces MCP

Types exacts : `packages/server/src/tools.ts` (schémas zod) et `packages/core/src/schemas.ts`.

| Outil | Entrées principales | Sortie |
|---|---|---|
| `capture_screen` | `deviceId`, `target` (`screen`\|`window`), `reason?`, `includeImage?` (défaut `false`) | métadonnées + `captureId` (+ image si demandée) |
| `analyze_screen` | `captureId`, `provider?`, `context?`, `expectation?`, `deleteAfter?` | `AnalysisReport` |
| `compare_screens` | `beforeCaptureId`, `afterCaptureId`, `threshold?`, `describe?`, `includeOverlay?` | `DiffResult` (+ description, + image de superposition) |
| `share_visual_report` | `captureId`, `toAgent`, `note?`, `includeImage?`, `compareWithCaptureId?`, `technicalContext?` | `VisualReport` + `agent-vision://reports/{id}` |

Ressources : `agent-vision://inbox`, `agent-vision://reports/{id}`, `agent-vision://captures/{id}` (propriétaire : original ; destinataire : **version masquée uniquement**).
Erreurs : `{ "error": <code>, "message": ... }` avec `isError: true` ; codes : `forbidden`, `not_found`, `consent_required`, `consent_denied`, `capture_stopped`, `screen_locked`, `blank_or_protected`, `analysis_required`, `incomparable`, `timeout`, `backend_unavailable`, `capture_failed`.

## 5. Contrat serveur ↔ appareil

*Pull* (Windows/Linux) : le serveur appelle l'API de l'agent local (HTTPS conseillé hors loopback, avec épinglage `tlsFingerprint256` pour les certificats auto-signés ; HTTP clair refusé hors loopback).
*Push* (Android) : l'appareil sonde `POST /v1/device/poll` (Bearer) ; une demande reste en attente (`pushTimeoutSeconds`) jusqu'à dépôt (`pngBase64`) ou refus (`declined:true`). Le serveur recalcule le SHA-256 et rejette les trames uniformes.

## 6. Flux « testeur → développeur → vérification »

Voir [examples/workflow.md](../examples/workflow.md). La séparation faits/hypothèses est portée par le schéma lui-même (`observations` vs `hypotheses`), de sorte qu'un agent développeur ne peut pas confondre un symptôme et une cause supposée.

## 6 bis. V1.1

- **Pipeline de sécurité visuelle** (`packages/privacy`) : OCR → détection → masquage irréversible → vérification par seconde lecture → transmission ; échec ⇒ rien n'est transmis à un fournisseur distant. L'OCR s'exécute côté serveur (là où l'image est envoyée au modèle) ; l'appareil applique les masques fixes.
- **Observation** : l'appareil applique le consentement (`/v1/observe/start|capture|stop`) ; le serveur (`observation.ts`) pilote la boucle, détecte les changements (diff + hash perceptuel), limite les analyses (budget, intervalle, backpressure, déduplication). Voir `docs/OBSERVATION.md`.
- **Images brutes** : `allowRawImages` (défaut `false`) ; sinon version assainie uniquement (`getSanitized`), y compris pour la ressource `agent-vision://captures/{id}` et `includeImage`.
- **Android** : application Compose (`android/`), appareil « push » ; observation périodique non prise en charge (accord humain à chaque capture).

## 7. Reste à faire

Windows Graphics Capture natif, macOS, iOS, Expo/React Native, captures événementielles et observation périodique, OCR local pour masquer les secrets directement dans les pixels sans dépendre du modèle, signature des rapports, empaquetage (service Windows, `systemd`).
