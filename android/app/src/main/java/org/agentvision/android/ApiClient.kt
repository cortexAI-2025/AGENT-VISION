package org.agentvision.android

import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

data class CaptureRequest(val requestId: String, val agentId: String, val target: String, val reason: String?)

/** Client minimal de la passerelle (POST /v1/device/poll, POST /v1/device/captures/{id}). */
class ApiClient(private val s: Settings) {

    private fun post(path: String, body: JSONObject): Pair<Int, String> {
        val c = URL(s.serverUrl + path).openConnection() as HttpURLConnection
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
    }

    fun poll(): List<CaptureRequest> {
        val (code, text) = post("/v1/device/poll", JSONObject())
        if (code != 200) return emptyList()
        val arr = JSONObject(text).getJSONArray("requests")
        return (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            CaptureRequest(o.getString("requestId"), o.getString("agentId"), o.getString("target"), o.optString("reason").ifEmpty { null })
        }
    }

    fun decline(requestId: String) {
        post("/v1/device/captures/$requestId", JSONObject().put("declined", true))
    }

    fun upload(requestId: String, png: ByteArray): Boolean {
        val body = JSONObject()
            .put("capturedAt", Instant.now().toString())
            .put("pngBase64", Base64.encodeToString(png, Base64.NO_WRAP))
        return post("/v1/device/captures/$requestId", body).first == 200
    }
}
