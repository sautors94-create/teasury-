// Proceso principal de Electron. Arranca sin build si se usa Vite dev server.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

function crearVentana() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "Sistema Integral de Tesorería",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  crearVentana();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});