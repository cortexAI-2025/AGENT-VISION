package org.agentvision.android.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import org.agentvision.android.core.CaptureRequest
import org.agentvision.android.data.Settings
import org.agentvision.android.net.ApiClient
import org.agentvision.android.net.PollResult
import org.agentvision.android.ui.CaptureRequestActivity
import kotlin.concurrent.thread

/**
 * Écoute les demandes de capture. La notification PERMANENTE est l'indicateur visible. Rien n'est capturé sans
 * acceptation explicite à chaque demande (CaptureRequestActivity + boîte de dialogue système MediaProjection).
 */
class PollService : Service() {
    @Volatile private var running = false
    private val notified = HashSet<String>()

    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            shutdown()
            return START_NOT_STICKY
        }
        ensureChannels()
        val stop = PendingIntent.getService(this, 0, Intent(this, PollService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val n: Notification = NotificationCompat.Builder(this, CH_ONGOING)
            .setContentTitle("Agent Vision actif")
            .setContentText("Les agents autorisés peuvent demander une capture. Chaque demande requiert votre accord.")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_delete, "Arrêter", stop)
            .build()
        startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        AppState.listening = true
        if (!running) {
            running = true
            thread(name = "av-poll") { loop() }
        }
        return START_NOT_STICKY
    }

    /** Android 15 : les services dataSync ont une durée maximale ; on s'arrête proprement. */
    override fun onTimeout(startId: Int, fgsType: Int) = shutdown()

    private fun shutdown() {
        running = false
        AppState.listening = false
        AppState.connection = Connection.UNKNOWN
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun loop() {
        val settings = Settings(this)
        val api = ApiClient(settings)
        while (running) {
            when (val r = api.poll()) {
                is PollResult.Ok -> {
                    AppState.connection = Connection.CONNECTED
                    AppState.connectionDetail = null
                    if (settings.deviceId != r.deviceId && r.deviceId.isNotEmpty()) settings.deviceId = r.deviceId
                    for (req in r.requests) if (notified.add(req.requestId)) askUser(req)
                }
                is PollResult.Unauthorized -> { AppState.connection = Connection.UNAUTHORIZED; AppState.connectionDetail = "Jeton refusé (appairage révoqué ?)" }
                is PollResult.Error -> { AppState.connection = Connection.ERROR; AppState.connectionDetail = r.message }
            }
            try { Thread.sleep(3_000) } catch (_: InterruptedException) { break }
        }
    }

    private fun askUser(r: CaptureRequest) {
        val i = Intent(this, CaptureRequestActivity::class.java)
            .putExtra("requestId", r.requestId).putExtra("agentId", r.agentId)
            .putExtra("target", r.target).putExtra("reason", r.reason)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = PendingIntent.getActivity(this, r.requestId.hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(this, CH_REQUEST)
            .setContentTitle("Demande de capture d'écran")
            .setContentText("L'agent « ${r.agentId} » demande une capture${r.reason?.let { " : $it" } ?: ""}")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pi).setAutoCancel(true)
            .build()
        getSystemService(NotificationManager::class.java).notify(r.requestId.hashCode(), n)
    }

    private fun ensureChannels() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_ONGOING, "Agent Vision actif", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CH_REQUEST, "Demandes de capture", NotificationManager.IMPORTANCE_HIGH))
    }

    override fun onDestroy() { running = false; AppState.listening = false; super.onDestroy() }

    companion object {
        const val ACTION_STOP = "org.agentvision.STOP"
        private const val CH_ONGOING = "av_ongoing"
        private const val CH_REQUEST = "av_request"
        fun start(c: Context) = c.startForegroundService(Intent(c, PollService::class.java))
        fun stop(c: Context) = c.startService(Intent(c, PollService::class.java).setAction(ACTION_STOP))
    }
}
