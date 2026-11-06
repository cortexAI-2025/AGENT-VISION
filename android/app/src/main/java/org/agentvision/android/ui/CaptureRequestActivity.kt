package org.agentvision.android.ui

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.agentvision.android.core.HistoryEntry
import org.agentvision.android.core.Outcome
import org.agentvision.android.data.HistoryStore
import org.agentvision.android.data.Settings
import org.agentvision.android.net.ApiClient
import org.agentvision.android.service.AppState
import org.agentvision.android.service.ScreenCaptureService
import kotlin.concurrent.thread

/**
 * Consentement humain pour UNE capture, à chaque demande : (1) cet écran décrit l'agent et le motif ;
 * (2) la boîte de dialogue système MediaProjection. Aucun jeton MediaProjection n'est conservé ni réutilisé.
 */
class CaptureRequestActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val requestId = intent.getStringExtra("requestId") ?: return finish()
        val agent = intent.getStringExtra("agentId") ?: "?"
        val reason = intent.getStringExtra("reason")
        setContent {
            AgentVisionTheme {
                val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
                    if (res.resultCode == Activity.RESULT_OK && res.data != null) {
                        startForegroundService(
                            Intent(this, ScreenCaptureService::class.java)
                                .putExtra("requestId", requestId).putExtra("agentId", agent).putExtra("reason", reason)
                                .putExtra("resultCode", res.resultCode).putExtra("data", res.data)
                        )
                    } else decline(requestId, agent, reason)
                    finish()
                }
                RequestScreen(agent, reason,
                    onAllow = {
                        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                        launcher.launch(mpm.createScreenCaptureIntent())
                    },
                    onDeny = { decline(requestId, agent, reason); finish() })
            }
        }
    }

    private fun decline(requestId: String, agent: String, reason: String?) {
        val app = applicationContext
        thread {
            ApiClient(Settings(app)).decline(requestId)
            HistoryStore(app).add(HistoryEntry(System.currentTimeMillis(), agent, reason, Outcome.DECLINED, "refusée par l'utilisateur"))
            AppState.historyVersion++
        }
    }
}

@Composable
private fun RequestScreen(agent: String, reason: String?, onAllow: () -> Unit, onDeny: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp, androidx.compose.ui.Alignment.CenterVertically)) {
        Text("Demande de capture d'écran", style = MaterialTheme.typography.headlineSmall)
        Text("L'agent « $agent » demande une capture de votre écran.")
        if (reason != null) Text("Motif : $reason")
        Text("Aucune action ne sera effectuée sur l'appareil. Android vous demandera une dernière confirmation.", style = MaterialTheme.typography.bodySmall)
        Button(onClick = onAllow) { Text("Autoriser cette capture") }
        OutlinedButton(onClick = onDeny) { Text("Refuser") }
    }
}
