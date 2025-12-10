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
3. Copy `.env.example` to `.env.local` (web) and, if you run the desktop shell locally, copy `.env.desktop.example` to `.env.desktop`.
   - Both files use the same Firebase client config (`*_API_KEY`, `*_AUTH_DOMAIN`, etc.) from **Firebase Console → Project Settings → General → Your apps**.
   - **Use a newly generated, HTTP-referrer–restricted Web API key**. Restrict it to `https://tracker-5.vercel.app` (plus any extra origins you own) along with the minimum set of Firebase APIs (Identity Toolkit, Firestore, etc.).
   - The Electron process loads `.env.desktop` first, then falls back to `.env.local`, then plain environment variables. Keep `.env.desktop` out of git just like `.env.local`.
   - `npm run electron:build` / `npm run electron:release` now run `vite build --mode desktop`, so the renderer also reads `.env.desktop` instead of `.env.local`. This lets you keep a referer-restricted key for the hosted web app while shipping an unrestricted desktop-only key in `.env.desktop`.
4. Run the app:
   `npm run dev`

## Security Notes

- Deploy the new Firestore rules (`firebase deploy --only firestore:rules`) so `adminSettings/global` and Dropbox tokens stay admin-only.
- Sensitive API keys should stay server-side; the client bundle no longer injects `GEMINI_API_KEY`.
- Desktop builds load `.env.desktop`; keep only client-safe keys there to avoid shipping secrets inside the installer.

## Desktop Firebase Client Setup (no admin keys)

The Electron app now uses the standard Firebase **client SDK** instead of `firebase-admin`, so you never have to ship a service-account JSON to users. After an agent signs into the web dashboard:

1. The renderer requests a custom token via the callable Cloud Function `issueDesktopToken`.
2. Electron receives `{ uid, desktopToken }`, signs in with `signInWithCustomToken`, and stores desktop-only metadata in Firestore using normal security rules.

To finish the migration:

- Deploy the new callable: `cd functions && npm run build && firebase deploy --only functions:issueDesktopToken`.
- Ensure your Firestore rules allow the authenticated user to read/write the agent-specific docs already used by the desktop app (no special admin channel required anymore).
- Keep your Firebase client config in `.env.desktop` or environment variables (see `.env.desktop.example`). The keys are the same ones already required by Vite.
- Remove any installer scripts that previously copied `firebase-key.json` into `electron/`; they are obsolete.

## Dropbox Auto Refresh Setup

1. In the web dashboard, open **Application Settings** → **Dropbox**.
2. Enter your Dropbox App Key/Secret (from the Dropbox developer console) and click **Save Settings**.
3. Make sure your Dropbox app lists `https://<your-domain>/api/dropbox-callback` as an allowed redirect URI (replace `<your-domain>` with the deployed dashboard host).
4. Click **Generate Refresh Token**. A Dropbox popup opens and walks you through granting offline access. (If the button is disabled, enter the Dropbox app key + secret first.)
5. After Dropbox shows "Connected", close the popup. The refresh token, short-lived access token, and expiry are stored in Firestore automatically.
6. Restart the Electron desktop app (or wait ~30 s) so it picks up the updated settings and refreshes tokens on demand.

> The web dashboard now serves the OAuth start/callback endpoints directly from Vercel. No Firebase Function proxy or CORS tweaks are required.

### Required Environment Variables (Vercel)

Add the following secrets to your Vercel project (or `.env` if you run `vercel dev`):

| Name | Description |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Full JSON string for a Firebase service account that has access to Firestore + Authentication. Paste it as a single line and keep it secret. |
| `DROPBOX_OAUTH_BASE_URL` *(optional)* | Overrides the base URL used when generating OAuth links. Set this if you front the dashboard with a custom domain. |

For local Vite development (without `vercel dev`), set `VITE_DROPBOX_SESSION_ENDPOINT` to a reachable server that can forward to the new API (for example, `https://<your-vercel-deployment>/api/create-dropbox-session`). Also update your Dropbox app's redirect URI to point to the host you are testing against (e.g., `http://localhost:4173/api/dropbox-callback`).

## Firebase Credentials & Admin Scripts

