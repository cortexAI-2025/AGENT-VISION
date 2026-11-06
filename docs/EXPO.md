# Observer une application Expo / React Native

Agent Vision **observe et analyse uniquement** : il ne pilote ni Expo, ni l'application, ni l'appareil (pas de tap, pas de saisie, pas de navigation). L'utilisateur ou le développeur navigue lui-même ; l'agent regarde.

## Mise en place
1. Téléphone Android avec l'app Agent Vision appairée (voir `ANDROID.md`), application Expo ouverte (Expo Go ou build de développement).
2. Agent MCP (stdio ou HTTP) avec `devices: ["a14"]`.

## Scénario
```
capture_screen   {"deviceId":"a14","reason":"Vérifier l'écran Profil"}      → accepter sur le téléphone
analyze_screen   {"captureId":"cap_…","context":"Expo SDK 52, écran Profil, FR","expectation":"Le nom complet est visible sans troncature, bouton Enregistrer visible"}
```
Le rapport sépare **observations** (texte tronqué, bouton hors cadre, débordement, contraste faible, erreur rouge Expo) et **hypothèses** (p. ex. `numberOfLines` trop bas, `flexShrink` manquant). Après correction (rechargement à chaud) :
```
capture_screen   → cap_B
compare_screens  {"beforeCaptureId":"cap_A","afterCaptureId":"cap_B","describe":true,"expectation":"…"}
analyze_screen_region {"captureId":"cap_B","region":{"x":0,"y":0.8,"width":1,"height":0.2}}   # barre d'onglets
```
Comparer des écrans entre versions : une capture par version, `compare_screens` (mêmes dimensions requises). Sur Android la capture est ponctuelle (accord humain à chaque fois) ; l'observation périodique d'un téléphone n'est pas prise en charge en V1.1.

## Ce qui est détecté
Le moteur est un modèle multimodal : texte tronqué/débordant, éléments invisibles ou masqués, mises en page cassées, incohérences entre écrans, contraste suspect, écran après navigation. Ce sont des **observations d'un modèle** : à confirmer ; le contraste n'est pas mesuré en WCAG par calcul de pixels.
