package org.agentvision.android.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import org.agentvision.android.core.Outcome
import org.agentvision.android.core.Validation
import org.agentvision.android.data.HistoryStore
import org.agentvision.android.data.Settings
import org.agentvision.android.service.AppState
import org.agentvision.android.service.Connection
import org.agentvision.android.service.PollService
import org.agentvision.android.service.ScreenCaptureService
import java.text.DateFormat
import java.util.Date

enum class Tab(val label: String) { HOME("Accueil"), PAIRING("Appairage"), CAPTURE("Capture"), HISTORY("Historique") }

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { AgentVisionTheme { AgentVisionApp() } }
    }
}

private fun fmt(t: Long?) = t?.let { DateFormat.getDateTimeInstance().format(Date(it)) } ?: "—"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentVisionApp() {
    val ctx = LocalContext.current
    var tab by remember { mutableStateOf(Tab.HOME) }
    Scaffold(
        topBar = { TopAppBar(title = { Text("Agent Vision") }) },
        bottomBar = {
            NavigationBar {
                Tab.values().forEach { t ->
                    NavigationBarItem(selected = tab == t, onClick = { tab = t }, label = { Text(t.label) }, icon = {})
                }
            }
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().padding(16.dp)) {
            when (tab) {
                Tab.HOME -> HomeScreen(ctx)
                Tab.PAIRING -> PairingScreen(ctx)
                Tab.CAPTURE -> CaptureScreen(ctx)
                Tab.HISTORY -> HistoryScreen(ctx)
            }
        }
    }
}

@Composable
private fun HomeScreen(ctx: Context) {
    val settings = remember { Settings(ctx) }
    val notifOk = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.verticalScroll(rememberScrollState())) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Serveur MCP", style = MaterialTheme.typography.titleMedium)
                Text(
                    when {
                        !settings.isPaired -> "Non appairé"
                        AppState.connection == Connection.CONNECTED -> "Connecté (${settings.deviceId.ifEmpty { "appareil" }})"
                        AppState.connection == Connection.UNAUTHORIZED -> "Jeton refusé"
                        AppState.connection == Connection.ERROR -> "Erreur : ${AppState.connectionDetail}"
                        else -> "Appairé, écoute inactive"
                    }
                )
            }
        }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Permissions et session", style = MaterialTheme.typography.titleMedium)
                Text("Notifications : " + if (notifOk) "accordées" else "non accordées")
                if (!notifOk && Build.VERSION.SDK_INT >= 33) Button(onClick = { permLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) }) { Text("Autoriser les notifications") }
                Text("Écoute des demandes : " + if (AppState.listening) "ACTIVE" else "arrêtée")
                Text("Capture en cours : " + if (AppState.captureActive) "OUI" else "non")
                Text("L'enregistrement d'écran est demandé à Android pour chaque capture.", style = MaterialTheme.typography.bodySmall)
            }
        }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("Dernière capture", style = MaterialTheme.typography.titleMedium)
                Text("${fmt(AppState.lastCaptureAt)} — ${AppState.lastCaptureAgent ?: "—"}")
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(enabled = settings.isPaired && !AppState.listening, onClick = { PollService.start(ctx) }) { Text("Activer l'écoute") }
            Button(colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error), onClick = { PollService.stop(ctx) }) { Text("ARRÊT IMMÉDIAT") }
        }
    }
}

