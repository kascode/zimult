# VR: question card + arcade console

Target file: `vr.js` only. Read it fully first. This plan replaces two things: the `targetLabel` text that sits on top of the raised cell, and the flat "dashboard" plate built in `build()` (the block that starts with the comment `// dashboard (section 5)`). Game logic, `index.html`, networking and the 2D view are untouched.

## 0. What exists (read before editing)

- `addTile({parent, x, y, z, rotX, w, h, label, font, k, onPress, key})` builds a rectangular pressable tile: a `tileGeo` box scaled to `w × h × 0.02`, a white `edgeGeo` outline, a `makeText` label 12.5 mm in front. It pushes `{obj, mesh, mat, w, h, label, onPress, shade, key}` into `tiles`. `paintTiles()` colours `mat` black / orange (hover) / yellow (pressed). Raycasting uses `mesh.userData.tile`, so any new tile shape must keep that.
- `makeText(text, opts)` returns a flat text quad (a `Mesh`, faces +z in its parent, `opts.flat` lays it on the ground). It is NOT a billboard.
- Cells: `cellMesh[key]` proxies; `syncScene` sets `sy` (cell height in 2 cm units: free 1, owned 4, target 6) and `topY(sy)` gives the top surface height. The target cell is already raised to `sy = 6` with `matTarget` (white) or `matCreeper` (green).
- `targetLabel` is created in `build()` (`makeText('?', ...)`) and positioned in `syncScene` at `topY(6) + 0.012` with the text `r×c`. This is what gets replaced.
- Controls live in the `dash` group under `lift` (so they lower in seated mode): `pad` (numpad + `padDisplay`), `fightTile` (label `ROLL`), `againTile`, `exitTile`, `seatTile`. `syncScene` toggles `pad.visible`, `fightTile.obj.visible`, `againTile.obj.visible`. `keyPress(label)` handles numpad keys; `roll()` / `again()` / `exitVR()` / `toggleSeated()` are the press handlers. `teardown()` nulls `pad, padDisplay, fightTile, againTile, dash, seatTile, exitTile`.
- Constants: `CELL = 0.1`, `PITCH = 0.11`, `cellX(c)`, `cellZ(r)`; the slab top is at y = 0.94, its front edge at z = −0.5, the pedestal front face at z = −0.45 from y = 0 to 0.9. The player stands at the origin facing −z; standing eye height ≈ 1.6 m.
- Fonts: `FONT_LABEL` (48 px VT323), `FONT_TILE` (40 px), `FONT_PANEL` (76 px). Yellow is `0xffd800`, orange `0xff7f27`.

## 1. Question card above the selected cell (proposal B)

Replace `targetLabel` with a `card` group built once in `build()` and shown/positioned in `syncScene`.

### Geometry (all in the `board` group, so it shakes and lowers with the board)

- `post`: `CylinderGeometry(0.003, 0.003, 1, 6)` white (`MeshBasicMaterial 0xffffff`), scaled in y each frame to run from the cell top to the card bottom.
- `cardGrp`: a group holding
  - `plate`: `PlaneGeometry(0.22, 0.09)` black (`MeshBasicMaterial 0x000000, side: DoubleSide`),
  - `frame`: `EdgesGeometry` of a `PlaneGeometry(0.228, 0.098)` with `lineMat` (white 3 px look is not possible with lines; instead use a second black plane 0.236 × 0.106 behind a white plane 0.228 × 0.098, giving a 4 mm white border, like the dialogue panel),
  - `text`: `makeText('', { font: FONT_PANEL, k: 0.9, color: '#ffffff', box: [0.2, 0.07] })` at z = 0.002,
  - `tail`: a small white triangle (`BufferGeometry` with 3 vertices, 2 cm wide, 1.5 cm tall) under the plate's bottom edge pointing down, so the card reads as a speech bubble pointing at the cell.
- Card height: `cardGrp.position.y = topY(6) + 0.16` (16 cm above the raised cell top). Card centre x/z = cell centre.

### Facing (the part that must not regress to the sprite problem)

- Yaw only. Each frame, while the card is visible: compute the camera's world position (`renderer.xr.isPresenting ? renderer.xr.getCamera().position : camera.position`), take the vector from the card to the camera, zero its y, and set `cardGrp.rotation.y = Math.atan2(dx, dz)`. Never tilt it in x or z. Because the plate is a vertical plane and the post is vertical, the card can never intersect the board.
- Optional subtle tilt toward the eye: `cardGrp.rotation.x = -0.15` (fixed, 9° back). Keep it fixed, not computed, so it cannot flip at steep angles.

### Content

- `text.setText(r + ' × ' + c)` (spaces around ×, the real × character). Prefix `◆ ` on an ore cell, `•_• ` on a creeper, exactly as the old label did.
- While the local player has typed digits, append them: `7 × 8 = 5_` (pad the typed string to 2 characters with `_`). Source: the same `typed` string `padDisplay` uses; call the card update from `updatePadDisplay()` as well as from `syncScene`.
- When the answer lands (`S.phase` goes back to idle), the card hides. The claim/miss effects already play on the cell.

### Opponent's turn

- The card shows on every screen, not only the active player's, so in P2P both players see the question. The typed digits are shown only on the screen that is typing.

### Cleanup

- Delete `targetLabel` creation, positioning and the `teardown` null. Add `card`, `post` to the `teardown` nulls and dispose their own geometries via `own(...)` like the rest.

## 2. Arcade console (proposal 2)

