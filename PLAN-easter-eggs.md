# Easter eggs: implementation plan

Target file: `index.html` (single file, vanilla JS, no build). Read it fully first. Keep every change inside the existing IIFE and the existing `<style>` block. Do not add libraries. Do not change the network protocol: everything new lives inside the shared `S` object so host → guest sync is automatic.

## 0. How the code works today (read before touching anything)

- `S` is the whole game state. The **authority** (local mode, or the host in P2P) mutates it inside `apply(action)`, then calls `broadcast()` (sends `S` to guest) and `render()`. Guests never mutate `S`; they send `{type:'action', action}` via `dispatch()` and receive full `S` snapshots.
- `render()` is idempotent and async. It is re-run on every state change on every screen. One-shot effects (sounds, confetti) are guarded by "already shown for round `S.n`" variables: `shownN`, `fxN`, `fx67N`, `fxWin`. **Every new effect must use the same pattern**: store an event in `S` with the round number `n`, play it in `render()` once per `n`, track with a local `xxxShown` variable. Never play an effect from `apply()` (guests never run `apply`).
- `S.n` increments on every roll. `S.phase` is `'idle'` (waiting for Roll) or `'answer'`.
- `S.last = {slot, r, c, given, ok}` is the last answer.
- Sounds: `tone(freq, dur, {type, gain, at, slide})` and `noise(dur, gain, at)`. `sfx.*` wrappers check `ut()` (Pixel RPG skin) for variants.
- Visual helpers: `cells[r+'-'+c]` → `<td>`; `cellCenter(key)` → `[x,y]`; `confetti(x,y,colors,count,power)`; `dmgPop(key, text, miss)` (RPG skin only); `setMsg(text, cls)` (typewriter in RPG skin, `cls` = `''|'ok'|'bad'`).
- Skins: `skin()` returns `''` (Classic) or `'ut'` (Pixel RPG). Skin-specific CSS is scoped under `[data-skin="ut"]`. Every new visual needs both skins to look acceptable (tokens `--p1 --p2 --hl --hl-strong --fg --bg --paper --line` already adapt; prefer them).
- `freshGame(names, seats)` builds a new `S`. Add all new fields here with safe defaults.
- `nick()` reads the lobby name field. Names are stored in `S.names[slot]`.

Existing example of the full pattern (67 mode): `hit67()` writes `S.ev67 = {n, kind}` in `apply`; `render()` checks `S.ev67.n === S.n && fx67N !== S.n`, sets `fx67N = S.n`, sets `animating = true`, awaits `play67()`, sets `animating = false`, returns `render()`. Copy this shape for the creeper explosion and glitch mode.

## 1. New state fields (add to `freshGame`)

```js
ach: [],            // [{id, slot, n}]  achievements earned this match (authority appends)
streak: [0, 0],     // consecutive correct answers per slot (reset to 0 on a miss)
behind: [0, 0],     // max deficit each slot has been at (for "comeback")
ore: [],            // 3 cell keys 'r-c' chosen at game start, hidden diamond cells
oreFound: [],       // ore keys that have been claimed (rendered with the diamond)
creeper: null,      // {n, key} when the current roll is a creeper cell
boom: null,         // {n, lost:[{key, slot}]} set when a creeper exploded (effect event)
craters: {},        // {key: n} cells cratered at round n; a crater lasts 2 rounds
ears: false,        // true after someone answers 1928; roll cursor gets ears
glitch: null,       // {n} set when someone answers 0 (effect event)
```

`ore` must be chosen by the authority inside `freshGame` (random 3 distinct keys, any r,c in 1..10, but **not** r=6/7 with c=6/7 combos reserved for 67, and not 1×1). Because `freshGame` runs on the authority only (local or host; the guest always receives `S`), plain `Math.random()` is fine.

Also add a helper next to `freshGame`:

