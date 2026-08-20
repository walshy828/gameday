// public/js/announcements.js
// Tournament-wide announcement banner + Setup-screen composer. Backend-
// agnostic: writes always go through the REST /api/announcements routes
// (Store-backed, works on both DATA_BACKEND=firebase and =local); live reads
// use a direct Firebase RTDB listener in firebase mode (same pattern as
// watchDivision) or a Socket.IO 'announcementUpdate' listener in local mode.
import { getAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement } from './api.js';
import { getSocket } from './socketClient.js';

const IS_LOCAL_BACKEND = window.__DATA_BACKEND__ === 'local';
const DISMISSED_KEY = 'annDismissed';

let announcements = [];
let editingId = null;

function authToken() {
  return sessionStorage.getItem('adminAuthToken');
}

async function init() {
  try {
    announcements = await getAnnouncements();
  } catch (e) {
    console.error('Failed to load announcements', e);
    announcements = [];
  }
  render();

  if (IS_LOCAL_BACKEND) {
    getSocket().off('announcementUpdate');
    getSocket().on('announcementUpdate', (list) => {
      announcements = list || [];
      render();
    });
  } else {
    firebase.database().ref('dodgeball-tournament/announcements').on('value', (snap) => {
      const val = snap.val() || {};
      announcements = Object.values(val).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      render();
    });
  }
}

function latestActive() {
  const active = announcements.filter(a => a.on);
  return active.length ? active[active.length - 1] : null;
}

function render() {
  renderBanner();
  renderInfoList();
  renderSetupList();
}

function renderBanner() {
  const banner = document.getElementById('announcement-banner');
  const text = document.getElementById('announcement-banner-text');
  if (!banner || !text) return;

  const pinned = latestActive();
  const dismissedId = Number(localStorage.getItem(DISMISSED_KEY) || 0);

  if (!pinned || pinned.id <= dismissedId) {
    banner.classList.add('hidden');
    return;
  }
  text.textContent = pinned.text;
  banner.classList.remove('hidden');
}

function dismissAnnouncementBanner() {
  const pinned = latestActive();
  if (pinned) localStorage.setItem(DISMISSED_KEY, String(pinned.id));
  renderBanner();
}

function renderInfoList() {
  const list = document.getElementById('info-announcements-list');
  if (!list) return;

  const active = announcements.filter(a => a.on).slice().sort((a, b) => b.ts - a.ts);
  if (!active.length) {
    list.innerHTML = '<p class="text-sm text-white/40">No announcements yet.</p>';
    return;
  }
  list.innerHTML = active.map((a, i) => `
    <div class="p-3 rounded-xl ${i === 0 ? 'border' : ''}" style="${i === 0
      ? 'background:linear-gradient(135deg,rgba(224,184,99,.16) 0%,rgba(166,48,63,.14) 100%);border-color:rgba(224,184,99,.3)'
      : 'background:rgba(255,255,255,.05)'}">
      <div class="text-[9px] font-semibold tracking-[.1em] ${i === 0 ? 'text-gold' : 'text-white/45'}">${new Date(a.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
      <div class="text-sm text-white/85 mt-1.5">${escapeHtml(a.text)}</div>
    </div>
  `).join('');
}

function renderSetupList() {
  const list = document.getElementById('setup-announcements-list');
  if (!list) return;

  if (!announcements.length) {
    list.innerHTML = '<p class="text-sm text-gray-500">No announcements posted yet.</p>';
    return;
  }
  const sorted = announcements.slice().sort((a, b) => b.ts - a.ts);
  list.innerHTML = sorted.map(a => `
    <div class="p-3 rounded-lg ${a.on ? 'bg-gray-800/60' : 'bg-gray-800/20'} flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="text-xs ${a.on ? 'text-gray-200' : 'text-gray-500'}">${escapeHtml(a.text)}</div>
        <div class="text-[10px] text-gray-500 mt-1">${new Date(a.ts).toLocaleString()}</div>
      </div>
      <div class="flex-none flex items-center gap-1.5">
        <button data-toggle="${a.id}" class="px-2.5 py-1 rounded-full text-[10px] font-semibold ${a.on ? 'bg-green-900/30 text-green-400' : 'bg-gray-700 text-gray-400'}">${a.on ? 'Active' : 'Hidden'}</button>
        <button data-edit="${a.id}" class="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-gray-700 text-gray-300">Edit</button>
        <button data-delete="${a.id}" class="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-red-900/30 text-red-400">Delete</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.onclick = () => toggleAnnouncement(Number(btn.dataset.toggle));
  });
  list.querySelectorAll('[data-edit]').forEach(btn => {
    btn.onclick = () => startEditAnnouncement(Number(btn.dataset.edit));
  });
  list.querySelectorAll('[data-delete]').forEach(btn => {
    btn.onclick = () => deleteAnnouncementById(Number(btn.dataset.delete));
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

async function postAnnouncementFromSetup() {
  const textarea = document.getElementById('announcement-draft');
  const text = (textarea?.value || '').trim();
  if (!text) {
    showStatus('Write the announcement first.', true);
    return;
  }
  try {
    if (editingId) {
      await updateAnnouncement(authToken(), editingId, { text });
      showStatus('Announcement updated.');
    } else {
      await createAnnouncement(authToken(), text);
      showStatus('Posted · now showing on every phone in the gym.');
    }
    cancelAnnouncementEdit();
    setTimeout(() => showStatus(null), 2600);
  } catch (e) {
    console.error('Failed to post announcement', e);
    showStatus('Failed to post announcement: ' + e.message, true);
  }
}

function startEditAnnouncement(id) {
  const a = announcements.find(x => x.id === id);
  if (!a) return;
  editingId = id;
  document.getElementById('announcement-draft').value = a.text;
  document.getElementById('announcement-post-btn').textContent = 'Save changes';
  document.getElementById('announcement-cancel-btn').classList.remove('hidden');
}

function cancelAnnouncementEdit() {
  editingId = null;
  const textarea = document.getElementById('announcement-draft');
  if (textarea) textarea.value = '';
  const postBtn = document.getElementById('announcement-post-btn');
  if (postBtn) postBtn.textContent = 'Post announcement';
  document.getElementById('announcement-cancel-btn')?.classList.add('hidden');
}

async function toggleAnnouncement(id) {
  const a = announcements.find(x => x.id === id);
  if (!a) return;
  try {
    await updateAnnouncement(authToken(), id, { on: !a.on });
  } catch (e) {
    console.error('Failed to toggle announcement', e);
    showStatus('Failed to update announcement: ' + e.message, true);
  }
}

async function deleteAnnouncementById(id) {
  try {
    await deleteAnnouncement(authToken(), id);
    showStatus('Announcement deleted.');
    setTimeout(() => showStatus(null), 2600);
  } catch (e) {
    console.error('Failed to delete announcement', e);
    showStatus('Failed to delete announcement: ' + e.message, true);
  }
}

export {
  init as initAnnouncements,
  dismissAnnouncementBanner,
  postAnnouncementFromSetup,
  cancelAnnouncementEdit
};
