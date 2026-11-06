# Checklist de publication

- [ ] `npm run lint`, `typecheck`, `npm test`, `test:x11` verts ; `audit:deps` sans vulnérabilité haute.
- [ ] Workflows CI **CI**, **Android**, **Windows** verts ; APK debug téléchargé.
- [ ] Recette physique **Windows** (écran, fenêtre, multi-écrans, verrouillage, arrêt) — non couverte par la CI.
- [ ] Recette physique **Android** (Galaxy A14 : Android 13/14 ; Android 15 si possible) : appairage, consentement, FLAG_SECURE, arrêt, notification permanente.
- [ ] Recette **Wayland** (GNOME/KDE) via portail.
- [ ] Test avec un fournisseur réel (clé de test) : forme de requêtes et de réponses.
- [ ] Vérifier qu'aucun secret ni image brute n'apparaît dans les journaux et l'audit.
- [ ] Relire `docs/SECURITY.md` (limites) ; mettre à jour `README.md` (état réel).
- [ ] Signer l'APK de release (la CI ne produit qu'un APK debug).
- [ ] Étiqueter la version ; ne pas fusionner sans revue.
