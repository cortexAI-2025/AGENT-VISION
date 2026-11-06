package org.agentvision.android

import android.content.Context

/** Appairage : URL de la passerelle du serveur Agent Vision (HTTPS) + jeton d'appareil. */
class Settings(ctx: Context) {
    private val p = ctx.getSharedPreferences("agent_vision", Context.MODE_PRIVATE)
    var serverUrl: String
        get() = p.getString("url", "") ?: ""
        set(v) = p.edit().putString("url", v.trim().trimEnd('/')).apply()
    var deviceToken: String
        get() = p.getString("token", "") ?: ""
        set(v) = p.edit().putString("token", v.trim()).apply()
    val isConfigured get() = serverUrl.startsWith("https://") && deviceToken.isNotEmpty()
}
