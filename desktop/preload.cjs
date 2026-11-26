// The one thing the dashboard may ask of the desktop shell: show the app menu where its menu button is (Windows/Linux, where the native menu bar is hidden).
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("factoryDesktop", { showMenu: (x, y) => ipcRenderer.send("app-menu", Number(x) || 0, Number(y) || 0) });
