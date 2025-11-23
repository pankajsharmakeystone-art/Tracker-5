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
  registerUid: (uid) => ipcRenderer.invoke("register-uid", uid),
  unregisterUid: () => ipcRenderer.invoke("unregister-uid"),

  // allow web to tell desktop about agent status changes
  // supported statuses: 'working', 'on_break'|'break', 'clocked_out'|'offline'
  setAgentStatus: (status) => ipcRenderer.invoke("set-agent-status", status),

  // recording flow
  requestScreenSources: () => ipcRenderer.invoke("start-recording"),
  stopRecording: () => ipcRenderer.invoke("stop-recording"),
  notifyRecordingSaved: (fileName, data) => ipcRenderer.invoke("notify-recording-saved", fileName, data),

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

  // auto-clocked-out notification
  onAutoClockOut: (cb) => ipcRenderer.on("auto-clocked-out", (e, data) => cb(data)),

  // basic ping
  ping: () => ipcRenderer.invoke("ping"),

  // app helper
  minimizeToTray: () => ipcRenderer.send("minimize-to-tray"),
  setAutoLaunch: (enable) => ipcRenderer.invoke("set-auto-launch", enable),

  // LOCK-SCREEN end-break API (invoked by the fullscreen lock UI)
  endBreak: () => ipcRenderer.invoke("end-break-from-lock-screen")
});
