package org.agentvision.android.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.agentvision.android.core.HistoryCodec
import org.agentvision.android.core.HistoryEntry
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Chiffre le jeton d'appareil avec une clé AES-GCM non exportable du Keystore Android. */
private object SecretBox {
    private const val ALIAS = "agent_vision_token_key"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        g.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build()
        )
        return g.generateKey()
    }

    fun encrypt(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val ct = c.doFinal(plain.toByteArray())
        return Base64.encodeToString(c.iv + ct, Base64.NO_WRAP)
    }

    fun decrypt(blob: String): String? = try {
        val raw = Base64.decode(blob, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12)) }
        String(c.doFinal(raw, 12, raw.size - 12))
    } catch (e: Exception) {
        null
    }
}

/** Appairage : URL de la passerelle (HTTPS), empreinte TLS attendue du serveur, jeton d'appareil (chiffré). */
class Settings(ctx: Context) {
    private val p = ctx.applicationContext.getSharedPreferences("agent_vision", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = p.getString("url", "") ?: ""
        set(v) { p.edit().putString("url", v).apply() }

    /** SHA-256 du certificat du serveur (hex). Vide : validation par les autorités système. */
    var pinnedFingerprint: String
        get() = p.getString("pin", "") ?: ""
        set(v) { p.edit().putString("pin", v).apply() }

    var deviceId: String
        get() = p.getString("deviceId", "") ?: ""
        set(v) { p.edit().putString("deviceId", v).apply() }

    var deviceToken: String
        get() = p.getString("token", null)?.let { SecretBox.decrypt(it) } ?: ""
        set(v) { p.edit().putString("token", if (v.isEmpty()) null else SecretBox.encrypt(v)).apply() }

    val isPaired get() = serverUrl.isNotEmpty() && deviceToken.isNotEmpty()

    /** Révocation locale : oublie le serveur et le jeton. (La révocation côté serveur se fait dans sa configuration.) */
    fun revoke() { p.edit().clear().apply() }
}

class HistoryStore(ctx: Context) {
    private val p = ctx.applicationContext.getSharedPreferences("agent_vision_history", Context.MODE_PRIVATE)
    fun load(): List<HistoryEntry> = HistoryCodec.decode(p.getString("h", null))
    fun add(e: HistoryEntry) { p.edit().putString("h", HistoryCodec.encode(HistoryCodec.add(load(), e))).apply() }
    fun clear() { p.edit().clear().apply() }
}
