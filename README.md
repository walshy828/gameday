Tournament Docker app with standings and schedule results

## Data backend

Set `DATA_BACKEND` in `.env` to choose the primary datastore:

- `firebase` (default) — Firebase Realtime Database, exactly as before. Requires `FIREBASE_DATABASE_URL`/`FIREBASE_PROJECT_ID`/`GOOGLE_CLIENT_EMAIL`/`GOOGLE_PRIVATE_KEY`.
- `local` — self-hosted MariaDB (provisioned by the `db` service in `docker-compose.yml`) with Socket.IO pushing live updates to connected browsers instead of Firebase's realtime listeners. Set `DB_HOST=db` to use the compose-managed database, and `MARIADB_ROOT_PASSWORD`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` to configure it.

Google Sheets mirroring (`SPREADSHEET_ID` + the same Google service account vars) is independent of `DATA_BACKEND` and works under either mode.

`docker-compose up --build` starts both the app and the MariaDB container; the database container is harmless to leave running even in `firebase` mode.

## Security setup (before game day)

- **Secrets**: the server refuses to start unless `ADMIN_PASSWORD` and `SUPERADMIN_PASSWORD` (≥ 8 chars, distinct from each other and `PARENT_PASSWORD`) and `SECRET_SALT` (≥ 16 chars, not the old default) are set.
- **Firebase rules (firebase mode)**: paste `database.rules.json` into Firebase console → Realtime Database → Rules (or `firebase deploy --only database`). It denies everything by default, allows public read of divisions/announcements/crew chat/timer, and allows timer writes only for the superadmin's custom token. The server uses the Admin SDK and is unaffected. Sessions (IPs), `chatLeadership` and `settings` become unreadable from browsers. Afterwards confirm timer start/stop, crew chat and a result save still work.
- **Reverse proxy / tunnel**: serve over HTTPS (Cloudflare Tunnel, Caddy, etc.). If the app sits behind one proxy, set `TRUST_PROXY=1` so client IPs (and the login rate limit) use `X-Forwarded-For`; leave it unset when exposing the port directly.
- **Login throttle**: 15 failed attempts per IP per 15 minutes (`LOGIN_MAX_FAILS` to change). In-memory, resets on restart.
