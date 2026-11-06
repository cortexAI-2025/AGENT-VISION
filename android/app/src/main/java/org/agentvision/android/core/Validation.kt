package org.agentvision.android.core

import java.security.MessageDigest

/** Logique pure (testable sans Android). */
object Validation {
    /** Seules les URL https:// d'hôte explicite sont acceptées (le clair est refusé). */
    fun serverUrlError(raw: String): String? {
        val u = raw.trim()
        if (!u.startsWith("https://")) return "L'adresse doit commencer par https://"
        val host = u.removePrefix("https://").substringBefore('/').substringBefore(':')
        if (host.isEmpty() || host.any { it.isWhitespace() }) return "Adresse invalide"
        return null
    }

    fun normalizeUrl(raw: String): String = raw.trim().trimEnd('/')

    /** Empreinte SHA-256 hexadécimale minuscule, sans séparateurs, depuis une saisie "AA:BB:..." ou "aabb...". */
    fun normalizeFingerprint(raw: String): String? {
        val f = raw.trim().replace(":", "").replace(" ", "").lowercase()
        return if (f.length == 64 && f.all { it in '0'..'9' || it in 'a'..'f' }) f else null
    }

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
