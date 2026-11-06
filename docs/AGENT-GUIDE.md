# Guide de connexion pour agents compatibles MCP

Agent Vision est indépendant du modèle : tout client MCP (Claude Desktop / Claude Code, Cursor, clients GPT, Gemini, DeepSeek, Grok, frameworks d'agents…) peut s'y connecter.

## Configuration côté serveur
1. `node packages/server/dist/cli.js new-token` → donne un **jeton** (à l'agent) et son **sha256** (à mettre dans `agents[].tokenSha256`).
2. Déclarer pour cet agent : `devices`, `providers`, `shareTo`, éventuellement `tools` (sinon les 4).
3. Sur l'appareil, l'utilisateur exécute `agent-vision-local grant --agent <id de l'agent>`.

## stdio (client local)
Voir [examples/mcp-client-stdio.json](../examples/mcp-client-stdio.json). Le jeton va dans `AGENT_VISION_AGENT_TOKEN`.

## HTTP (client distant ou plusieurs agents)
`node packages/server/dist/cli.js start --transport http` puis voir [examples/mcp-client-http.json](../examples/mcp-client-http.json). Hors loopback, activer TLS dans `gateway.tls`.

## Utilisation conseillée
1. `capture_screen` (`reason` clair : il est montré à l'utilisateur).
2. `analyze_screen` avec `context` et `expectation`. Lire **séparément** `observations` (faits) et `hypotheses` (à vérifier).
3. `share_visual_report` vers l'agent suivant ; celui-ci lit `agent-vision://inbox`.
4. Après correction : nouvelle capture puis `compare_screens` (`describe: true` pour une description sémantique).

Si un outil répond `consent_required` : demander à l'utilisateur d'exécuter la commande `grant` ; ne pas réessayer en boucle. `capture_stopped` : l'utilisateur a arrêté la capture, respecter cette décision.

## V1.1
- Découvrir : `list_available_devices`, puis `get_device_capabilities`.
- Observer : l'utilisateur lance `grant-observation` ; l'agent appelle `start_observation` (liste explicite dans `tools`), lit `get_visual_changes` avec `sinceChangeId`, et appelle `stop_observation` à la fin. `consent_required` ⇒ demander la commande à l'utilisateur, ne pas boucler.
- Détail d'une zone : `analyze_screen_region`.
- Les images renvoyées sont assainies ; une image brute exige `allowRawImages` dans la politique de l'agent.
- Expo / React Native : voir `EXPO.md`.
