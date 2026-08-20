// public/js/chat.js
// Staff-only crew chat (CHAT tab). Backend-agnostic like announcements.js:
// writes go through POST /api/chat (server derives `who`/`mgr` from the
// validated authToken — never trusted from the client); live reads use a
// direct Firebase RTDB listener in firebase mode or a Socket.IO 'chatUpdate'
// listener in local mode. The CHAT tab itself is only shown to signed-in
// staff (see updateAdminUI in admin.js) — same UI-level gating the rest of
// the app already uses for staff-only views.
import { getChatMessages, postChatMessage } from './api.js';
import { getSocket } from './socketClient.js';

const IS_LOCAL_BACKEND = window.__DATA_BACKEND__ === 'local';
const SEEN_KEY = 'chatSeen';

let chat = [];

function authToken() {
  return sessionStorage.getItem('adminAuthToken');
}

/** Must match the `who` string the server computes in POST /api/chat. */
function meLabel() {
  const name = App.state.reporterName || 'Staff';
  return App.state.isSuperAdmin ? `Admin · ${name}` : `Court ${App.state.selectedCourt || '?'} · ${name}`;
}

async function init() {
  try {
    chat = await getChatMessages();
  } catch (e) {
    console.error('Failed to load chat', e);
    chat = [];
  }
  render();

  if (IS_LOCAL_BACKEND) {
    getSocket().off('chatUpdate');
    getSocket().on('chatUpdate', (list) => {
      chat = list || [];
      render();
    });
  } else {
    firebase.database().ref('dodgeball-tournament/chat').on('value', (snap) => {
      const val = snap.val() || {};
      chat = Object.values(val).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      render();
    });
  }
}

function render() {
  renderMessages();
  renderUnreadDot();
}

function renderMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const me = meLabel();
  container.innerHTML = chat.map(m => {
    const mine = m.who === me;
    return `
      <div class="flex ${mine ? 'justify-end' : 'justify-start'}">
        <div class="max-w-[86%] px-3.5 py-2.5 rounded-2xl ${mine ? 'rounded-br-md' : 'rounded-bl-md'}"
             style="background:${mine ? 'linear-gradient(140deg,rgba(166,48,63,.42) 0%,rgba(123,29,43,.34) 100%)' : (m.mgr ? 'rgba(224,184,99,.12)' : 'rgba(255,255,255,.06)')}">
          <div class="flex justify-between gap-3 items-baseline">
            <span class="text-[10px] font-semibold ${m.mgr ? 'text-gold' : 'text-white/60'}">${escapeHtml(m.who)}</span>
            <span class="text-[10px] text-white/35 flex-none">${new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          </div>
          <div class="text-[13px] text-white/[.88] mt-1 leading-relaxed">${escapeHtml(m.text)}</div>
        </div>
      </div>
    `;
  }).join('');

  const scrollArea = document.getElementById('chat-scroll-area');
  if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function renderUnreadDot() {
  const dot = document.getElementById('chat-unread-dot');
  if (!dot) return;

  const seen = Number(localStorage.getItem(SEEN_KEY) || 0);
  const me = meLabel();
  const unread = chat.filter(m => m.id > seen && m.who !== me);

  if (!unread.length) {
    dot.classList.add('hidden');
    return;
  }
  const isAdminUnread = unread.some(m => m.mgr);
  dot.style.background = isAdminUnread ? 'var(--warn)' : 'var(--mar-l)';
  dot.classList.remove('hidden');
}

/** Called by navigation.js's switchView() when the CHAT tab is opened. */
function onChatTabOpened() {
  if (chat.length) {
    localStorage.setItem(SEEN_KEY, String(chat[chat.length - 1].id));
  }
  renderUnreadDot();

  const sub = document.getElementById('chat-sub');
  if (sub) sub.textContent = App.state.isSuperAdmin ? 'Every court manager sees this channel.' : 'Court managers and admins.';
  const postingAs = document.getElementById('chat-posting-as');
  if (postingAs) postingAs.textContent = meLabel();
}

async function sendChatMessage() {
  const input = document.getElementById('chat-composer-input');
  const text = (input?.value || '').trim();
  if (!text) return;

  input.value = '';
  updateComposerButton();
  try {
    await postChatMessage(authToken(), text, App.state.reporterName, App.state.selectedCourt);
  } catch (e) {
    console.error('Failed to send chat message', e);
    showStatus('Failed to send: ' + e.message, true);
  }
}

function updateComposerButton() {
  const input = document.getElementById('chat-composer-input');
  const btn = document.getElementById('chat-send-btn');
  if (!input || !btn) return;
  const hasText = !!input.value.trim();
  btn.style.background = hasText ? 'linear-gradient(135deg,var(--mar-l) 0%,var(--mar) 100%)' : 'rgba(255,255,255,.12)';
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('chat-composer-input');
  if (input) {
    input.addEventListener('input', updateComposerButton);
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendChatMessage();
    });
  }
});

export {
  init as initChat,
  onChatTabOpened,
  sendChatMessage
};
