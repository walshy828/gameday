# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"Dodgeball Tracker" (repo name: tournament-gamedayapp) — a live tournament gameday app: division standings, schedule, admin match entry, and a synchronized round timer/scoreboard, deployed via Docker.

## Commands

- `npm start` — run the server (`node server/index.js`), serves both the API and the static frontend on `PORT` (default 8888).
- `npm run build:css` — one-shot Tailwind build (`src/input.css` → `public/dist/output.css`, minified).
- `npm run watch:css` — Tailwind in watch mode during frontend work.
- `docker-compose up --build` — build and run the containerized app (maps port 8888, loads `.env`).

There is no test suite or linter configured in this repo.

Frontend has no bundler/build step of its own — `public/js/*.js` are loaded directly as ES modules by `public/index.html`; only CSS goes through Tailwind.

## Architecture

**Split backend architecture — two different paths for reading data:**
- The Express server (`server/index.js`) exposes a small JSON API (`/api/allData`, `/api/divisions`, `/api/standings`, `/api/validateAdmin`, `/api/saveMatchResult`) backed by Firebase Realtime Database as the primary data source (`server/sheets.js`, despite its name, reads/writes Firebase — Google Sheets is a secondary, best-effort mirror).
- The frontend (`public/js/main.js`, `public/js/navigation.js`) *also* loads the Firebase client SDK directly (`firebase-app-compat.js`, `firebase-database-compat.js`, `firebase-auth-compat.js` via CDN in `index.html`) and talks to Firebase directly in the browser for: fetching division names, live-watching a division for realtime updates (`watchDivision`), and all round-timer/scoreboard state (`timerRef` under the `timer` RTDB node). Initial data loads (standings/schedule) go through the Express API (`getAllData` in `public/js/api.js`); live delta updates and the timer bypass the server entirely.
- When editing data-loading logic, check whether you're in the server-API path or the direct-Firebase browser path — they are separate and not interchangeable.

**Triple write-through on match result save** (`POST /api/saveMatchResult` → `server/index.js`): a single save writes to three systems, each independently, with the request still succeeding if some fail (see `server/sheets.js:saveMatchResult` and `server/index.js`'s route handler):
1. Firebase RTDB schedule entry + a `history` push log (source of truth for the live UI).
2. Google Sheets, columns H:L + a JSON history blob in column M (only if `SPREADSHEET_ID`/Google service account env vars are set — otherwise silently skipped).
3. MariaDB (`server/mariadb.js` → `server/db.js`), an audit-log style insert into `gameday_submissions` (only if the DB pool is configured/reachable).

Data key structure in Firebase RTDB: `dodgeball-tournament/divisions/{sheetName}/{standings|schedule}`, where `sheetName` is the division name used as the RTDB key directly (division names must avoid `. # $ [ ] /`).

**Auth model**: no sessions/JWTs for the app's own auth — `ADMIN_PASSWORD`/`SUPERADMIN_PASSWORD` (env) are checked server-side in `/api/validateAdmin`, which returns a deterministic SHA-256 token (`password + SECRET_SALT`) that the client resends as `authToken` on subsequent writes (`isValidToken` in `server/index.js` recomputes and compares). Superadmin additionally receives a Firebase custom auth token (`Fb.createCustomToken`) so the browser's Firebase client SDK can authenticate for direct RTDB writes (e.g. timer controls).

**Frontend module structure** (`public/js/`, loaded as native ES modules, no bundler):
- `main.js` — app bootstrap, global `showStatus`/`loadData`, direct-Firebase timer/round-control logic (`timerRef`, round next/prev), and `exposeGlobals()` which attaches selected module functions to `window` so inline `onclick=` handlers in `index.html` can reach them.
- `navigation.js` — division dropdown (desktop select + mobile scroll buttons), view switching (`standings`/`schedule`/`admin-entry`), filter dropdowns.
- `admin.js` — admin login/logout, match entry modal, save-result flow.
- `schedule.js` / `standings.js` — rendering schedule/standings tables and the admin standings ticker/pager.
- `celebration.js` — championship banner/confetti when a playoffs final completes.
- `api.js` — thin fetch wrappers for the Express `/api/*` routes (relative to `window.location.origin`, no separate API base config needed for same-origin deploys).
- Global app state lives in a plain `App` object defined inline in `index.html` (`App.state`, `App.data`, `App.config`, `App.settings`, `App.refresh`), not in any JS module — read it there before assuming a field exists.

**Styling**: Tailwind, custom theme colors (`primary`/`secondary`/`accent`/`admin-bg`) in `tailwind.config.js`; source in `src/input.css`, compiled output committed at `public/dist/output.css` and served with an explicit MIME-type-safe route (`server/index.js`) in case a hosting proxy mis-serves it as `text/html`.

## Environment

Configured via `.env` (see `docker-compose.yml`, loaded with `dotenv`): Firebase service account (`FIREBASE_PROJECT_ID`/`GOOGLE_CLIENT_EMAIL`/`GOOGLE_PRIVATE_KEY`/`FIREBASE_DATABASE_URL`), optional Google Sheets mirror (`SPREADSHEET_ID` + same service account), optional MariaDB (`DB_HOST`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`), app auth (`ADMIN_PASSWORD`/`SUPERADMIN_PASSWORD`/`SECRET_SALT`), and optional GA4 event tracking (`GA_MEASUREMENT_ID`/`GA_API_SECRET`). Each integration degrades gracefully (features log/skip) when its env vars are absent, except Firebase, which is required — `server/firebase.js` will throw at import if the service account vars are missing.
