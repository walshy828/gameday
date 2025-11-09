// Configuration for the confetti
const COUNT = 20; // Number of confetti pieces per burst
// --- ADJUSTED: New burst every 0.5 seconds for a constant stream ---
const BURST_INTERVAL_MS = 1000; 
// --- ADJUSTED: Must match the CSS animation time (4s) for smooth cleanup ---
const ANIMATION_DURATION_MS = 15000; 
const container = document.getElementById('confetti-container');

// Global state variables for control
let isConfettiRunning = false;
let confettiInterval = null;


function championshipBanner() {
    // 1. Get the container for the champion message
    const championMessageContainer = document.getElementById('tournament-champion-message');

    if (!container) return;

    // Check if already showing
    //if (!container.classList.contains('hidden')) {
    //    return; // Don't recreate if already visible
    //}

    // Clear any previous message before starting
    if (championMessageContainer) {
        championMessageContainer.innerHTML = '';
        championMessageContainer.classList.add('hidden'); // Assuming it starts hidden
    }
    
    const finalsGame = App.data.allScheduleData.find(game => game.roundTime === "P5.Finals" && game.winner);
    if (finalsGame && championMessageContainer) {
        // Assuming finalsGame has a 'divisionName' property
        const division = finalsGame.divisionName || 'N/A';
        const winnerraw = finalsGame.winner;
        const regex = /\s*\(\#\d+\)$/;
        const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/ug;

        const winner=winnerraw.replace(regex,'').replace(emojiRegex,'');

        // Create the HTML for the message
        championMessageContainer.innerHTML = `
            <div id="champion-inner-box">
                <button 
                    id="champion-dismiss-btn"
                    onclick="closeChampion();" 
                    title="Close"
                >
                    &times;
                </button>
                <p class="text-lg md:text-4xl font-extrabold text-white uppercase tracking-wider p-2">TOURNAMENT CHAMPION</p>
                <p class="text-lg md:text-6xl font-extrabold uppercase tracking-wider p-1" style="color: #FFD700;">🏆 ${winner} 🏆</p>
                
                <div class="flex items-center justify-center">
                    <img src="https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExaXVyZ3Z4em1rZG55c2lrMXIydXh5bGd5eHhpeHh2YnRkd2c2Nm94YiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/11sBLVxNs7v6WA/giphy.gif"/>
                </div>
            </div>
        `;
        championMessageContainer.classList.remove('hidden');

            // 1. Call immediately to start the first burst
        generateConfetti();

        // 2. Set the interval to keep generating new bursts constantly
        confettiInterval = setInterval(generateConfetti, BURST_INTERVAL_MS);
    } else {
        clearInterval(confettiInterval);
    }
    
}

function closeChampion() {
    document.getElementById('tournament-champion-message').classList.add('hidden');
    //stop the confetti
    clearInterval(confettiInterval);
}



// ----------------------------------------------------
// Function to generate a single burst of confetti
// ----------------------------------------------------
function generateConfetti() {
const colors = ['#9F8C58', '#C8B273','#F0D695', '#f1faee', '#a8dadc', '#457b9d', '#1d3557', '#ffc300', '#da291c', '#00b4d8'];

const viewportWidth = window.innerWidth;
const viewportHeight = window.innerHeight;

// --- FIX: Create a DocumentFragment to hold particles ---
const fragment = document.createDocumentFragment();

for (let i = 0; i < COUNT; i++) {
    const confetti = document.createElement('span');
    confetti.className = 'confetti';

    confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];

    // ... (all your other confetti styling code remains the same) ...
    const startX = Math.random() * viewportWidth;
    const startY = Math.random() * viewportHeight * 0.4;
    confetti.style.left = `${startX}px`;
    confetti.style.top = `${startY}px`;

    const endX = (Math.random() - 0.5) * 800; 
    const endY = viewportHeight + 100 + Math.random() * 200; 
    const rotation = Math.random() * 1080 + 360; 
    
    confetti.style.setProperty('--x', `${endX}px`);
    confetti.style.setProperty('--y', `${endY}px`);
    confetti.style.setProperty('--r', `${rotation}deg`);
    
    const size = Math.random() * 6 + 4;
    confetti.style.width = `${size}px`;
    confetti.style.height = `${size * 1.5}px`;
    confetti.style.borderRadius = `${Math.random() > 0.5 ? '50%' : '2px'}`; 

    confetti.style.animationDelay = `${Math.random() * 0.5}s`; 

    // --- FIX: Add to the fragment (fast) instead of the container (slow) ---
    fragment.appendChild(confetti);

    // Individual cleanup
    const delay = parseFloat(confetti.style.animationDelay) * 1000 || 0;
    setTimeout(() => {
    confetti.remove();
    }, ANIMATION_DURATION_MS + delay + 500); // 500ms buffer
}

// --- FIX: Add all 20 particles to the DOM in one single operation ---
container.appendChild(fragment);
}
    
    // ----------------------------------------------------
    // Public function to START the continuous confetti
    // ----------------------------------------------------
    function startConfetti() {
        if (isConfettiRunning) return; // Already running

        isConfettiRunning = true;
        
        console.log("Confetti STARTING in continuous loop...");
        
        // 1. Call immediately to start the first burst
        generateConfetti();

        // 2. Set the interval to keep generating new bursts constantly
        confettiInterval = setInterval(generateConfetti, BURST_INTERVAL_MS);
        
        // If you need the confetti to start AFTER a server-side action:
        /*
        google.script.run
            .withSuccessHandler(function() {
                // Same logic as above: start state, generate first burst, set interval
            })
            .withFailureHandler(function(error) {
                console.error("Server error:", error);
                stopConfetti(); // Stop if the server call fails
            })
            .runServerEvent();
        */
    }
    
    // ----------------------------------------------------
    // Public function to STOP the continuous confetti
    // ----------------------------------------------------
    function stopConfetti() {
        if (!isConfettiRunning) return; // Already stopped

        isConfettiRunning = false;
        
        console.log("Confetti STOPPING.");

        // Clear the interval so no new confetti bursts are generated
        clearInterval(confettiInterval);
        
        // NOTE: Particles currently on the screen will continue their animation 
        // for the remaining time and then be removed by their individual cleanup timers.
    }

export {
    championshipBanner,
    closeChampion,
    stopConfetti,
    generateConfetti,
    startConfetti
};

window.closeChampion = closeChampion;
window.startConfetti = startConfetti;
window.stopConfetti = stopConfetti;
window.championshipBanner = championshipBanner;