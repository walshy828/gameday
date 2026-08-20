// server/datastores/index.js
// Selects the active data backend based on DATA_BACKEND (default: firebase).
// Uses a dynamic import so that firebaseStore.js — which transitively
// imports server/firebase.js and throws at import time if Firebase env vars
// are missing — is never loaded at all when DATA_BACKEND=local.
//
// dotenv.config() is called here (not just in server/index.js) because
// static `import` statements are hoisted and evaluate before any of the
// importing module's own top-level code — including its dotenv.config()
// call. Without this, `process.env.DATA_BACKEND` reads as undefined on
// every `npm start` that relies on .env rather than a real shell/container
// env var, and this module silently falls back to the firebase backend.
import dotenv from 'dotenv';
dotenv.config();

const backend = (process.env.DATA_BACKEND || 'firebase').toLowerCase();

if (backend !== 'firebase' && backend !== 'local') {
  throw new Error(`Invalid DATA_BACKEND "${backend}" — expected "firebase" or "local".`);
}

export const Store = backend === 'local'
  ? await import('./localStore.js')
  : await import('./firebaseStore.js');
