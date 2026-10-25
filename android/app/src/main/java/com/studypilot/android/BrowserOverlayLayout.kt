package com.studypilot.android

import android.content.Context
import android.view.MotionEvent
import android.webkit.WebView
import android.widget.FrameLayout

/** Transparent WebViews still consume touch. Route each entire gesture by its initial position. */
class BrowserOverlayLayout(context: Context) : FrameLayout(context) {
    var browser: WebView? = null
    var headerBottom = 0f
    var panelTop = Float.MAX_VALUE
    var modalOpen = false
    private var browserGesture = false

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            browserGesture = !modalOpen && event.y >= headerBottom && event.y < panelTop
        }
        if (!browserGesture) return super.dispatchTouchEvent(event)
        val target = browser ?: return false
        val forwarded = MotionEvent.obtain(event)
        forwarded.offsetLocation(-target.left.toFloat(), -target.top.toFloat())
        val handled = target.dispatchTouchEvent(forwarded)
        forwarded.recycle()
        return handled
    }
}