- **Never commit service-account JSON**: `.gitignore` still blocks `firebase-adminsdk` files, but double-check `git status` before pushing.
- **Desktop builds no longer need service accounts**: the Electron app runs entirely on Firebase’s client SDK and authenticates with per-user custom tokens. Configure it with `.env.desktop` or process env vars and you are done.
- **Server-side APIs and maintenance scripts may still need admin credentials**: `functions/`, `api/`, and utilities such as `components/migrateWorklogTypes.js` continue to use `firebase-admin`. Store the JSON outside the repo (for example `C:\secrets\tracker-service-account.json`) and reference it with `FIREBASE_SERVICE_ACCOUNT_PATH` or inline via `FIREBASE_SERVICE_ACCOUNT_JSON`.
- **Rotate leaked keys**: because older commits contained a service account, generate a new key in Firebase Console → Project Settings → Service accounts, update your deployment secrets, and delete the compromised key.
- **Automate local materialization** (for scripts/functions only):
   ```powershell
   pwsh -File scripts/materialize-firebase-key.ps1 -SourcePath C:\secrets\tracker-service-account.json -SetEnv -Force
   ```
   or feed inline JSON with `-InlineJson "$env:FIREBASE_SERVICE_ACCOUNT_JSON"`. The script copies the key to `%LOCALAPPDATA%\Tracker5\firebase-service-account.json`, optionally sets `FIREBASE_KEY_PATH`, and refuses to overwrite existing files unless `-Force` is provided.
   If you store the secret in Vercel, you can pull it directly:
   ```powershell
   pwsh -File scripts/materialize-firebase-key.ps1 \
      -VercelToken $env:VC_TOKEN -VercelProject tracker-5 \
      -VercelEnvKey FIREBASE_SERVICE_ACCOUNT_JSON -SetEnv -Force
   ```
   (The token needs `projects.read` scope.)
   Additional providers:
   - `-HttpUrl https://...` plus optional `-HttpHeaders @{ Authorization = "Bearer ..." }` to fetch from any HTTPS secret endpoint.
   - `-ProviderCommand "aws secretsmanager get-secret-value --secret-id tracker-service-account --query SecretString --output text"` to execute any shell command whose stdout is the JSON.

   If you still have a workflow that requires materializing the key before packaging (for example, seeding data via `node scripts/...`), you can chain it like this:
   ```powershell
   pwsh -File scripts/materialize-firebase-key.ps1 \
      -VercelToken $env:VC_TOKEN -VercelProject tracker-5 \
      -SetEnv -Force -RunCommand "node components/migrateWorklogTypes.js" \
      -Cleanup -RemoveEnvOnCleanup
   ```
   `-Cleanup` deletes the materialized JSON after the command finishes (even on failure), and `-RemoveEnvOnCleanup` clears `FIREBASE_KEY_PATH` so you do not accidentally reference a deleted file later.

## Fresh Clone Automation

After the history rewrite every collaborator must work from a clean checkout. Run the helper script from the current repo root:

```powershell
pwsh -File scripts/reclone.ps1 -CreateBackup
```

Flags:

- `-DestinationName` → optional folder name for the fresh clone (default: `Tracker-5-clean-<timestamp>`).
- `-CreateBackup` / `-BackupName` → zip-free copy of the old workspace before recloning.
- `-RepoUrl` / `-Branch` → override the remote or branch if needed.

The script clones the repo to a sibling folder so you can migrate gradually: close VS Code, open the new folder, run `npm install`, and re-add environment files (`.env`, `firebase-service-account.json` stored outside git) before continuing development.

### Post-reset setup

Use `scripts/post-reset-setup.ps1` to bootstrap dependencies and env files after recloning/resetting:

```powershell
pwsh -File scripts/post-reset-setup.ps1 -InstallNpm -InstallFunctions -InstallElectron -GenerateEnv -EnvTemplate .env.example -EnvTarget .env.local
```

- `-InstallNpm` installs root dependencies.
- `-InstallElectron` runs `npm install` inside `electron/`.
- `-InstallFunctions` installs Firebase Functions dependencies.
- `-GenerateEnv` copies `.env.example` to `.env.local` (skips if it already exists).

Edit the generated `.env.local` manually and run `scripts/materialize-firebase-key.ps1` afterwards to place the Firebase service account JSON outside the repo.

## Desktop Releases & Auto-Update

1. **Build locally:** `npm run build` generates the Vite bundle consumed by Electron.
2. **Publish installers:** set `GH_TOKEN=<github personal access token with repo scope>` and run `npm run electron:release`. Electron Builder will package Windows (NSIS), macOS (DMG), and Linux (AppImage) installers and upload them to the `pankajsharmakeystone-art/Tracker-5` GitHub Releases page.
3. **Download button:** The landing page already links to `https://github.com/pankajsharmakeystone-art/Tracker-5/releases/latest`, so once the release is published the desktop app is available to end users immediately.
4. **Auto-update:** The bundled `electron-updater` checks GitHub Releases on launch. Every time you cut a new release (bump `version` in `package.json` and rerun the command above) clients download and install it automatically after restart.

> For dry runs without publishing, run `npm run electron:build` instead—the installers will be written to the `release/` folder locally.
