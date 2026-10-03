// public/js/chat.js
// Staff-only crew chat (CHAT tab) with two channels:
//   crew — everyone (referees, admins, parents)
//   lead — superadmin + parents only; referees never see the tab, and the
//          server refuses their tokens on both read and write.
// Backend-agnostic like announcements.js:
// writes go through POST /api/chat (server derives `who`/`mgr` from the
// validated authToken — never trusted from the client); live reads use a
// direct Firebase RTDB listener in firebase mode or a Socket.IO 'chatUpdate'
// listener in local mode. The CHAT tab itself is only shown to signed-in
// staff (see updateAdminUI in admin.js) — same UI-level gating the rest of
// the app already uses for staff-only views.
import { getChatMessages, getLeadChatMessages, postChatMessage, deleteChatMessage as apiDeleteChatMessage, getPresence } from './api.js';
import { getSocket } from './socketClient.js';

const IS_LOCAL_BACKEND = window.__DATA_BACKEND__ === 'local';
const SEEN_KEYS = { crew: 'chatSeen', lead: 'chatSeenLead' };
const LEAD_POLL_INTERVAL_MS = 5000; // firebase mode: lead messages aren't on a client-readable RTDB listener
const AT_BOTTOM_THRESHOLD = 48; // px of slack before we consider the user "scrolled away"
const PRESENCE_POLL_INTERVAL_MS = 15000;
const ACTIVE_WINDOW_MS = 60 * 60 * 1000; // messages older than this age into the "history" fold
const AGE_CHECK_INTERVAL_MS = 60 * 1000;

const data = { crew: [], lead: [] };
const known = { crew: new Set(), lead: new Set() }; // message ids already rendered, used to detect genuinely-new arrivals
let active = 'crew'; // channel currently shown
let leadStarted = false;
let leadPollTimer = null;
let pendingJumpCount = 0; // messages that arrived while the user was scrolled up
let confirmDeleteId = null; // message currently showing its inline "delete this?" prompt
let presence = new Map(); // "who" string (matches m.who) -> 'online' | 'offline'
let presencePollTimer = null;
let ageTimer = null;
let showHistory = false; // user clicked "Show earlier messages" this visit
// The last-seen watermark as it stood the moment the CHAT tab was opened —
// snapshotted so the "New messages" divider stays put for this visit even
// as messages scroll into view and advance SEEN_KEY. null while off the tab.
let chatOpenSeenSnapshot = null; // for the active channel
let seenObserver = null; // IntersectionObserver: marks a message read once it's actually on screen

function authToken() {
  return sessionStorage.getItem('adminAuthToken');
}

/** Superadmins and parents may use the leadership channel; referees may not. */
function canLead() {
  return !!(App.state.isSuperAdmin || App.state.isParent);
}

const seenFor = (ch) => Number(localStorage.getItem(SEEN_KEYS[ch]) || 0);

/** Must match the `who` string the server computes in POST /api/chat. */
function meLabel() {
  const name = App.state.reporterName || 'Staff';
  if (App.state.isSuperAdmin) return `Admin · ${name}`;
  if (App.state.isParent) return `Parent · ${name}`;
  return `Court ${App.state.selectedCourt || '?'} · ${name}`;
}

async function init() {
  try {
    data.crew = await getChatMessages();
  } catch (e) {
    console.error('Failed to load chat', e);
    data.crew = [];
  }
  render();

  if (IS_LOCAL_BACKEND) {
    getSocket().off('chatUpdate');
    getSocket().on('chatUpdate', (list) => {
      data.crew = list || [];
      render();
    });
  } else {
    firebase.database().ref('dodgeball-tournament/chat').on('value', (snap) => {
      const val = snap.val() || {};
      data.crew = Object.values(val).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      render();
    });
  }
  syncChatRole();

  // Re-render periodically so messages age into history without new traffic.
  if (!ageTimer) ageTimer = setInterval(() => { if (hasAgedMessages()) renderMessages(); }, AGE_CHECK_INTERVAL_MS);

  refreshPresence();
  if (!presencePollTimer) presencePollTimer = setInterval(refreshPresence, PRESENCE_POLL_INTERVAL_MS);
}

