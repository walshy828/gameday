/**
 * Renders the standings data.
 */
import { updateAdminUI } from './admin.js';
function renderStandings(data) {
    const tbody = document.getElementById('standings-table-body');
    const standingsView = document.getElementById('standings-view');
    
    if (!tbody || !standingsView) return; 
    
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

    tbody.innerHTML = ''; 

    if (!data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="text-center py-4 text-gray-500">No standings data available.</td></tr>';
        return;
    }
    const fragment = document.createDocumentFragment();  //use to batch flows
    data.forEach((item, index) => {
        if (!item.team || item.team.trim() === '') return; 
        
        const rank = item.rank || index + 1;
        
        const row = document.createElement('tr');
        if (index % 2 === 0) {
            row.classList.add('bg-gray-900/50'); 
        }
        const safeTeamName = item.team.replace(/'/g, "\\'");

        row.innerHTML = `
            <td class="px-2 md:px-3 py-2 text-left font-bold font-mono text-base">${rank}</td>
            <td class="px-4 md:px-6 py-2 text-left font-semibold text-base cursor-pointer text-gray-200 hover:text-accent transition-colors duration-150 font-mono text-base" 
                onclick="filterScheduleByTeam('${safeTeamName}')">
                ${item.team}
            </td>
            <td class="px-2 md:px-6 py-2 text-right font-mono text-base font-bold min-w-[4.5rem] whitespace-nowrap">${item.record || '0-0'} 
                <div class="text-xs">(${item.points || 0})</div>
            </td>
        `;
        fragment.appendChild(row);
    });
    tbody.appendChild(fragment);
}

export {
    renderStandings
};