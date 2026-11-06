# Observation intelligente

Aucune observation périodique ne démarre sans **consentement local explicite, limité dans le temps et révocable**.

```
agent-vision-local grant-observation --agent tester --minutes 15 --max-captures 60 --min-interval-ms 5000
agent-vision-local revoke --agent tester     # révoque captures ET observation
agent-vision-local stop                      # arrêt immédiat (toutes les sessions)
```

## Qui applique quoi
- **Appareil** (point d'application) : grant d'observation valide, durée ≤ grant, captures ≤ grant, intervalle ≥ grant, une session par agent, arrêt d'urgence, révocation vérifiée à chaque capture, écran verrouillé et images noires refusés. Les sessions vivent en mémoire : un redémarrage les invalide ; les grants persistent sur disque.
- **Serveur** : plafonds (`observation.*`), isolation par agent, boucle de capture, détection de changements, budget d'analyses.

## Détection de changements
1. Image identique octet pour octet à la référence → comptée, non stockée.
2. Diff pixel (zones `ignoreRegions` masquées, p. ex. horloge) : sous `changeThreshold` → « mineure », non stockée, **la référence ne bouge pas** (une dérive lente finit par franchir le seuil).
3. Changement retenu : capture stockée, régions modifiées calculées, référence mise à jour.
4. Analyse IA seulement si `analyzeChanges` : déduplication par **hash perceptuel (dHash 64 bits)**, une analyse à la fois (**backpressure**), `maxAnalysesPerSession`, `minAnalysisIntervalMs`. Images passées par le pipeline OCR (fail-closed).
5. Nettoyage : `keepCaptures`, TTL (`retentionSeconds`), `deleteOnStop`.

Fin de session : `stopped`, `expired`, `exhausted`, `stopped_by_device`, `error` (3 échecs consécutifs).

## Limites
Observation non disponible sur les appareils Android « push » (chaque capture exige un accord humain). Les sessions serveur sont en mémoire (perdues au redémarrage du serveur ; la session locale expire d'elle-même).
