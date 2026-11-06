# Windows

## Mécanisme
Script PowerShell (encodé `-EncodedCommand`, cible validée en liste blanche) : GDI `Graphics.CopyFromScreen` pour l'écran virtuel (tous moniteurs, origine négative gérée), `PrintWindow(PW_RENDERFULLCONTENT)` pour la fenêtre au premier plan (repli `CopyFromScreen`). DPI per-monitor v2 avec repli system-aware. Aucun fichier temporaire (PNG en mémoire, base64 sur stdout) ; ressources GDI libérées.

## Garde-fous
Session verrouillée / bureau sécurisé (`OpenInputDesktop` inaccessible ou `LogonUI`) → `screen_locked`. Fenêtre minimisée ou absente → erreur. Image uniforme (DRM, `SetWindowDisplayAffinity`) → `blank_or_protected`. Erreurs PowerShell remontées de façon concise (jamais la commande encodée). Pas d'API d'entrée (test sur le script : ni `SendInput`, ni `SetCursorPos`…).

## Validation
- Tests unitaires du script/parseurs : exécutés sous Linux et Windows.
- `windows.integration.test.ts` (capture réelle) : exécuté **sur le runner GitHub `windows-latest`** (bureau virtuel). **Ce n'est pas un ordinateur physique** : multi-écrans réels, DPI mixtes, verrouillage réel, contenu DRM et UAC n'ont pas été validés sur matériel.

## Utilisation
```
node packages/local-agent/dist/cli.js init --device-id win-pc
node packages/local-agent/dist/cli.js start
node packages/local-agent/dist/cli.js grant --agent tester --minutes 30
node packages/local-agent/dist/cli.js stop
```
