/** The desktop app hides the native title bar (see desktop/main.cjs), so the page has to leave room for the window controls. */
const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
export const inElectron = /Electron\//.test(ua);
export const electronMac = inElectron && /Mac/.test(ua);
export const electronOverlay = inElectron && !electronMac; // Windows / Linux: native buttons are drawn over the top-right corner
