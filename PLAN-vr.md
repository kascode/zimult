# VR duel arena: implementation plan

Target: add an optional WebXR (`immersive-vr`) view to ZIMULT. The 2D game in `index.html` stays the source of truth; VR is a second renderer + input device that lives in a new file `vr.js`, lazy-loaded only when the player presses "Enter VR". Phones and desktops without WebXR never download it.

Read `index.html` fully before touching anything. Keep the existing IIFE intact; the only changes to `index.html` are the small **bridge** described in section 1.

## 0. How the game works today (what VR must respect)

- `S` is the whole game state. Only the **authority** (local / solo / streak modes, or the host in P2P) mutates it, inside `apply(action)`. Guests send `{type:'action', action}` through `dispatch(action)` and receive full `S` snapshots. VR never mutates `S`; it only calls `dispatch`.
- `render()` (async) is re-run on every state change on every screen. It paints the DOM from `S` and plays one-shot effects guarded by "shown for round `S.n`" variables (`shownN`, `fxN`, `fx67N`, `boomShown`, `glitchShown`, `whistleShown`, `fxWin`). The VR renderer will keep its **own** guards with the same names prefixed `vr` and must never touch the 2D ones.
- The roll animation is deterministic: `mulberry(seed)` → `roll(target, seed)` builds `steps = [{r, c, wait}]` (18 row steps, 26 column steps, waits from 45 ms easing out to ~345 ms). VR replays the exact same step list so both views land together.
- Sounds: `tone(freq, dur, {type, gain, at, slide})`, `noise(dur, gain, at, filter)`, wrappers in `sfx`. VR reuses `sfx` as-is (non-spatial) in phase 1.
- Modes: `mode` is `'local' | 'host' | 'guest' | 'solo' | 'streak'`; `mySlotIdx` is the VR player's seat (0 or 1, `-1` when spectating). `canAct(slot)` says whether this screen may act for `slot`.
- Actions VR needs: `{type:'roll'}`, `{type:'answer', slot, value:String}`, `{type:'reset'}`.
- Cell keys are `'r-c'` strings with r, c in 1..10. `S.cells[key] = slot`. `S.ore` (hidden diamonds), `S.oreFound`, `S.creeper = {n, key}`, `S.craters = {key: n}`, `S.boom = {n, key, lost:[{key, slot}]}`, `S.ev67 = {n, kind}`, `S.last = {slot, r, c, given, ok}`, `S.winner`, `S.ach = [{id, slot, n}]`.
- P2P transport: PeerJS data channel `conn`. Host handles `hello` and `action`; guest handles `state` and `full`. Section 7 adds a `pose` message in both directions.

## 1. Bridge in `index.html` (the only edits to the existing file)

Add, inside the IIFE, right after `function dispatch(action) {...}`:

```js
// ---------- external renderer bridge (VR) ----------
const stateListeners = new Set();
window.ZIMULT = Object.freeze({
  get state(){ return S; },
  get mode(){ return mode; },
  get mySlot(){ return mySlotIdx; },
  canAct, dispatch, name, mulberry, sfx, GOAL, N,
  onState(fn){ stateListeners.add(fn); if (S) fn(S); return () => stateListeners.delete(fn); },
  sendPose(p){ if ((mode === 'host' || mode === 'guest') && conn && conn.open) conn.send({ type:'pose', p }); },
  onPose(fn){ poseListener = fn; },
  rollSteps(target, seed){ /* copy of the step builder from roll(), returns the steps array only */ },
});
let poseListener = null;
```

