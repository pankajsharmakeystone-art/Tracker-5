# Electron Desktop Integration

## Running in Development

1. Start the Vite dev server:
   ```powershell
   npm run dev
   ```
2. In a separate terminal, run Electron in dev mode:
   ```powershell
   npm run electron:serve
   ```
   Or manually:
   ```powershell
   $env:ELECTRON_DEV='true'; npx electron electron/main.js
   ```

## Building for Production

1. Build the web app:
   ```powershell
   npm run build
   ```
2. Package Electron (requires electron-builder):
   ```powershell
   npm run electron:build
   ```

## Firebase Service Account

**IMPORTANT:** Do NOT commit your Firebase service account JSON to the repo.

Two options for providing the key:

1. **Environment Variable (Recommended for Production):**
   ```powershell
   $env:FIREBASE_KEY_PATH='C:\path\to\your\firebase-key.json'
   npm run electron:serve
   ```

2. **Local File (Dev Only):**
   Place `firebase-key.json` in the `electron/` folder (add to `.gitignore`).

## Available Scripts

- `npm run electron:serve` — runs Electron in dev mode (loads `http://localhost:5173`)
- `npm run electron:build` — builds web app and packages Electron desktop app

## How It Works

- **Dev Mode:** Electron loads the Vite dev server at `http://localhost:5173`
- **Production:** Electron loads the built `dist/index.html` from the Vite build

The mode is controlled by the `ELECTRON_DEV` environment variable or `NODE_ENV`.

## Next Steps

1. Install Electron and related dependencies:
   ```powershell
   npm install --save-dev electron electron-builder
   ```

2. Add Firebase admin SDK dependencies to `electron/package.json` if needed.

3. Place your Firebase service account key securely (use `FIREBASE_KEY_PATH` env var).

4. Test the integration:
   ```powershell
   npm run dev
   # In another terminal:
   npm run electron:serve
   ```

---

See `main.js` for implementation details on Firebase initialization and URL switching logic.
