# Android Liquid Glass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Execute inline in this existing feature branch; do not delegate.

**Goal:** Upgrade the seven Android tool tabs and overlay motion, and consume outside touches when dismissing the tools.

**Architecture:** Keep native browser dimensions and mounted tool state. Synchronize an explicit panel-open/blocking flag to the native gesture router. Render a shared sliding indicator and a dismiss surface in the transparent React overlay; retain the existing native webpage snapshot for frosted material.

**Tech Stack:** React 18, TypeScript, CSS transitions, Capacitor, Kotlin, Playwright CDP and ADB.

---

### Task 1: Reproduce outside-touch failure

**Files:** Create `scripts/check-android-glass.mjs`.

- [x] Add an Android CDP fixture with a webpage click counter; calculate screen coordinates using the debuggable WebView description and issue real ADB input.

```js
const before = await source.evaluate(() => window.clicks);
await shell.getByRole('button', { name: '设置', exact: true }).click();
runAdb('shell', 'input', 'tap', String(point.x), String(point.y));
await shell.waitForFunction(() => !document.querySelector('.mobile-sheet.is-open'));
assert.equal(await source.evaluate(() => window.clicks), before);
```

- [x] Run the script against the previous APK; expect failure because the native router forwards the outside click to the source.

### Task 2: Implement whole-gesture dismissal

**Files:** Modify `src/MobileApp.tsx`, `src/platform/nativeWebViewPlugin.ts`, `android/app/src/main/java/com/studypilot/android/BrowserOverlayLayout.kt`, `android/app/src/main/java/com/studypilot/android/NativeWebViewPlugin.kt`.

- [x] Add the synchronized blocking flag to the bridge and route an entire gesture using the initial state.

```kotlin
var panelOpen = false
// ACTION_DOWN only:
browserGesture = !modalOpen && !panelOpen && event.y >= headerBottom && event.y < panelTop
```

- [x] Keep the dismiss surface and blocking flag until the close transition settles; close only on a click without significant pointer movement and with no open dialog. Keep mounted panels and their drafts.
- [x] Rebuild/install and rerun the test; expect outside tap dismisses without webpage events and a subsequent tap reaches the webpage.

### Task 3: Upgrade dock and material

**Files:** Create `src/components/MobileToolDock.tsx`; modify `src/MobileApp.tsx`, `src/mobile.css`.

- [x] Move only dock rendering to a focused component and measure the selected button with ResizeObserver. The final dock uses the active tab to collapse the panel and has no separate toggle button.

```ts
track.style.setProperty('--dock-active-x', `${selected.offsetLeft}px`);
track.style.setProperty('--dock-active-width', `${selected.offsetWidth}px`);
```

- [x] Style the shared capsule, translucent surfaces, fine edge highlights, blue selection and press feedback. Transition the panel using transform/opacity with a modest overshoot; remove transitions for reduced motion.
- [x] Refresh snapshots on open, navigation and settled viewport changes; cancel stale capture results.
- [x] Test draft retention, fast tab switching, close/reopen during motion, scrolling outside, rotation, reduced motion and stable browser dimensions.

### Task 4: Verify and package

**Files:** Modify Android `app/build.gradle` version; create `docs/qa/android-browser/liquid-glass-verification.md` and new artifacts in `release/android/` (ignored).

- [x] Run `npm test`, `npm run android:build`, and Android `:app:lintDebug`; fix actionable failures.
- [x] Run `node scripts/check-android-glass.mjs` and existing `node scripts/check-android-browser.mjs` against API 35 and API 29. Inspect actual screenshots in both themes, 320px and landscape.
- [x] Review final diff for touch races, mounted state, dialog priority, animation cleanup, capture work and unrelated changes.
- [x] Package version 1.1.0 (code 2), compute SHA256, and record exact verified behavior and debug signing. Preserve previous APKs. Deliver local APK without replacing the existing GitHub Release.

### Task 5: Complete drag, dissolve and repeated-tab interaction

**Files:** `src/components/MobileToolDock.tsx`, `src/mobile/dissolve.ts`, `src/mobile/useToolDissolve.ts`, `src/mobile.css`, `src/MobileApp.tsx`, `NativeWebViewPlugin.kt`, and both Android QA scripts.

- [x] Reproduce the previous APK showing eight controls where seven are required (observed: `8 !== 7`). Remove the separate toggle and close by tapping the active tab.
- [x] Add 320ms hold recognition, whole-pointer capture, continuous position/width/light updates, edge auto-scroll, cancellation on resize, and release selection; retain short-swipe scrolling.
- [x] Capture only the visible app-owned tool surface through bounded PixelCopy. Run a cancellable Canvas particle sweep over actual pixels; run immediately without particles for reduced motion, capture failure or automated task return. Keep screenshot bytes in memory only.
- [x] Apply common glass tokens to the seven tool pages, address and browser tabs, cards, buttons, editors, menus and dialogs. Keep one page frost layer to avoid repeated WebView blur composition bugs.
- [x] Verify repeated click toggling, native long-hold drag, correct released selection, edge scrolling, cancellation, real particles, interruption, input drafts and dialog priority. Run the complete existing browser checks on both emulators, package a new artifact without overwriting the earlier build.
