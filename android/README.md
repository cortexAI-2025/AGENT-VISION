# Agent Vision — prototype Android

⚠️ **Non compilé et non exécuté** dans l'environnement de développement actuel (pas de SDK Android). À ouvrir dans Android Studio (AGP 8.7, Kotlin 2.0, minSdk 26, targetSdk 35) et à tester sur un appareil réel avant tout usage.

Rôle : appareil « push ». Côté serveur : `{"kind":"push","id":"pixel","platform":"android","tokenSha256":"<sha256 du jeton>"}` et la passerelle exposée en **HTTPS** (l'appli refuse `http://`).

Flux : `PollService` (notification permanente = indicateur visible) → `POST /v1/device/poll` → demande d'un agent → notification → `CaptureRequestActivity` (agent + motif, **Autoriser / Refuser**) → dialogue système MediaProjection → `ScreenCaptureService` (service de premier plan `mediaProjection`, **une** image) → `POST /v1/device/captures/{id}` → arrêt immédiat de la projection.

Respect des contraintes MediaProjection : consentement utilisateur à chaque session, jeton non réutilisé, service de premier plan de type `mediaProjection` démarré avant `getMediaProjection()`, callback enregistré avant `createVirtualDisplay()` (Android 14+). Aucune permission d'accessibilité, aucune injection d'événements. `FLAG_SECURE` est respecté par le système (image noire, rejetée par le serveur).

Limites du prototype : un seul écran, pas de capture de fenêtre, pas de Keystore pour le jeton, pas d'épinglage de certificat, pas de tests instrumentés.
