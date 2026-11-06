package org.agentvision.android.net

import android.util.Base64
import org.agentvision.android.core.CaptureRequest
import org.agentvision.android.core.PollParser
import org.agentvision.android.core.Validation
import org.agentvision.android.data.Settings
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.time.Instant
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

sealed class PollResult {
    data class Ok(val deviceId: String, val requests: List<CaptureRequest>) : PollResult()
    object Unauthorized : PollResult()
    data class Error(val message: String) : PollResult()
}

/**
 * Client de la passerelle. Si une empreinte est épinglée, SEUL le certificat feuille correspondant est accepté
 * (identité du serveur vérifiée) ; sinon, validation standard par les autorités du système.
 */
class ApiClient(private val s: Settings) {

    private fun open(path: String): HttpsURLConnection {
        val c = URL(s.serverUrl + path).openConnection() as HttpsURLConnection
        val pin = Validation.normalizeFingerprint(s.pinnedFingerprint)
        if (pin != null) {
            val tm = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = throw java.security.cert.CertificateException("no client auth")
                override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                    val got = Validation.sha256Hex(chain[0].encoded)
                    if (got != pin) throw java.security.cert.CertificateException("server certificate does not match the pinned fingerprint")
                }
                override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            }
            val ctx = SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(tm), SecureRandom()) }
            c.sslSocketFactory = ctx.socketFactory
            c.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true } // l'identité est portée par l'épinglage
        }
        return c
    }

    private fun post(path: String, body: JSONObject): Pair<Int, String> {
        val c = open(path)
        try {
            c.requestMethod = "POST"
            c.connectTimeout = 10_000
            c.readTimeout = 30_000
            c.doOutput = true
            c.setRequestProperty("authorization", "Bearer ${s.deviceToken}")
            c.setRequestProperty("content-type", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray()) }
            val code = c.responseCode
            val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""
            return code to text
        } finally {
            c.disconnect()
        }
    }

    fun poll(): PollResult = try {
        val (code, text) = post("/v1/device/poll", JSONObject())
        when {
            code == 401 -> PollResult.Unauthorized
            code != 200 -> PollResult.Error("HTTP $code")
            else -> PollResult.Ok(JSONObject(text).optString("deviceId"), PollParser.parse(text))
        }
    } catch (e: Exception) {
        PollResult.Error(e.javaClass.simpleName + (e.message?.let { ": $it" } ?: ""))
    }

    fun decline(requestId: String): Boolean = try {
        post("/v1/device/captures/$requestId", JSONObject().put("declined", true)).first == 200
    } catch (e: Exception) { false }

    fun upload(requestId: String, png: ByteArray): Boolean = try {
        val body = JSONObject()
            .put("capturedAt", Instant.now().toString())
            .put("pngBase64", Base64.encodeToString(png, Base64.NO_WRAP))
        post("/v1/device/captures/$requestId", body).first == 200
    } catch (e: Exception) { false }
}
