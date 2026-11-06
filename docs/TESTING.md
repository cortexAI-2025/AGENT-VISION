# Tests

```
npm ci
npm run lint            # ESLint
npm run typecheck       # tsc, tous les paquets
npm test                # Vitest : unitaires, MCP en mémoire, HTTP, OCR réel, observation, sécurité
npm run test:x11        # Xvfb + openbox + xterm : capture réelle écran/fenêtre, refus, expiration
npm run test:windows    # Windows seulement : capture réelle (AGENT_VISION_WIN_TEST=1)
npm run audit:deps      # npm audit (production, niveau high)
cd android && ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```
Dépendances système X11 : `xvfb imagemagick x11-utils openbox xterm`.

## Couverture par risque
| Risque | Tests |
|---|---|
| OCR / masquage | `packages/privacy/test` (Tesseract réel sur images synthétiques, fail-closed simulé), `packages/server/test/privacy.test.ts` |
| Permissions / isolation / révocation | `tools.test.ts`, `v11-tools.test.ts`, `observation.test.ts` (autre agent, appareil non autorisé, politique modifiée à chaud) |
| Consentement / arrêt / expiration | `service.test.ts`, `http.test.ts`, `observe.test.ts`, `x11.integration.test.ts` |
| Redémarrage | `observe.test.ts` (sessions perdues, grants conservés) |
| Concurrence | `observe.test.ts` (verrou de capture), `v11-tools.test.ts` (agents parallèles), backpressure d'analyse |
| Entrées malformées | JSON invalide, corps trop gros, identifiants hostiles, schémas stricts |
| Échecs réseau / fournisseurs | `integration.test.ts` (HTTP 401 fournisseur, appareil injoignable, TLS épinglé), `observation.test.ts` (3 erreurs ⇒ `error`) |
| Android | tests JVM (`CoreTest.kt`) ; `androidTest` fournis **non exécutés** |

Les fixtures ne contiennent aucun secret réel (valeurs fictives). Aucun test n'est désactivé pour obtenir un CI vert ; les tests dépendant d'une plateforme sont ignorés explicitement hors de leur plateforme (X11, Windows).