- Extract the step list builder out of `roll()` into `function rollSteps(target, seed)` (returns `steps`), make `roll()` call it, and expose it as above. Both views then share one timing table.
- At the top of `render()`, right after the `if (!S || animating) return;` guard, add: `for (const fn of stateListeners) fn(S);`. (Listeners get every state, including ones the 2D view is still animating; the VR view has its own guards.)
- In `startHost`'s `c.on('data', ...)` add: `else if (m.type === 'pose') poseListener && poseListener(m.p);`. Same line in `startJoin`'s `conn.on('data', ...)`.
- Lobby: in the "Play together" section add `<li id="vrRow" hidden><button id="vrBtn" type="button">Enter VR</button><span class="hint">Quest or PC VR headset</span></li>`. On load: `if (navigator.xr) navigator.xr.isSessionSupported('immersive-vr').then(ok => { $('vrRow').hidden = !ok; }).catch(() => {});`. The button is **also** needed once a game is running (the player picks a mode first, then enters VR): add `<button class="ghost" id="vrBtn2" type="button" hidden>VR</button>` in the header `.skin` group next to `#mute`, shown under the same condition.
- Both buttons call `enterVR()`: `const m = await import('./vr.js'); m.start(window.ZIMULT);` wrapped in try/catch; on failure show the error in `#lmsg` / `setMsg(..., 'bad')`. If the lobby is still open when `vrBtn` is pressed, start **solo** mode first (`startSolo()`), because VR needs a running game; say so in the hint text ("Starts a solo game").
- Also expose `window.ZIMULT.enterVR = enterVR` so `vr.js` can show a re-enter button after the session ends.

Nothing else in `index.html` changes. Run the usual syntax check after editing.

## 2. `vr.js` skeleton and loading

```js
import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js';
export async function start(Z) { ... }
```

- ES module, loaded with dynamic `import('./vr.js')`. No bundler. `three.module.min.js` is a single file; do not import examples/jsm addons (they need import maps). Write the few helpers needed (text sprites, simple tweens) by hand.
- `start(Z)`:
  1. Create `renderer = new THREE.WebGLRenderer({antialias:true})`, `renderer.xr.enabled = true`, `renderer.setPixelRatio(1)`, canvas appended to `document.body` with `position:fixed; inset:0; z-index:20`, hidden until the session starts.
  2. `session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] })`; `renderer.xr.setReferenceSpaceType('local-floor')`; `await renderer.xr.setSession(session)`.
  3. Build the scene (section 3), subscribe `Z.onState(syncScene)`, start `renderer.setAnimationLoop(frame)`.
  4. On `session.addEventListener('end', ...)`: stop the loop, unsubscribe, remove the canvas, dispose geometries/materials, and the 2D page is simply there again (it kept rendering all along).
- Guard against a second `start()` while a session is active (`if (active) return`).

## 3. Scene layout (units are metres, y up, player stands at the origin facing −z)

| object | spec |
|---|---|
| Background | `scene.background = new THREE.Color(0x000000)`; 400 tiny `Points` (size 0.01, white, opacity 0.35) scattered in a 12 m sphere so head turns have reference |
| Arena | wireframe box `4 × 3 × 4` centred at (0, 1.5, −1.0), `EdgesGeometry` + `LineBasicMaterial({color:0xffffff})` |
| Pedestal | `BoxGeometry(1.3, 0.9, 1.3)`, material `0x111111`, top at y = 0.9, centre at (0, 0.45, −1.1) |
| Board slab | `BoxGeometry(1.2, 0.04, 1.2)` at y = 0.92, colour `0x000000`, edges white |
| Cells | 100 `Mesh(BoxGeometry(0.1, 0.02, 0.1))` in a 10×10 grid, pitch 0.11, cell (r, c) at `x = (c - 5.5) * 0.11`, `z = -1.1 + (r - 5.5) * 0.11` (row 1 is nearest the opponent, row 10 nearest the player, so the player reads it like the 2D table), y = 0.95. Material per cell: `MeshStandardMaterial({color:0x202020})`. Keep refs in `cellMesh[key]` |
| Headers | 20 text sprites (section 3.1) on the slab rim: column numbers along the far edge, row numbers along the left edge, white |
| Lights | `HemisphereLight(0xffffff, 0x222222, 1.2)` + `DirectionalLight(0xffffff, 0.8)` from (1, 3, 1) |
| Dialogue panel | plane `1.6 × 0.5` at (0, 1.75, −2.3), black with a 0.02 white border (two planes), text sprite inside (section 3.1), updated from `#msg`'s `textContent` on every frame (cheap diff) so the typewriter and all egg messages come for free |
| HP bars | two groups at (−1.2, 1.9, −2.0) and (1.2, 1.9, −2.0): a name sprite, a red track `0.8 × 0.08`, a yellow fill scaled by `scores[slot] / GOAL` (in streak mode slot 1 shows `S.best`) |
| Numpad | section 5 |
| Opponent marker | section 7 |