@Composable
private fun PairingScreen(ctx: Context) {
    val settings = remember { Settings(ctx) }
    var url by remember { mutableStateOf(settings.serverUrl.ifEmpty { "https://" }) }
    var pin by remember { mutableStateOf(settings.pinnedFingerprint) }
    var token by remember { mutableStateOf("") }
    var msg by remember { mutableStateOf<String?>(null) }
    var paired by remember { mutableStateOf(settings.isPaired) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.verticalScroll(rememberScrollState())) {
        Text("Appairage sécurisé", style = MaterialTheme.typography.titleMedium)
        Text("Identifiant d'appareil : ${settings.deviceId.ifEmpty { "(connu après la première connexion)" }}")
        OutlinedTextField(url, { url = it }, label = { Text("Adresse de la passerelle (https://…)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(pin, { pin = it }, label = { Text("Empreinte SHA-256 du certificat du serveur") }, supportingText = { Text("Affichée par le serveur au démarrage. Vérifie l'identité du serveur.") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(token, { token = it }, label = { Text(if (paired) "Jeton (déjà enregistré)" else "Jeton d'appareil") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), singleLine = true)
        msg?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(onClick = {
            val err = Validation.serverUrlError(url)
            val fp = if (pin.isBlank()) "" else Validation.normalizeFingerprint(pin)
            when {
                err != null -> msg = err
                fp == null -> msg = "Empreinte invalide (64 caractères hexadécimaux)"
                token.isBlank() && !paired -> msg = "Jeton requis"
                else -> {
                    settings.serverUrl = Validation.normalizeUrl(url)
                    settings.pinnedFingerprint = fp
                    if (token.isNotBlank()) settings.deviceToken = token.trim()
                    token = ""; paired = true; msg = null
                }
            }
        }) { Text("Enregistrer l'appairage") }
        OutlinedButton(onClick = { settings.revoke(); PollService.stop(ctx); paired = false; token = ""; pin = ""; url = "https://"; msg = "Appairage révoqué localement. Retirez aussi l'appareil de la configuration du serveur." }) { Text("Révoquer l'appairage") }
    }
}

@Composable
private fun CaptureScreen(ctx: Context) {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        if (res.resultCode == Activity.RESULT_OK && res.data != null) {
            ctx.startForegroundService(Intent(ctx, ScreenCaptureService::class.java).putExtra("resultCode", res.resultCode).putExtra("data", res.data))
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.verticalScroll(rememberScrollState())) {
        Text("Capture manuelle (locale)", style = MaterialTheme.typography.titleMedium)
        Text("Android demandera votre consentement. L'image reste sur l'appareil (prévisualisation) et n'est jamais envoyée depuis cet écran.", style = MaterialTheme.typography.bodySmall)
        if (AppState.captureActive) Text("● SESSION DE CAPTURE ACTIVE", color = MaterialTheme.colorScheme.error)
        Button(enabled = !AppState.captureActive, onClick = { launcher.launch((ctx.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager).createScreenCaptureIntent()) }) { Text("Capturer maintenant") }
        AppState.preview?.let { bmp ->
            Image(bmp.asImageBitmap(), contentDescription = "Prévisualisation locale", modifier = Modifier.fillMaxWidth())
            OutlinedButton(onClick = { AppState.preview = null }) { Text("Supprimer la prévisualisation") }
        }
        Button(colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error), onClick = { PollService.stop(ctx) }) { Text("ARRÊT IMMÉDIAT") }
    }
}

@Composable
private fun HistoryScreen(ctx: Context) {
    val store = remember { HistoryStore(ctx) }
    var version by remember { mutableStateOf(0) }
    val entries = remember(version, AppState.historyVersion) { store.load() }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Text("Historique (${entries.size})", style = MaterialTheme.typography.titleMedium)
            OutlinedButton(onClick = { store.clear(); version++ }) { Text("Tout supprimer") }
        }
        Text("Seuls les métadonnées sont conservées (aucune image).", style = MaterialTheme.typography.bodySmall)
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(entries) { e ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) {
                        Text("${fmt(e.timestamp)} — ${e.agentId}")
                        Text(when (e.outcome) { Outcome.UPLOADED -> "Transmise"; Outcome.DECLINED -> "Refusée"; Outcome.FAILED -> "Échec"; Outcome.MANUAL -> "Locale" } + (e.detail?.let { " · $it" } ?: ""))
                        e.reason?.let { Text("Motif : $it", style = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
        }
    }
}
