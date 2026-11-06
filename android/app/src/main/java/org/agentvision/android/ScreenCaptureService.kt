package org.agentvision.android

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
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

/**
 * Capture d'UNE image via MediaProjection (API officielle), envoi, puis arrêt immédiat de la projection.
 * Le contenu protégé (FLAG_SECURE, DRM) est rendu noir par le système ; le serveur rejette alors la trame.
 */
class ScreenCaptureService : Service() {
    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val requestId = intent?.getStringExtra("requestId") ?: return stopNow()
        val resultCode = intent.getIntExtra("resultCode", 0)
        @Suppress("DEPRECATION") val data = intent.getParcelableExtra<Intent>("data") ?: return stopNow()

        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH, "Capture en cours", NotificationManager.IMPORTANCE_LOW))
        val n: Notification = NotificationCompat.Builder(this, CH)
            .setContentTitle("Capture d'écran en cours")
            .setSmallIcon(android.R.drawable.ic_menu_camera).setOngoing(true).build()
        startForeground(2, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)

        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val mp = mpm.getMediaProjection(resultCode, data)
        captureOnce(mp, requestId)
        return START_NOT_STICKY
    }

    private fun captureOnce(mp: MediaProjection, requestId: String) {
        val m = resources.displayMetrics
        val w = m.widthPixels
        val h = m.heightPixels
        val reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        val handler = Handler(Looper.getMainLooper())
        var display: VirtualDisplay? = null
        var done = false

        fun finish() {
            display?.release(); reader.close(); mp.stop()
            stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
        }

        // Android 14+ : un callback doit être enregistré AVANT createVirtualDisplay.
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { if (!done) { done = true; display?.release(); reader.close() } }
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
                val out = ByteArrayOutputStream()
                cropped.compress(Bitmap.CompressFormat.PNG, 100, out)
                val png = out.toByteArray()
                thread { runCatching { ApiClient(Settings(applicationContext)).upload(requestId, png) } }
            } finally {
                img.close()
                handler.post { finish() }
            }
        }, handler)

        display = mp.createVirtualDisplay("agent-vision", w, h, m.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.surface, null, handler)

        // garde-fou : on ne laisse jamais la projection ouverte plus de 10 s
        handler.postDelayed({ if (!done) { done = true; finish() } }, 10_000)
    }

    private fun stopNow(): Int { stopSelf(); return START_NOT_STICKY }

    companion object { private const val CH = "av_capture" }
}
