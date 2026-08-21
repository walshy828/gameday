/**
 * Renders the standings data.
 */
import { updateAdminUI } from './admin.js';

/** Escapes a value for safe interpolation into a template-literal row. */
function esc(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
}

function renderStandings(data) {
    const list = document.getElementById('standings-list');
    const standingsView = document.getElementById('standings-view');

    if (!list || !standingsView) return;

    // 1. Ensure Admin Controls are present in the DOM
    let adminControls = document.getElementById('admin-controls');
    if (!adminControls) {
        adminControls = document.createElement('div');
        adminControls.id = 'admin-controls';
        adminControls.classList.add('p-3', 'bg-yellow-900/20', 'rounded-lg', 'border', 'border-yellow-600', 'text-yellow-300', 'font-medium', 'hidden', 'text-sm', 'space-y-2');
        adminControls.innerHTML = `
            <p class="font-bold text-lg">Admin Tools Active</p>
            <p>You have administrative access. Switch to the 🛠️ Admin Match Entry tab to update results.</p>
        `;
        // Insert after the H2 element
        //standingsView.insertBefore(adminControls, standingsView.children[1]); 
    }
    // 2. Update UI based on current admin status
    updateAdminUI(); 

    list.innerHTML = '';

    if (!data || data.length === 0) {
        list.innerHTML = '<p class="py-4 text-center text-sm text-white/45">No standings data available.</p>';
        return;
    }

    // Dark glass rows to match the rest of the app's dark surfaces.
    const fragment = document.createDocumentFragment();  //use to batch flows
    data.forEach((item, index) => {
        if (!item.team || item.team.trim() === '') return;

        const rank = item.rank || index + 1;

        const row = document.createElement('div');
        row.className = 'flex items-center gap-2.5 rounded-2xl px-3 py-2.5 cursor-pointer transition-colors bg-white/[.06]';
        row.onclick = () => window.filterScheduleByTeam(item.team);

        row.innerHTML = `
            <span class="flex-none w-[26px] h-[26px] rounded-[10px] text-center text-xs font-bold leading-[26px] tabular-nums bg-white/10 text-white/70">${esc(rank)}</span>
            <span class="flex-1 min-w-0 truncate text-sm font-semibold leading-tight tracking-[-.01em] text-gray-50">${esc(item.team)}</span>
            <span class="w-[58px] flex-none text-right text-xs font-medium leading-none text-white/45 tabular-nums">${esc(item.record || '0-0')}</span>
            <span class="w-[52px] flex-none text-right text-[17px] font-bold leading-none tracking-[-.02em] tabular-nums text-gold-l">${esc(item.points ?? 0)}</span>
        `;
        fragment.appendChild(row);
    });
    list.appendChild(fragment);
}

export {
    renderStandings
};