// Puente seguro entre renderer y main (sin nodeIntegration).
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("teasury", {
  plataforma: process.platform,
  version: process.versions.electron,
});