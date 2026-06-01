const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: 'hidden', // Creates a modern frameless titlebar look
    trafficLightPosition: { x: 12, y: 12 }, // Aligns Mac window controls
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js') // Optional helper
    }
  });

  // Load the React production build
  mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));

  // Optional: Auto-unhide menu bar on Mac
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

// Support standard macOS lifecycle behavior
app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});