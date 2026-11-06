# OCR local et confidentialité visuelle

## Pipeline
1. Capture sur l'appareil, masques fixes (`maskRegions`) appliqués.
2. Le serveur reçoit l'image ; avant toute transmission à un modèle, **OCR local** (Tesseract via `tesseract.js`, modèle anglais embarqué par `@tesseract.js-data/eng` : aucun téléchargement, aucun service distant).
3. Détection par motifs sur le texte de chaque ligne : e-mails, téléphones, clés d'API (`sk-…`, AWS, GitHub, Google, Slack), JWT, jetons Bearer, `password=`/`token=`, identifiants de session, IBAN, cartes (Luhn), motifs utilisateur (`privacy.customLiterals`, `customRegexes`), et heuristique de chaînes à forte entropie.
4. Calcul des boîtes des mots concernés, **masquage noir irréversible** (marge 3 px).
5. **Vérification** : pixels masqués noirs + seconde lecture OCR de l'image masquée ; un secret encore lisible ⇒ échec.
6. Transmission de l'image assainie.

## Politique fail-closed
- OCR en erreur / timeout / vérification échouée + **fournisseur distant** ⇒ `sanitization_failed`, **rien n'est transmis**.
- Même cas avec un fournisseur **local** (`local: true`) : l'analyse locale reste possible mais aucune version « partageable » n'est créée.
- `privacy.ocr: "off"` désactive le pipeline : choix explicite de l'opérateur, consigné dans le rapport (`privacy.ocr.status = "off"`).

## Limites (importantes)
- L'OCR n'est **pas une garantie** : texte très petit, stylisé, faible contraste, rotation, langues non latines, QR codes, images/captures imbriquées, secrets hors motifs peuvent échapper à la détection. Les masques fixes et les `allowedAgents`/`providers` restent la première ligne de défense.
- Modèle anglais seul (caractères latins courants) ; pas de prétraitement d'agrandissement : le texte inférieur à ~10 px est mal lu.
- Coût : quelques secondes par image (WASM, CPU).
- Les journaux ne contiennent ni image ni texte détecté (seulement les types détectés).
- Les fixtures de test (`packages/privacy/test/fixtures`) sont synthétiques : aucun secret réel.
