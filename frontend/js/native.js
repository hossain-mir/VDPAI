/* JARVIS AI — Android native bridge.
 *
 * This file is a deliberate no-op in the browser.  Capacitor injects
 * `window.Capacitor` into the Android WebView before any page script runs,
 * which is how we detect the native build without bundling the frontend.
 *
 * We call the low-level bridge directly so the HUD keeps working without a
 * JavaScript bundler.  Registering an `App` backButton listener tells the
 * native plugin that JavaScript owns the back button; it then forwards every
 * press here instead of navigating/exiting on its own.
 */
(() => {
  const cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== "function" || !cap.isNativePlatform()) return;
  if (typeof cap.nativeCallback !== "function" || typeof cap.nativePromise !== "function") return;

  const isVisible = (node) =>
    !!node && !node.hidden && window.getComputedStyle(node).display !== "none";

  /** Close the top-most transient UI. Returns true when something was closed. */
  function closeOverlay() {
    const modal = document.getElementById("approvalModal");
    if (isVisible(modal)) {
      document.getElementById("rejectBtn")?.click();
      return true;
    }
    const sheet = document.getElementById("sheet");
    if (isVisible(sheet)) {
      document.querySelector("#sheet .sheet-head .icon-btn")?.click();
      return true;
    }
    return false;
  }

  function leaveApp() {
    cap
      .nativePromise("App", "minimizeApp", {})
      .catch(() => cap.nativePromise("App", "exitApp", {}))
      .catch(() => {
        /* last resort: native callback without a promise */
        cap.nativeCallback("App", "exitApp", {}, () => {});
      });
  }

  cap.nativeCallback("App", "addListener", { eventName: "backButton" }, () => {
    if (closeOverlay()) return;
    leaveApp();
  });

  // Expose a tiny test hook; harmless in production.
  window.JARVIS_NATIVE_BRIDGE = { closeOverlay, leaveApp };
})();