### 3.1 Text sprites

One helper `makeText(text, {size=256, color='#fff', font='48px "VT323", monospace'})` draws onto a canvas, returns a `Sprite` with `SpriteMaterial({map: CanvasTexture, transparent:true})`, scaled so 1 px ≈ 1 mm. Expose `.setText(t)` that redraws the canvas and sets `texture.needsUpdate = true`. Cache by text to avoid redrawing the same string. Use the page's fonts (they are already loaded by the 2D page; wait on `document.fonts.ready` once before the first draw).

## 4. Syncing the board from `S` (`syncScene(S)`)

Runs on every state callback. Pure diff of `S` → scene, no animation state except the roll:

- Each cell: colour by owner: slot 0 → `0xff2a2a` emissive-ish (`color 0x3a0000, emissive 0xff2a2a, emissiveIntensity 0.6`), slot 1 → blue (`0x002a4a / 0x49a6ff`), free → `0x202020`. Hero colours: read `getComputedStyle(document.documentElement).getPropertyValue('--p1'/'--p2')` once per sync (cheap) so secret names carry over.
- Owned cells are **raised**: `scale.y = 4` (8 cm block) with a product text sprite on top (`r*c`). Free cells `scale.y = 1`, no label.
- `S.oreFound` cells get a small cyan octahedron (`OctahedronGeometry(0.02)`) floating 6 cm above, slowly spinning in `frame()`.
- Live craters (`S.n - S.craters[k] < 2`): colour `0x555555`, `scale.y = 0.5`.
- `S.creeper` live (`phase === 'answer'` and `creeper.n === S.n`): target cell colour `0x4caf50` with a face sprite `"•_•"`.
- Target cell during `phase === 'answer'`: raised to `scale.y = 6`, colour white, `"?"` sprite on top; if the key is in `S.ore`, show the octahedron and `"◆"` instead of `"?"`.
- HP bars + names from `S.scores`, `Z.name(slot)`.
- Winner: hide the numpad, show a big "PLAY AGAIN" tile (section 5) that dispatches `{type:'reset'}`.

Rolls are handled separately in section 4.1, so `syncScene` must **skip** repainting the highlight while `vrRolling` is true.

### 4.1 Roll replay

- Guard `vrShownN`. When `S.roll && S.n !== vrShownN`: set `vrShownN = S.n`, `vrRolling = true`, and run `playRoll(S.roll)`.
- `playRoll`: `const steps = Z.rollSteps({r, c}, seed)`. Two glowing bars: `rowBar = BoxGeometry(1.15, 0.015, 0.1)` and `colBar = BoxGeometry(0.1, 0.015, 1.15)`, white `MeshBasicMaterial`, y = 0.985. Walk `steps` with the same `wait` values via `setTimeout` (not the frame loop, so timing matches the 2D view exactly): on each step move `rowBar.position.z` and `colBar.position.x` to the step's row/col. The 2D view already plays `sfx.tick`; **do not** play it again from VR (the same page is the audio source; it would double).
- After the last step wait 220 ms, then: hide the bars, run a 300 ms tween raising the target cell (scale.y 1 → 6) with a small white flash sprite, set `vrRolling = false`, call `syncScene(Z.state)`.
- If a newer state arrives mid-roll (`S.n` changed), abort via a token exactly like `animToken` in `roll()`.

## 5. Input: the numpad (phase 1 input device)

