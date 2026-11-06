# Exemple : testeur → développeur → vérification

Côté utilisateur (une fois) :
```
agent-vision-local grant --agent tester --minutes 30
```

Agent « tester » (outils MCP) :
1. `capture_screen {"deviceId":"win-pc","reason":"Vérifier la page de connexion"}` → `captureId: cap_A`
2. `analyze_screen {"captureId":"cap_A","expectation":"Le tableau de bord s'affiche"}` → observations + hypothèses
3. `share_visual_report {"captureId":"cap_A","toAgent":"developer","note":"Le login échoue"}` → `reportId`

Agent « developer » : lit `agent-vision://inbox`, puis `agent-vision://reports/{id}` (image masquée comprise).
Après correction, « tester » refait `capture_screen` → `cap_B`, puis
`compare_screens {"beforeCaptureId":"cap_A","afterCaptureId":"cap_B","describe":true,"expectation":"Le tableau de bord s'affiche"}`.
