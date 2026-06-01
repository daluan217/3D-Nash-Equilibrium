const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

// Prevent multiple instances from running concurrently (prevents port collisions)
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // Set environment parameters before requiring backend compiled server
  process.env.NODE_ENV = 'production';
  process.env.PORT = '14321';
  process.env.IS_ELECTRON = 'true';
  process.env.ELECTRON_USER_DATA_PATH = app.getPath('userData');

  let serverStarted = false;
  let expressPort = 14321;
  let mainWindow = null;

  global.onExpressListening = (port) => {
    expressPort = port;
    serverStarted = true;
    if (app.isReady() && !mainWindow) {
      createWindow(port);
    } else if (mainWindow) {
      mainWindow.loadURL(`http://127.0.0.1:${port}`);
    }
  };

  // Boot our compiled full-stack Express server inside Electron
  try {
    require('./dist/server.cjs');
  } catch (err) {
    console.error("Failed to start the integrated backend Express server:", err);
  }

  function createWindow(portToUse) {
    const finalPort = portToUse || expressPort;
    const windowOptions = {
      width: 1200,
      height: 800,
      title: "Nash Equilibrium Simulator",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      }
    };

    // On macOS, infuse the top bar (traffic lights) directly into the app
    if (process.platform === 'darwin') {
      windowOptions.titleBarStyle = 'hidden';
      windowOptions.trafficLightPosition = { x: 16, y: 16 };
    }

    mainWindow = new BrowserWindow(windowOptions);

    // Load the Express-served application on loopback
    mainWindow.loadURL(`http://127.0.0.1:${finalPort}`);

    // Open external links (e.g. documentation, help pages) in standard Safari/default browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    mainWindow.on('closed', function () {
      mainWindow = null;
    });
  }

  // Handle second instance activation
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Ensure Electron lifecycle events are managed
  app.on('ready', () => {
    if (serverStarted) {
      createWindow(expressPort);
    } else {
      // Fallback in case of slow boot sequence
      setTimeout(() => {
        if (!mainWindow) {
          createWindow(expressPort);
        }
      }, 800);
    }
  });

  app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', function () {
    if (mainWindow === null) {
      createWindow(expressPort);
    }
  });
}