- Group at (0.45, 1.15, −0.55), tilted 30° toward the player. 12 tiles `0.08 × 0.08 × 0.02`: `7 8 9 / 4 5 6 / 1 2 3 / ⌫ 0 ↵`. Tile material `0x000000` with white `EdgesGeometry` outline and a text sprite; hover colour `0xff7f27`, pressed `0xffd800`. A display sprite above the pad shows the typed digits (max 4 chars).
- Also a big **FIGHT** tile (`0.3 × 0.1`) centred below the pad, visible only when `S.phase === 'idle' && Z.canAct(S.turn) && S.winner == null`; it dispatches `{type:'roll'}`. In the RPG skin wording is already FIGHT; use "ROLL" when `document.documentElement.dataset.skin !== 'ut'`.
- The numpad is visible only when `S.phase === 'answer' && Z.canAct(S.turn)`. `↵` dispatches `{type:'answer', slot:S.turn, value:typed}` and clears `typed`. Empty `typed` is ignored.
- **Pointing**: for each `renderer.xr.getController(i)` (i = 0, 1) draw a thin ray (`Line` from (0,0,0) to (0,0,−1), length 1.5 m, white, opacity 0.5). Each frame cast `Raycaster` along the controller's forward; the first hit among `[...numpadTiles, fightTile, playAgainTile]` is the hovered tile. `selectstart` on the controller presses the hovered tile; `selectend` releases. Play `Z.sfx.click()` on press.
- **Hands** (if `hand-tracking` granted): `renderer.xr.getHand(i)`; use the `index-finger-tip` joint position; a tile is pressed when the tip is within 1.5 cm of the tile's front face and released when it leaves. Treat hands and controllers identically downstream. If hand joints are undefined, skip silently.
- Keyboard fallback for desktop testing (section 11): digits, Backspace, Enter and `R` (roll) call the same handlers.

## 6. Effects in VR (own guards, same events as 2D)

| event | guard | effect |
|---|---|---|
| claim (`S.last.ok`, `vrFxN !== S.n`) | `vrFxN` | the cell tweens from `scale.y 6` to 4 with a bounce; 40 small cubes (0.01) burst upward from the cell in the owner's colour, gravity, 1.2 s, removed after. `"+1"` (or `"+2"` on ore) sprite rises 15 cm and fades |
| miss | `vrFxN` | cell flashes red for 400 ms, `"MISS"` grey sprite rises; **shake the board group** (pedestal + slab + cells) ±1 cm for 300 ms, never the camera |
| 67 (`S.ev67.n === S.n`, `vr67N`) | `vr67N` | cells in rows/cols 6 and 7 bob ±3 cm in a checkerboard for 3 s; two giant text sprites "SIX" then "SEVEN!" (2 m wide) drop from y = 4 to y = 2.6 in front of the arena with a bounce; 60 falling "6"/"7" sprites from the ceiling |
| boom (`S.boom.n === S.n`, `vrBoomN`) | `vrBoomN` | the creeper cell flashes white, lost cells' blocks (clone meshes) fly off with random velocity and tumble into the void for 1.5 s then are removed; board shake ±2 cm |
| glitch (`S.glitch.n === S.n`, `vrGlitchN`) | `vrGlitchN` | for 2 s: every 90 ms jitter 25 random cells' `position.y` by ±2 cm and swap their colour to a random grey; dialogue panel text scrambled like the 2D one (read `#msg` as usual, it is already scrambled by the 2D view) |
| whistle (`S.evWhistle`) | `vrWhistleN` | two white "ears" (spheres r = 0.03) appear on the row/col bar intersection for the rest of the match while `S.ears` |
| win (`S.winner != null`, `vrWin`) | `vrWin` | 200-cube confetti fountain from the board, dialogue panel text comes from `#msg`; show PLAY AGAIN tile |
| achievement toast | `vrAchShown` Set keyed `id:slot:n` | a floating panel (0.5 × 0.15) at (−0.9, 1.4, −1.3) with icon + title, slides in from the left over 250 ms, stays 3 s, fades |

Sounds are already played by the 2D page; VR plays **no** sounds of its own except `sfx.click()` on tile press.

## 7. Opponent presence (P2P only)

- Every 100 ms, if `Z.mode` is host/guest and the session is active: `Z.sendPose({ h:[x,y,z,qx,qy,qz,qw], l:[x,y,z], r:[x,y,z] })` from the XR camera pose and controller/hand positions (or `null` for a missing hand). Coordinates are in the sender's local-floor space; the receiver **mirrors** them across the board: `x → -x`, `z → -2.2 - z` (the opponent stands at z ≈ −2.2 facing +z), `y` unchanged.
- `Z.onPose(p => ...)` stores the latest pose; `frame()` lerps the marker toward it (factor 0.2).
- Marker: a flat heart (two spheres + a rotated box, or a heart-shaped `Shape` extruded 1 cm) in the opponent's colour at head position, 10 cm wide, plus two 4 cm wireframe spheres for hands. If no pose has arrived for 3 s, fade the marker to 30 % opacity.
- In solo mode show a 0.6 m "face" sprite (`"•_•"` for Dummy, `"[o_o]"` Robot, `"[>_<]"` Boss) hovering at (0, 1.8, −2.2) that bobs ±2 cm; during the CPU's answer phase it tilts toward the target cell.
- Streak/local modes: no marker.
- Host side: the `pose` message is **not** part of `S` and is never applied to state.

