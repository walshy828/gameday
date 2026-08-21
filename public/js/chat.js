// public/js/chat.js
// Staff-only crew chat (CHAT tab). Backend-agnostic like announcements.js:
// writes go through POST /api/chat (server derives `who`/`mgr` from the
// validated authToken — never trusted from the client); live reads use a
// direct Firebase RTDB listener in firebase mode or a Socket.IO 'chatUpdate'
// listener in local mode. The CHAT tab itself is only shown to signed-in
// staff (see updateAdminUI in admin.js) — same UI-level gating the rest of
// the app already uses for staff-only views.
import { getChatMessages, postChatMessage, deleteChatMessage as apiDeleteChatMessage } from './api.js';
import { getSocket } from './socketClient.js';

const IS_LOCAL_BACKEND = window.__DATA_BACKEND__ === 'local';
const SEEN_KEY = 'chatSeen';
const AT_BOTTOM_THRESHOLD = 48; // px of slack before we consider the user "scrolled away"

let chat = [];
let knownIds = new Set(); // message ids already rendered, used to detect genuinely-new arrivals
let pendingJumpCount = 0; // messages that arrived while the user was scrolled up
let confirmDeleteId = null; // message currently showing its inline "delete this?" prompt

function authToken() {
  return sessionStorage.getItem('adminAuthToken');
}

/** Must match the `who` string the server computes in POST /api/chat. */
function meLabel() {
  const name = App.state.reporterName || 'Staff';
  if (App.state.isSuperAdmin) return `Admin · ${name}`;
  if (App.state.isParent) return `Parent · ${name}`;
  return `Court ${App.state.selectedCourt || '?'} · ${name}`;
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

function isAtBottom(scrollArea) {
  return scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight < AT_BOTTOM_THRESHOLD;
}

function renderMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const scrollArea = document.getElementById('chat-scroll-area');
  const wasAtBottom = scrollArea ? isAtBottom(scrollArea) : true;
  const me = meLabel();

  const newMessages = chat.filter(m => !knownIds.has(m.id));
  const newFromOthers = newMessages.filter(m => m.who !== me);
  const newFromMe = newMessages.length - newFromOthers.length;

  container.innerHTML = chat.map(m => {
    const mine = m.who === me;
    const canDelete = !!App.state.isSuperAdmin;
    const confirming = confirmDeleteId === m.id;
    return `
      <div class="flex ${mine ? 'justify-end' : 'justify-start'} group">
        <div class="max-w-[86%] px-3.5 py-2.5 rounded-2xl relative ${mine ? 'rounded-br-md' : 'rounded-bl-md'}"
             style="background:${mine ? 'linear-gradient(140deg,rgba(166,48,63,.42) 0%,rgba(123,29,43,.34) 100%)' : (m.mgr ? 'rgba(224,184,99,.12)' : 'rgba(255,255,255,.06)')}">
          <div class="flex justify-start gap-1.5 items-baseline">
            <span class="text-[10px] font-semibold ${m.mgr ? 'text-gold' : 'text-white/60'}">${escapeHtml(m.who)}</span>
            <span class="text-[10px] text-white/35 flex-none">${new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
            ${canDelete ? `<button onclick="requestDeleteChatMessage(event, ${m.id})" title="Delete message"
                class="ml-auto flex-none opacity-0 group-hover:opacity-100 transition-opacity text-white/40 hover:text-white/90">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3">
                  <path d="M3 6h18"></path>
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
                  <path d="M10 11v6"></path>
                  <path d="M14 11v6"></path>
                </svg>
              </button>` : ''}
          </div>
          <div class="text-[13px] text-white/[.88] mt-1 leading-relaxed">${escapeHtml(m.text)}</div>
          ${confirming ? `
            <div class="mt-2 pt-2 border-t border-white/15 flex items-center justify-between gap-2" onclick="event.stopPropagation()">
              <span class="text-[11px] text-white/70">Delete this message?</span>
              <div class="flex gap-1.5 flex-none">
                <button onclick="cancelDeleteChatMessage(event)"
                    class="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-white/10 text-white/80 hover:bg-white/15">Cancel</button>
                <button onclick="confirmDeleteChatMessage(event, ${m.id})"
                    class="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-warn text-white hover:opacity-90">Delete</button>
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  knownIds = new Set(chat.map(m => m.id));

  if (!scrollArea) return;

  if (wasAtBottom || newFromMe > 0) {
    scrollChatToBottom();
  } else if (newFromOthers.length) {
    pendingJumpCount += newFromOthers.length;
    showJumpButton();
  }
}

function scrollChatToBottom() {
  const scrollArea = document.getElementById('chat-scroll-area');
  if (!scrollArea) return;
  scrollArea.scrollTop = scrollArea.scrollHeight;
  pendingJumpCount = 0;
  hideJumpButton();
}

function showJumpButton() {
  const btn = document.getElementById('chat-jump-btn');
  const count = document.getElementById('chat-jump-count');
  if (!btn) return;
  if (count) count.textContent = pendingJumpCount > 1 ? String(pendingJumpCount) : '';
  btn.classList.remove('hidden');
}

function hideJumpButton() {
  const btn = document.getElementById('chat-jump-btn');
  if (btn) btn.classList.add('hidden');
}

function jumpToChatBottom() {
  scrollChatToBottom();
  renderUnreadDot();
}

function requestDeleteChatMessage(event, id) {
  event.stopPropagation();
  confirmDeleteId = id;
  renderMessages();
}

function cancelDeleteChatMessage(event) {
  event.stopPropagation();
  confirmDeleteId = null;
  renderMessages();
}

async function confirmDeleteChatMessage(event, id) {
  event.stopPropagation();
  confirmDeleteId = null;
  try {
    await apiDeleteChatMessage(authToken(), id);
  } catch (e) {
    console.error('Failed to delete chat message', e);
    showStatus('Failed to delete: ' + e.message, true);
  }
  renderMessages();
}

// Any click outside an open confirm prompt cancels it (the prompt itself
// stops propagation, so this only fires for genuine "click off" clicks).
document.addEventListener('click', () => {
  if (confirmDeleteId !== null) {
    confirmDeleteId = null;
    renderMessages();
  }
});

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
  scrollChatToBottom();

  const sub = document.getElementById('chat-sub');
  if (sub) sub.textContent = App.state.isSuperAdmin ? 'Every court manager and parent sees this channel.' : 'Court managers, admins, and parents.';
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
  sendChatMessage,
  jumpToChatBottom,
  requestDeleteChatMessage,
  cancelDeleteChatMessage,
  confirmDeleteChatMessage
};
