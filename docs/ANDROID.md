# Application Android « Agent Vision »

Kotlin, Jetpack Compose, Material 3. minSdk 29 (Android 10 — **à valider sur appareil**), targetSdk 35. Recette visée : Samsung Galaxy A14.

## État de validation
- ✅ Compilation, 13 tests unitaires JVM, Android Lint, APK debug : exécutés (local et CI).
- ❌ **Jamais exécutée sur un appareil ni un émulateur** : consentement MediaProjection, services de premier plan, rendu des écrans, tests instrumentés (`androidTest`, fournis mais non lancés) et recette Galaxy A14 restent **à faire**.

## Écrans
Accueil (connexion, permissions, session, dernière capture, **arrêt immédiat**) · Appairage (URL HTTPS, empreinte TLS épinglée, jeton chiffré Keystore, identifiant d'appareil, révocation locale) · Capture (capture manuelle, prévisualisation locale, indicateur de session) · Historique (métadonnées, suppression).

## Sécurité
- HTTPS obligatoire (`usesCleartextTraffic=false`) ; épinglage optionnel du certificat feuille (SHA-256) = vérification d'identité du serveur.
- Jeton d'appareil chiffré AES-GCM par une clé non exportable du Keystore. Pas de sauvegarde cloud.
- Chaque demande d'agent : notification → écran d'accord → dialogue système MediaProjection. Aucun jeton de projection réutilisé ; projection fermée juste après l'unique image (garde-fou 10 s).
- `FLAG_SECURE` : le système fournit une image noire, jamais contournée ; le serveur la rejette.
- Aucun AccessibilityService, aucune superposition, aucune injection d'événements.
- Android 15 : callback `onTimeout` du service `dataSync` ; Android 14 : callback MediaProjection avant `createVirtualDisplay`.
- Limite : « révocation » côté appareil = oubli local ; la révocation côté serveur consiste à retirer l'appareil de la configuration. Le résultat d'analyse n'est pas renvoyé à l'appli (l'historique montre l'état de transmission).

## Installation sur Galaxy A14
1. Télécharger l'artefact `agent-vision-debug-apk` du workflow **Android** (onglet Actions).
2. Sur le téléphone : Paramètres → Sécurité → « Installer des applications inconnues » pour le navigateur/gestionnaire de fichiers. Ou `adb install -r app-debug.apk` (débogage USB).
3. Serveur : appareil `{"kind":"push","id":"a14","platform":"android","tokenSha256":"<sha256 du jeton>"}` ; passerelle exposée en **HTTPS** (`gateway.tls`), empreinte du certificat à saisir dans l'appli.
4. Appli → Appairage → Enregistrer → Accueil → « Activer l'écoute » ; accepter les notifications.
5. Un agent appelle `capture_screen` → accepter dans l'appli puis dans la boîte de dialogue système.

Compilation locale : `cd android && ./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug` (SDK Android 35 requis).
