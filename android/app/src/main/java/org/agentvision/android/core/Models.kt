package org.agentvision.android.core

import org.json.JSONArray
import org.json.JSONObject

data class CaptureRequest(val requestId: String, val agentId: String, val target: String, val reason: String?)

object PollParser {
    /** Analyse défensive de la réponse du serveur : entrées invalides ignorées, jamais d'exception. */
    fun parse(json: String): List<CaptureRequest> = try {
        val arr: JSONArray = JSONObject(json).optJSONArray("requests") ?: JSONArray()
        (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val id = o.optString("requestId")
            val agent = o.optString("agentId")
            if (id.isEmpty() || agent.isEmpty() || !id.matches(Regex("[A-Za-z0-9_-]{4,64}"))) return@mapNotNull null
            CaptureRequest(id, agent.take(64), o.optString("target", "screen"), o.optString("reason").ifEmpty { null }?.take(300))
        }
    } catch (e: Exception) {
        emptyList()
    }
}

enum class Outcome { UPLOADED, DECLINED, FAILED, MANUAL }

data class HistoryEntry(val timestamp: Long, val agentId: String, val reason: String?, val outcome: Outcome, val detail: String?) {
    fun toJson(): JSONObject = JSONObject()
        .put("t", timestamp).put("a", agentId).put("r", reason ?: JSONObject.NULL)
        .put("o", outcome.name).put("d", detail ?: JSONObject.NULL)

    companion object {
        fun fromJson(o: JSONObject) = HistoryEntry(
            o.getLong("t"), o.getString("a"), if (o.isNull("r")) null else o.getString("r"),
            runCatching { Outcome.valueOf(o.getString("o")) }.getOrDefault(Outcome.FAILED),
            if (o.isNull("d")) null else o.getString("d"),
        )
    }
}

/** Historique borné (les plus récents d'abord). Aucune image n'y est conservée. */
object HistoryCodec {
    const val MAX = 100
    fun encode(list: List<HistoryEntry>): String = JSONArray(list.take(MAX).map { it.toJson() }).toString()
    fun decode(s: String?): List<HistoryEntry> = try {
        val a = JSONArray(s ?: "[]")
        (0 until a.length()).map { HistoryEntry.fromJson(a.getJSONObject(it)) }
    } catch (e: Exception) {
        emptyList()
    }
    fun add(list: List<HistoryEntry>, e: HistoryEntry) = (listOf(e) + list).take(MAX)
}
