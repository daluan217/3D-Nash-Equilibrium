const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');

// Override the package.json "name" so the macOS app menu (About/Hide/Quit)
// reads the product name instead of the template default ("react-example").
app.setName('Nash Equilibrium Simulator');

// Public site that hosts the latest DMG + version manifest (served from GCS via Cloud Run).
const UPDATE_BASE_URL = 'https://nash-equilibrium-simulator.com';

// Numeric semver compare: returns 1 if a > b, -1 if a < b, 0 if equal.
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// Ask the public site for the latest version; if newer than this build, offer the download.
async function checkForUpdates(parentWindow) {
  try {
    const res = await fetch(`${UPDATE_BASE_URL}/api/version`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const latest = data && data.version;
    if (!latest) return;

    const current = app.getVersion();
    if (compareVersions(latest, current) <= 0) return;

    const choice = await dialog.showMessageBox(parentWindow, {
      type: 'info',
      buttons: ['Download Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Available',
      message: `A new version (${latest}) of Nash Equilibrium Simulator is available.`,
      detail: `You're on ${current}. Download the latest version and reinstall to update.`,
    });
    if (choice.response === 0) {
      shell.openExternal(`${UPDATE_BASE_URL}/api/download/dmg`);
    }
  } catch (err) {
    // Offline or endpoint unavailable should never disrupt the app.
    console.error('Update check failed:', err);
  }
}

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
  let updateCheckDone = false;

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
      windowOptions.trafficLightPosition = { x: 16, y: 12 };
    }

    mainWindow = new BrowserWindow(windowOptions);
    mainWindow.webContents.setZoomFactor(1.33);

    // Load the Express-served application on loopback
    mainWindow.loadURL(`http://127.0.0.1:${finalPort}`);

    // Notify renderer of macOS native fullscreen transitions
    const dispatchFullscreen = (value) => {
      mainWindow.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('electron-fullscreen-change', { detail: ${value} }))`
      ).catch(() => {});
    };
    mainWindow.on('enter-full-screen', () => dispatchFullscreen(true));
    mainWindow.on('leave-full-screen', () => dispatchFullscreen(false));

    // Open external links (e.g. documentation, help pages) in standard Safari/default browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    mainWindow.on('closed', function () {
      mainWindow = null;
    });

    // Check for a newer published version once, shortly after the first window opens.
    if (!updateCheckDone) {
      updateCheckDone = true;
      setTimeout(() => checkForUpdates(mainWindow), 3000);
    }
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
