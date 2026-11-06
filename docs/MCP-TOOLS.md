# Outils MCP (V1.1)

Les quatre outils V1 (`capture_screen`, `analyze_screen`, `compare_screens`, `share_visual_report`) conservent leurs contrats. Sept outils s'y ajoutent. Les schémas stricts (zod) sont dans `packages/server/src/tools.ts` ; toute entrée hors schéma est rejetée par le SDK avant l'exécution.

Permissions par agent (`agents[].tools`) : par défaut les 4 outils V1 + `list_available_devices`, `get_device_capabilities`, `analyze_screen_region`. **Les outils d'observation (`start_observation`, `stop_observation`, `get_observation_status`, `get_visual_changes`) doivent être listés explicitement.**

| Outil | Entrées | Résultat / garanties |
|---|---|---|
| `list_available_devices` | — | Uniquement les appareils autorisés pour l'agent. |
| `get_device_capabilities` | `deviceId` | Capacités réelles (cibles, observation, consentement, TLS, en ligne). Appareil non autorisé = inexistant : même réponse `not_found`. |
| `analyze_screen_region` | `captureId`, `region` (0..1), `provider?`, `context?`, `expectation?` | Découpe la région dans l'image **assainie** puis l'analyse. Fail-closed avec un fournisseur distant. |
| `start_observation` | `deviceId`, `target`, `intervalSeconds`, `maxDurationSeconds`, `maxCaptures`, `changeThreshold`, `ignoreRegions`, `analyzeChanges`, `provider?`, `retentionSeconds`, `deleteOnStop` … | Exige le consentement local d'observation. Plafonds serveur et appareil. |
| `stop_observation` | `observationId` | Arrêt immédiat. |
| `get_observation_status` | `observationId` | État, compteurs, temps restant. |
| `get_visual_changes` | `observationId`, `sinceChangeId`, `limit` | Changements retenus (diff par régions + description). |

Images : `capture_screen(includeImage)` et la ressource `agent-vision://captures/{id}` renvoient la **version assainie** ; l'image brute n'est accessible qu'à un agent dont la politique porte `allowRawImages: true`.

Erreurs : `{ "error": code, "message" }` avec `isError: true`. Codes : `forbidden`, `not_found`, `bad_request`, `rate_limited`, `consent_required`, `consent_denied`, `capture_stopped`, `screen_locked`, `blank_or_protected`, `sanitization_failed`, `analysis_required`, `incomparable`, `timeout`, `backend_unavailable`, `capture_failed`.
