/* Capacitor configuration for VDPAI.
 *
 * The HUD is always bundled locally in www/ and launches offline.  No remote
 * WebView URL and no backend are required.  An optional default backend URL can
 * be provided at build time via HSAI_BACKEND_URL, but it is only written into
 * the editable in-app setting.
 */
const config = {
  appId: "com.hsai.assistant",
  appName: "VDPAI",
  webDir: "www",
  android: {
    allowMixedContent: false,
  },
  plugins: {
    App: {
      disableBackButtonHandler: false,
    },
  },
};

module.exports = config;
