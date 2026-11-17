package com.studypilot.android

import android.content.Context
import android.graphics.RectF
import android.view.MotionEvent
import android.webkit.WebView
import android.widget.FrameLayout

/** Transparent WebViews still consume touch. Route each entire gesture by its initial position. */
class BrowserOverlayLayout(context: Context) : FrameLayout(context) {
    var browser: WebView? = null
    var headerBottom = 0f
    val dockBounds = RectF()
    var modalOpen = false
    // Includes the closing transition. Never send an outside dismiss gesture to the page.
    var panelOpen = false
    private var browserGesture = false

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            // Hit the visible capsule, leaving its sides, rounded corners and
            // bottom gap available to the webpage underneath.
            val radius = dockBounds.height() / 2
            val centerX = event.x.coerceIn(dockBounds.left + radius, dockBounds.right - radius)
            val dx = event.x - centerX
            val dy = event.y - dockBounds.centerY()
            val inDock = !dockBounds.isEmpty && dx * dx + dy * dy <= radius * radius
            browserGesture = !modalOpen && !panelOpen && event.y >= headerBottom && !inDock
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
