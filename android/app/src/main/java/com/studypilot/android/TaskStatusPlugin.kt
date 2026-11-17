package com.studypilot.android

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.*
import com.getcapacitor.annotation.*

@CapacitorPlugin(name = "TaskStatus", permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])])
class TaskStatusPlugin : Plugin() {
    private val handler = Handler(Looper.getMainLooper())
    private var foreground = true
    private var pendingOpen = false
    override fun load() {
        context.getSharedPreferences("task_status", 0).edit().remove("overlay").apply()
        pendingOpen = activity.intent?.action == "studypilot.SHOW_TASK"
        TaskStatusService.onRunningChanged = { running ->
            if (running) bridge.webView.onResume()
            else if (!foreground) bridge.webView.onPause()
        }
        TaskStatusService.onMediaControl = { paused -> notifyListeners("mediaControl", JSObject().put("paused", paused)) }
    }
    private fun capabilities() = JSObject().apply {
        put("api", Build.VERSION.SDK_INT)
        put("notifications", NotificationManagerCompat.from(context).areNotificationsEnabled())
        put("overlay", false)
        put("overlayEnabled", false)
        put("mediaCard", context.getSharedPreferences("task_status", 0).getBoolean("media_card", false))
        put("manufacturer", Build.MANUFACTURER)
        put("brand", Build.BRAND)
        put("liveUpdates", Build.VERSION.SDK_INT >= 36 && (context.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as NotificationManager).canPostPromotedNotifications())
        put("batteryRestricted", Build.VERSION.SDK_INT >= 28 && (context.getSystemService(android.content.Context.ACTIVITY_SERVICE) as android.app.ActivityManager).isBackgroundRestricted)
    }
    @PluginMethod fun getCapabilities(call: PluginCall) { call.resolve(capabilities()) }
    @PluginMethod fun consumeOpenTask(call: PluginCall) { call.resolve(JSObject().put("open", pendingOpen)); pendingOpen = false }
    @PluginMethod fun requestNotifications(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) requestPermissionForAlias("notifications", call, "permissionResult")
        else { if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) openSettings(if (Build.VERSION.SDK_INT >= 26) Settings.ACTION_APP_NOTIFICATION_SETTINGS else Settings.ACTION_APPLICATION_DETAILS_SETTINGS); call.resolve(capabilities()) }
    }
    @PermissionCallback private fun permissionResult(call: PluginCall) { call.resolve(capabilities()) }
    // Retired bridge method: old preferences/callers must not recreate a
    // separate floating bar alongside the native ongoing notification.
    @PluginMethod fun setOverlay(call: PluginCall) { call.resolve(capabilities()) }
    @PluginMethod fun setMediaCard(call: PluginCall) {
        val enabled = call.getBoolean("enabled", false) ?: false
        context.getSharedPreferences("task_status", 0).edit().putBoolean("media_card", enabled).apply()
        activity.runOnUiThread { TaskStatusService.instance?.refreshPresentation(); call.resolve(capabilities()) }
    }
    @PluginMethod fun openLiveUpdateSettings(call: PluginCall) {
        activity.runOnUiThread {
            openSettings(if (Build.VERSION.SDK_INT >= 36) Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS else if (Build.VERSION.SDK_INT >= 26) Settings.ACTION_APP_NOTIFICATION_SETTINGS else Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            call.resolve()
        }
    }
    @PluginMethod fun openBatterySettings(call: PluginCall) { openSettings(Settings.ACTION_APPLICATION_DETAILS_SETTINGS); call.resolve() }
    private fun openSettings(action: String) {
        try {
            val intent = Intent(action).apply {
                if (Build.VERSION.SDK_INT >= 26 && (action == Settings.ACTION_APP_NOTIFICATION_SETTINGS || (Build.VERSION.SDK_INT >= 36 && action == Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS))) putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                else data = Uri.parse("package:${context.packageName}")
            }
            activity.startActivity(intent)
        } catch (_: RuntimeException) {
            activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
        }
    }
    @PluginMethod fun update(call: PluginCall) {
        activity.runOnUiThread {
            if (call.getBoolean("running", false) == true) {
                val intent = Intent(context, TaskStatusService::class.java)
                    .putExtra("title", call.getString("title", "学习助手答题")!!.take(40))
                    .putExtra("phase", call.getString("phase", "正在处理题目")!!.take(60))
                    .putExtra("total", (call.getInt("total", 0) ?: 0).coerceIn(0, 100000))
                    .putExtra("completed", (call.getInt("completed", 0) ?: 0).coerceIn(0, 100000))
                    .putExtra("paused", call.getBoolean("paused", false))
                    .putExtra("canPause", call.getBoolean("canPause", false))
                    .putExtra("indeterminate", call.getBoolean("indeterminate", false))
                try {
                    // Starting only while the app is visible satisfies Android 12+ FGS restrictions.
                    if (foreground || TaskStatusService.active) ContextCompat.startForegroundService(context, intent)
                    val preferences = context.getSharedPreferences("task_status", 0)
                    if (foreground && Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED && !preferences.getBoolean("notification_asked", false)) {
                        preferences.edit().putBoolean("notification_asked", true).apply()
                        requestPermissionForAlias("notifications", call, "permissionResult")
                    } else call.resolve()
                } catch (_: RuntimeException) { call.reject("系统未允许后台服务，请检查后台权限。") }
            } else { TaskStatusService.instance?.finishWithNotice(if (call.getString("outcome") == "completed") "答题已完成" else null); call.resolve() }
        }
    }
    override fun handleOnResume() {
        foreground = true; TaskStatusService.visible = true
        bridge.webView.onResume()
    }
    override fun handleOnStop() {
        foreground = false; TaskStatusService.visible = false
        if (TaskStatusService.active) bridge.webView.onResume()
    }
    override fun handleOnNewIntent(intent: Intent?) {
        if (intent?.action == "studypilot.SHOW_TASK") { pendingOpen = true; handler.postDelayed({
            bridge.webView.evaluateJavascript("window.dispatchEvent(new Event('studypilot:show-task'))", null)
        }, 250) }
    }
    override fun handleOnDestroy() {
        handler.removeCallbacksAndMessages(null); TaskStatusService.onRunningChanged = null; TaskStatusService.onMediaControl = null
        TaskStatusService.instance?.finishWithNotice("应用已关闭，请重新启动任务")
    }
}
