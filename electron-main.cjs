const { app, BrowserWindow, Menu, shell, dialog, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

// Override the package.json "name" so the macOS app menu (About/Hide/Quit)
// reads the product name instead of the template default ("react-example").
app.setName('Nash Equilibrium Simulator');

// Public site that hosts the latest DMG + version manifest (served from GCS via Cloud Run).
const UPDATE_BASE_URL = 'https://nash-equilibrium-simulator.com';

// A version is exactly three dot-separated integers. Anything else is not a
// version and must never be compared as one.
//
// BLUE-LOOP-DESKTOP-22 (reviewer finding, reproduced): `parseInt` accepts a
// LEADING integer and discards the rest, so the old compare read
// `'0.0.224abc'` as 0.0.224 and `'999junk.0.0'` as 999.0.0 — both "newer" than
// 0.0.223, both prompting every installed copy to download. `'1.0.0-beta.1'`
// did the same. A corrupted or hand-edited app-version.json therefore drove
// the update prompt.
const VERSION_RE = /^\d+\.\d+\.\d+$/;
function isVersion(v) { return typeof v === 'string' && VERSION_RE.test(v); }

// Numeric semver compare: returns 1 if a > b, -1 if a < b, 0 if equal.
// A non-version NEVER compares greater — the caller treats 0 as "no update".
function compareVersions(a, b) {
  if (!isVersion(a) || !isVersion(b)) return 0;
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// The ONLY scheme that may be handed to the operating system. `shell.openExternal`
// launches the default handler for whatever it is given: `file://` opens Finder on an
// arbitrary path, `smb://` reaches for a network share, and macOS resolves any custom
// scheme an installed app has registered. Every caller below takes a URL the RENDERER
// chose. The app's own outbound links are https; its local server is reached with
// loadURL, never openExternal, so http: buys nothing and is not allowed.
const EXTERNAL_URL_SCHEMES = new Set(['https:']);
function openExternalIfSafe(rawUrl) {
  let parsed = null;
  try { parsed = new URL(String(rawUrl)); } catch { /* not a URL at all */ }
  if (!parsed || !EXTERNAL_URL_SCHEMES.has(parsed.protocol)) {
    console.warn(`Refused to open an external URL with an unsupported scheme: ${String(rawUrl).slice(0, 120)}`);
    return false;
  }
  // `https://apple.com@attacker.example/signin` IS https, and its host is
  // attacker.example. The scheme check above passes it. No link this app owns
  // carries userinfo, and a URL that does either hands the OS a credential or
  // reads as an origin it is not — so the gate refuses the shape outright.
  if (parsed.username !== '' || parsed.password !== '') {
    console.warn(`Refused to open an external URL carrying userinfo, real host ${parsed.host}`);
    return false;
  }
  Promise.resolve(shell.openExternal(parsed.toString())).catch((err) => {
    console.warn(`The operating system refused to open ${parsed.origin}: ${err && err.message}`);
  });
  return true;
}

// Where the renderer may send this app. `setWindowOpenHandler` only sees
// window.open/target=_blank; a plain <a href> or location.href navigates THIS
// window, and with titleBarStyle 'hidden' there is no URL bar to reveal that the
// full-bleed page became a remote origin. Same policy for every door: stay on the
// app's own origin, hand anything else to the OS through the scheme filter above.
//
// It is assigned through `loadAppOrigin` and NOWHERE else, because the port is
// not fixed: server.ts retries port+1 on EADDRINUSE (another copy of the app,
// or anything else already on 14321) and reports the port it finally bound via
// `onExpressListening`. That arrives AFTER the window exists whenever the
// 800ms slow-boot fallback has already fired — which is precisely the case
// where the server was slow because it was walking the port range. Setting
// appOrigin only inside createWindow() left the policy naming the dead port
// after such a move: measured, every in-app navigation was preventDefault'd
// and handed to shell.openExternal (refused there only by the scheme filter,
// so the click did nothing at all), while the PREVIOUS port — now owned by
// whatever process took it — stayed on the allowlist.
let appOrigin = null;

// The window's URL and the navigation allowlist are one decision, so they are
// one function: the origin can never name a port the window is not on.
// Gate review #8, finding 7: the assignment used to come FIRST, so if loadURL
// threw (a destroyed-but-not-yet-nulled window in the port-move arm — the
// 'closed' handler that nulls mainWindow runs after the event), the allowlist
// was left naming a port with no live window on it. Load first, allow second:
// a failed load leaves the previous origin, which is the only origin a live
// window is actually on.
function loadAppOrigin(win, port) {
  const origin = `http://127.0.0.1:${port}`;
  // Gate review #8 finding 7: do not update the allowlist before calling
  // loadURL. A destroyed-but-not-yet-nulled window can throw synchronously in
  // the port-move arm; preserving the previous origin is then safer than
  // authorising an origin no live window reached.
  win.loadURL(origin);
  appOrigin = origin;
}

// BLUE-LOOP-DESKTOP-22, angle G. Electron GRANTS most renderer permission
// requests when no handler is installed, and none was. MEASURED against the
// live 0.0.223 DMG over CDP: `getUserMedia({audio:true})` produced no
// synchronous refusal — it reached the OS, where a macOS microphone prompt
// would name this app (electron-builder's default Info.plist already ships
// NSMicrophoneUsageDescription/NSCameraUsageDescription, so the prompt has
// copy to show). This app is an offline 2x2-game visualiser: the ONLY
// permission-gated API anywhere in src/ is `navigator.clipboard.writeText`
// (DownloadModal's copy buttons), which needs no grant. So the honest policy
// is a default-deny allowlist, not a per-permission patch: a capability that
// arrives in a future Chromium is denied by default instead of inheriting a
// yes. `media` covers camera+microphone+display-capture.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);
function applyPermissionPolicy(ses) {
  if (!ses || ses.__nashPermissionPolicy) return;
  ses.__nashPermissionPolicy = true;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  // The REQUEST handler alone is not enough: Chromium consults the CHECK
  // handler for synchronous queries (navigator.permissions.query, and the
  // pre-flight some APIs run), and its default also says yes.
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  // Device pickers (WebHID/WebUSB/Bluetooth) ask separately; returning null
  // is "no device", i.e. nothing to hand over.
  if (typeof ses.setDevicePermissionHandler === 'function') ses.setDevicePermissionHandler(() => false);
}

const hardenedContents = new WeakSet();
function hardenWebContents(contents) {
  if (!contents || hardenedContents.has(contents)) return;
  hardenedContents.add(contents);
  // Per-contents, not once at startup: a webview or popup can carry its own
  // session, and a partition created later would otherwise start unpoliced.
  applyPermissionPolicy(contents.session);
  contents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: 'deny' };
  });
  const keepInApp = (event, url) => {
    let origin = null;
    try { origin = new URL(String(url)).origin; } catch { /* not a URL at all */ }
    if (appOrigin !== null && origin === appOrigin) return;
    event.preventDefault();
    openExternalIfSafe(url);
  };
  contents.on('will-navigate', keepInApp);
  // Electron 31 passes ONE argument here (an Event carrying `url`); older/newer
  // shapes pass (event, details). preventDefault must land on the event either
  // way, so take the URL from whichever argument carries it. Both shapes probed.
  contents.on('will-frame-navigate', (event, details) => {
    keepInApp(event, (details && details.url) || (event && event.url));
  });
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
      openExternalIfSafe(`${UPDATE_BASE_URL}/api/download/dmg`);
    }
  } catch (err) {
    // Offline or endpoint unavailable should never disrupt the app.
    console.error('Update check failed:', err);
  }
}

