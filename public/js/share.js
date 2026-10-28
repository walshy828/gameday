// public/js/share.js
// "Share this app" dialog: a QR code (scan from another phone) plus the link
// with a copy button. Open to every user, no auth. The QR is drawn locally by
// the vendored qrcode-generator (public/js/vendor/qrcode.js, loaded as a
// classic script that defines window.qrcode), so it works without network.

function shareUrl() {
  return `${window.location.origin}/`;
}

// `suffix` picks the dialog ('') or the inline Info-page module ('-inline').
function renderQr(url, suffix = '') {
  const box = document.getElementById(`share-qr${suffix}`);
  if (!box) return;
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
    const svg = box.querySelector('svg');
    if (svg) {
      svg.setAttribute('class', 'w-full h-full');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'QR code linking to the app');
    }
  } catch (e) {
    box.textContent = 'QR code unavailable';
  }
}

function showCopied(ok, suffix = '') {
  const btn = document.getElementById(`share-copy-btn${suffix}`);
  if (!btn) return;
  btn.textContent = ok ? 'Copied ✓' : 'Press and hold the link to copy';
  setTimeout(() => { btn.textContent = 'Copy link'; }, 2000);
}

async function copyShareLink(suffix = '') {
  const url = shareUrl();
  try {
    await navigator.clipboard.writeText(url);
    showCopied(true, suffix);
    return;
  } catch (e) { /* insecure context or denied: fall back below */ }
  const input = document.getElementById(`share-link-field${suffix}`);
  try {
    input.focus();
    input.select();
    input.setSelectionRange(0, url.length);
    showCopied(document.execCommand('copy'), suffix);
  } catch (e) {
    showCopied(false, suffix);
  }
}

function openShareModal() {
  const url = shareUrl();
  const input = document.getElementById('share-link-field');
  if (input) input.value = url;
  renderQr(url);
  document.getElementById('share-modal')?.classList.remove('hidden');
}

function closeShareModal() {
  document.getElementById('share-modal')?.classList.add('hidden');
}

// Inline module on the Info page: always visible, so draw it once at load.
const inlineField = document.getElementById('share-link-field-inline');
if (inlineField) {
  inlineField.value = shareUrl();
  renderQr(shareUrl(), '-inline');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeShareModal();
});

export { openShareModal, closeShareModal, copyShareLink };
