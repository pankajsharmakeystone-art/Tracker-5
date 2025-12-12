const { contextBridge, ipcRenderer } = require("electron");

// Listen for main instructing to clear local desktop UID (prevent auto-register on restart)
try {
  ipcRenderer.on("clear-desktop-uid", () => {
    try { localStorage.removeItem("desktop-uid"); } catch(e) {}
  });
} catch(e) {}

contextBridge.exposeInMainWorld("desktopAPI", {
  // handshake
  onReady: (cb) => ipcRenderer.on("desktop-ready", (e, data) => cb(data)),
  onRegistered: (cb) => ipcRenderer.on("desktop-registered", (e, data) => cb(data)),

  // register/unregister uid (webapp should call registerUid after login)
  registerUid: (payload) => ipcRenderer.invoke("register-uid", payload),
  unregisterUid: () => ipcRenderer.invoke("unregister-uid"),
  syncAdminSettings: (settings) => ipcRenderer.invoke("sync-admin-settings", settings),

  // allow web to tell desktop about agent status changes
  // supported statuses: 'working', 'on_break'|'break', 'clocked_out'|'offline'
  setAgentStatus: (status) => ipcRenderer.invoke("set-agent-status", status),

  // recording flow
  requestScreenSources: () => ipcRenderer.invoke("start-recording"),
  stopRecording: (meta) => ipcRenderer.invoke("stop-recording", meta || {}),
  notifyRecordingSaved: (fileName, data, meta = {}) => ipcRenderer.invoke("notify-recording-saved", fileName, data, meta || {}),

  // idle
  getIdleTime: () => ipcRenderer.invoke("get-idle-time"),

  // upload
  uploadToDropbox: (filePath) => ipcRenderer.invoke("upload-dropbox", filePath),

  // NEW: expose recording quality (renderer can use resolution returned from start-recording,
  // or request explicitly if needed)
  getRecordingQuality: () => {
    return ipcRenderer.invoke("get-idle-time").then(() => {
      return { note: "Call start-recording to receive resolution in response" };
    });
  },

  // Sign-out confirmation flow
  // Query desktop whether user is currently clocked in
  requestSignOut: () => ipcRenderer.invoke("request-sign-out"),

  // Perform clock out and then unregister (used if user chooses "Clock Out & Sign Out")
  clockOutAndSignOut: () => ipcRenderer.invoke("clock-out-and-sign-out"),

  // admin commands sent from main to renderer
  onCommandStartRecording: (cb) => ipcRenderer.on("command-start-recording", (e, data) => cb(data)),
  onCommandStopRecording: (cb) => ipcRenderer.on("command-stop-recording", (e, data) => cb(data)),
  onCommandForceBreak: (cb) => ipcRenderer.on("command-force-break", (e, data) => cb(data)),
  onSettingsUpdated: (cb) => ipcRenderer.on("settings-updated", (e, data) => cb(data)),
  onDesktopRequestEndBreak: (cb) => {
    if (typeof cb !== "function") return () => {};
    const handler = (_event, data) => cb(data);
    ipcRenderer.on("desktop-request-end-break", handler);
    return () => ipcRenderer.removeListener("desktop-request-end-break", handler);
  },

  // auto-clocked-out notification
  onAutoClockOut: (cb) => {
    if (typeof cb !== "function") return () => {};
    const handler = (_event, data) => cb(data);
    ipcRenderer.on("auto-clocked-out", handler);
    return () => ipcRenderer.removeListener("auto-clocked-out", handler);
  },

  // signed-out notification (desktop forced logout / manual sign-out)
  onSignedOut: (cb) => {
    if (typeof cb !== "function") return () => {};
    const handler = (_event, data) => cb(data);
    ipcRenderer.on("signed-out", handler);
    return () => ipcRenderer.removeListener("signed-out", handler);
  },

  // renderer -> main error reporting (best-effort crash telemetry)
  reportError: (payload) => ipcRenderer.invoke("report-renderer-error", payload),

  // basic ping
  ping: () => ipcRenderer.invoke("ping"),

  // app helper
  minimizeToTray: () => ipcRenderer.send("minimize-to-tray"),
  setAutoLaunch: (enable) => ipcRenderer.invoke("set-auto-launch", enable),

  // LOCK-SCREEN end-break API (invoked by the fullscreen lock UI)
  endBreak: () => ipcRenderer.invoke("end-break-from-lock-screen"),

  // Live streaming helpers
  getLiveStreamSources: () => ipcRenderer.invoke("live-stream-get-sources")
,
  // Auto-update bridge
  onAutoUpdateStatus: (cb) => {
    if (typeof cb !== "function") return () => {};
    const handler = (_event, data) => cb(data);
    ipcRenderer.on("auto-update-status", handler);
    return () => ipcRenderer.removeListener("auto-update-status", handler);
  },
  requestImmediateUpdateCheck: () => ipcRenderer.invoke("auto-check-updates"),
  installPendingUpdate: () => ipcRenderer.invoke("auto-install-update")
});