async function loadLead() {
  if (!canLead()) return;
  try {
    data.lead = await getLeadChatMessages(authToken());
    render();
  } catch (e) {
    console.error('Failed to load leadership chat', e);
  }
}

/**
 * Called on login/logout and whenever the CHAT tab opens: starts (or tears
 * down) the leadership channel to match the current role, so a referee's
 * client never fetches or holds leadership messages.
 */
function syncChatRole() {
  if (canLead() && !leadStarted) {
    leadStarted = true;
    loadLead();
    if (IS_LOCAL_BACKEND) {
      // Payload-free ping: the broadcast reaches every socket, so the data
      // itself is only ever fetched through the authenticated endpoint.
      getSocket().off('chatLeadPing');
      getSocket().on('chatLeadPing', loadLead);
    } else {
      leadPollTimer = setInterval(loadLead, LEAD_POLL_INTERVAL_MS);
    }
  } else if (!canLead() && leadStarted) {
    leadStarted = false;
    if (leadPollTimer) { clearInterval(leadPollTimer); leadPollTimer = null; }
    if (IS_LOCAL_BACKEND) getSocket().off('chatLeadPing');
    data.lead = [];
    known.lead = new Set();
    active = 'crew';
  }
  renderChannelBar();
  render();
}

/**
 * A message's sender is 'online' (green) if their session has heartbeated
 * recently, 'offline' (yellow) if they're still signed in but the app has
 * gone quiet (backgrounded/closed without logging out), or 'signed-out'
 * (grey) if they have no active session at all — i.e. they logged out (or
 * this message predates the presence feature).
 */
function presenceStatus(who) {
  return presence.get(who) || 'signed-out';
}

async function refreshPresence() {
  try {
    const list = await getPresence(authToken());
    presence = new Map(list.map(p => [p.who, p.online ? 'online' : 'offline']));
  } catch (e) {
    console.error('Failed to load presence', e);
    return;
  }
  renderMessages();
}

function isRecent(m) {
  return Date.now() - (m.ts || 0) < ACTIVE_WINDOW_MS;
}

function hasAgedMessages() {
  return data[active].some(m => !isRecent(m));
}

function render() {
  renderMessages();
  renderUnreadDot();
  renderChannelBar();
}

function unreadCount(ch) {
  const seen = seenFor(ch);
  const me = meLabel();
  return data[ch].filter(m => m.id > seen && m.who !== me && isRecent(m)).length;
}

const CHANNEL_META = {
  crew: {
    label: 'Crew', sub: 'Everyone', icon: '👥',
    banner: 'Everyone can read this — referees, admins &amp; parents.',
    placeholder: 'Message the crew…'
  },
  lead: {
    label: 'Leadership', sub: 'Admins &amp; parents', icon: '🔒',
    banner: 'Private to admins &amp; parents. Referees can’t see this channel.',
    placeholder: 'Message leadership only…'
  }
};

/** Segmented channel switcher, context banner, composer hint and theme for the active channel. */
function renderChannelBar() {
  const view = document.getElementById('chat-view');
  if (view) view.dataset.channel = active;

  const bar = document.getElementById('chat-channel-bar');
  const banner = document.getElementById('chat-channel-banner');
  const kicker = document.getElementById('chat-kicker');
  const input = document.getElementById('chat-composer-input');
  const leader = canLead();

  if (bar) {
    bar.classList.toggle('hidden', !leader);
    bar.innerHTML = leader ? ['crew', 'lead'].map(ch => {
      const meta = CHANNEL_META[ch];
      const unread = ch === active ? 0 : unreadCount(ch);
      return `
        <button onclick="switchChatChannel('${ch}')" data-ch="${ch}" aria-pressed="${ch === active}"
                class="chat-seg ${ch === active ? 'chat-seg-on' : ''}">
          <span class="chat-seg-title">${meta.icon} ${meta.label}${unread ? `<span class="chat-seg-badge">${unread}</span>` : ''}</span>
          <span class="chat-seg-sub">${meta.sub}</span>
        </button>`;
    }).join('') : '';
  }
  if (banner) {
    banner.classList.toggle('hidden', !leader);
    banner.innerHTML = leader ? CHANNEL_META[active].banner : '';
  }
  if (kicker) kicker.textContent = leader ? CHANNEL_META[active].sub.replace('&amp;', '&') : 'Referees & parents';
  if (input) input.placeholder = CHANNEL_META[active].placeholder;
}

