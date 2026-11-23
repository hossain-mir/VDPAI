/* Capacitor configuration for HSAI 2.0 Android.
 *
 * The Python backend is NOT bundled into the APK.  Normally this variable is
 * left empty: the HUD in www/ is packaged locally and launches offline. The
 * backend URL is configured later in System → Backend server.
 *
 * For a local build you may optionally set HSAI_BACKEND_URL (or the legacy
 * JARVIS_BACKEND_URL) to a deployed
 * HTTPS URL.  Then the WebView loads the app from that origin, so API calls,
 * cookies and CSRF stay same-origin.  No secret is ever embedded in the APK.
 */
const backend = (process.env.HSAI_BACKEND_URL || process.env.JARVIS_BACKEND_URL || "").trim().replace(/\/+$/, "");

if (backend && !/^https:\/\//i.test(backend)) {
  throw new Error("HSAI_BACKEND_URL must be an https:// URL for Android builds.");
}

const config = {
  appId: "com.hsai.assistant",
  appName: "HSAI 2.0",
  webDir: "www",
  android: {
    // Never allow an HTTPS WebView to load plaintext HTTP subresources.
    allowMixedContent: false,
  },
  plugins: {
    App: {
      // Keep native default handling enabled; our JS listener takes priority
      // and closes overlays before minimizing the app.
      disableBackButtonHandler: false,
    },
  },
};

if (backend) {
  config.server = { url: backend };
}

module.exports = config;
