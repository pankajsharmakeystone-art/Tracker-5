<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1Cn17wxMG8487klqzHJ60OpO8kUeu6klV

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Dropbox Auto Refresh Setup

1. In the web dashboard, open **Application Settings** → **Dropbox**.
2. Enter your Dropbox App Key/Secret (from the Dropbox developer console) and click **Save Settings**.
3. Click **Generate Refresh Token**. A Dropbox popup opens and walks you through granting offline access.
4. After Dropbox shows "Connected", close the popup. The refresh token, short-lived access token, and expiry are stored in Firestore automatically.
5. Restart the Electron desktop app (or wait ~30 s) so it picks up the updated settings and refreshes tokens on demand.

> If you host Firebase Functions in a different region or emulator, set `VITE_FUNCTIONS_BASE_URL` so the dashboard button knows which endpoint to call.

## Desktop Releases & Auto-Update

1. **Build locally:** `npm run build` generates the Vite bundle consumed by Electron.
2. **Publish installers:** set `GH_TOKEN=<github personal access token with repo scope>` and run `npm run electron:release`. Electron Builder will package Windows (NSIS), macOS (DMG), and Linux (AppImage) installers and upload them to the `pankajsharmakeystone-art/Tracker-5` GitHub Releases page.
3. **Download button:** The landing page already links to `https://github.com/pankajsharmakeystone-art/Tracker-5/releases/latest`, so once the release is published the desktop app is available to end users immediately.
4. **Auto-update:** The bundled `electron-updater` checks GitHub Releases on launch. Every time you cut a new release (bump `version` in `package.json` and rerun the command above) clients download and install it automatically after restart.

> For dry runs without publishing, run `npm run electron:build` instead—the installers will be written to the `release/` folder locally.
