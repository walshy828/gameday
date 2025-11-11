import admin from './firebase.js';

export function initRealtimeListeners() {
  const db = admin.database();
  const baseRef = db.ref('dodgeball-tournament/divisions');

  // Example: listen for any schedule changes under any division
  baseRef.on('child_changed', (snapshot) => {
    const divisionKey = snapshot.key;
    const divisionData = snapshot.val();

    console.log(`Division ${divisionKey} updated.`);
    handleDivisionUpdate(divisionKey, divisionData);
  });
}

function handleDivisionUpdate(divisionKey, data) {
  // Your custom logic here
  console.log(`Running logic for division ${divisionKey}`, data);
  // NOTE: This is a server-side listener — do not call browser-only functions
  // such as `championshipBanner()` here. Instead, implement server-side
  // processing (update caches, send notifications, trigger analytics, etc.).
  // Example placeholder: maybe update stats, send notification, etc.
}