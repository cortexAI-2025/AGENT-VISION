package org.agentvision.android

import android.Manifest
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val s = Settings(this)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 96, 48, 48) }
        root.addView(TextView(this).apply {
            text = "Agent Vision — perception visuelle uniquement.\nAucun contrôle de l'appareil. Chaque capture demande votre accord."
        })
        val url = EditText(this).apply { hint = "https://serveur:7822"; setText(s.serverUrl); inputType = InputType.TYPE_TEXT_VARIATION_URI }
        val token = EditText(this).apply { hint = "Jeton d'appareil"; setText(s.deviceToken); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        root.addView(url); root.addView(token)
        root.addView(Button(this).apply {
            text = "Activer l'écoute"
            setOnClickListener {
                s.serverUrl = url.text.toString(); s.deviceToken = token.text.toString()
                if (!s.isConfigured) { text = "URL https:// et jeton requis"; return@setOnClickListener }
                if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
                PollService.start(this@MainActivity)
            }
        })
        root.addView(Button(this).apply { text = "Arrêter immédiatement"; setOnClickListener { PollService.stop(this@MainActivity) } })
        setContentView(root)
    }
}
