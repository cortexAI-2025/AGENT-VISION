package org.agentvision.android.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import org.agentvision.android.core.HistoryEntry
import org.agentvision.android.core.Outcome
import org.agentvision.android.data.HistoryStore
import org.agentvision.android.data.Settings
import org.agentvision.android.net.ApiClient
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

/**
 * Capture d'UNE image via MediaProjection (API officielle), envoi éventuel, puis arrêt immédiat de la projection.
 * Le contenu protégé (FLAG_SECURE) est rendu noir par le système ; il n'est jamais contourné.
 * requestId == null : capture manuelle locale (prévisualisation uniquement, rien n'est envoyé).
 */
class ScreenCaptureService : Service() {
    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val requestId = intent?.getStringExtra("requestId")
        val agent = intent?.getStringExtra("agentId") ?: "(manuel)"
        val reason = intent?.getStringExtra("reason")
        val resultCode = intent?.getIntExtra("resultCode", 0) ?: 0
        @Suppress("DEPRECATION") val data = intent?.getParcelableExtra<Intent>("data") ?: return stopNow()

        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH, "Capture en cours", NotificationManager.IMPORTANCE_LOW))
        val n: Notification = NotificationCompat.Builder(this, CH)
            .setContentTitle("Capture d'écran en cours")
            .setSmallIcon(android.R.drawable.ic_menu_camera).setOngoing(true).build()
        // Le service de premier plan (type mediaProjection) DOIT être actif avant getMediaProjection().
        startForeground(2, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        AppState.captureActive = true

        val mp = (getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager).getMediaProjection(resultCode, data)
        captureOnce(mp, requestId, agent, reason)
        return START_NOT_STICKY
    }

    private fun captureOnce(mp: MediaProjection, requestId: String?, agent: String, reason: String?) {
        val m = resources.displayMetrics
        val w = m.widthPixels
        val h = m.heightPixels
        val reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        val handler = Handler(Looper.getMainLooper())
        var display: VirtualDisplay? = null
        var done = false
        val history = HistoryStore(applicationContext)

        fun finish() {
            display?.release(); reader.close(); mp.stop()
            AppState.captureActive = false
            stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
        }
        fun record(o: Outcome, d: String?) {
            history.add(HistoryEntry(System.currentTimeMillis(), agent, reason, o, d)); AppState.historyVersion++
        }

        // Android 14+ : un callback doit être enregistré AVANT createVirtualDisplay.
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { if (!done) { done = true; display?.release(); reader.close(); AppState.captureActive = false } }
        }, handler)

        reader.setOnImageAvailableListener({ r ->
            if (done) return@setOnImageAvailableListener
            val img = r.acquireLatestImage() ?: return@setOnImageAvailableListener
            done = true
            try {
                val plane = img.planes[0]
                val rowPad = plane.rowStride - plane.pixelStride * w
                val bmp = Bitmap.createBitmap(w + rowPad / plane.pixelStride, h, Bitmap.Config.ARGB_8888)
                bmp.copyPixelsFromBuffer(plane.buffer)
                val cropped = Bitmap.createBitmap(bmp, 0, 0, w, h)
                AppState.lastCaptureAt = System.currentTimeMillis()
                AppState.lastCaptureAgent = agent
                if (requestId == null) {
                    AppState.preview = cropped
                    record(Outcome.MANUAL, "capture locale")
                } else {
                    val out = ByteArrayOutputStream()
                    cropped.compress(Bitmap.CompressFormat.PNG, 100, out)
                    val png = out.toByteArray()
                    thread {
                        val ok = ApiClient(Settings(applicationContext)).upload(requestId, png)
                        record(if (ok) Outcome.UPLOADED else Outcome.FAILED, if (ok) "transmise" else "échec de transmission ou image refusée par le serveur")
                    }
                }
            } finally {
                img.close()
                handler.post { finish() }
            }
        }, handler)

        display = mp.createVirtualDisplay("agent-vision", w, h, m.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.surface, null, handler)

        // garde-fou : la projection n'est jamais laissée ouverte plus de 10 s
        handler.postDelayed({ if (!done) { done = true; record(Outcome.FAILED, "délai dépassé"); finish() } }, 10_000)
    }

    private fun stopNow(): Int { stopSelf(); return START_NOT_STICKY }

    companion object { private const val CH = "av_capture" }
}
