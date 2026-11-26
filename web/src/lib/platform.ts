/** The desktop app hides the native title bar (see desktop/main.cjs), so the page has to leave room for the window controls. */
const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
export const inElectron = /Electron\//.test(ua);
export const electronMac = inElectron && /Mac/.test(ua);
export const electronOverlay = inElectron && !electronMac; // Windows / Linux: native buttons are drawn over the top-right corner

declare global { interface Window { factoryDesktop?: { showMenu: (x: number, y: number) => void } } }
/** Set by desktop/preload.cjs on Windows/Linux, where the app menu is a button here rather than a native bar. */
export const desktopMenu = (): Window["factoryDesktop"] => (typeof window === "undefined" ? undefined : window.factoryDesktop);