function switchChatChannel(ch) {
  if (!CHANNEL_META[ch] || (ch === 'lead' && !canLead()) || ch === active) return;
  active = ch;
  chatOpenSeenSnapshot = seenFor(ch);
  showHistory = false;
  confirmDeleteId = null;
  pendingJumpCount = 0;
  hideJumpButton();
  render();
  scrollChatToBottom();
}

function isAtBottom(scrollArea) {
  return scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight < AT_BOTTOM_THRESHOLD;
}

/** Lazily creates the observer that marks a message read once it's actually visible in the scroll area. */
function ensureSeenObserver() {
  if (seenObserver) return seenObserver;
  const root = document.getElementById('chat-scroll-area') || null;
  seenObserver = new IntersectionObserver((entries) => {
    let advanced = false;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const id = Number(entry.target.dataset.msgId);
      const seen = seenFor(active);
      if (id > seen) {
        localStorage.setItem(SEEN_KEYS[active], String(id));
        advanced = true;
      }
      seenObserver.unobserve(entry.target);
    }
    if (advanced) renderUnreadDot();
  }, { root, threshold: 0.6 });
  return seenObserver;
}

function renderMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const scrollArea = document.getElementById('chat-scroll-area');
  const wasAtBottom = scrollArea ? isAtBottom(scrollArea) : true;
  const me = meLabel();
  const chat = data[active];

  const newMessages = chat.filter(m => !known[active].has(m.id));
  const newFromOthers = newMessages.filter(m => m.who !== me);
  const newFromMe = newMessages.length - newFromOthers.length;

  // Only meaningful while the CHAT tab is open (chatOpenSeenSnapshot is set
  // in onChatTabOpened) — marks where the "New messages" divider goes.
  const firstUnread = chatOpenSeenSnapshot != null
    ? chat.filter(m => showHistory || isRecent(m)).find(m => m.id > chatOpenSeenSnapshot && m.who !== me)
    : null;

  const historyCount = chat.filter(m => !isRecent(m)).length;
  const visible = showHistory ? chat : chat.filter(isRecent);
  const toggle = document.getElementById('chat-history-toggle');
  if (toggle) {
    toggle.classList.toggle('hidden', historyCount === 0);
    toggle.textContent = showHistory ? 'Hide earlier messages' : `Show earlier messages (${historyCount})`;
  }
  const emptyNote = !visible.length
    ? `<p class="text-center text-xs text-white/40 mt-6">${historyCount ? 'No messages in the last hour.' : 'No messages yet.'}</p>`
    : '';

  container.innerHTML = emptyNote + visible.map(m => {
    const mine = m.who === me;
    const canDelete = !!App.state.isSuperAdmin;
    const confirming = confirmDeleteId === m.id;
    const status = presenceStatus(m.who);
    const statusColor = status === 'online' ? '#22c55e' : status === 'offline' ? '#eab308' : '#6b7280';
    const statusLabel = status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Signed out';
    const divider = firstUnread && m.id === firstUnread.id ? `
      <div class="flex items-center gap-2 my-1 select-none">
        <div class="flex-1 h-px" style="background:var(--ch-a)"></div>
        <span class="text-[10px] font-semibold uppercase tracking-wide" style="color:var(--ch-a)">New messages</span>
        <div class="flex-1 h-px" style="background:var(--ch-a)"></div>
      </div>` : '';
    return `
      ${divider}
      <div class="flex ${mine ? 'justify-end' : 'justify-start'} group" data-msg-id="${m.id}">
        <div class="max-w-[86%] px-3.5 py-2.5 rounded-2xl relative ${mine ? 'rounded-br-md' : 'rounded-bl-md'}"
             style="background:${mine ? 'var(--ch-mine)' : (m.mgr ? 'rgba(224,184,99,.12)' : 'rgba(255,255,255,.06)')}">
          <div class="flex justify-start gap-1.5 items-baseline">
            <span class="text-[10px] font-semibold ${m.mgr ? 'text-gold' : 'text-white/60'}">${escapeHtml(m.who)}</span>
            <span class="inline-block w-1.5 h-1.5 rounded-full flex-none" style="background:${statusColor}" title="${statusLabel}"></span>
            <span class="text-[10px] text-white/35 flex-none">${new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
            ${canDelete ? `<button onclick="requestDeleteChatMessage(event, ${m.id})" title="Delete message"
                class="ml-auto flex-none p-1 -m-1 text-white/50 hover:text-white/90">
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

  known[active] = new Set(chat.map(m => m.id));

  // Watch every not-yet-seen message; the observer advances SEEN_KEY (and
  // clears the tab's unread dot) the moment one actually scrolls into view.
  const observer = ensureSeenObserver();
  const seenNow = seenFor(active);
  container.querySelectorAll('[data-msg-id]').forEach(el => {
    if (Number(el.dataset.msgId) > seenNow) observer.observe(el);
  });

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

function toggleChatHistory() {
  const scrollArea = document.getElementById('chat-scroll-area');
  showHistory = !showHistory;
  renderMessages();
  // Expanding history: keep the reader at the top (where it appeared); collapsing: back to latest.
  if (showHistory && scrollArea) scrollArea.scrollTop = 0;
  else scrollChatToBottom();
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
    const list = await apiDeleteChatMessage(authToken(), id, active);
    if (active === 'lead' && list?.chat) data.lead = list.chat;
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

  const crewUnread = unreadCount('crew');
  const leadUnread = canLead() ? unreadCount('lead') : 0;
  if (!crewUnread && !leadUnread) {
    dot.classList.add('hidden');
    return;
  }
  // Leadership unread wins the dot color (violet) so it can't be mistaken for crew chatter.
  const isAdminUnread = data.crew.some(m => m.mgr && m.id > seenFor('crew') && isRecent(m));
  dot.style.background = leadUnread ? 'var(--lead-a)' : isAdminUnread ? 'var(--warn)' : 'var(--mar-l)';
  dot.classList.remove('hidden');
}

/** Called by navigation.js's switchView() when the CHAT tab is opened. */
function onChatTabOpened() {
  // Snapshot where "unread" ended before this visit, so the divider has a
  // fixed anchor for the whole visit instead of chasing SEEN_KEY as the
  // IntersectionObserver marks messages read one by one.
  syncChatRole();
  chatOpenSeenSnapshot = seenFor(active);
  showHistory = false;
  window.scrollTo(0, 0);
  sizeChatView();
  renderMessages();
  scrollChatToBottom();
  renderUnreadDot();
}

/** Stretch the chat so the composer sits just above the floating bottom tab bar. */
function sizeChatView() {
  const view = document.getElementById('chat-view');
  const bar = document.getElementById('bottom-tab-bar');
  if (!view || !bar || view.classList.contains('hidden')) return;
  const top = view.getBoundingClientRect().top + window.scrollY;
  const barTop = bar.getBoundingClientRect().top;
  const h = Math.max(240, Math.floor(barTop - 12 - (top - window.scrollY)));
  view.style.height = h + 'px';
}
window.addEventListener('resize', sizeChatView);

async function sendChatMessage() {
  const input = document.getElementById('chat-composer-input');
  const text = (input?.value || '').trim();
  if (!text) return;

  input.value = '';
  updateComposerButton();
  try {
    const res = await postChatMessage(authToken(), text, App.state.reporterName, App.state.selectedCourt, sessionStorage.getItem('sessionId'), active);
    if (active === 'lead' && res?.chat) { data.lead = res.chat; render(); }
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
  btn.style.background = hasText ? 'linear-gradient(135deg,var(--ch-a) 0%,var(--ch-b) 100%)' : 'rgba(255,255,255,.12)';
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
  syncChatRole,
  switchChatChannel,
  sendChatMessage,
  jumpToChatBottom,
  toggleChatHistory,
  requestDeleteChatMessage,
  cancelDeleteChatMessage,
  confirmDeleteChatMessage
};
