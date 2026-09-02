const { app, BrowserWindow, shell, dialog, ipcMain, nativeTheme } = require('electron');
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

  // RUNG 3 ON THE DESKTOP.
  //
  // These three are set for the web backend in `cloudbuild.yaml` and were set
  // NOWHERE for the desktop, so the packaged app quietly ran a different code
  // path from the site. `package.json`'s `build.files` ships no `.env` either,
  // which is correct — a packaged app must not carry credentials — but it left
  // the desktop with no way to reach the flags at all.
  //
  // MEASURED under packaged conditions (the built `dist/` copied to an empty
  // directory with no `.env`, launched with exactly the four variables above,
  // which is what makes the measurement meaningful: run the same bundle from
  // the repo instead and dotenv silently loads the repo's own `.env`, the app
  // finds credentials it could never have when packaged, and the answer
  // changes to `source: 'llm'`):
  //
  //   without these flags   source: 'deterministic', report: null — the desktop
  //                         app produced NO explanation and NO scenario at all
  //   with these flags      source: 'template', solver-rendered prose, and a
  //                         scenario from the bundled bank: 20 requests on one
  //                         game returned 20 DISTINCT names, no network, no key
  //
  // The bank is consulted inside `inventScenario`, which the main report path
  // only reaches through `NASH_PAYOFF_TEMPLATE === '1'`. So the offline story
  // bank shipped for exactly this app was unreachable from its report panel
  // until these lines existed. (It was already reachable from the "New AI
  // scenario" button, which takes the separate `scenarioOnly` path — that one
  // returned bank scenarios without any flag.)
  //
  // At rung 3 the solver renders every mathematical sentence and the bank
  // supplies the story, so the desktop needs neither a model nor a network.
  // `src/electronenv.contract.test.ts` fails if any of the three is dropped.
  process.env.NASH_PAYOFF_TEMPLATE = '1';
  process.env.NASH_LLM_TIES = 'template';
  process.env.NASH_DIRECTION_CHECKS = '1';

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

  // The backend's own data-directory lock (server.ts's acquireDesktopLock)
  // used to fail with a bare `process.exit(1)` on every path, which — because
  // that file is require()'d IN-PROCESS below, not spawned — silently killed
  // this ENTIRE Electron main process before any window ever existed: no
  // dialog, no crash report, nothing in the unified log. A user hitting this
  // (routine after any crash/force-quit, since the pid the stale lock
  // recorded gets reused by an unrelated process eventually) saw the dock
  // icon bounce once and nothing else, forever, with no way to know why.
  // (RED-DESKTOP-4/001-reused-pid-silent-app-vanish.md)
  //
  // Registering this hook BEFORE requiring the server is what tells
  // server.ts "someone can show a dialog" — its own check is exactly this
  // global's presence. A real dialog turns the failure into something a
  // user can act on immediately: quit the other copy, or — since the
  // failure is frequently a MISIDENTIFIED lock (a reused pid, not a real
  // second instance) — go find the dotfile themselves instead of it staying
  // hidden forever.
  //
  // Deliberately NOT an automatic "delete the lock and relaunch" button
  // (CodeRabbit caught this on review): `acquireDesktopLock` reaches this
  // hook only after `process.kill(heldBy, 0)` said the recorded pid IS
  // alive right now — which is equally true whether that pid is a reused,
  // unrelated process OR a genuine second copy of this app. The app cannot
  // tell those apart (no process-identity check exists), so an automatic
  // delete-and-relaunch would just as often start a REAL second writer
  // against the same db.json as it would recover from a false positive —
  // exactly the data-loss scenario this whole lock exists to prevent. The
  // safer action a click can take is "Show Lock File", which reveals its
  // location so a user who has actually checked (e.g. Activity Monitor —
  // no OTHER copy of Nash Equilibrium Simulator running) can delete it
  // themselves; the app never performs the destructive step on its own.
  global.onDesktopLockFailure = ({ message, lockFile }) => {
    dialog.showMessageBox({
      type: 'error',
      buttons: ['Quit', 'Show Lock File'],
      defaultId: 0,
      cancelId: 0,
      title: 'Nash Equilibrium Simulator — Startup Blocked',
      message: 'Nash Equilibrium Simulator could not start.',
      detail: `${message}\n\nIf you're sure no other copy is running, "Show Lock File" reveals it `
        + 'so you can delete it yourself, then relaunch.',
    }).then((result) => {
      if (result.response === 1) {
        shell.showItemInFolder(lockFile);
        // Leave the (now-informed, still-blocked) app running rather than
        // quitting out from under a user who is mid-cleanup in Finder.
        return;
      }
      app.exit(0);
    }).catch((err) => {
      // The dialog itself failed to show — still must not leave the process
      // silently hanging with no window and no way out.
      console.error('Failed to show the startup-blocked dialog:', err);
      app.exit(1);
    });
  };

  // Boot our compiled full-stack Express server inside Electron
  try {
    require('./dist/server.cjs');
  } catch (err) {
    console.error("Failed to start the integrated backend Express server:", err);
  }

  // The renderer reports its theme (App.tsx darkMode effect, via the preload
  // bridge) so the native window background always matches the page. Without
  // this the native color shows as a white strip whenever a drag-resize
  // outpaces the repaint. Registered once, resolves the window per-sender.
  ipcMain.on('set-background-color', (event, color) => {
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.setBackgroundColor(color);
  });

  function createWindow(portToUse) {
    const finalPort = portToUse || expressPort;
    const windowOptions = {
      width: 1200,
      height: 800,
      title: "Nash Equilibrium Simulator",
      // Pre-load guess only: the app persists its own theme in localStorage,
      // which main cannot read before the page runs, so start from the OS
      // preference and let the renderer correct it on mount. Colors mirror
      // the page root (bg-slate-50 / dark:bg-slate-950).
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#020617' : '#f8fafc',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, 'electron-preload.cjs'),
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
