import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.studypilot.android',
  appName: '学习通答题助手',
  webDir: 'dist',
  android: {
    buildOptions: {
      keystorePath: undefined,
    },
  },
  server: {
    // Allow the embedded WebView to reach external URLs (Xuexitong, AI APIs)
    allowNavigation: [
      '*.chaoxing.com',
      '*.xuexitong.com',
      '*.baidu.com',
      'openai.com',
      'dashscope.aliyuncs.com',
      'api.deepseek.com',
      'api.siliconflow.cn',
      'openrouter.ai',
      'generativelanguage.googleapis.com',
    ],
    cleartext: true, // some Xuexitong sub-domains use plain HTTP
  },
  plugins: {
    // The shared native browser/tool container owns system-bar and IME insets.
    // Capacitor's decor padding would subtract the keyboard height a second time.
    SystemBars: {
      insetsHandling: 'disable',
    },
    SplashScreen: {
      launchShowDuration: 0,
    },
  },
};

export default config;
