package com.studypilot.android

import android.app.*
import android.content.*
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.*
import android.provider.Settings
import android.view.*
import android.widget.*
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.lang.ref.WeakReference

/** A finite, user-started job. No boot receiver or automatic process resurrection. */
class TaskStatusService : Service() {
    companion object {
        const val CHANNEL = "answer_progress"
        const val NOTIFICATION = 1203
        var active = false
            private set
        var visible = true
        var onRunningChanged: ((Boolean) -> Unit)? = null
        private var serviceRef = WeakReference<TaskStatusService>(null)
        val instance: TaskStatusService? get() = serviceRef.get()
        fun openTask(context: Context): PendingIntent = PendingIntent.getActivity(context, 1203,
            Intent(context, MainActivity::class.java).setAction("studypilot.SHOW_TASK")
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    private val handler = Handler(Looper.getMainLooper())
    private var wake: PowerManager.WakeLock? = null
    private var status = Bundle()
    private var lastHeartbeat = 0L
    private var capsule: LinearLayout? = null
    private var caption: TextView? = null
    private var progress: ProgressBar? = null
    private val windows by lazy { getSystemService(WINDOW_SERVICE) as WindowManager }
    private val ticker = object : Runnable {
        override fun run() {
            if (!active) return
            if (SystemClock.elapsedRealtime() - lastHeartbeat > 90000) {
                finishWithNotice("后台任务连接中断，请回到应用检查"); return
            }
            if (wake?.isHeld != true) wake?.acquire(60000)
            refreshOverlay()
            handler.postDelayed(this, 15000)
        }
    }
    override fun onCreate() {
        super.onCreate(); serviceRef = WeakReference(this)
        if (Build.VERSION.SDK_INT >= 26) {
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(
                NotificationChannel(CHANNEL, "答题实时进度", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "用户启动答题后的步骤和完成数量"; setShowBadge(false)
                })
        }
        wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:answer").apply { setReferenceCounted(false) }
    }
    override fun onBind(intent: Intent?) = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.extras == null) { stopSelf(); return START_NOT_STICKY }
        status = intent.extras!!
        lastHeartbeat = SystemClock.elapsedRealtime()
        if (!active) {
            val notification = notification()
            if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            else startForeground(NOTIFICATION, notification)
            active = true; onRunningChanged?.invoke(true)
            handler.post(ticker)
        } else notifyProgress()
        refreshOverlay()
        return START_NOT_STICKY
    }
    private fun notification(): Notification {
        val total = status.getInt("total").coerceAtLeast(0)
        val count = status.getInt("completed").coerceIn(0, total.coerceAtLeast(1))
        val phase = status.getString("phase", "正在处理题目")
        val detail = if (total > 0) "$phase · 已完成 $count/$total" else phase
        val builder = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_task_status).setContentTitle(status.getString("title", "学习助手答题"))
            .setContentText(detail).setStyle(NotificationCompat.BigTextStyle().bigText(detail))
            .setContentIntent(openTask(this)).setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setProgress(total.coerceAtLeast(1), count, total == 0 || status.getBoolean("indeterminate"))
        if (Build.VERSION.SDK_INT >= 36) {
            builder.setRequestPromotedOngoing(true)
            builder.setShortCriticalText(if (status.getBoolean("paused")) "已暂停" else if (total > 0) "$count/$total" else "答题中")
        }
        return builder.build()
    }
    private fun notifyProgress() {
        try { NotificationManagerCompat.from(this).notify(NOTIFICATION, notification()) } catch (_: SecurityException) { /* Notification permission is optional. */ }
    }
    private fun allowedOverlay() = getSharedPreferences("task_status", MODE_PRIVATE).getBoolean("overlay", false) && Settings.canDrawOverlays(this)
    fun refreshOverlay() {
        if (!active || visible || !allowedOverlay()) { removeOverlay(); return }
        val total = status.getInt("total").coerceAtLeast(0)
        val count = status.getInt("completed").coerceIn(0, total.coerceAtLeast(1))
        val text = if (total > 0) "${status.getString("phase", "答题中")}  $count/$total" else status.getString("phase", "答题中")
        if (capsule == null) {
            val dark = GradientDrawable().apply { setColor(Color.argb(242, 12, 18, 28)); cornerRadius = dp(26).toFloat(); setStroke(dp(1), Color.argb(125, 177, 211, 255)) }
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; background = dark
                setPadding(dp(16), dp(10), dp(16), dp(10)); elevation = dp(10).toFloat()
                contentDescription = "后台答题状态，点击返回任务"
                setOnClickListener { try { openTask(this@TaskStatusService).send() } catch (_: PendingIntent.CanceledException) {} }
            }
            caption = TextView(this).apply { setTextColor(Color.WHITE); textSize = 12f; typeface = Typeface.DEFAULT_BOLD; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; gravity = Gravity.CENTER }
            progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { progressTintList = android.content.res.ColorStateList.valueOf(Color.rgb(142, 202, 255)) }
            row.addView(caption, LinearLayout.LayoutParams(-1, -2))
            row.addView(progress, LinearLayout.LayoutParams(-1, dp(3)).apply { topMargin = dp(5) })
            val type = if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
            val params = WindowManager.LayoutParams(minOf(dp(320), resources.displayMetrics.widthPixels - dp(32)), -2, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT).apply {
                gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL; y = dp(8); title = "StudyPilot task status"
            }
            try { windows.addView(row, params); capsule = row } catch (_: RuntimeException) { caption = null; progress = null }
        }
        caption?.text = text
        progress?.apply { max = total.coerceAtLeast(1); setProgress(count); isIndeterminate = total == 0 || status.getBoolean("indeterminate") }
    }
    private fun dp(value: Int) = (resources.displayMetrics.density * value).toInt()
    private fun removeOverlay() {
        capsule?.let { try { windows.removeView(it) } catch (_: IllegalArgumentException) {} }
        capsule = null; caption = null; progress = null
    }
    fun finishWithNotice(message: String? = null) {
        val end = message ?: if (status.getString("outcome") == "completed") "答题已完成" else "任务已结束，请查看结果"
        stopForeground(STOP_FOREGROUND_REMOVE)
        if (!visible) {
            try { NotificationManagerCompat.from(this).notify(NOTIFICATION + 1, NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_task_status).setContentTitle(end).setContentText("点击返回学习助手")
                .setContentIntent(openTask(this)).setAutoCancel(true).setTimeoutAfter(60000).setSilent(true).build()) } catch (_: SecurityException) {}
        }
        stopSelf()
    }
    override fun onConfigurationChanged(newConfig: Configuration) { super.onConfigurationChanged(newConfig); removeOverlay(); refreshOverlay() }
    override fun onTaskRemoved(rootIntent: Intent?) { finishWithNotice("任务已随应用关闭"); super.onTaskRemoved(rootIntent) }
    override fun onDestroy() {
        active = false; serviceRef.clear(); handler.removeCallbacksAndMessages(null)
        removeOverlay(); if (wake?.isHeld == true) wake?.release(); onRunningChanged?.invoke(false)
        super.onDestroy()
    }
}