```js
function award(id, slot){ if (!S.ach.some(a => a.id === id && a.slot === slot)) S.ach.push({ id, slot, n: S.n }); }
```

Achievements are once per player per match.

## 2. Achievement toasts (shared mechanic)

### Catalogue (`const ACH = {...}` near `UT_LABELS`)

| id | title | how to earn (checked in `apply`) |
|---|---|---|
| `first-blood` | First blood | first correct answer of the match: after a claim, `S.scores[0]+S.scores[1] === 1` |
| `nine-master` | Nine-master | after a claim, the player owns ≥3 cells where `r===9 || c===9` |
| `speedrun` | Gotta go fast | `S.streak[slot]` reaches 3 |
| `full-stack` | Full stack | correct answer and `r*c === 64` |
| `sixty-seven` | Six seven | inside `hit67()` (slot = `S.turn` for `'roll'` kind, `S.last.slot` for others; for `'score'` give to both) |
| `knockout` | A knockout! | on win, loser has ≤3 |
| `comeback` | Comeback kid | on win, `S.behind[winner] >= 3` |
| `diamond` | Diamonds! | claimed an ore cell |
| `creeper` | Creeper survivor | answered a creeper cell correctly before it blew |
| `steamboat` | Steamboat | answered exactly 1928 (wrong answer, still awarded) |
| `abstracted` | Abstracted | answered exactly 0 |

Each entry: `{ title, icon }` where `icon` is a single emoji (🩸 9️⃣ 💨 📦 🎰 🥊 🔁 💎 💥 🚢 🌀). Emoji is fine in both skins.

### Bookkeeping in `apply` (answer branch), in this order

1. Compute `ok` as today.
2. `if (ok) S.streak[slot]++; else S.streak[slot] = 0;`
3. Apply score change (see ore/creeper below for +2 and explosions).
4. `const d = S.scores[1-slot] - S.scores[slot]; if (d > S.behind[slot]) S.behind[slot] = d;` (do for both slots each answer).
5. Run the checks in the table and call `award(...)`.
6. Win checks (`knockout`, `comeback`) run right after `winner` is set.

### Rendering toasts

- Markup: add `<div id="toasts" aria-live="polite"></div>` right after `<canvas id="fx">`.
- CSS (Classic): fixed, `top: calc(env(safe-area-inset-top,0px) + 12px); right: 12px;` column, gap 8px, z-index 11, pointer-events none. Each `.toast`: dark panel `background:var(--fg); color:var(--bg)`, radius 6px, padding 10px 14px, grid `auto 1fr`, icon 26px, line 1 small uppercase "Achievement get!" (muted), line 2 title bold. Animation: slide in from right 250ms ease-out, hold 3s, fade out 300ms; remove the node after 3.6s. Max 3 visible (drop oldest).
- CSS (RPG skin): black box, 3px white border, no radius, Press Start 2P 9px for the header line, VT323 20px title, icon stays emoji.
- Sound: `sfx.ach()` = two rising triangle notes 880→1320 (0.1s each), RPG variant square.
- Display logic in `render()`: keep a module-level `achShown = new Set()`. After `paintOwners(S.cells)` and before the waiting-for-player check, do:

```js
for (const a of S.ach) { const k = a.id + ':' + a.slot + ':' + a.n; if (!achShown.has(k)) { achShown.add(k); toast(a); } }
```

