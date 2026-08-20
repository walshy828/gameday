# Handoff: Dodgeball Tournament Game-Day App (v2 redesign)

## Overview
Game-day companion app for the Algonquin Regional hockey team's dodgeball fundraiser tournament.
Three audiences share one app:

1. **Fans / players** (no login) — live round clock, standings, schedule, tournament info, announcement banner.
2. **Court managers** (login) — report the final of every game on their court, switch courts mid-day, crew chat.
3. **Tournament managers** (login, superadmin) — round clock + round advance, results across every active division, announcements, Google Sheet sync setup, crew chat.

Google Sheets remains the document of record; the app reads match data from it and writes results back.

## About the Design Files
The files in this bundle are **design references created in HTML** — a prototype showing intended look and behavior, **not production code to copy**. The task is to **recreate these designs in the target codebase** (`tournament-gamedayapp`) using its existing framework, component patterns, routing, and Firebase data layer. Where this prototype holds state locally (React class state), the real app should read/write Firebase.

`Dodgeball Game Day v2.dc.html` is the current design. It is a single-file HTML/React prototype: markup at the top, a logic class below the `<script>` marker. `dodgeball-game-day.html` is the same design bundled to one standalone offline file — open it in a browser to click through every screen. `Dodgeball Game Day.dc.html` is the previous (v1, flat) design, included only for diffing.

## Fidelity
**High fidelity.** Colors, type, spacing, radii, and interactions are final. Recreate pixel-close, but substitute the codebase's own component library where it already has an equivalent (buttons, inputs, toggles, modals). All copy in the prototype is intended production copy.

## Device targets
Designed mobile-first inside a device frame (390px-class phone) with a tablet toggle. The frame itself (the outer maroon/gold page, the phone/tablet segmented control, the device bezel) is **prototype chrome only — do not build it**. Build the screen contents responsively: single column on phone, and where the prototype uses `repeat(auto-fit,minmax(240–250px,1fr))` grids, let them become 2-up on tablet/desktop.

## Navigation model
- **Gate (fan landing)** → division picker → app tabs.
- **Division-first**: picking a division scopes standings, schedule, live, and (for court managers) the results list. Fans can return to the picker from the header chip.
- **Bottom tab bar, maximum 5 tabs.**
  - Not signed in: LIVE, STANDINGS, GAMES, INFO
  - Signed in (either role): STANDINGS, GAMES, INFO, ADMIN, CHAT — **LIVE is removed when signed in** (staff get the clock on the Admin page).
  - There is **no Setup tab**. Tournament managers reach Setup via the gear button next to Sign out on the Admin page; Setup has a "← Admin" button back.
- Login is reached from the gate's "Admin login" pill and from the INFO tab's admin card.
- **All teams advance to playoffs** — there is no bracket screen anywhere.

## Screens

