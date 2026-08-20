Tournament Docker app with standings and schedule results

## Data backend

Set `DATA_BACKEND` in `.env` to choose the primary datastore:

- `firebase` (default) — Firebase Realtime Database, exactly as before. Requires `FIREBASE_DATABASE_URL`/`FIREBASE_PROJECT_ID`/`GOOGLE_CLIENT_EMAIL`/`GOOGLE_PRIVATE_KEY`.
- `local` — self-hosted MariaDB (provisioned by the `db` service in `docker-compose.yml`) with Socket.IO pushing live updates to connected browsers instead of Firebase's realtime listeners. Set `DB_HOST=db` to use the compose-managed database, and `MARIADB_ROOT_PASSWORD`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` to configure it.

Google Sheets mirroring (`SPREADSHEET_ID` + the same Google service account vars) is independent of `DATA_BACKEND` and works under either mode.

`docker-compose up --build` starts both the app and the MariaDB container; the database container is harmless to leave running even in `firebase` mode.