`toast(a)` builds the node with `ACH[a.id].icon`, `ACH[a.id].title`, and a third line with `name(a.slot)`. In P2P every screen shows every toast (both players see each other's).

- Win screen: after the existing win message, append a list of achievements per player: `$('actions')` gets a `<div class="achlist">` with `name(slot) + ': ' + titles.join(', ')` for each slot that has any. Keep the "Play again" button first.
- Reset: `achShown.clear()` inside the `'reset'` branch is not possible on guests; instead clear it whenever `S.n === 0 && S.ach.length === 0` at the top of `render()`.

## 3. Creeper cell

### Authority (`apply`, roll branch)

- After choosing `t` and assigning the roll: `if (!S.force67 && Math.random() < 0.04) S.creeper = { n: S.n, key: t.r+'-'+t.c }; else S.creeper = null;` (4 %, never on a forced-67 roll, never on an ore cell).
- Start a fuse timer on the authority only: a module-level `let fuseTimer`; `clearTimeout(fuseTimer); if (S.creeper) fuseTimer = setTimeout(() => apply({ type:'fuse', n: S.n }), 8000);` Place this inside `apply` right after the roll assignment; `apply` only runs on the authority so this is safe. 8 s = ~2.3 s roll animation + ~5.5 s to answer.
- New action branch `'fuse'`: ignore unless `S.phase === 'answer' && S.creeper && S.creeper.n === action.n && action.n === S.n`. Otherwise call `explode(slot = S.turn)` and then treat it as a wrong answer: `last = {slot, r, c, given: null, ok: false}`, `phase:'idle'`, `turn: 1-slot`, `streak[slot]=0`.
- In the answer branch: `clearTimeout(fuseTimer)` first. If `S.creeper && S.creeper.n === S.n`: on `ok` → `award('creeper', slot)`; on wrong → `explode(slot)` before writing `last`.
- `explode(slot)`:
  ```js
  const [r,c] = S.creeper.key.split('-').map(Number);
  const near = []; for (let dr=-1; dr<=1; dr++) for (let dc=-1; dc<=1; dc++) { if (!dr && !dc) continue; const k = (r+dr)+'-'+(c+dc); if (S.cells[k] != null) near.push(k); }
  near.sort(() => Math.random()-0.5);
  const lost = near.slice(0, 3).map(k => { const owner = S.cells[k]; delete S.cells[k]; S.scores[owner]--; S.craters[k] = S.n; return { key:k, slot: owner }; });
  S.craters[S.creeper.key] = S.n;
  S.boom = { n: S.n, key: S.creeper.key, lost };
  ```
  Scores can drop; never below 0 (they cannot, cells are only removed if owned). `winner` stays null.
- `freeCells()`: exclude keys where `S.craters[k] != null && S.n - S.craters[k] < 2`.
- On every roll, prune craters older than 2 rounds: `for (const k in S.craters) if (S.n - S.craters[k] >= 2) delete S.craters[k];`

### Guest / all screens (`render`)

- When `S.phase === 'answer' && S.creeper && S.creeper.n === S.n`, after the existing `target asking` classes add `creeper` to the target cell and `body.classList.add('fuse')`. Remove both whenever that is not true.
- Countdown bar: inside the `.bar`, add `<div id="fuse"><i></i></div>` (CSS: hidden unless `body.fuse`; 6px tall track, inner `<i>` width animates 100%→0 over 5.5 s with `animation: fuseDown 5.5s linear forwards`). Restart the animation when the creeper round begins: the roll animation ends in `render()` (after `await roll(...)`), so right there do `const f = $('fuse').firstElementChild; f.style.animation = 'none'; void f.offsetWidth; f.style.animation = '';`. Also play `sfx.hiss()` there if the current roll is a creeper: a 1.2 s filtered noise swell (`noise(1.2, 0.25)` is fine) plus a low sine at 60 Hz.
- Explosion effect: module-level `boomShown = 0`. In `render()`, in the `else` branch (phase idle) before the existing `S.last` effects: `if (S.boom && S.boom.n === S.n && boomShown !== S.n) { boomShown = S.n; await playBoom(S.boom); }` using the same `animating = true/false; return render()` shape as `play67`. `playBoom`: `sfx.boom()` (noise 0.5 s gain 0.5 + sine 50 Hz slide −30, 0.6 s), body shake 400 ms (reuse the existing `document.body.animate` keyframes with ±12px), confetti from the creeper cell in greens/greys `['#4caf50','#2e7d32','#9e9e9e']` count 90 power 1.8, and each `lost` cell flashes (add class `blast` for 600 ms: background `var(--bad)`).
- Craters: `paintOwners` already clears classes; after it, loop `S.craters` and add class `crater` where `S.n - S.craters[k] < 2`. CSS Classic: `background: repeating-linear-gradient(45deg, var(--line) 0 4px, transparent 4px 8px)`, text hidden. RPG: dark grey `#222` with `#555` dashes.
- Creeper cell look (`td.creeper`): Classic: `background:#4caf50; color:#0b3d10`, show `::after` content `"▚"` (a creeper-ish face is fine as plain text `"ᓚᘏᗢ"` is not; use `"•_•"` in 0.8em). RPG: green bg, black face. Keep the `?` from `.asking` hidden when `.creeper` is present.
- Message while a creeper is live: in the `'answer'` branch of `render()` prefix the message with `'Creeper! '`.

## 4. Diamond (ore) cells

- `freshGame`: pick 3 keys into `S.ore` (see §1).
- `apply` roll branch: nothing special (ore cells are chosen like any free cell).
- `apply` answer branch: `const isOre = S.ore.includes(r+'-'+c);` on `ok` and `isOre`: `S.scores[slot] += 2` instead of `+1`, push key to `S.oreFound`, `award('diamond', slot)`. Wrong: ore stays hidden (nothing changes).
- `render()`: when `phase === 'answer'` and the target key is in `S.ore`, add class `ore` to the target cell (reveal). After `paintOwners`, add class `ore-found` to every key in `S.oreFound`.
- CSS `td.ore::after` content `"◆"` in `#4dd0e1` (cyan), replacing the `?`; `td.ore-found` keeps the owner tint and shows a small `◆` in the top-right corner via `::before` (absolute, 0.6em). RPG skin: same glyph, `#5fe6ff`.
- Sound on landing on an ore cell: in `render()` right after `await roll(...)`, `if (S.ore.includes(key)) sfx.ore()` = three quick ascending sine notes 1200/1600/2000 Hz (0.08 s each), XP-orb feel.
- Message in `'answer'` phase: prefix `'Diamond! Worth 2. '`.
- Win-screen line: unchanged.

## 5. Secret names

- Table near `UT_LABELS`:

```js
const HEROES = {
  sonic:   { color:'#2b6cff', soft:'#d6e2ff', icon:'💨' },
  cuphead: { color:'#d9442b', soft:'#f8d9d3', icon:'☕' },
  mugman:  { color:'#2b8fd9', soft:'#d3e8f8', icon:'☕' },
  steve:   { color:'#3f8f3a', soft:'#d9efd6', icon:'⛏' },
  creeper: { color:'#4caf50', soft:'#d8f0d9', icon:'💥' },
  mickey:  { color:'#d81b1b', soft:'#f8d6d6', icon:'🐭' },
  donald:  { color:'#1e5bc6', soft:'#d4dff5', icon:'🦆' },
  goofy:   { color:'#e08a1e', soft:'#f9e5cc', icon:'🐶' },
  pomni:   { color:'#c2185b', soft:'#f6d3e1', icon:'🃏' },
  caine:   { color:'#f2b400', soft:'#fbeeb8', icon:'🎩' },
  jax:     { color:'#7e57c2', soft:'#e3d8f5', icon:'🐰' },
};
```

- `function hero(slot){ const n = (S.names[slot] || '').trim().toLowerCase(); return HEROES[n] || null; }`
- In `render()`, before painting names: for each slot, `const h = hero(slot); const root = document.documentElement.style;` if `h`, `root.setProperty('--p'+(slot+1), h.color); root.setProperty('--p'+(slot+1)+'-soft', h.soft);` else `root.removeProperty(...)` for both. In the RPG skin use `h.color` as-is but set `soft` to a 20 % mix with black: simplest is to keep `soft` only for Classic (`if (!ut())`) and remove it in RPG.
- `name(slot)` prepends `h.icon + ' '` when a hero matches (keep the `(you)` suffix logic).
- Circus scheme: `const circus = ['pomni','caine','jax'].includes(lower name)` for either slot → `document.body.classList.toggle('circus', anyCircus)`. CSS under `body.circus`: `th.hl, td.hl-row, td.hl-col { background: repeating-linear-gradient(90deg, #e53935 0 10px, #fdd835 10px 20px, #1e88e5 20px 30px); color:#fff; text-shadow:0 1px 0 #000 }`, `td.hl-row.hl-col { background:#fff; color:#000 }`, and the active player card gets a 4px striped top border (`border-image: repeating-linear-gradient(90deg,#e53935 0 10px,#fdd835 10px 20px,#1e88e5 20px 30px) 4`). Same rule set works in both skins (literal colours are intentional, it is a circus).
- The lobby already stores `nick`; nothing else to change. Names are max 14 chars and compared lowercase, so `Sonic`, `SONIC`, `sonic` all work.

## 6. 1928 answer (Steamboat)

- `apply` answer branch: `if (g === 1928) { S.ears = true; award('steamboat', slot); S.evWhistle = { n: S.n }; }` (add `evWhistle: null` to `freshGame`).
- `render()`: module-level `whistleShown = 0`. In the idle branch, with the other `S.last` effects: `if (S.evWhistle && S.evWhistle.n === S.n && whistleShown !== S.n) { whistleShown = S.n; sfx.whistle(); }` `sfx.whistle()` = two overlapping sines, 520 Hz and 780 Hz, each 0.9 s, with a quick upward slide of +60 Hz at the start, gain 0.15, then the same pair again at `at: 1.0`. Steamboat toot-toot.
- Ears: `document.body.classList.toggle('ears', !!S.ears)` in `render()`. CSS: `body.ears td.hl-row.hl-col::before, body.ears td.hl-row.hl-col::after { content:""; position:absolute; top:-30%; width:45%; aspect-ratio:1; border-radius:50%; background:var(--fg); z-index:2 }` with `::before { left:-8% }` and `::after { right:-8% }`. In RPG skin they are white squares (`border-radius:0`). Ears also show on `td.target.asking` so they persist on the landed cell during the answer phase.
- Message: when `g === 1928`, the usual "said 1928, but …" line gets the suffix `'Toot toot! '` (append in the `line` builder like the 67 suffix).

## 7. Glitch mode (answer 0)

- `apply` answer branch: `if (g === 0) { S.glitch = { n: S.n }; award('abstracted', slot); }`
- `render()`: module-level `glitchShown = 0`. In the idle branch **before** the `S.last` effects (so the normal miss sound plays after): `if (S.glitch && S.glitch.n === S.n && glitchShown !== S.n) { glitchShown = S.n; animating = true; await playGlitch(); animating = false; return render(); }`
- `playGlitch()` (2 s):
  - `document.body.classList.add('glitching')`; CSS: `body.glitching .board { animation: glitch 2s steps(12) }` where `@keyframes glitch` cycles `clip-path: inset(a% 0 b% 0)` with `transform: translateX(±6px)` and `filter: hue-rotate(90deg) invert(1)` on odd steps (write 6 keyframe stops, values can be hand-picked).
  - Every 90 ms for 2 s, set `textContent` of 25 random `<td>` elements to a random char from `'#%&@?!¤§∆◊'`; keep a map of originals (`td.dataset.v` is the real product, and `td.textContent` is normally empty: the glitch writes text directly and must set it back to `''` at the end, and claimed cells use `::before` so are unaffected).
  - Header texts (`#nm0`, `#nm1`, `#msg`) also get scrambled the same way; restore from saved strings at the end.
  - Sound: `sfx.glitch()` = noise 2 s gain 0.18 through a bandpass at 2500 Hz, plus 8 random square blips of 30 ms at random pitches 200–3000 Hz spaced 0.25 s.
  - After 2 s: remove class, restore texts, `sfx.click()`.
- Message suffix for `g === 0`: `'Abstracted. '`.

## 8. Sounds to add to `sfx` (summary)

| name | Classic | RPG (`ut()`) |
|---|---|---|
| `ach()` | triangle 880→1320, 2 notes | square same |
| `hiss()` | noise 1.2 s gain 0.25 + sine 60 Hz 1.2 s | same |
| `boom()` | noise 0.5 s gain 0.5 + sine 50 Hz slide −30 | same |
| `ore()` | sine 1200/1600/2000, 0.08 s each | square |
| `whistle()` | two sines 520+780 Hz ×2 | square |
| `glitch()` | bandpass noise 2 s + 8 random blips | same |

`noise()` currently hard-codes a lowpass at 1800 Hz. Add an optional 4th argument `filter = {type:'lowpass', freq:1800}` so `glitch()` can pass a bandpass.

## 9. CSS additions checklist

- `#toasts`, `.toast` (+ RPG variants)
- `td.creeper`, `body.fuse #fuse`, `#fuse i`, `@keyframes fuseDown`, `td.blast`, `td.crater` (+ RPG)
- `td.ore::after`, `td.ore-found::before` (+ RPG colour)
- `body.circus …` stripes
- `body.ears …` ears (+ RPG squares)
- `body.glitching .board`, `@keyframes glitch`
- `.achlist` on the win screen (small muted text, wraps)
- Every animation gets a `@media (prefers-reduced-motion: reduce)` override that sets `animation: none` (toasts just appear, glitch only scrambles text, boom only flashes cells).

## 10. Order of work (each step ends with the page loading without console errors)

1. State fields + `award()` + achievement catalogue + toast UI + `first-blood`, `speedrun`, `full-stack`, `knockout`, `comeback`, `nine-master`, `sixty-seven`.
2. Secret names + circus stripes.
3. Diamonds.
4. Creeper (authority logic first, then visuals, then `fuse` timeout).
5. 1928 whistle + ears.
6. Glitch mode.
7. Win-screen achievement list.

## 11. How to test (headless, already used on this project)

Start a server and drive the page with `agent-browser`:

```bash
python3 -m http.server 8766 --directory /Users/kascode/Work/zimult &
agent-browser open http://localhost:8766/index.html
```

Use `agent-browser eval --stdin` with a heredoc. Helpers that work in this page:

```js
// start local mode
document.getElementById('localBtn').click();
// roll (button is the first child of #actions when phase is idle)
document.querySelector('#actions button').click(); await new Promise(r=>setTimeout(r,6500)); // wait for the roll animation
// read the question and answer it
const [r,c] = document.querySelector('.q').textContent.match(/\d+/g);
const i = document.getElementById('answer'); i.value = r*c; // or 0 / 1928 / 67 for eggs
i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
// inspect state
window.__S   // getter for S, already exposed
```

To force specific scenarios without waiting for RNG, temporarily set state through `window.__S` on the authority before rolling, e.g. `__S.ore = [ '3-4' ]` or set `__S.creeper` after a roll (then dispatch an answer). Remove any debug code before finishing. Collect `window.onerror` messages during each scenario; the acceptance bar is: zero errors, every effect plays exactly once per round, and the P2P guest (second tab, same room code, see earlier session notes in this repo) shows the same toasts/effects as the host.

Always run `node --check` on the extracted script after edits:

```bash
sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > /tmp/ttd.js && node --check /tmp/ttd.js
```

## 12. Out of scope / do not do

- No external assets, images, audio files, or fonts beyond the two Google Fonts links already present.
- No references to trademarked names in UI text other than the player's own typed name and the achievement titles listed above.
- Do not change roll animation timing, the 67 mode, the PeerJS code, or the skin switcher.
