package com.studypilot.android

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.KeyEvent
import android.content.Context
import android.view.inputmethod.InputMethodManager
import android.webkit.*
import android.widget.FrameLayout
import androidx.core.graphics.Insets
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.JSObject
import com.getcapacitor.JSArray
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

private data class AndroidTask(
    val sourceUrl: String,
    val sourceTabId: String,
    var byteCount: Long = 0L,
    val mediaCache: ConcurrentHashMap<String, StoredMedia> = ConcurrentHashMap()
)
private data class StoredMedia(val bytes: ByteArray, val mime: String, val digest: String)

@CapacitorPlugin(name = "NativeWebView")
class NativeWebViewPlugin : Plugin() {
    private var studyWebView: WebView? = null
    private var container: BrowserOverlayLayout? = null
    private val tabs = linkedMapOf<String, WebView>()
    private var activeTabId = "study"
    private var currentUrl = ""
    private var currentTitle = ""
    private var isLoading = false
    private var headerHeight = 50
    private var tabHeight = 56
    private val handler = Handler(Looper.getMainLooper())
    private val tasks = ConcurrentHashMap<String, AndroidTask>()
    private val IMAGE_LIMIT = 8 * 1024 * 1024L
    private val TASK_LIMIT = 32 * 1024 * 1024L
    private val bridgeScript by lazy {
        context.assets.open("android-webview-bridge.js").bufferedReader().use { it.readText() }
    }
    private val okHttpClient: OkHttpClient by lazy {
        OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS).followRedirects(true).build()
    }

    override fun load() {
        super.load()
        activity.window.decorView.post { setupWebView() }
    }

    private fun createBrowser(tabId: String): WebView = WebView(context).apply {
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            mediaPlaybackRequiresUserGesture = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(true)
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
        setBackgroundColor(Color.WHITE)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(this, bridgeScript, setOf("*"))
        }
        webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                if (tabId == "study") { currentUrl = url; isLoading = true }
                notifyNavigation(tabId, true)
            }
            override fun onPageFinished(view: WebView, url: String) {
                if (tabId == "study") { currentUrl = url; currentTitle = view.title ?: ""; isLoading = false }
                view.evaluateJavascript(bridgeScript, null)
                notifyNavigation(tabId, false)
            }
            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                if (tabId == "study") currentUrl = url
                notifyNavigation(tabId)
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    if (tabId == "study") isLoading = false
                    android.util.Log.e("StudyPilot", "Load error: " + error.description)
                    notifyNavigation(tabId, false)
                }
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                return !url.startsWith("https://") && !url.startsWith("http://") && url != "about:blank"
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView, title: String) {
                if (tabId == "study") currentTitle = title
                notifyNavigation(tabId)
            }
            override fun onProgressChanged(view: WebView, progress: Int) {
                if (tabId == "study") isLoading = progress < 100
                notifyNavigation(tabId, progress < 100)
            }
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                android.util.Log.d("StudyPilot", "JS: " + message.message())
                return true
            }
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
            override fun onCloseWindow(window: WebView) { closeBrowser(tabId) }
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean {
                if (!isUserGesture) return false
                // Give window.open / target=_blank its own browser and history,
                // including about:blank popups whose URL is assigned later.
                val popup = addBrowser()
                (resultMsg.obj as WebView.WebViewTransport).webView = popup
                resultMsg.sendToTarget()
                return true
            }
        }
    }

    private fun setupWebView() {
        if (container != null) return
        val bridgeView = bridge?.webView ?: run { handler.postDelayed({ setupWebView() }, 100); return }
        val root = activity.findViewById<FrameLayout>(android.R.id.content) ?: return
        var toolContainer: View = bridgeView
        while (toolContainer.parent is View && toolContainer.parent !== root) {
            toolContainer = toolContainer.parent as View
        }
        if (toolContainer.parent !== root) return
        val overlay = BrowserOverlayLayout(context)
        container = overlay
        // CSS transparency alone does not clear the native WebView's white background.
        bridgeView.setBackgroundColor(Color.TRANSPARENT)
        toolContainer.setBackgroundColor(Color.TRANSPARENT)
        root.removeView(toolContainer)
        root.addView(overlay, FrameLayout.LayoutParams(-1, -1))
        studyWebView = createBrowser("study")
        tabs["study"] = studyWebView!!
        overlay.addView(studyWebView, browserLayout())
        overlay.addView(toolContainer, FrameLayout.LayoutParams(-1, -1))
        overlay.browser = studyWebView
        val density = context.resources.displayMetrics.density
        overlay.headerBottom = headerHeight * density
        overlay.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            if (overlay.panelTop == Float.MAX_VALUE) overlay.panelTop = overlay.height - tabHeight * density
        }
        ViewCompat.setOnApplyWindowInsetsListener(overlay) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val lp = view.layoutParams as FrameLayout.LayoutParams
            val bottom = maxOf(bars.bottom, ime.bottom)
            if (lp.topMargin != bars.top || lp.bottomMargin != bottom || lp.leftMargin != bars.left || lp.rightMargin != bars.right) {
                lp.setMargins(bars.left, bars.top, bars.right, bottom)
                view.layoutParams = lp
            }
            // Both WebViews already fit above the IME and inside the safe area.
            // Pass zero managed insets so descendants cannot apply them again.
            // A new object (rather than CONSUMED) lets WebView recalculate its
            // safe-area CSS when the keyboard closes or the phone rotates.
            WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(), Insets.NONE)
                .setInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(), Insets.NONE)
                .build()
        }
        ViewCompat.requestApplyInsets(overlay)
        activity.onBackPressedDispatcher.addCallback(activity, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // The Capacitor WebView has no page history; the active native
                // browser does. Dismiss tools first, then navigate that browser.
                bridgeView.evaluateJavascript("""
                    (function() {
                        var dialog = document.querySelector('dialog[open]');
                        if (dialog) {
                            if (typeof dialog.requestClose === 'function') dialog.requestClose();
                            else dialog.close();
                            return true;
                        }
                        if (document.querySelector('.mobile-url-input, .mobile-sheet.is-open')) {
                            window.dispatchEvent(new Event('studypilot:show-source'));
                            return true;
                        }
                        return false;
                    })()
                """.trimIndent()) { handled ->
                    if (handled != "true" && !activity.isFinishing && !activity.isDestroyed) {
                        val browser = container?.browser
                        if (browser?.canGoBack() == true) browser.goBack()
                        else activity.moveTaskToBack(true)
                    }
                }
            }
        })
        studyWebView!!.loadUrl("https://i.chaoxing.com")
    }

    private fun browserLayout() = FrameLayout.LayoutParams(-1, -1).apply {
        val density = context.resources.displayMetrics.density
        topMargin = (headerHeight * density).toInt()
        bottomMargin = (tabHeight * density).toInt()
    }
    private fun state(tabId: String, loading: Boolean? = null): JSObject {
        val view = tabs[tabId]
        return JSObject().apply {
            put("tabId", tabId); put("activeTabId", activeTabId)
            put("url", view?.url ?: ""); put("title", view?.title ?: "")
            put("loading", loading ?: (if (tabId == "study") isLoading else (view?.progress ?: 0) < 100))
            put("canGoBack", view?.canGoBack() ?: false); put("canGoForward", view?.canGoForward() ?: false)
        }
    }
    private fun notifyNavigation(tabId: String, loading: Boolean? = null) {
        notifyListeners("navigationChanged", state(tabId, loading))
    }
    private fun target(call: PluginCall, defaultTab: String = activeTabId): WebView? {
        val id = call.getString("tabId") ?: defaultTab
        return tabs[id] ?: run { call.reject("原标签已关闭或浏览器尚未就绪。"); null }
    }

    @PluginMethod
    fun setLayout(call: PluginCall) {
        activity.runOnUiThread {
            val overlay = container ?: run { call.reject("浏览器尚未就绪。"); return@runOnUiThread }
            headerHeight = call.getInt("headerHeight", 50) ?: 50
            tabHeight = call.getInt("tabHeight", 56) ?: 56
            val density = context.resources.displayMetrics.density
            overlay.headerBottom = headerHeight * density
            overlay.panelTop = (call.getFloat("panelTop") ?: (overlay.height / density - tabHeight)) * density
            overlay.modalOpen = call.getBoolean("modalOpen", false) ?: false
            tabs.values.forEach { view -> view.layoutParams = browserLayout() }
            call.resolve()
        }
    }

    @PluginMethod
    fun captureBackdrop(call: PluginCall) {
        activity.runOnUiThread {
            val overlay = container ?: run { call.reject("浏览器尚未就绪。"); return@runOnUiThread }
            val browser = overlay.browser ?: return@runOnUiThread call.reject("浏览器尚未就绪。")
            if (overlay.width <= 0 || overlay.height <= 0) { call.resolve(JSObject().put("dataUrl", "")); return@runOnUiThread }
            val scale = minOf(1f, 320f / overlay.width)
            val bitmap = Bitmap.createBitmap(maxOf(1, (overlay.width * scale).toInt()), maxOf(1, (overlay.height * scale).toInt()), Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            canvas.drawColor(Color.WHITE)
            canvas.scale(scale, scale)
            canvas.translate(browser.left.toFloat(), browser.top.toFloat())
            browser.draw(canvas)
            val bytes = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, 75, bytes)
            bitmap.recycle()
            call.resolve(JSObject().put("dataUrl", "data:image/jpeg;base64," + android.util.Base64.encodeToString(bytes.toByteArray(), android.util.Base64.NO_WRAP)))
        }
    }

    @PluginMethod
    fun loadUrl(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url required")
        if (!url.startsWith("https://") && !url.startsWith("http://")) return call.reject("仅支持 HTTP/HTTPS 网页。")
        activity.runOnUiThread { target(call)?.let { it.loadUrl(url); call.resolve() } }
    }
    @PluginMethod
    fun createTab(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url required")
        if (!url.startsWith("https://") && !url.startsWith("http://")) return call.reject("无效网页地址。")
        activity.runOnUiThread {
            if (container == null) return@runOnUiThread call.reject("浏览器尚未就绪。")
            val view = addBrowser()
            val id = activeTabId
            view.loadUrl(url)
            call.resolve(state(id, true))
        }
    }
    private fun addBrowser(): WebView {
        val id = "tab_" + UUID.randomUUID().toString()
        val view = createBrowser(id)
        tabs[id] = view
        container!!.addView(view, 0, browserLayout())
        focus(id)
        return view
    }
    private fun focus(id: String) {
        val changed = activeTabId != id
        if (changed) tabs[activeTabId]?.clearFocus()
        activeTabId = id
        tabs.forEach { (key, view) -> view.visibility = if (key == id) View.VISIBLE else View.INVISIBLE }
        container?.browser = tabs[id]
        tabs[id]?.requestFocus()
        if (changed) {
            // The previous AI editor's IME otherwise keeps covering the source page.
            val inputMethod = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            inputMethod.hideSoftInputFromWindow(container?.windowToken, 0)
        }
        notifyNavigation(id)
    }
    @PluginMethod
    fun listTabs(call: PluginCall) {
        activity.runOnUiThread {
            val list = JSArray()
            tabs.keys.forEach { list.put(state(it)) }
            call.resolve(JSObject().put("tabs", list).put("activeTabId", activeTabId))
        }
    }
    private fun closeBrowser(id: String) {
        if (!tabs.containsKey(id) || tabs.size <= 1) return
        val ids = tabs.keys.toList()
        val index = ids.indexOf(id)
        val view = tabs.remove(id)!!
        if (id == "study") studyWebView = null
        container?.removeView(view)
        view.stopLoading()
        view.destroy()
        if (activeTabId == id) focus(ids[if (index > 0) index - 1 else 1])
        else notifyNavigation(activeTabId)
    }
    @PluginMethod
    fun closeTab(call: PluginCall) {
        val id = call.getString("tabId") ?: return call.reject("tabId required")
        activity.runOnUiThread {
            if (!tabs.containsKey(id)) return@runOnUiThread call.reject("原标签已关闭。")
            if (tabs.size <= 1) return@runOnUiThread call.reject("请保留至少一个标签页。")
            closeBrowser(id)
            call.resolve()
        }
    }
    @PluginMethod
    fun sendEnter(call: PluginCall) {
        activity.runOnUiThread {
            val view = target(call) ?: return@runOnUiThread
            val id = call.getString("tabId") ?: activeTabId
            // Physical keys need the target WebView to hold focus, also after rotation.
            focus(id)
            view.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
            view.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
            call.resolve()
        }
    }
    @PluginMethod
    fun focusTab(call: PluginCall) {
        val id = call.getString("tabId") ?: return call.reject("tabId required")
        activity.runOnUiThread {
            if (!tabs.containsKey(id)) return@runOnUiThread call.reject("原标签已关闭。")
            focus(id); call.resolve(state(id))
        }
    }
    @PluginMethod
    fun getState(call: PluginCall) {
        activity.runOnUiThread {
            if (target(call) == null) return@runOnUiThread
            call.resolve(state(call.getString("tabId") ?: activeTabId))
        }
    }
    @PluginMethod
    fun goBack(call: PluginCall) { activity.runOnUiThread { target(call)?.let { it.goBack(); call.resolve() } } }
    @PluginMethod
    fun goForward(call: PluginCall) { activity.runOnUiThread { target(call)?.let { it.goForward(); call.resolve() } } }
    @PluginMethod
    fun reload(call: PluginCall) { activity.runOnUiThread { target(call)?.let { it.reload(); call.resolve() } } }
    @PluginMethod
    fun setVisible(call: PluginCall) { call.resolve() }
    @PluginMethod
    fun resizeSplit(call: PluginCall) { call.resolve() } // compatibility: never resize the browser

    @PluginMethod
    fun getDiagnostics(call: PluginCall) {
        activity.runOnUiThread {
            val report = "Browser: " + state(activeTabId).toString() +
                "\nBrowser size: " + container?.browser?.width + "x" + container?.browser?.height +
                "\nOverlay size: " + container?.width + "x" + container?.height +
                "\nTouch regions: " + container?.headerBottom + ".." + container?.panelTop
            call.resolve(JSObject().put("report", report))
        }
    }

    // evaluateJavascript returns immediately for Promises. Store each completed result by request ID.
    private fun evaluateAsync(view: WebView, code: String, call: PluginCall, unwrap: Boolean = false) {
        val id = UUID.randomUUID().toString()
        val key = JSONObject.quote(id)
        val wrapped = """
(function() {
  var results = window.__spNativeResults || (window.__spNativeResults = {});
  Promise.resolve().then(function() { return ($code); }).then(function(value) {
    results[$key] = {ok:true, value:value === undefined ? null : value};
  }, function(error) { results[$key] = {ok:false,error:String(error && error.message || error)}; });
})()
""".trimIndent()
        view.evaluateJavascript(wrapped, null)
        val deadline = android.os.SystemClock.uptimeMillis() + 12000
        val poll = object : Runnable {
            override fun run() {
                view.evaluateJavascript("(window.__spNativeResults || {})[$key] || null") { raw ->
                    if (raw != null && raw != "null") {
                        view.evaluateJavascript("delete window.__spNativeResults[$key]", null)
                        try {
                            val result = JSONObject(raw)
                            if (!result.optBoolean("ok")) call.reject(result.optString("error"))
                            else if (unwrap) call.resolve(JSObject(result.getJSONObject("value").toString()))
                            else call.resolve(JSObject().put("result", result.opt("value")))
                        } catch (error: Exception) { call.reject("网页结果解析失败: " + error.message) }
                    } else if (android.os.SystemClock.uptimeMillis() < deadline) handler.postDelayed(this, 50)
                    else {
                        view.evaluateJavascript("delete (window.__spNativeResults || {})[$key]", null)
                        call.reject("原题目页面响应超时，请等待页面就绪后重试。")
                    }
                }
            }
        }
        handler.postDelayed(poll, 25)
    }

    @PluginMethod
    fun executeScript(call: PluginCall) {
        val code = call.getString("code") ?: return call.reject("code required")
        activity.runOnUiThread { target(call)?.let { evaluateAsync(it, code, call) } }
    }
    @PluginMethod
    fun injectBridge(call: PluginCall) {
        activity.runOnUiThread {
            target(call)?.evaluateJavascript(bridgeScript + "\n;Boolean(window.__studyPilotAndroidBridge)") { value ->
                if (value == "true") call.resolve() else call.reject("题目页面桥接未能初始化。")
            }
        }
    }
    @PluginMethod
    fun dispatchBridgeEvent(call: PluginCall) {
        val event = call.getString("event") ?: return call.reject("event required")
        val channel = call.getString("resultChannel") ?: return call.reject("resultChannel required")
        val allowed = mapOf("studypilot:android-extract" to "studypilot:android-extract-result",
            "studypilot:android-apply" to "studypilot:android-apply-result",
            "studypilot:android-exam-next" to "studypilot:android-exam-next-result")
        if (allowed[event] != channel) return call.reject("无效桥接事件。")
        val detail = try { JSONObject(call.getString("detail") ?: "{}") } catch (error: Exception) { return call.reject("无效请求。") }
        val id = UUID.randomUUID().toString()
        detail.put("requestId", id)
        val eventJson = JSONObject.quote(event)
        val channelJson = JSONObject.quote(channel)
        val idJson = JSONObject.quote(id)
        val code = """
new Promise(function(resolve, reject) {
  var timer = setTimeout(function() { window.removeEventListener($channelJson, listener); reject(new Error('题目页面响应超时。')); }, 11000);
  function listener(ev) {
    if (!ev.detail || ev.detail.requestId !== $idJson) return;
    clearTimeout(timer); window.removeEventListener($channelJson, listener); resolve(ev.detail);
  }
  window.addEventListener($channelJson, listener);
  window.dispatchEvent(new CustomEvent($eventJson, {detail:$detail}));
})
""".trimIndent()
        activity.runOnUiThread {
            target(call)?.let { view ->
                evaluateAsync(view, code, call, true)
            }
        }
    }

    @PluginMethod
    fun clearSession(call: PluginCall) {
        activity.runOnUiThread {
            tabs.values.forEach { view -> view.clearCache(true); view.clearHistory() }
            tasks.clear()
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
            WebStorage.getInstance().deleteAllData()
            notifyNavigation(activeTabId)
            call.resolve()
        }
    }

    // ──────────────── Task lease (image session management) ────────────────

    @PluginMethod
    fun leaseWebAITask(call: PluginCall) {
        val sessionId = call.getString("sessionId") ?: run { call.reject("sessionId required"); return }
        val sourceUrl = call.getString("sourceUrl") ?: ""
        activity.runOnUiThread {
            val id = call.getString("sourceTabId") ?: tabs.entries.firstOrNull { it.value.url == sourceUrl }?.key
            if (id == null || tabs[id]?.url != sourceUrl) return@runOnUiThread call.reject("原题目页面已变化，请重新抓题。")
            val old = tasks[sessionId]
            if (old != null && (old.sourceTabId != id || old.sourceUrl != sourceUrl)) return@runOnUiThread call.reject("任务原题目来源已变化。")
            tasks.getOrPut(sessionId) { AndroidTask(sourceUrl, id) }
            call.resolve(JSObject().put("ok", true).put("sessionId", sessionId))
        }
    }

    @PluginMethod
    fun releaseWebAITask(call: PluginCall) {
        val sessionId = call.getString("sessionId") ?: run { call.resolve(); return }
        tasks.remove(sessionId)
        call.resolve()
    }

    // ──────────────── Image reading (含图题) ────────────────

    /**
     * Reads an image from the question page.
     * Priority: http(s) via OkHttp+cookies → data:/blob: via in-page fetch → canvas screenshot crop
     * Returns { ok, bytes (number array), mime, digest } matching Electron's MediaResult shape.
     */
    @PluginMethod
    fun readQuestionMedia(call: PluginCall) {
        val sessionId = call.getString("sessionId") ?: run { call.reject("sessionId required"); return }
        val questionHash = call.getString("questionHash") ?: run { call.reject("questionHash required"); return }
        val mediaId = call.getString("mediaId") ?: run { call.reject("mediaId required"); return }
        val selector = call.getString("selector") ?: run { call.reject("selector required"); return }
        val sourceUrl = call.getString("sourceUrl") // optional

        val task = tasks[sessionId] ?: return call.reject("原题目图片会话尚未绑定，请重新抓题。")
        val cacheKey = "$questionHash:$mediaId"
        val cached = task.mediaCache[cacheKey]
        if (cached != null) {
            call.resolve(mediaResult(cached))
            return
        }

        // Step 1: inject inspection JS on UI thread, then do network work on background thread
        activity.runOnUiThread {
            val wv = tabs[task.sourceTabId]
            if (wv == null || wv.url != task.sourceUrl) { call.reject("原题目页面已变化，请重新抓题。"); return@runOnUiThread }

            val inspectJs = buildInspectJs(selector, sourceUrl)
            wv.evaluateJavascript(inspectJs) { raw ->
                Thread {
                    try {
                        val inspection = parseInspection(raw)
                        if (inspection.error != null) { call.reject(inspection.error); return@Thread }

                        val resolvedUrl = inspection.sourceUrl
                        val media: StoredMedia? = when {
                            // Path A: http(s) URL — fetch with cookies
                            resolvedUrl != null && resolvedUrl.startsWith("http") -> {
                                fetchWithCookies(resolvedUrl, task.sourceUrl)
                            }
                            // Path B: data:/blob: — in-page fetch via JS
                            resolvedUrl != null && (resolvedUrl.startsWith("data:") || resolvedUrl.startsWith("blob:")) -> {
                                fetchViaPageJs(wv, resolvedUrl)
                            }
                            // Path C: screenshot crop
                            inspection.rect != null -> {
                                screenshotCrop(wv, inspection.rect)
                            }
                            else -> null
                        }

                        if (media == null) { call.reject("图片无法读取"); return@Thread }
                        if (media.bytes.size > IMAGE_LIMIT) { call.reject("单张图片超过 8 MiB"); return@Thread }
                        if (task.byteCount + media.bytes.size > TASK_LIMIT) { call.reject("本任务图片总量超过 32 MiB"); return@Thread }

                        task.byteCount += media.bytes.size
                        task.mediaCache[cacheKey] = media
                        call.resolve(mediaResult(media))
                    } catch (e: Exception) {
                        call.reject(e.message ?: "图片读取失败")
                    }
                }.start()
            }
        }
    }

    // ──────────────── Helpers ────────────────

    private fun buildInspectJs(selector: String, sourceUrl: String?): String {
        val selectorJson = JSONObject.quote(selector)
        val sourceUrlJson = if (sourceUrl != null) JSONObject.quote(sourceUrl) else "null"
        // Inline version of Electron's inspectSourceMedia, adapted for Android
        return """
(function() {
  var sel = $selectorJson;
  var expectedUrl = $sourceUrlJson;
  var element;
  try { element = document.querySelector(sel); } catch(e) { return JSON.stringify({error:'图片定位无效'}); }
  if (!element || !/^(?:IMG|SVG|CANVAS)${'$'}/.test(element.tagName)) return JSON.stringify({error:'题目图片已不存在'});
  var ancestors = [];
  for (var n = element; n; n = n.parentElement) ancestors.push(n);
  for (var i = 0; i < ancestors.length; i++) {
    var s = window.getComputedStyle(ancestors[i]);
    if (s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse') return JSON.stringify({error:'图片区域不可读取'});
  }
  var img = element;
  var lazy = element.getAttribute('data-original')||element.getAttribute('data-src')||element.getAttribute('data-lazy-src')||element.getAttribute('data-url');
  var rawSrc = (img.currentSrc)||lazy||(element.getAttribute('src'))||'';
  var resolvedUrl;
  try { resolvedUrl = rawSrc ? new URL(rawSrc, document.baseURI).href : null; } catch(e) { resolvedUrl = null; }
  if (resolvedUrl && !/^(https?:|data:|blob:)/.test(resolvedUrl)) resolvedUrl = null;
  if (expectedUrl && resolvedUrl && resolvedUrl !== expectedUrl) resolvedUrl = expectedUrl;
  var rect = element.getBoundingClientRect();
  var visible = rect.width>0 && rect.height>0;
  return JSON.stringify({
    sourceUrl: resolvedUrl || null,
    rect: visible ? {x:Math.floor(rect.x),y:Math.floor(rect.y),width:Math.ceil(rect.width),height:Math.ceil(rect.height)} : null
  });
})()
""".trimIndent()
    }

    private data class Inspection(val sourceUrl: String?, val rect: Rect?, val error: String?)
    private data class Rect(val x: Int, val y: Int, val width: Int, val height: Int)

    private fun parseInspection(raw: String?): Inspection {
        if (raw == null || raw == "null") return Inspection(null, null, "图片校验失败")
        return try {
            // evaluateJavascript returns a JSON-encoded string — unwrap one level
            val unquoted = if (raw.startsWith("\"")) JSONObject.quote("").let {
                raw.substring(1, raw.length - 1).replace("\\\"", "\"").replace("\\\\", "\\")
            } else raw
            val json = JSONObject(unquoted)
            val error = if (json.has("error")) json.getString("error") else null
            if (error != null) return Inspection(null, null, error)
            val sourceUrl = if (json.has("sourceUrl") && !json.isNull("sourceUrl")) json.getString("sourceUrl") else null
            val rect = if (json.has("rect") && !json.isNull("rect")) {
                val r = json.getJSONObject("rect")
                Rect(r.getInt("x"), r.getInt("y"), r.getInt("width"), r.getInt("height"))
            } else null
            Inspection(sourceUrl, rect, null)
        } catch (e: Exception) {
            Inspection(null, null, "图片校验数据解析失败")
        }
    }

    private fun fetchWithCookies(url: String, referer: String): StoredMedia? {
        val cookies = CookieManager.getInstance().getCookie(url) ?: ""
        val req = Request.Builder()
            .url(url)
            .header("Referer", referer)
            .apply { if (cookies.isNotEmpty()) header("Cookie", cookies) }
            .build()
        val resp = okHttpClient.newCall(req).execute()
        if (!resp.isSuccessful) return null
        val body = resp.body ?: return null
        val mime = (resp.header("Content-Type") ?: "image/png").split(";").first().trim().lowercase()
        if (!mime.startsWith("image/")) return null
        val bytes = body.bytes()
        return StoredMedia(bytes, mime, sha256Hex(bytes))
    }

    private fun fetchViaPageJs(wv: WebView, url: String): StoredMedia? {
        val urlJson = JSONObject.quote(url)
        val js = """
(function() {
  return fetch($urlJson).then(function(r) {
    var mime = (r.headers.get('content-type')||'image/png').split(';')[0].trim();
    return r.arrayBuffer().then(function(buf) {
      var arr = Array.from(new Uint8Array(buf));
      return JSON.stringify({bytes: arr, mime: mime});
    });
  }).catch(function(e) { return JSON.stringify({error: e.message}); });
})()
""".trimIndent()
        var result: StoredMedia? = null
        val latch = java.util.concurrent.CountDownLatch(1)
        activity.runOnUiThread {
            wv.evaluateJavascript(js) { raw ->
                try {
                    val unwrapped = unwrapJsonString(raw ?: "")
                    val json = JSONObject(unwrapped)
                    if (!json.has("error")) {
                        val arr = json.getJSONArray("bytes")
                        val bytes = ByteArray(arr.length()) { i -> arr.getInt(i).toByte() }
                        val mime = json.getString("mime")
                        result = StoredMedia(bytes, mime, sha256Hex(bytes))
                    }
                } catch (_: Exception) {}
                latch.countDown()
            }
        }
        latch.await(15, TimeUnit.SECONDS)
        return result
    }

    private fun screenshotCrop(wv: WebView, rect: Rect): StoredMedia? {
        if (rect.width <= 0 || rect.height <= 0) return null
        val scale = wv.scale
        val px = (rect.x * scale).toInt()
        val py = (rect.y * scale).toInt()
        val pw = (rect.width * scale).toInt()
        val ph = (rect.height * scale).toInt()

        var bitmap: Bitmap? = null
        val latch = java.util.concurrent.CountDownLatch(1)
        activity.runOnUiThread {
            try {
                val full = Bitmap.createBitmap(wv.width, wv.height, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(full)
                wv.draw(canvas)
                val safeX = px.coerceIn(0, (full.width - 1).coerceAtLeast(0))
                val safeY = py.coerceIn(0, (full.height - 1).coerceAtLeast(0))
                val safeW = pw.coerceIn(1, full.width - safeX)
                val safeH = ph.coerceIn(1, full.height - safeY)
                bitmap = Bitmap.createBitmap(full, safeX, safeY, safeW, safeH)
                full.recycle()
            } catch (_: Exception) {}
            latch.countDown()
        }
        latch.await(10, TimeUnit.SECONDS)
        val bmp = bitmap ?: return null
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        bmp.recycle()
        val bytes = out.toByteArray()
        return StoredMedia(bytes, "image/png", sha256Hex(bytes))
    }

    private fun mediaResult(media: StoredMedia): JSObject {
        val ret = JSObject()
        ret.put("ok", true)
        ret.put("mime", media.mime)
        ret.put("digest", media.digest)
        // Build a JSON number array for bytes — Capacitor bridges number[] cleanly
        val arr = com.getcapacitor.JSArray()
        for (b in media.bytes) arr.put(b.toInt() and 0xFF)
        ret.put("bytes", arr)
        return ret
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString("") { "%02x".format(it) }
    }

    private fun unwrapJsonString(raw: String): String {
        // evaluateJavascript wraps Promise-resolved strings in an extra JSON string layer
        return if (raw.startsWith("\"") && raw.endsWith("\"")) {
            raw.substring(1, raw.length - 1)
                .replace("\\\"", "\"")
                .replace("\\\\", "\\")
                .replace("\\/", "/")
                .replace("\\n", "\n")
                .replace("\\r", "\r")
                .replace("\\t", "\t")
        } else raw
    }
}