## 8. Audio

Phase 1: none in VR (page audio continues). Phase 2 (optional): wrap `Z.sfx.tick` so that, while a session is active, a `THREE.PositionalAudio` attached to `colBar` plays the tick instead; needs an `AudioListener` on the camera and a tiny generated click buffer. Skip unless everything else is done.

## 9. Comfort, exit, errors

- Camera never moves programmatically. No vignette needed.
- "Seated" toggle: a small tile on the pedestal front that lowers the whole board group by 0.35 m and remembers it in `localStorage('ttd-vr-seated')`.
- Exit: the headset's system gesture ends the session; also a small "EXIT" tile next to the numpad calls `session.end()`.
- When `requestSession` rejects (permission denied, no headset), show the error in `#lmsg` / `setMsg` and leave the 2D game untouched.
- `renderer.xr.setFramebufferScaleFactor(1.0)`; do not use post-processing. Target 72 Hz on Quest 2: ≤ 150 draw calls (cells share one geometry and up to three materials: free / p1 / p2; use `InstancedMesh` for the 100 cells if draw calls exceed budget; labels are only created for owned cells).

## 10. Order of work (each step ends with `node --check` passing on the extracted `index.html` script and `node --check vr.js` passing)

1. Bridge in `index.html` (section 1) + empty `vr.js` that only logs `start` and ends the session. Verify the lobby button appears only with `navigator.xr`.
2. Scene (section 3) with a desktop fallback: when `window.location.hash === '#vrdesk'`, skip XR, render to a normal canvas with a fixed camera at (0, 1.6, 0.4) looking at the board, and accept keyboard input. All later steps are developed in this mode first.
3. `syncScene` (section 4) and roll replay (4.1).
4. Numpad + FIGHT tile + controller rays (section 5).
5. Effects (section 6).
6. Opponent presence + solo face (section 7).
7. Comfort/exit/seated (section 9), hand tracking.
8. Real headset pass (user does this; section 11 says what to check).

## 11. How to test

- Desktop: `python3 -m http.server 8766 --directory /Users/kascode/Work/zimult` then open `http://localhost:8766/#vrdesk`, pick "Perfect ten" or "Vs the machine", press "VR" in the header. Headless check with `agent-browser` (used throughout this repo): load the page, call `window.ZIMULT.enterVR()` from `eval`, wait 1 s, assert `document.querySelector('canvas[data-zimult-vr]')` exists, no `window.onerror`, and that pressing keys `5`, `6`, `Enter` dispatches an answer (check `window.__S.last`). Screenshot the canvas to eyeball the board.
- Roll sync: in desktop mode, start a roll and compare `window.__S.roll` target with the VR target cell's raised state after ~2.5 s.
- Headset: Quest browser → `https://zimult.equato.fun/` (HTTPS required). Check: button appears, session starts, board at waist height, numpad reachable without leaning, FIGHT → bars sweep → cell rises, answer with controller, claim effect, exit returns to 2D with the same state. Then a P2P match: phone on one side, headset on the other; the heart marker should move with the phone player's... nothing (phones send no pose) — so instead test two headsets or accept the static marker.
- Performance: Quest browser `chrome://webrtc-internals` is irrelevant; use the in-headset performance overlay (Developer Hub) and keep frame time < 13 ms.

## 12. Out of scope / do not do

- No changes to game rules, networking protocol (beyond `pose`), skins, or the 2D DOM.
- No three.js addons from `examples/jsm`, no import maps, no bundler.
- No camera movement, teleport or locomotion.
- No AR (`immersive-ar`) in this plan.
- No external models, textures or audio files; everything is generated geometry, canvas text and existing page sounds.
