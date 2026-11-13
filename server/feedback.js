// server/feedback.js
// Public feedback from parents/coaches (no login): a compliment, complaint or
// suggestion plus a note. Stored via the Store (MariaDB `feedback` table in
// local mode, `dodgeball-tournament/feedback` in firebase mode) and read only
// by the superadmin (Setup → Feedback). A complaint also pushes to ntfy when
// NTFY_URL is set; the superadmin's open tabs get the data-less
// `feedbackUpdate` socket nudge (staff tier only) and refetch.
import { Store } from './datastores/index.js';
import { pushNtfy } from './ntfy.js';

export const KINDS = ['compliment', 'complaint', 'suggestion'];
export const STATUSES = ['new', 'read', 'resolved'];
export const MAX_MESSAGE = 1000;
const LABEL = { compliment: 'Compliment', complaint: 'Complaint', suggestion: 'Suggestion' };

function clean(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** Validates a public submission. Returns { error } or { value }. */
export function parseSubmission(body) {
  const kind = typeof body?.kind === 'string' ? body.kind.trim().toLowerCase() : '';
  if (!KINDS.includes(kind)) return { error: 'Pick compliment, complaint or suggestion.' };
  // Keep line breaks in the note, collapse long runs of blank lines.
  const message = clean(body?.message, MAX_MESSAGE).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  if (message.length < 3) return { error: 'Please add a short note.' };
  return {
    value: {
      kind,
      message,
      name: clean(body?.name, 80).replace(/\s+/g, ' '),
      division: clean(body?.division, 120),
      team: clean(body?.team, 120),
      createdAt: Date.now()
    }
  };
}

export async function submit(value) {
  const saved = await Store.addFeedback(value);
  if (value.kind === 'complaint') {
    const where = [value.division, value.team].filter(Boolean).join(' · ');
    pushNtfy({
      title: `Feedback: complaint${where ? ` (${where})` : ''}`,
      body: `${value.message}${value.name ? `\n— ${value.name}` : ''}\n\nOpen Setup → Feedback to review.`,
      priority: 'high',
      tags: 'speech_balloon'
    });
  }
  return saved;
}

export const list = () => Store.listFeedback(500);
export const setStatus = (id, status, by) => Store.setFeedbackStatus(id, status, by);
export const remove = (id) => Store.deleteFeedback(id);
export const labelOf = (k) => LABEL[k] || k;
