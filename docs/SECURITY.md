# Sécurité et confidentialité

## Exigences et mise en œuvre

| Exigence | Mise en œuvre | Test |
|---|---|---|
| Consentement explicite | Grant local à durée limitée, par agent **et** par cible, ou dialogue par capture (`consentMode: "prompt"`) ; Android : accord à chaque demande + dialogue système | `service.test.ts`, `http.test.ts` |
| Aucune capture clandestine | Notification/log à chaque capture ; journal local `capture-log.jsonl` ; notification permanente Android | `service.test.ts` (indicateur), e2e |
| Aucun accès souris/clavier/tactile | Aucune API d'entrée n'est exposée ni utilisée ; manifeste Android sans accessibilité | revue de code |
| Pas d'écran verrouillé / protégé | Contrôle `LogonUI`/`loginctl LockedHint` avant capture ; image uniforme rejetée (agent **et** serveur) | `service.test.ts`, `integration.test.ts` |
| Chiffrement | HTTPS/TLS ≥ 1.2 ; écoute hors loopback refusée sans TLS ; HTTP clair vers hôte distant refusé ; épinglage de certificat | `integration.test.ts` (TLS), `http.test.ts` |
| Permissions par appareil et par agent | `devices`, `tools`, `providers`, `shareTo` dans la config | `tools.test.ts` |
| Rétention configurable / suppression | `retention.*`, purge, `deleteAfter`, `DELETE /admin/captures/{id}` | `tools.test.ts`, `integration.test.ts` |
| Pas de cloud obligatoire | Stockage disque local ; fournisseur local (`local: true`, Ollama…) possible | — |
| Secrets, tokens, données personnelles | (1) masques fixes configurables côté appareil ; (2) le modèle signale les zones sensibles, elles sont **noircies** dans la version partageable ; (3) détection par motifs dans tous les textes (sortie du modèle, titres de fenêtre, contexte, notes) ; (4) un destinataire ne reçoit jamais l'original | `core.test.ts`, `tools.test.ts` |
| Authentification des agents | Jeton par agent (SHA-256 stocké, temps constant) ; identité liée à la session MCP | `integration.test.ts` |
| Journal d'audit | JSONL chaîné par hachage (`audit-verify`), accès autorisés **et** refusés, jamais d'image ni de secret | `core.test.ts`, `tools.test.ts` |

## Limites connues (à lire)

- **Le masquage de pixels dépend du modèle d'analyse** : une zone sensible que le modèle ne signale pas n'est pas noircie. Seuls les `maskRegions` fixes sont déterministes. Sans OCR local, `analyze_screen` n'est pas une garantie : traiter les images comme potentiellement sensibles. Une image n'est partageable qu'après analyse, mais l'analyse n'est pas infaillible.
- L'image **brute** va, par `analyze_screen`, au fournisseur choisi (cloud ou local) : n'autoriser dans `providers` que des fournisseurs acceptables pour les données visées. Le propriétaire de la capture peut lire l'original (c'est l'agent que l'utilisateur a autorisé).
- Le journal d'audit est **détectable en cas d'altération**, pas inviolable : quelqu'un ayant l'accès en écriture peut recalculer toute la chaîne. Pour plus de garanties, exporter vers un stockage en ajout seul.
- Le jeton d'appareil Android est stocké dans les préférences privées de l'application (pas de Keystore dans ce prototype).
- Sous X11, l'OS n'impose aucun consentement : seul celui d'Agent Vision protège.
- Un utilisateur local malveillant (même compte) peut lire `consent.json` ou la config : le modèle de menace vise les agents distants, pas le propriétaire de la machine.
- Les textes affichés dans les captures peuvent contenir des instructions (injection de prompt visuelle) : le prompt du moteur les traite comme des données, ce qui réduit mais n'élimine pas le risque ; les sorties du moteur doivent être traitées comme non fiables par les agents consommateurs.

## Signaler une vulnérabilité

Ouvrir un avis de sécurité privé sur le dépôt plutôt qu'une issue publique.
