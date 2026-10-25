package com.studypilot.android;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeWebViewPlugin.class);
        super.onCreate(savedInstanceState);
        // NativeWebViewPlugin applies insets once to both WebViews. Keep the
        // system from also fitting/resizing content on pre-edge-to-edge Android.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        // NativeWebViewPlugin installs the browser and transparent tool overlay.
    }
}
