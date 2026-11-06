package org.agentvision.android.service

import android.graphics.Bitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

enum class Connection { UNKNOWN, CONNECTED, UNAUTHORIZED, ERROR }

/** État observable par l'UI. Aucune persistance : la prévisualisation reste en mémoire. */
object AppState {
    var listening by mutableStateOf(false)
    var connection by mutableStateOf(Connection.UNKNOWN)
    var connectionDetail by mutableStateOf<String?>(null)
    var captureActive by mutableStateOf(false)
    var lastCaptureAt by mutableStateOf<Long?>(null)
    var lastCaptureAgent by mutableStateOf<String?>(null)
    var preview by mutableStateOf<Bitmap?>(null)
    var historyVersion by mutableStateOf(0)
}