### 1. Gate — fan landing
Full-bleed dark hero. Kicker "ALGONQUIN HOCKEY PRESENTS" (600 10px, .18em, gold), title "Dodgeball / Tournament" (700 27px, -.03em, #F5F5F6), team logo 42px. Bottom row: fine print left ("All proceeds support Algonquin Regional hockey."), **Admin login** pill right (999px radius, 1px `rgba(224,184,99,.5)` border, `rgba(224,184,99,.1)` fill, gold-light text, 12px 18px).

### 2. Division picker
Grid of division cards, one per active division: kicker (GRADES / GIRLS), short label ("5–6"), team count. Tapping sets `divId` and enters the app on the LIVE tab.

### 3. Login
Card on glass: kicker "ADMIN SIGN-IN" (gold), headline "Sign in to run games". Fields: **Your name** (text), **Access code** (4-digit). Role choice as two tiles:
- *Court manager* — "Report the final of every game on your court." (shows a **Your court** 4-up segmented picker, courts 1–4)
- *Tournament manager* — "Clock, rounds, announcements, settings, every court."
Primary button gradient maroon (`linear-gradient(135deg,var(--mar-l),var(--mar))`), 16px radius, white text.

### 4. Announcement banner (global, above tab content)
Pill-card, margin `12px 14px 0`, 20px radius, `linear-gradient(135deg,rgba(224,184,99,.2),rgba(166,48,63,.16))`, 1px `rgba(224,184,99,.28)` border, blur(18px). Layout: "NOW" label (gold, 9px, .14em) · text (500 12px/1.45, `rgba(255,255,255,.86)`) · **✕ dismiss** button (22px circle).
Behavior: always shows the **latest active announcement**. Dismissing records that announcement's id (`annDismissed`); the banner stays hidden until a **newer** announcement is posted or re-activated, then it pops back in with a 0.28s ease slide-up (`sheetin`). Announcements have **no categories/tags** — text and timestamp only.

### 5. LIVE (fans; hidden for signed-in staff)
Round clock card: kicker `ROUND n · COURTS 1–4`, clock `700 36px` tabular-nums, sub-line. Pulsing 8px dot (`glowpulse` 1s infinite) when running. Below: **games in progress** per court, and a **Top of the standings** card (top 3, gold rank chips 24px/9px radius, record, points in gold-light) with an "All standings →" link.

### 6. STANDINGS
Title "Standings" (700 26px) + scoring label (e.g. "3 PTS WIN · 1 TIE"). Rows: rank, emoji, team name, W-L-T, points. Points sorted by points then tiebreak (players left × tiebreak value).

### 7. GAMES (schedule)
Title "Schedule" + court count label. **All teams** select filter (18px radius, glass). Rounds listed with time, court, both teams, and result stamp when reported.

### 8. INFO
Cards: **Announcements** (active list; newest gets the gold/maroon gradient treatment, rest `rgba(255,255,255,.05)`; each row = time · text), **Rules** (numbered 1–6, maroon-tinted number chips), **Fundraiser** (maroon gradient card), and the **admin access** card ("Admin login →" / "Back to my admin view →", sub "Court managers and admins only.").

### 9. ADMIN
Header: `{adminTitle}` — "Court n results" or "Tournament control"; sub-line `{adminWho}`. Right side: **Sign out** pill and, for tournament managers only, a **⚙ gear button** (36px circle, gold-tinted) that opens Setup.

Court manager body:
- **My court** card (white .95 glass): 4-up court segmented picker + helper copy.
- **Results list** for their court, rounds n-1…n+1.

Tournament manager body:
- **Timer controls** card (dark glass, maroon gradient): clock `700 48px`, −30s / play-pause / +30s; divider; **After-round timer** toggle + −15s / value / +15s; **Prev round** / **Next round**; **Show clock to everyone** toggle.
- **Results list across every active division** — there is no division switcher on this page (removed); each row's meta reads `DIVISION · COURT n · TIME · THIS ROUND`.

Results list rows (white card, 20px radius rows): meta line, team A, team B, result stamp ("Not reported yet" in `#B8873A`, or "<Team> won · n left · <reporter>" in green), and a **Report** (gold gradient) / **Edit** (white outline) button.

### 10. Report result modal
Backdrop `rgba(10,10,11,.62)` + blur; sheet animates in with `sheetin` (0.28s). Meta line `Court n · time · Division`. Winner choice: Team A / Team B / Tie. **Players left** stepper (0–12, tiebreak input). Optional note field. Save writes the result attributed to the signed-in reporter and flashes a toast.

### 11. CHAT (crew chat)
Title "Crew chat" + "COURTS 1–4 + DESK". Sub-line: managers see "Every court manager sees this channel."; court managers see "Court managers and admins."
Bubbles: mine right-aligned (`20px 20px 6px 20px`), others left (`20px 20px 20px 6px`), glass fill, author label + time, 13px/1.5 body. Composer: pill input + **Send** (maroon gradient when non-empty, else `rgba(255,255,255,.12)`). Footer: "Posting as <label> — fans never see this channel."
Author labels: tournament manager = `Admin · <name>`; court manager = `Court n · <name>`.

**Unread dot on the CHAT tab** — 9px circle, top:-3px right:-6px on the tab icon, 1.5px `rgba(20,20,22,.9)` ring:
- Any unread message from a **tournament manager (admin)** → **red** `var(--warn)` #D9503C
- Unread only from **other court managers** → **maroon** `var(--mar-l)` #A6303F
- Admin overrides: red wins when both are unread.
Unread = messages with `id > chatSeen` not authored by me. Opening the CHAT tab sets `chatSeen` to the max message id.

### 12. SETUP (tournament manager only)
Header "Setup" + "← Admin" pill. Cards:
- **Announcement manager** (moved here from Admin): textarea composer ("e.g. Grades 5–6 semifinals move to Court 1 at 4:20."), **Post announcement** / **Save changes** button (maroon gradient; `#C6C6CA` when empty), **Cancel edit** when editing, then the full announcement list with **Live/Hidden toggle**, **Edit**, **Delete** per row. No tag/category picker.
- **Google Sheet sync**: CONNECTED badge, "↻ Sync now" (gold gradient), last-sync time, **Auto-sync** toggle with 15s/30s/60s rate chips, and **SYNC SCOPE · ACTIVE DIVISIONS** toggles (this is where divisions are activated/deactivated).
- **Recent syncs**: time · OK badge · detail.

## Interactions & behavior
- Round clock ticks every 1000ms while `running`; pause/resume, ±30s, prev/next round.
- Clock turns `--warn` under 60s remaining; pulsing dot only while running.
- `showClock` hides the fan-facing clock; staff always see it.
- Toast: 2600ms auto-dismiss, bottom-anchored, used for "Result saved", "Posted · now showing on every phone in the gym.", "Announcement updated/deleted.", "Signed out. Back to the fan view."
- Sign out clears role/name/pin and returns to the fan LIVE view.
- Modals: tap backdrop or Cancel to close; nothing else scrolls behind.
- Keyframes: `glowpulse` (1s live dot), `sheetin` (0.28s modal/banner entry).

## State → Firebase mapping (suggested)
| Prototype state | Firebase / server |
| --- | --- |
| `divisions`, `teams`, `schedule` | synced from Google Sheet → `/divisions/{divId}` |
| `results[gameId]` | `/results/{divId}/{gameId}` = { winner, remaining, tie, by, notes, ts } |
| `anns[]` | `/announcements/{id}` = { text, ts, on } (ordered by ts; latest active is the banner) |
| `annDismissed` | client-local (localStorage), per device |
| `chat[]` | `/chat/{id}` = { who, mgr, text, ts } |
| `chatSeen` | client-local (localStorage) per device/user |
| `clock`, `running`, `round`, `showClock`, `afterOn`, `afterSec` | `/clock` — server-authoritative; write `endsAt` timestamps, not tick counts, so all phones agree |
| `active[]` | `/config/activeDivisions` |
| `auto`, `rate`, `synced` | `/config/sync` |
| `settings` (win/tie/tiebreak/courts/roundLen) | `/config/scoring` — admin-editable |

Auth: two roles only — `courtManager` (has a `court`) and `tournamentManager`. Access code gates both; tournament manager is superadmin (clock, rounds, announcements, sync, all divisions).

## Configurable values (were prototype tweaks — make these admin settings)
| Setting | Default | Range |
| --- | --- | --- |
| Points per win | 3 | 1–5 |
| Points per tie | 1 | 0–3 |
| Tiebreak per player left | 0.01 | 0–0.1 |
| Courts running | 4 | 2–4 |
| Round length | 6 min | 2–12 |

## Design tokens
```
--mar:   #7B1D2B   maroon (primary)
--mar-l: #A6303F   maroon light
--mar-d: #4E101B   maroon dark
--gold:  #E0B863   gold (accent)
--gold-l:#F3DCA9   gold light
--gold-d:#B8893A   gold dark
--ink:   #1A1A1C   text on light surfaces
--mute:  #6C6C70   muted text
--line:  rgba(18,18,20,.09)  hairline on light
--ok:    #2E9E63   success
--warn:  #D9503C   alert / unread-from-admin
page bg: #0A0A0B with maroon radial washes
light surfaces: #FFFFFF / rgba(255,255,255,.95), #F5F5F6, #F3F3F4, #EFEFF0
dark glass:  rgba(255,255,255,.05–.08) + 1px rgba(255,255,255,.10–.13) + blur(18–28px)
```
Neutrals are true grays — **no purple/violet tint anywhere**.

Type: Inter (`-apple-system` fallback). Scale used: 700 36–48px clock, 700 26px screen titles, 700 22–24px card headlines, 600 13–15px labels/buttons, 500 12–13px body, 600 9–11px uppercase kickers (letter-spacing .08–.18em). Tabular-nums on all clocks, scores, and points.

Radii: 40px device frame, 26px cards, 20px rows, 16–18px inputs/buttons, 14–15px small buttons, 999px pills.
Shadows: `0 16px 44px rgba(0,0,0,.3)` on light cards, `0 18px 44px rgba(0,0,0,.5)` on the tab bar, `inset 0 1px 0 rgba(255,255,255,.09)` top-light on dark glass.
Spacing rhythm: 6/7/10/11/14/16/18px; grids use `gap:6–10px`.

## Assets
- `assets/algonquin-hockey.png` — team logo (gate 42px, in-app header 38px). Use the real team asset in production.
- Team emojis are inline Unicode in the prototype's team pool — replace with the real roster from the sheet.
- Icons: the prototype uses emoji for tab icons as placeholders. **Substitute a proper icon set** (Phosphor or the codebase's existing set) in production.

## Files in this bundle
- `Dodgeball Game Day v2.dc.html` — current design (source of truth)
- `dodgeball-game-day.html` — same design, standalone/offline; open this to click through
- `Dodgeball Game Day.dc.html` — previous v1 design, for reference only
- `support.js`, `_ds/`, `assets/` — runtime + design-system tokens + logo the prototype loads

## Known non-goals
- No bracket / playoff seeding screen (all teams advance).
- No push notifications (unread dot only).
- The device frame and phone/tablet toggle are prototype scaffolding, not product.
