# Copilot instructions

## Architecture overview
- Vite + React (React 19) SPA; entry in App.tsx uses HashRouter for routes (see App.tsx).
- Auth state is centralized in contexts/AuthContext.tsx; it ensures a user profile doc exists in Firestore and exposes `userData`.
- Firebase client SDK setup lives in services/firebase.ts; it throws if required VITE_FIREBASE_* env vars are missing.
- Core Firestore domain logic (users/teams/worklogs/time tracking) is in services/db.ts; it defines the “Rule N1” active worklog behavior.
- Firebase Cloud Functions (admin ops, Dropbox OAuth, scheduling) are in functions/src/index.ts and use firebase-admin.
- Electron desktop shell lives in electron/main.js with a preload bridge in electron/preload.js that exposes `window.desktopAPI` to the renderer.

## Key integration flows
- Desktop auth: renderer calls services/desktop.ts (`issueDesktopToken`) → Cloud Function → Electron uses Firebase client SDK to sign in; useDesktopBridge.ts handles register/heartbeat and admin settings sync.
- Dropbox OAuth: Vercel serverless endpoints in api/* use firebase-admin (api/_lib/firebaseAdmin.js) and store tokens in adminSettings/global.

## Developer workflows
- Web dev: `npm run dev` (Vite).
- Desktop dev: run `npm run dev` then `npm run electron:serve` in another terminal.
- Desktop build/release: `npm run electron:build` or `npm run electron:release` (requires GH_TOKEN).
- Functions deploy (desktop token): `cd functions && npm run build && firebase deploy --only functions:issueDesktopToken`.

## Environment/config notes
- Web uses .env.local; desktop uses .env.desktop (loaded first, then .env.local). Desktop builds use `vite build --mode desktop`.
- Service account JSON must stay out of git; scripts/materialize-firebase-key.ps1 is used for admin scripts/functions.

## Project-specific conventions
- Prefer services/* for Firebase interactions, hooks/* for side effects, and keep Firestore shapes in types.ts.
- Desktop IPC features require updates in electron/main.js, electron/preload.js, and the renderer hook/component that consumes `window.desktopAPI`.
- Firestore admin settings are under adminSettings/global; keep desktop and dashboard features in sync with those fields.
