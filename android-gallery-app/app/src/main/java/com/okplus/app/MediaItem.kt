package com.okplus.app

import android.net.Uri

data class MediaItem(
    val id: Long,
    val uri: Uri,
    val mimeType: String,
    val durationMs: Long,
    val album: String,
    val dateAdded: Long
) {
    val isVideo: Boolean get() = mimeType.startsWith("video/")
}