Replace the flat `dashPlate` + rectangle tiles with a cabinet-style console. Same `dash` group, same position/tilt (`(0, 0.80, -0.30)`, `rotation.x = -0.62`), same press handlers, same visibility rules, so `syncScene`, `keyPress`, `paintTiles`, `teardown` need no changes beyond what is listed.

### Body

- `body`: a shallow trapezoid prism. Build it with `ExtrudeGeometry` from a `Shape` with points `(-0.50, -0.19), (0.50, -0.19), (0.44, 0.19), (-0.44, 0.19)` extruded `depth: 0.03`, then `translate(0, 0, -0.03)` so the front face is at z = 0. Material `MeshStandardMaterial 0x0a0a0a, roughness 0.9`. Add an `EdgesGeometry` outline with `lineMat`.
- A 1 cm raised "bezel" strip along the top edge: `BoxGeometry(0.88, 0.02, 0.012)` at `(0, 0.17, 0.006)` white, like a cabinet marquee rail.

### ROLL button (round, slap-able)

- New helper `addRoundTile({parent, x, y, z, r, label, font, k, onPress, key})`: `CylinderGeometry(r, r, 0.03, 32)` rotated so its axis points +z (`geometry.rotateX(Math.PI / 2)`), material `MeshStandardMaterial 0x000000`, a white ring on top made from `RingGeometry(r * 0.86, r, 32)` at z = 0.016, label `makeText` at z = 0.017. It must set `mesh.userData.tile = tile` and push into `tiles` with the same shape as `addTile` (`{obj, mesh, mat, w: 2r, h: 2r, label, onPress, shade, key}`) so `paintTiles` and the raycaster work unchanged.
- ROLL: `r = 0.085` at `(-0.30, 0.0, 0.0)`, label `ROLL` in `FONT_LABEL` `k 1.0`. On press (in addition to dispatching): animate `obj.position.z` from 0 to −0.012 and back over 120 ms (use the existing `animate(ms, fn)` helper) so it visibly depresses.
- PLAY AGAIN replaces ROLL in the same spot when the match is over: reuse the same round tile and just swap its label and handler? No: keep two tiles for clarity (`fightTile`, `againTile`) exactly as now, both round, both at the same position, visibility toggled as today.

### Numpad

- Keys `0.075 × 0.075`, pitch `0.082`, same 4 × 3 layout, group `pad` at `(0.04, -0.035, 0.012)`. Keys use `addTile` as now but with `k 1.0` and `FONT_LABEL` so the digits are bigger. Rounded look: not needed, the outline already matches the skin.
- `padDisplay` becomes a "screen": a black `PlaneGeometry(0.42, 0.075)` with a 3 mm white border (two planes, like the card) at `(0.04, 0.145, 0.012)`, text `FONT_PANEL k 0.8 color #ffd800 box [0.4, 0.06]`. It shows `7 × 8 = 5_` and is visible whenever the pad is visible.

### Small buttons

- EXIT and SIT DOWN become small round buttons `r = 0.035` at `(0.40, 0.09)` and `(0.40, -0.05)`, labels `FONT_TILE k 0.6` (`EXIT`, `SIT` / `STAND`). Keep `seatTile.label.setText(...)` calls in `applySeated` working (change the strings to `STAND` / `SIT`).

### Marquee text

- Along the bezel, a flat text `makeText('ZIMULT', { font: FONT_LABEL, k: 0.7 })` at `(0, 0.17, 0.014)`; purely decorative.

## 3. Selected cell

- Keep the rise to `sy = 6`. Add a 300 ms rise tween when the target first appears (`scale.y` 1 → 6 with the existing `ease`), reusing the `scaleLock` mechanism that effects already use so `syncScene` does not snap it. On landing the 2D view already plays the sound.
- Light the headers: the row header and column header text quads for the target get colour `#ffd800` while the target is shown (store header meshes in two arrays `rowHdr[r]`, `colHdr[c]` when they are created; `setText` with a different colour re-renders via the texture cache). Reset to white otherwise.

## 4. Order of work

1. Question card (section 1), delete `targetLabel`.
2. Cell rise tween + lit headers (section 3).
3. `addRoundTile`, then the console body, ROLL/PLAY AGAIN round buttons.
4. Numpad + screen.
5. EXIT / SIT round buttons, marquee.
6. `node --check vr.js`, then the desktop pass below.

## 5. How to test (desktop fallback, no headset)

```bash
python3 -m http.server 8766 --directory /Users/kascode/Work/zimult &
agent-browser set viewport 1280 800
agent-browser open "http://localhost:8766/#vrdesk"
```

Then with `agent-browser eval --stdin`: click `#vrStreakBtn`, wait 2.5 s, press `r` (`document.dispatchEvent(new KeyboardEvent('keydown', {key:'r', bubbles:true}))`), wait 7 s, screenshot. Expect: the target cell raised, a white-bordered card 16 cm above it facing the camera, reading `r × c`, the console with a round ROLL button hidden (answering) and the numpad + yellow screen visible. Type `5`, `6` via keydown events and confirm the card and screen both show `… = 56`. Press Enter, confirm the card hides. Collect `window.onerror` messages; zero is the bar. Also press `R` in idle state and screenshot: round ROLL visible, numpad hidden.

Yaw check without a headset: in `#vrdesk` mode move the camera with `camera.position.x = 1; camera.lookAt(0, 0.95, -1.1)` via eval and screenshot again; the card must still face the camera and never show its edge.

## 6. Out of scope

- No changes to `index.html`, game rules, networking, 2D skins.
- No hand-tracking changes; the new round tiles are picked by the existing raycaster.
- No camera motion, no new sounds.