// RED-DESKTOP-21/002: the desktop app is an offline math tool, so it must talk
// to loopback and its own domain only. MEASURED, with the idle-egress harness
// (_gen/blue21-bg-network.mjs, 40 snapshots over 20s of pure idle, no request
// ever sent to the app's own server):
//   before             39/40 snapshots non-loopback; 142.250.190.238, 142.250.68.200
//   gtag gated only     7/40; ONLY 216.239.36.21 = nash-equilibrium-simulator.com
//   ungated + switches 38/40; 142.250.x back
// So index.html's analytics gate is what closes the egress; the 142.250.x hosts
// were googletagmanager/google-analytics, not Chromium's variations seed. No
// switch below showed a measured effect, so only the one documented primary
// guard is kept, as defense-in-depth if a Chromium default changes — the rest
// (component-update, domain-reliability, client-side-phishing-detection, sync,
// no-pings, metrics-recording-only, safebrowsing-disable-auto-update,
// variations-server-url, the ChromeVariations feature token) were dropped
// rather than shipped unmeasured; an empty `variations-server-url` in
// particular falls back to the default Google URL, so it was worse than absent.
// Must precede app ready: Chromium reads its command line during startup, so a
// switch appended later is simply ignored. The app's only remaining egress is
// its own disclosed update check against UPDATE_BASE_URL (checkForUpdates).
app.commandLine.appendSwitch('disable-background-networking');

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
  // RED-DESKTOP-5/002: `startServer()` returns before initDB()/listen() on
  // the lock-failure path, so `serverStarted` never becomes true and
  // `expressPort` never advances past its hard-coded initial value — but the
  // 800ms "slow boot sequence" fallback below and `app.on('activate')` were
  // both unconditional on that alone, so ~800ms after `app.on('ready')` (or
  // on a dock-icon click while the blocking dialog is still up) they called
  // `createWindow(14321)` anyway. Nothing is listening there (correctly —
  // the server never bound a port), so a second, blank `BrowserWindow`
  // opened showing Chromium's own chrome-error://chromewebdata/ page RIGHT
  // ALONGSIDE the correct native "Startup Blocked" dialog — live-reproduced
  // via CDP against the packaged .app. Fixed two ways, deliberately: the
  // fallback timer is CANCELLED outright the moment a lock failure is known
  // (so it can never fire at all, the primary fix — cancelling beats
  // checking, since a cancelled timer cannot race anything), and
  // `lockFailurePending` is kept as defense-in-depth for `app.on('activate')`,
  // which has no timer to cancel (a dock-icon click can happen at any time
  // while the dialog is still up).
  let lockFailurePending = false;
  let slowBootFallbackTimer = null;

  global.onExpressListening = (port) => {
    expressPort = port;
    serverStarted = true;
    if (app.isReady() && !mainWindow) {
      createWindow(port);
    } else if (mainWindow) {
      // Moves the navigation allowlist with the window — see `appOrigin`.
      loadAppOrigin(mainWindow, port);
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
  // safer action a click can take is "Show Location", which reveals it in
  // Finder so a user who has actually checked (e.g. Activity Monitor — no
  // OTHER copy of Nash Equilibrium Simulator running) can delete/repair it
  // themselves; the app never performs the destructive step on its own.
  //
  // `lockFile` is named for its original, and still most common, case (the
  // `.server.lock` file itself) but is NOT always a file: RED-DESKTOP-5b
  // added a second, directory-creation failure site that also routes
  // through this same hook and passes the DIRECTORY path instead — and in
  // THAT case the path may not exist at all (that is exactly why it
  // failed). `shell.showItemInFolder`'s behavior on a nonexistent path is
  // undefined (CodeRabbit, this round), so `revealLockLocation` below picks
  // between it and `shell.openPath` on the nearest existing ancestor,
  // rather than assuming the target is a real, existing file.
  // `target` is normally the `.server.lock` file (exists — reveal it
  // directly, selected, so the user can inspect/delete it). For the
  // directory-creation failure site, `target` is the user-data directory
  // itself, which may legitimately NOT exist (that IS the failure). Walk up
  // to the nearest existing ancestor and open THAT instead — `path.dirname`
  // on a root path is a fixed point, so this always terminates.
  async function revealLockLocation(target) {
    try {
      if (fs.existsSync(target)) {
        shell.showItemInFolder(target);
        return;
      }
      let dir = path.dirname(target);
      while (!fs.existsSync(dir)) {
        const parent = path.dirname(dir);
        if (parent === dir) break; // reached the filesystem root; stop rather than loop forever
        dir = parent;
      }
      // CodeRabbit (this round): shell.openPath resolves with a NON-EMPTY
      // error string on failure rather than rejecting — an un-awaited call
      // silently swallows that, leaving the blocked user with no feedback
      // at all after clicking "Show Location".
      const openErr = await shell.openPath(dir);
      if (openErr) console.error(`Failed to open ${dir} in the file manager:`, openErr);
    } catch (err) {
      console.error('Failed to reveal the lock/data-directory location:', err);
    }
  }

  global.onDesktopLockFailure = ({ message, lockFile, kind = 'lock', candidateCount }) => {
    lockFailurePending = true;
    // Cancel the slow-boot fallback outright — a cancelled timer cannot fire
    // regardless of what races it against (see this block's own comment
    // above). No-op if `app.on('ready')` has not scheduled it yet (the
    // `require('./dist/server.cjs')` call below runs before `ready` in the
    // normal Electron startup order, so this is typically the case) or if
    // the `serverStarted` branch never scheduled one at all.
    if (slowBootFallbackTimer !== null) {
      clearTimeout(slowBootFallbackTimer);
      slowBootFallbackTimer = null;
    }
    dialog.showMessageBox({
      type: 'error',
      buttons: ['Quit', 'Show Location'],
      defaultId: 0,
      cancelId: 0,
      title: 'Nash Equilibrium Simulator — Startup Blocked',
      message: 'Nash Equilibrium Simulator could not start.',
      // CodeRabbit (this round): this app's own single-instance lock
      // (app.requestSingleInstanceLock, above) means clicking the Dock icon
      // or double-clicking the app again WITHOUT quitting this blocked
      // process first does nothing visible — 'second-instance' only
      // focuses `mainWindow`, which was deliberately never created on this
      // path (RED-DESKTOP-5/002), so the new launch attempt silently exits
      // with no window, no error, nothing to notice. The old wording ("...
      // then relaunch") told the user to do exactly the thing that fails
      // silently. Now says explicitly to quit THIS app first.
      detail: kind === 'data-conflict'
        // `candidateCount` may be 1 when a conflict copy exists with no
        // primary db.json yet (e.g. it synced in before this machine ever
        // created its own) — the wording must not claim "both" files when
        // only one is actually on disk.
        ? candidateCount === 1
          ? `${message}\n\n"Show Location" reveals the detected file. Back it up before resolving the conflict. `
            + 'This app will not choose, merge, rename, or delete it. When you\'re done, quit this app (it will not '
            + 'start normally while blocked), then relaunch it.'
          : `${message}\n\n"Show Location" reveals the detected conflict copy. Back up both database files before resolving the conflict. `
            + 'This app will not choose, merge, rename, or delete either copy. When you\'re done, quit this app (it will not '
            + 'start normally while blocked), then relaunch it.'
        : `${message}\n\nIf you're sure no other copy is running, "Show Location" reveals it `
          + 'so you can inspect/delete it yourself. When you\'re done, quit this app (it will not '
          + 'start normally while blocked), then relaunch it.',
    }).then((result) => {
      if (result.response === 1) {
        revealLockLocation(lockFile);
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

  // Electron installs a DEFAULT application menu when none is set, and its View
  // submenu carries live `toggleDevTools`, `reload` and `forceReload` roles — a
  // shipped inspector on the production renderer (RED-DESKTOP-21/001). Replace it
  // with an explicit template: keep what a user needs (app/edit/window roles,
  // zoom, fullscreen) and omit the whole `viewMenu` role, which would re-expand
  // into exactly those three. Reload is dropped on purpose too: this is an SPA
  // whose state lives in memory, so a reload silently discards the user's game.
  function installApplicationMenu() {
    if (process.platform !== 'darwin') {
      // Off macOS the menu bar is per-window chrome the app does not use, and
      // clipboard/zoom shortcuts work without it. No menu at all = no default.
      Menu.setApplicationMenu(null);
      return;
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]));
  }

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
        // Unconditional, not `!app.isPackaged`: this kills the capability at the
        // webContents level, so no menu item, accelerator, or stray
        // openDevTools() call anywhere can open an inspector on the renderer.
        // Cost: `npm run electron:start` has no inspector either; debug the same
        // UI in the browser via `npm run dev`, which is where it is debugged anyway.
        devTools: false,
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
    loadAppOrigin(mainWindow, finalPort);

    // Notify renderer of macOS native fullscreen transitions
    const dispatchFullscreen = (value) => {
      mainWindow.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('electron-fullscreen-change', { detail: ${value} }))`
      ).catch(() => {});
    };
    mainWindow.on('enter-full-screen', () => dispatchFullscreen(true));
    mainWindow.on('leave-full-screen', () => dispatchFullscreen(false));

    // Open external links in Safari/the default browser, and keep this window on the app.
    hardenWebContents(mainWindow.webContents);

    mainWindow.on('closed', function () {
      mainWindow = null;
    });

    // Check for a newer published version once, shortly after the first window opens.
    if (!updateCheckDone) {
      updateCheckDone = true;
      setTimeout(() => checkForUpdates(mainWindow), 3000);
    }
  }

  // Any other webContents Electron creates (webview, devtools-opened child) gets the
  // same policy; the WeakSet keeps the main window from being hardened twice.
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));

  // Handle second instance activation
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Ensure Electron lifecycle events are managed
  app.on('ready', () => {
    installApplicationMenu();
    if (serverStarted) {
      createWindow(expressPort);
    } else {
      // Fallback in case of slow boot sequence. Must NOT fire while a lock
      // failure is in progress (RED-DESKTOP-5/002) — that path deliberately
      // never starts the server, so `serverStarted` staying false here is
      // not "slow", it is "never coming", and creating a window would only
      // ever load a dead port. `onDesktopLockFailure` cancels this timer
      // outright the moment it knows that (see its own comment); the
      // `!lockFailurePending` check is defense-in-depth for a lock failure
      // detected in the narrow window before this line runs.
      slowBootFallbackTimer = setTimeout(() => {
        slowBootFallbackTimer = null;
        if (!mainWindow && !lockFailurePending) {
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
    // Same guard as the ready-fallback above: a dock-icon click while the
    // "Startup Blocked" dialog is still up (mainWindow is still null) must
    // not open a second, blank, dead-port window behind/alongside it.
    if (mainWindow === null && !lockFailurePending) {
      createWindow(expressPort);
    }
  });
}
