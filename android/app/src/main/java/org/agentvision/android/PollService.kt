package org.agentvision.android

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
import kotlin.concurrent.thread

/**
 * Écoute les demandes de capture. La notification PERMANENTE est l'indicateur visible : tant qu'elle
 * est affichée, l'appareil peut recevoir des demandes — mais RIEN n'est capturé sans acceptation
 * explicite, à chaque demande, dans CaptureRequestActivity (+ dialogue système MediaProjection).
 */
class PollService : Service() {
    @Volatile private var running = false
    private val notified = HashSet<String>()

    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            running = false
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        ensureChannels()
        val stop = PendingIntent.getService(this, 0, Intent(this, PollService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val n: Notification = NotificationCompat.Builder(this, CH_ONGOING)
            .setContentTitle("Agent Vision actif")
            .setContentText("Des agents autorisés peuvent demander une capture — vous devrez accepter chaque demande.")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_delete, "Arrêter", stop)
            .build()
        startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        if (!running) {
            running = true
            thread(name = "av-poll") { loop() }
        }
        return START_STICKY
    }

    private fun loop() {
        val settings = Settings(this)
        val api = ApiClient(settings)
        while (running) {
            try {
                for (r in api.poll()) {
                    if (notified.add(r.requestId)) askUser(r)
                }
            } catch (_: Exception) { /* réseau indisponible : on réessaie */ }
            Thread.sleep(3_000)
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
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(pi).setFullScreenIntent(pi, true).setAutoCancel(true)
            .build()
        getSystemService(NotificationManager::class.java).notify(r.requestId.hashCode(), n)
    }

    private fun ensureChannels() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_ONGOING, "Agent Vision actif", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CH_REQUEST, "Demandes de capture", NotificationManager.IMPORTANCE_HIGH))
    }

    override fun onDestroy() { running = false; super.onDestroy() }

    companion object {
        const val ACTION_STOP = "org.agentvision.STOP"
        private const val CH_ONGOING = "av_ongoing"
        private const val CH_REQUEST = "av_request"
        fun start(c: Context) = c.startForegroundService(Intent(c, PollService::class.java))
        fun stop(c: Context) = c.startService(Intent(c, PollService::class.java).setAction(ACTION_STOP))
    }
}
