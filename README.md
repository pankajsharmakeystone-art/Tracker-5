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

## Protecting Firebase Credentials

- **Never commit service-account JSON**: `.gitignore` now blocks `firebase-adminsdk` files, but verify `git status` before pushing.
- **Store keys outside the repo**: save the JSON someplace like `C:\secrets\tracker-service-account.json` and point tools to it with `FIREBASE_SERVICE_ACCOUNT_PATH` or `FIREBASE_KEY_PATH`.
- **Electron builds**: before running `npm run electron:release`, set `FIREBASE_KEY_PATH` so the packager bundles the correct file from outside the repo. Delete any copied key after the build completes.
- **CLI scripts**: utilities such as `components/migrateWorklogTypes.js` now read either `FIREBASE_SERVICE_ACCOUNT_JSON` (inline JSON) or `FIREBASE_SERVICE_ACCOUNT_PATH`.
- **Rotate leaked keys**: because older commits contained the service account, generate a new key in Firebase Console → Project Settings → Service accounts, update your deployment secrets, and delete the compromised key.
- **Automate local materialization**: run
   ```powershell
   pwsh -File scripts/materialize-firebase-key.ps1 -SourcePath C:\secrets\tracker-service-account.json -SetEnv -Force
   ```
   or feed inline JSON with `-InlineJson "$env:FIREBASE_SERVICE_ACCOUNT_JSON"`. The script copies the key to `%LOCALAPPDATA%\Tracker5\firebase-service-account.json`, optionally sets `FIREBASE_KEY_PATH`, and refuses to overwrite existing files unless `-Force` is provided.
   If you already store the secret in Vercel, you can pull it directly:
   ```powershell
   pwsh -File scripts/materialize-firebase-key.ps1 \ 
      -VercelToken $env:VC_TOKEN -VercelProject tracker-5 \ 
      -VercelEnvKey FIREBASE_SERVICE_ACCOUNT_JSON -SetEnv -Force
   ```
   (The token needs `projects.read` scope.)
   Additional providers:
   - `-HttpUrl https://...` plus optional `-HttpHeaders @{ Authorization = "Bearer ..." }` to fetch from any HTTPS secret endpoint.
   - `-ProviderCommand "aws secretsmanager get-secret-value --secret-id tracker-service-account --query SecretString --output text"` to execute any shell command whose stdout is the JSON.

   To run the Electron release and clean up the key automatically:
   ```powershell
   pwsh -File scripts/materialize-firebase-key.ps1 \ 
      -VercelToken $env:VC_TOKEN -VercelProject tracker-5 \ 
      -SetEnv -Force -RunCommand "npm run electron:release" \ 
      -Cleanup -RemoveEnvOnCleanup
   ```
   `-Cleanup` deletes the materialized JSON after the command finishes (even on failure), and `-RemoveEnvOnCleanup` clears `FIREBASE_KEY_PATH` so you don't accidentally reference a deleted file later.

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
