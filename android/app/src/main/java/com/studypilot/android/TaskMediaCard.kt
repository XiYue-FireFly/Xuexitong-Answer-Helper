package com.studypilot.android

import android.app.Notification
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Bundle

/** Explicitly opted-in compatibility surface; never plays audio or takes audio focus. */
class TaskMediaCard(private val context: Context, private val control: (Boolean) -> Unit) {
    private var session: MediaSession? = null
    private var canPause = false
    private val artwork by lazy {
        val drawable = context.getDrawable(R.mipmap.ic_launcher)!!
        Bitmap.createBitmap(192, 192, Bitmap.Config.ARGB_8888).also { bitmap ->
            drawable.setBounds(0, 0, bitmap.width, bitmap.height); drawable.draw(Canvas(bitmap))
        }
    }
    fun apply(notification: Notification, status: Bundle): Notification {
        canPause = status.getBoolean("canPause")
        val activeSession = session ?: MediaSession(context, "StudyPilotTaskProgress").apply {
            setSessionActivity(TaskStatusService.openTask(context))
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() { if (canPause) control(false) }
                override fun onPause() { if (canPause) control(true) }
                // A task's completion count cannot be scrubbed or skipped.
            })
            isActive = true
        }.also { session = it }
        val total = status.getInt("total").coerceAtLeast(0)
        val completed = status.getInt("completed").coerceIn(0, total)
        val count = if (total > 0) "$completed/$total 题" else "正在准备题目"
        activeSession.setMetadata(MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, "答题进度 · $count")
            .putString(MediaMetadata.METADATA_KEY_ARTIST, status.getString("phase", "正在处理题目"))
            .putString(MediaMetadata.METADATA_KEY_ALBUM, "学习助手答题任务")
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, "学习助手答题 · $count")
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, status.getString("phase"))
            .putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artwork)
            // Seconds here are task units for a proportional system progress
            // bar, not a playback clock. Speed zero prevents invented progress.
            .putLong(MediaMetadata.METADATA_KEY_DURATION, total * 1000L).build())
        val actions = if (status.getBoolean("canPause")) PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE else 0L
        activeSession.setPlaybackState(PlaybackState.Builder().setActions(actions)
            .setState(if (status.getBoolean("paused")) PlaybackState.STATE_PAUSED else PlaybackState.STATE_PLAYING,
                completed * 1000L, 0f).build())
        return Notification.Builder.recoverBuilder(context, notification)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setLargeIcon(artwork)
            .setStyle(Notification.MediaStyle().setMediaSession(activeSession.sessionToken)).build()
    }
    fun release() { session?.apply { isActive = false; release() }; session = null }
}
