// server/firebase.js
import admin from 'firebase-admin';
import dotenv from 'dotenv';
dotenv.config();

const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_PROJECT_ID,
  clientEmail: process.env.GOOGLE_CLIENT_EMAIL,
  privateKey: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

export async function pushMatchUpdate(sheetName, firebaseIndex, payload) {
  if (!process.env.FIREBASE_DATABASE_URL) throw new Error('FIREBASE_DATABASE_URL not set');
  // Use the raw sheetName as the division key so it matches the sheet title
  // Note: Firebase RTDB keys cannot contain the characters . # $ [ ] / .
  // We assume sheet names don't contain those; if they do, consider a deterministic map.
  const refPath = `dodgeball-tournament/divisions/${sheetName}/schedule/${firebaseIndex}`;
  await admin.database().ref(refPath).update(payload);
  return true;
}

export async function createCustomToken(uid, claims = {}) {
  return admin.auth().createCustomToken(uid, claims);
}

// Also export the initialized admin SDK as the default export for callers
export default admin;
