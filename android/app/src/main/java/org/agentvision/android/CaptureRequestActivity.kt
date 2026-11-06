package org.agentvision.android

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import kotlin.concurrent.thread

/**
 * Consentement humain pour UNE capture. Deux niveaux : (1) cet écran « Autoriser / Refuser »
 * qui décrit l'agent et le motif ; (2) la boîte de dialogue système MediaProjection.
 * Aucun jeton MediaProjection n'est conservé ni réutilisé : chaque demande repasse par ici.
 */
class CaptureRequestActivity : AppCompatActivity() {
    private lateinit var requestId: String

    private val projection = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        if (res.resultCode == Activity.RESULT_OK && res.data != null) {
            // Le service de premier plan (type mediaProjection) DOIT être démarré avant getMediaProjection().
            startForegroundService(
                Intent(this, ScreenCaptureService::class.java)
                    .putExtra("requestId", requestId)
                    .putExtra("resultCode", res.resultCode)
                    .putExtra("data", res.data)
            )
        } else {
            decline()
        }
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestId = intent.getStringExtra("requestId") ?: return finish()
        val agent = intent.getStringExtra("agentId") ?: "?"
        val reason = intent.getStringExtra("reason")

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 96, 48, 48)
        }
        layout.addView(TextView(this).apply {
            textSize = 18f
            text = "L'agent « $agent » demande une capture de votre écran.\n" +
                (reason?.let { "Motif : $it\n" } ?: "") +
                "\nAucune action ne sera effectuée sur l'appareil. Le système vous demandera une dernière confirmation."
        })
        layout.addView(Button(this).apply {
            text = "Autoriser cette capture"
            setOnClickListener {
                val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                projection.launch(mpm.createScreenCaptureIntent())
            }
        })
        layout.addView(Button(this).apply {
            text = "Refuser"
            setOnClickListener { decline(); finish() }
        })
        setContentView(layout)
    }

    private fun decline() {
        val id = requestId
        thread { runCatching { ApiClient(Settings(applicationContext)).decline(id) } }
    }
}
