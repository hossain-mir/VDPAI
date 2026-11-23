/* Capacitor configuration for the JARVIS AI Android wrapper.
 *
 * The Python backend is NOT bundled into the APK.  Set JARVIS_BACKEND_URL to
 * the deployed HTTPS URL of the backend before building.  When it is set, the
 * WebView loads the app from that origin, so API calls, cookies and CSRF stay
 * same-origin and no secret is ever embedded in the APK.
 *
 * When the variable is empty the build falls back to the bundled copy in
 * www/ (same-origin only — intended for local development, not for a device
 * that is not running the backend).
 */
const backend = (process.env.JARVIS_BACKEND_URL || "").trim().replace(/\/+$/, "");

if (backend && !/^https:\/\//i.test(backend)) {
  throw new Error("JARVIS_BACKEND_URL must be an https:// URL for Android builds.");
}

const config = {
  appId: "com.jarvis.ai",
  appName: "JARVIS AI",
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
