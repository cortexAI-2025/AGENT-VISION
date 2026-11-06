package org.agentvision.android

import org.agentvision.android.core.HistoryCodec
import org.agentvision.android.core.HistoryEntry
import org.agentvision.android.core.Outcome
import org.agentvision.android.core.PollParser
import org.agentvision.android.core.Validation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class ValidationTest {
    @Test fun rejectsCleartext() { assertNotNull(Validation.serverUrlError("http://srv:7822")) }
    @Test fun rejectsEmptyHost() { assertNotNull(Validation.serverUrlError("https://")); assertNotNull(Validation.serverUrlError("https:// x")) }
    @Test fun acceptsHttps() { assertNull(Validation.serverUrlError("https://srv.example:7822/")) }
    @Test fun normalizesUrl() { assertEquals("https://a.b", Validation.normalizeUrl(" https://a.b/ ")) }
    @Test fun fingerprintFormats() {
        val hex = "ab".repeat(32)
        assertEquals(hex, Validation.normalizeFingerprint(hex.chunked(2).joinToString(":").uppercase()))
        assertNull(Validation.normalizeFingerprint("abc"))
        assertNull(Validation.normalizeFingerprint("zz".repeat(32)))
    }
    @Test fun sha256KnownVector() {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", Validation.sha256Hex("abc".toByteArray()))
    }
}

class PollParserTest {
    @Test fun parsesValidRequest() {
        val r = PollParser.parse("""{"deviceId":"d","requests":[{"requestId":"req_abc123","agentId":"tester","target":"screen","reason":"test"}]}""")
        assertEquals(1, r.size); assertEquals("tester", r[0].agentId); assertEquals("test", r[0].reason)
    }
    @Test fun ignoresMalformedEntries() {
        val r = PollParser.parse("""{"requests":[{"agentId":"x"},{"requestId":"../../etc","agentId":"x"},42,null]}""")
        assertEquals(0, r.size)
    }
    @Test fun survivesGarbage() {
        assertEquals(0, PollParser.parse("not json").size)
        assertEquals(0, PollParser.parse("{}").size)
    }
    @Test fun truncatesLongReason() {
        val r = PollParser.parse("""{"requests":[{"requestId":"req_abcd","agentId":"a","reason":"${"x".repeat(1000)}"}]}""")
        assertEquals(300, r[0].reason!!.length)
    }
}

class HistoryTest {
    @Test fun roundTrip() {
        val e = HistoryEntry(1L, "tester", "why", Outcome.UPLOADED, null)
        val back = HistoryCodec.decode(HistoryCodec.encode(listOf(e)))
        assertEquals(listOf(e), back)
    }
    @Test fun boundedAndNewestFirst() {
        var l = emptyList<HistoryEntry>()
        for (i in 1..150) l = HistoryCodec.add(l, HistoryEntry(i.toLong(), "a", null, Outcome.DECLINED, null))
        assertEquals(HistoryCodec.MAX, l.size); assertEquals(150L, l[0].timestamp)
    }
    @Test fun corruptedStorageGivesEmpty() { assertEquals(0, HistoryCodec.decode("{{{").size) }
}
