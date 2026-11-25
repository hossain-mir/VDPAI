/* VDPAI — Android native bridge helpers.
 *
 * Deliberately a no-op outside Capacitor.  It forwards the Android back button
 * to the top-most VDPAI overlay before minimising the app, and exposes a small
 * diagnostic hook used by the Control Center.
 */
(() => {
  const cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== "function" || !cap.isNativePlatform()) return;
  window.HSAI_NATIVE_BUILD = true;

  const isVisible = (node) => Boolean(node) && !node.hidden && window.getComputedStyle(node).display !== "none";

  function closeTopOverlay() {
    for (const id of ["promptModal", "confirmModal", "providerModal"]) {
      const node = document.getElementById(id);
      if (!isVisible(node)) continue;
      const cancel = id === "confirmModal" ? "confirmCancel" : id === "promptModal" ? "promptCancel" : "providerCancelBtn";
      document.getElementById(cancel)?.click();
      return true;
    }
    for (const id of ["controlCenter", "historySheet"]) {
      const node = document.getElementById(id);
      if (!isVisible(node)) continue;
      document.getElementById(id === "controlCenter" ? "ccClose" : "historyClose")?.click();
      return true;
    }
    return false;
  }

  function leaveApp() {
    if (typeof cap.nativePromise === "function") {
      cap
        .nativePromise("App", "minimizeApp", {})
        .catch(() => cap.nativePromise("App", "exitApp", {}))
        .catch(() => {});
      return;
    }
    if (typeof cap.nativeCallback === "function") cap.nativeCallback("App", "minimizeApp", {}, () => {});
  }

  if (typeof cap.nativeCallback === "function") {
    cap.nativeCallback("App", "addListener", { eventName: "backButton" }, () => {
      if (closeTopOverlay()) return;
      if (window.VDPAI && typeof window.VDPAI.handleBackNavigation === "function") {
        if (window.VDPAI.handleBackNavigation()) return;
      }
      leaveApp();
    });
  }

  window.VDPAI_NATIVE_BRIDGE = {
    closeTopOverlay,
    leaveApp,
    platform: "android",
  };
  window.HSAI_NATIVE_BRIDGE = window.VDPAI_NATIVE_BRIDGE;
})();
