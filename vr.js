// vr.js: optional WebXR duel arena for ZIMULT. Lazy-loaded by index.html via start(window.ZIMULT).
// Reads the game only through the Z bridge and never mutates S: every player action goes through Z.dispatch.
// Desktop fallback: location.hash === '#vrdesk' renders the same scene to a flat canvas (no XR session).
import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js';

// ---------- constants ----------
const MM = 0.001;                                   // 1 canvas px = 1 mm
const FONT_LABEL = '48px "VT323", monospace';
const FONT_TILE = '40px "VT323", monospace';
const FONT_PANEL = '76px "VT323", monospace';
const CELL = 0.1, PITCH = 0.11;
const TILT = -Math.PI / 6;                          // control panels lean 30 degrees toward the player
const DIGITS = /^[0-9]$/;
const KEY_MAP = { Backspace: '⌫', Enter: '↵' };   // backspace / return glyphs used on the numpad
const FALLBACK_P = ['#c8551d', '#1f7a8c'];         // Classic skin hero colours, used when --p1/--p2 are unset

// ---------- module state (everything here is reset by teardown) ----------
let active = false, tearingDown = false, sessionEnded = false;
let Z = null, desk = false, GRID = 10, GOAL = 10;
let renderer = null, scene = null, camera = null, session = null, canvas = null;
let board = null;                                   // pedestal + slab + cells + labels + roll bars: lowered or shaken as one
const cellMesh = {}, labelFor = {}, gemFor = {};    // 'r-c' -> Mesh (cell) / Sprite (product label) / Mesh (ore gem)
let tileGeo = null, edgeGeo = null, cellGeo = null, gemGeo = null, lineMat = null;
let matFree = null, matCrater = null, matTarget = null, matCreeper = null, matGem = null, matP = [];
let rowBar = null, colBar = null, flash = null, targetLabel = null, glowTex = null;
let panel = null, roomLabel = null, hpBars = [];
let pad = null, padDisplay = null, fightTile = null, againTile = null;
let msgEl = null, codeBoxEl = null, codeEl = null;
let panelText = null, roomText = null, lastP = ['', ''];
let typed = '', typedN = -1;
let vrShownN = 0, vrRolling = false, rollKey = null, rollToken = 0, rollTimer = 0, rollTween = null;
let unsubState = null, lastT = 0;
const updaters = new Set();     // per-frame functions (now, dt). Later sections register here.
const tweens = new Set();       // jobs {t0, ms, step, done} run by tweenUpdater
const tiles = [];               // raycast-pressable tiles (numpad, FIGHT, PLAY AGAIN; EXIT and SEATED register the same way)
const sources = [];             // pointing sources: {obj} controller, {hand} hand, or mouse; each has hover / pressed
const cleanup = [];             // run in reverse on session end
const textCache = new Map();
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const v3 = new THREE.Vector3(), v3b = new THREE.Vector3();

// ---------- small helpers ----------
const own = o => { cleanup.push(() => o.dispose()); return o; };
const ut = () => document.documentElement.dataset.skin === 'ut';
const click = () => { try { if (Z && Z.sfx && Z.sfx.click) Z.sfx.click(); } catch (_) {} };
const cellX = c => (c - (GRID + 1) / 2) * PITCH;
const cellZ = r => -1.1 + (r - (GRID + 1) / 2) * PITCH;
const topY = sy => 0.95 + 0.01 * sy;                // top surface of a cell scaled to sy (box is 2 cm tall)
const ease = p => 1 - Math.pow(1 - p, 3);
const shown = o => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };

// ---------- text sprites (section 3.1) ----------
function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    if (!maxW) { out.push(para); continue; }
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? line + ' ' + word : word;
      if (line && ctx.measureText(test).width > maxW) { out.push(line); line = word; } else line = test;
    }
    out.push(line);
  }
  return out;
}
// Textures are cached by (font, colour, wrap width, text). Shared textures are never mutated.
function textTexture(text, o) {
  const key = o.font + '|' + o.color + '|' + o.maxW + '|' + text;
  let tex = textCache.get(key);
  if (tex) { textCache.delete(key); textCache.set(key, tex); return tex; }
  const cv = document.createElement('canvas'), ctx = cv.getContext('2d');
  ctx.font = o.font;
  const lines = wrapLines(ctx, text, o.maxW);
  let w = 1; for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
  cv.width = Math.ceil(w) + o.pad * 2;
  cv.height = lines.length * o.lh + o.pad * 2;
  ctx.font = o.font; ctx.textBaseline = 'top'; ctx.textAlign = 'center'; ctx.fillStyle = o.color;
  lines.forEach((l, i) => ctx.fillText(l, cv.width / 2, o.pad + i * o.lh));
  tex = new THREE.CanvasTexture(cv);
  tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
  tex.userData.w = cv.width; tex.userData.h = cv.height;
  textCache.set(key, tex);
  if (textCache.size > 240) { const [k0, t0] = textCache.entries().next().value; textCache.delete(k0); t0.dispose(); }
  return tex;
}
// makeText(text, opts) -> Sprite with setText(t). 1 px = 1 mm times opts.k. opts.box [w, h] in metres shrinks oversize text.
function makeText(text, opts = {}) {
  const o = { font: FONT_LABEL, color: '#ffffff', pad: 8, maxW: 0, k: 1, box: null, lh: 0, ...opts };
  o.lh = o.lh || Math.round(parseFloat(o.font) * 1.15);
  const mat = new THREE.SpriteMaterial({ transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  let cur = null;
  sp.setText = t => {
    t = String(t == null ? '' : t);
    if (t === cur) return sp;
    cur = t;
    const tex = textTexture(t, o);
    mat.map = tex; mat.needsUpdate = true;
    const s = o.k * MM;
    let sx = tex.userData.w * s, sy = tex.userData.h * s;
    if (o.box) { const f = Math.min(1, o.box[0] / sx, o.box[1] / sy); sx *= f; sy *= f; }
    sp.scale.set(sx, sy, 1);
    return sp;
  };
  sp.setText(text);
  return sp;
}
function makeGlow() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

// ---------- pressable tiles (section 5). Other sections register EXIT / SEATED through addTile too. ----------
function addTile({ parent, x = 0, y = 0, z = 0, rotX = 0, w, h, label, font = FONT_TILE, k = 1, onPress }) {
  const grp = new THREE.Group();
  grp.position.set(x, y, z); grp.rotation.x = rotX;
  const mat = own(new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.7 }));
  const mesh = new THREE.Mesh(tileGeo, mat);
  mesh.scale.set(w, h, 0.02);
  mesh.add(new THREE.LineSegments(edgeGeo, lineMat));      // white outline, scaled with the tile
  const text = makeText(label, { font, k });
  text.position.set(0, 0, 0.0125);                         // in front of the face; sprites are not parented to the scaled mesh
  grp.add(mesh, text);
  parent.add(grp);
  const tile = { obj: grp, mesh, mat, w, h, label: text, onPress, shade: -1 };
  mesh.userData.tile = tile;
  tiles.push(tile);
  return tile;
}
function paintTiles() {
  for (const t of tiles) {
    const down = sources.some(s => s.pressed === t);
    const shade = down ? 2 : sources.some(s => s.hover === t) ? 1 : 0;
    if (shade !== t.shade) { t.shade = shade; t.mat.color.setHex(shade === 2 ? 0xffd800 : shade === 1 ? 0xff7f27 : 0x000000); }
  }
}
function pick() {
  const meshes = [];
  for (const t of tiles) if (shown(t.obj)) meshes.push(t.mesh);
  if (!meshes.length) return null;
  const hit = raycaster.intersectObjects(meshes, false)[0];
  return hit ? hit.object.userData.tile : null;
}
// Distance from a world point to a tile's front face, in metres (dz > 0 is in front of the face).
function faceDist(t, p) {
  v3b.copy(p); t.mesh.worldToLocal(v3b);               // mesh geometry is a unit box scaled to (w, h, 0.02)
  return { dz: (v3b.z - 0.5) * 0.02, inside: Math.abs(v3b.x * t.w) <= t.w / 2 + 0.01 && Math.abs(v3b.y * t.h) <= t.h / 2 + 0.01 };
}
function press(t) {
  if (!t || !t.onPress) return;
  click();
  t.onPress();
}

// ---------- numpad, FIGHT, PLAY AGAIN (section 5) ----------
function updateDisplay() { if (padDisplay) padDisplay.setText(typed ? typed.padEnd(4, '_') : '____'); }
function keyPress(label) {
  if (!pad || !pad.visible) return;
  if (DIGITS.test(label)) { if (typed.length < 4) typed += label; }
  else if (label === KEY_MAP.Backspace) typed = typed.slice(0, -1);
  else if (label === KEY_MAP.Enter) submit();
  updateDisplay();
}
function submit() {
  const S = Z.state;
  if (!pad || !pad.visible || !typed || !S) return;
  const value = typed;
  typed = '';
  Z.dispatch({ type: 'answer', slot: S.turn, value });
}
function roll() { if (fightTile && fightTile.obj.visible) Z.dispatch({ type: 'roll' }); }
function again() { if (againTile && againTile.obj.visible) Z.dispatch({ type: 'reset' }); }

// ---------- scene building ----------
function paintHeroColours() {
  const cs = getComputedStyle(document.documentElement);
  for (let s = 0; s < 2; s++) {
    const str = cs.getPropertyValue('--p' + (s + 1)).trim() || FALLBACK_P[s];
    if (!str || str === lastP[s]) continue;
    lastP[s] = str;
    const c = new THREE.Color(str);
    matP[s].color.copy(c).multiplyScalar(0.25);
    matP[s].emissive.copy(c);
  }
}
function productLabel(k) {
  if (!labelFor[k]) { labelFor[k] = makeText('', { k: 0.8 }); labelFor[k].visible = false; board.add(labelFor[k]); }
  return labelFor[k];
}
function gemOf(k) {
  if (!gemFor[k]) { gemFor[k] = new THREE.Mesh(gemGeo, matGem); gemFor[k].visible = false; board.add(gemFor[k]); }
  return gemFor[k];
}
function updateHp(S) {
  for (let s = 0; s < 2; s++) {
    const hb = hpBars[s];
    const val = Z.mode === 'streak' && s === 1 ? (S.best || 0) : S.scores[s];
    hb.name.setText(Z.name(s) + '  ' + val);
    const f = Math.max(0, Math.min(1, val / GOAL));
    hb.fill.scale.x = 0.8 * f;
    hb.fill.position.x = s === 0 ? -0.4 + 0.4 * f : 0.4 - 0.4 * f;
  }
}

function build() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  camera = new THREE.PerspectiveCamera(desk ? 80 : 60, 1, 0.01, 50);   // desktop: wider so the dialogue panel and HP bars stay in frame
  camera.position.set(0, 1.6, 0.4);                  // desktop fallback view; XR replaces the pose
  camera.lookAt(0, 0.95, -1.1);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8); sun.position.set(1, 3, 1); scene.add(sun);

  // shared geometry and materials
  lineMat = own(new THREE.LineBasicMaterial({ color: 0xffffff }));
  tileGeo = own(new THREE.BoxGeometry(1, 1, 1));
  edgeGeo = own(new THREE.EdgesGeometry(tileGeo));
  cellGeo = own(new THREE.BoxGeometry(CELL, 0.02, CELL));
  gemGeo = own(new THREE.OctahedronGeometry(0.02));
  matGem = own(new THREE.MeshStandardMaterial({ color: 0x4dd0e1, emissive: 0x1b6a75 }));
  matFree = own(new THREE.MeshStandardMaterial({ color: 0x202020 }));
  matCrater = own(new THREE.MeshStandardMaterial({ color: 0x555555 }));
  matTarget = own(new THREE.MeshStandardMaterial({ color: 0xffffff }));
  matCreeper = own(new THREE.MeshStandardMaterial({ color: 0x4caf50 }));
  matP = [0, 1].map(() => own(new THREE.MeshStandardMaterial({ color: 0x202020, emissiveIntensity: 0.6 })));
  glowTex = own(makeGlow());

  // background stars and the arena wireframe
  const sp = new Float32Array(400 * 3);
  for (let i = 0; i < 400; i++) {
    const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), R = 12 * Math.cbrt(Math.random());
    sp[i * 3] = R * Math.sin(ph) * Math.cos(th); sp[i * 3 + 1] = R * Math.cos(ph); sp[i * 3 + 2] = R * Math.sin(ph) * Math.sin(th);
  }
  const starGeo = own(new THREE.BufferGeometry());
  starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  scene.add(new THREE.Points(starGeo, own(new THREE.PointsMaterial({ color: 0xffffff, size: 0.01, transparent: true, opacity: 0.35 }))));
  const arenaBox = own(new THREE.BoxGeometry(4, 3, 4));
  const arena = new THREE.LineSegments(own(new THREE.EdgesGeometry(arenaBox)), lineMat);
  arena.position.set(0, 1.5, -1); scene.add(arena);

  // board group: pedestal, slab, cells, headers, roll bars, labels, gems
  board = new THREE.Group(); scene.add(board);
  const pedGeo = own(new THREE.BoxGeometry(1.3, 0.9, 1.3));
  const ped = new THREE.Mesh(pedGeo, own(new THREE.MeshStandardMaterial({ color: 0x111111 })));
  ped.position.set(0, 0.45, -1.1); board.add(ped);
  const slabGeo = own(new THREE.BoxGeometry(1.2, 0.04, 1.2));
  const slab = new THREE.Mesh(slabGeo, own(new THREE.MeshStandardMaterial({ color: 0x000000 })));
  slab.position.set(0, 0.92, -1.1); board.add(slab);
  const slabEdges = new THREE.LineSegments(own(new THREE.EdgesGeometry(slabGeo)), lineMat);
  slabEdges.position.copy(slab.position); board.add(slabEdges);

  for (let r = 1; r <= GRID; r++) for (let c = 1; c <= GRID; c++) {
    const k = r + '-' + c, m = new THREE.Mesh(cellGeo, matFree);
    m.position.set(cellX(c), 0.95, cellZ(r)); m.userData.key = k;
    cellMesh[k] = m; board.add(m);
  }
  // headers on the slab rim: columns along the far edge, rows along the left edge
  for (let c = 1; c <= GRID; c++) {
    const h = makeText(String(c), { k: 0.5, color: '#ffffff' });
    h.position.set(cellX(c), 0.96, cellZ(1) - 0.075); board.add(h);
  }
  for (let r = 1; r <= GRID; r++) {
    const h = makeText(String(r), { k: 0.5, color: '#ffffff' });
    h.position.set(-0.575, 0.96, cellZ(r)); board.add(h);
  }
  // roll highlight bars (section 4.1) and the flash used when the roll lands
  const barMat = own(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  rowBar = new THREE.Mesh(own(new THREE.BoxGeometry(1.15, 0.015, 0.1)), barMat);
  colBar = new THREE.Mesh(own(new THREE.BoxGeometry(0.1, 0.015, 1.15)), barMat);
  rowBar.position.y = colBar.position.y = 0.985;
  rowBar.visible = colBar.visible = false;
  board.add(rowBar, colBar);
  flash = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false })));
  flash.visible = false; board.add(flash);
  targetLabel = makeText('?', { k: 1 }); targetLabel.visible = false; board.add(targetLabel);

  // dialogue panel mirrors #msg (section 3); room code sits above it while a P2P room is open
  const black = own(new THREE.MeshBasicMaterial({ color: 0x000000 })), white = own(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const border = new THREE.Mesh(own(new THREE.PlaneGeometry(1.64, 0.54)), white);
  border.position.set(0, 1.75, -2.302); scene.add(border);
  const plate = new THREE.Mesh(own(new THREE.PlaneGeometry(1.6, 0.5)), black);
  plate.position.set(0, 1.75, -2.3); scene.add(plate);
  panel = { text: makeText('', { font: FONT_PANEL, lh: 84, maxW: 1300, box: [1.5, 0.44] }) };
  panel.text.position.set(0, 1.75, -2.295); scene.add(panel.text);
  roomLabel = makeText('', { k: 0.8 }); roomLabel.position.set(0, 2.1, -2.3); roomLabel.visible = false; scene.add(roomLabel);

  // HP bars (section 3): name + score sprite, red track, yellow fill
  const unitGeo = own(new THREE.PlaneGeometry(1, 1));
  const trackMat = own(new THREE.MeshBasicMaterial({ color: 0xc00000 })), fillMat = own(new THREE.MeshBasicMaterial({ color: 0xffd800 }));
  hpBars = [0, 1].map(s => {
    const g = new THREE.Group(); g.position.set(s === 0 ? -1.2 : 1.2, 1.9, -2.0); scene.add(g);
    const name = makeText('', { k: 0.9 }); name.position.set(0, 0.12, 0); g.add(name);
    const track = new THREE.Mesh(unitGeo, trackMat); track.scale.set(0.8, 0.08, 1); g.add(track);
    const fill = new THREE.Mesh(unitGeo, fillMat); fill.scale.set(0, 0.08, 1); fill.position.z = 0.002; g.add(fill);
    return { name, fill };
  });

  // numpad (group at (0.45, 1.15, -0.55), tilted), its display, FIGHT under it, PLAY AGAIN mirrored on the left
  pad = new THREE.Group(); pad.position.set(0.45, 1.15, -0.55); pad.rotation.x = TILT; scene.add(pad);
  const backing = new THREE.Mesh(own(new THREE.PlaneGeometry(0.3, 0.5)), own(new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.85 })));
  backing.position.set(0, 0.02, -0.01); pad.add(backing);
  const keys = [['7', '8', '9'], ['4', '5', '6'], ['1', '2', '3'], [KEY_MAP.Backspace, '0', KEY_MAP.Enter]];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 3; col++) {
    const label = keys[row][col];
    addTile({ parent: pad, x: (col - 1) * 0.09, y: (1.5 - row) * 0.09, w: 0.08, h: 0.08, label, onPress: () => keyPress(label) });
  }
  padDisplay = makeText('____', { font: FONT_LABEL, k: 0.8, color: '#ffd800' });
  padDisplay.position.set(0, 0.235, 0.01); pad.add(padDisplay);
  pad.updateMatrixWorld(true);
  const fightAt = pad.localToWorld(new THREE.Vector3(0, -0.27, 0));
  fightTile = addTile({ parent: scene, x: fightAt.x, y: fightAt.y, z: fightAt.z, rotX: TILT, w: 0.3, h: 0.1, label: 'FIGHT', font: FONT_LABEL, k: 0.6, onPress: roll });
  fightTile.obj.visible = false;
  againTile = addTile({ parent: scene, x: -0.45, y: 1.2, z: -0.55, rotX: TILT, w: 0.6, h: 0.14, label: 'PLAY AGAIN', font: FONT_LABEL, k: 0.7, onPress: again });
  againTile.obj.visible = false;

  msgEl = document.getElementById('msg');
  codeBoxEl = document.getElementById('codebox');
  codeEl = document.getElementById('code');
}

// ---------- syncing the board from S (section 4) ----------
function startRoll(roll) {                              // section 4.1: replay the 2D roll with the same step list
  abortRoll();
  const token = ++rollToken;
  vrRolling = true; rollKey = roll.r + '-' + roll.c;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { vrRolling = false; rollKey = null; return; }   // the caller's syncScene pass lands the target directly
  const steps = Z.rollSteps({ r: roll.r, c: roll.c }, roll.seed);
  const setBars = (r, c) => { rowBar.position.z = cellZ(r); colBar.position.x = cellX(c); };
  const finish = () => {
    if (token !== rollToken) return;
    rowBar.visible = colBar.visible = false;
    const cell = cellMesh[rollKey], [r, c] = rollKey.split('-').map(Number);
    flash.position.set(cellX(c), 1.0, cellZ(r)); flash.visible = true;
    rollTween = animate(300, p => {
      cell.scale.y = 1 + 5 * ease(p);
      flash.material.opacity = 1 - p; flash.scale.setScalar(0.25 + 0.2 * p);
    }, () => {
      rollTween = null; flash.visible = false;
      vrRolling = false; rollKey = null;
      syncScene(Z.state);
    });
  };
  rowBar.visible = colBar.visible = true;
  let i = 0;
  const tick = () => {                                  // same timing as the 2D roll(): show step, wait its own wait
    if (token !== rollToken) return;
    const s = steps[i++];
    setBars(s.r, s.c);
    rollTimer = setTimeout(i < steps.length ? tick : finish, i < steps.length ? s.wait : 220);
  };
  tick();
}
function abortRoll() {
  rollToken++; clearTimeout(rollTimer);
  if (rollTween) { rollTween(); rollTween = null; }
  if (rowBar) rowBar.visible = false;
  if (colBar) colBar.visible = false;
  if (flash) flash.visible = false;
  vrRolling = false; rollKey = null;
}

function syncScene(S) {
  if (!board || !S) return;
  paintHeroColours();
  if (S.roll && S.n !== vrShownN) { vrShownN = S.n; startRoll(S.roll); }   // may clear vrRolling (reduced motion)
  const hold = vrRolling ? rollKey : null;            // the roll tween owns this cell until it lands
  const targetKey = S.roll && S.phase === 'answer' ? S.roll.r + '-' + S.roll.c : null;
  const creeper = !!(S.creeper && S.creeper.n === S.n && S.phase === 'answer');
  const ore = S.ore || [], oreFound = S.oreFound || [], craters = S.craters || {};
  const showTarget = !!targetKey && !hold;

  for (let r = 1; r <= GRID; r++) for (let c = 1; c <= GRID; c++) {
    const k = r + '-' + c;
    if (k === hold) continue;
    const owner = S.cells[k];
    const craterLive = craters[k] != null && S.n - craters[k] < 2;
    let mat = matFree, sy = 1;
    if (owner != null) { mat = matP[owner]; sy = 4; }
    else if (craterLive) { mat = matCrater; sy = 0.5; }
    if (showTarget && k === targetKey) { mat = creeper ? matCreeper : matTarget; sy = 6; }
    const cell = cellMesh[k];
    cell.material = mat; cell.scale.y = sy;
    if (owner != null) {
      const lb = productLabel(k);
      lb.setText(r * c);
      lb.position.set(cellX(c), topY(sy) + 0.012, cellZ(r));
      lb.visible = true;
    } else if (labelFor[k]) labelFor[k].visible = false;
  }

  // ore gems (found ones, plus the target while it is an ore cell) and the target marker
  const gemWant = new Set(oreFound);
  if (showTarget && ore.includes(targetKey)) gemWant.add(targetKey);
  for (const k in gemFor) gemFor[k].visible = false;
  for (const k of gemWant) {
    const [r, c] = k.split('-').map(Number);
    const sy = showTarget && k === targetKey ? 6 : S.cells[k] != null ? 4 : 1;
    const g = gemOf(k);
    g.visible = true; g.position.set(cellX(c), topY(sy) + 0.06, cellZ(r));
  }
  if (showTarget) {
    const [r, c] = targetKey.split('-').map(Number);
    targetLabel.setText(creeper ? '•_•' : ore.includes(targetKey) ? '◆' : '?');
    targetLabel.position.set(cellX(c), topY(6) + 0.012, cellZ(r));
    targetLabel.visible = true;
  } else targetLabel.visible = false;

  updateHp(S);

  // controls: numpad while answering, FIGHT while it is your roll, PLAY AGAIN when the match is over
  const over = S.winner != null;
  const seated = Z.mode === 'local' || !!(S.seats && S.seats[0] && S.seats[1]);
  const mine = !over && seated && Z.canAct(S.turn);
  if (S.n !== typedN) { typed = ''; typedN = S.n; }
  pad.visible = mine && S.phase === 'answer' && !hold;
  fightTile.obj.visible = mine && S.phase === 'idle';
  againTile.obj.visible = over;
  fightTile.label.setText(ut() ? 'FIGHT' : 'ROLL');
  againTile.label.setText(ut() ? 'MERCY' : 'PLAY AGAIN');
  updateDisplay();

  // section 6 hook: claim / miss / 67 / boom / glitch / whistle / win effects, each guarded by its own vr*N variable
  // section 7 hook: opponent marker and solo face (driven by Z.onPose in frame())
  // section 9 hook: seated toggle and EXIT tile (register with addTile)
}

// ---------- tweens, per-frame updaters, panel mirror ----------
function animate(ms, step, done) {
  const job = { t0: performance.now(), ms, step, done };
  tweens.add(job);
  return () => tweens.delete(job);
}
function tweenUpdater(now) {
  for (const job of [...tweens]) {
    const p = Math.min(1, (now - job.t0) / job.ms);
    job.step(p);
    if (p >= 1) { tweens.delete(job); if (job.done) job.done(); }
  }
}
function mirrorPanel() {
  const t = msgEl ? msgEl.textContent : '';
  if (t !== panelText) { panelText = t; panel.text.setText(t); }
  const room = codeBoxEl && !codeBoxEl.hidden && codeEl ? 'ROOM ' + codeEl.textContent : '';
  if (room !== roomText) { roomText = room; roomLabel.setText(room); roomLabel.visible = !!room; }
}
function spinGems(now, dt) {
  for (const k in gemFor) if (gemFor[k].visible) gemFor[k].rotation.y += dt * 1.5;
}
// Pointing: controllers cast along their own forward, hands use the index tip (both feed sources[]).
function pointUpdater() {
  for (const s of sources) {
    if (s.obj) { raycaster.setFromXRController(s.obj); raycaster.far = 1.5; s.hover = pick(); }
    else if (s.hand) updateHand(s);
  }
}
function updateHand(s) {
  const tip = s.hand.joints && s.hand.joints['index-finger-tip'];
  if (!tip || !tip.visible) { s.hover = null; s.pressed = null; return; }
  tip.getWorldPosition(v3);
  let best = null, bf = null;
  for (const t of tiles) {
    if (!shown(t.obj)) continue;
    const f = faceDist(t, v3);
    if (!f.inside || f.dz < -0.03 || f.dz > 0.05) continue;
    if (!bf || Math.abs(f.dz) < Math.abs(bf.dz)) { best = t; bf = f; }
  }
  if (s.pressed) { const f = faceDist(s.pressed, v3); if (!f.inside || f.dz > 0.03) s.pressed = null; }
  else if (best && bf.dz < 0.015) { s.pressed = best; press(best); }
  s.hover = s.pressed || best;
}

// ---------- frame loop ----------
function frame() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000) || 0;
  lastT = now;
  scene.updateMatrixWorld();
  for (const fn of updaters) fn(now, dt);
  // section 6 / 7 / 9 updaters register into `updaters` in their own build step
  paintTiles();
  renderer.render(scene, camera);
}

// ---------- input wiring ----------
function attachControllers() {                           // XR only
  const rayGeo = own(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1.5)]));
  const rayMat = own(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
  for (let i = 0; i < 2; i++) {
    const ctrl = renderer.xr.getController(i);
    const ray = new THREE.Line(rayGeo, rayMat);
    ray.visible = false; ctrl.add(ray); scene.add(ctrl);
    const src = { obj: ctrl, hover: null, pressed: null };
    sources.push(src);
    const onConnected = e => { ray.visible = !(e.data && e.data.hand); };
    const onDisconnected = () => { ray.visible = false; src.hover = null; src.pressed = null; };
    const onDown = () => { src.pressed = src.hover; if (src.hover) press(src.hover); };
    const onUp = () => { src.pressed = null; };
    const off = [['connected', onConnected], ['disconnected', onDisconnected], ['selectstart', onDown], ['selectend', onUp]];
    for (const [t, f] of off) ctrl.addEventListener(t, f);
    cleanup.push(() => { for (const [t, f] of off) ctrl.removeEventListener(t, f); scene.remove(ctrl); });
    const hand = renderer.xr.getHand(i);
    scene.add(hand);
    sources.push({ hand, hover: null, pressed: null });
  }
}
function attachDesk() {
  canvas.style.display = '';
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const mouse = { hover: null, pressed: null };
  sources.push(mouse);
  const onMove = e => {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera); raycaster.far = Infinity;
    mouse.hover = pick();
  };
  const onDown = e => { if (e.button !== 0) return; onMove(e); mouse.pressed = mouse.hover; press(mouse.hover); };
  const onUp = () => { mouse.pressed = null; };
  const onLeave = () => { mouse.hover = null; mouse.pressed = null; };
  const onResize = () => { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
  const onKey = e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); teardown(); return; }
    let handled = true;
    if (DIGITS.test(e.key) || e.key in KEY_MAP) keyPress(KEY_MAP[e.key] || e.key);
    else if (e.key === 'r' || e.key === 'R') roll();
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }   // capture phase: keys belong to VR, not the hidden 2D input
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  cleanup.push(() => {
    canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointerleave', onLeave);
    window.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onResize);
  });
  onResize();
}

// ---------- lifecycle ----------
function disposeObject(o) {
  if (o.geometry) o.geometry.dispose();
  const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
  for (const m of ms) { if (m.map) m.map.dispose(); m.dispose(); }
}
// Idempotent. Used on session end, Escape in desktop mode, and when start() fails part-way.
function teardown() {
  if (!active || tearingDown) return;
  tearingDown = true;
  abortRoll(); tweens.clear(); updaters.clear();
  if (session && !sessionEnded) { try { session.end().catch(() => {}); } catch (_) {} }
  for (const fn of cleanup.splice(0).reverse()) { try { fn(); } catch (_) {} }
  if (scene) scene.traverse(disposeObject);
  for (const tex of textCache.values()) tex.dispose();
  textCache.clear();
  if (renderer) { try { renderer.dispose(); renderer.forceContextLoss(); } catch (_) {} }
  renderer = scene = camera = session = canvas = board = null;
  for (const k in cellMesh) delete cellMesh[k];
  for (const k in labelFor) delete labelFor[k];
  for (const k in gemFor) delete gemFor[k];
  tiles.length = 0; sources.length = 0; hpBars = [];
  tileGeo = edgeGeo = cellGeo = gemGeo = lineMat = null;
  matFree = matCrater = matTarget = matCreeper = matGem = null; matP = [];
  rowBar = colBar = flash = targetLabel = glowTex = null;
  panel = roomLabel = pad = padDisplay = fightTile = againTile = null;
  msgEl = codeBoxEl = codeEl = null;
  panelText = roomText = null; lastP = ['', ''];
  typed = ''; typedN = -1; vrShownN = 0; vrRolling = false; rollKey = null;
  unsubState = null; sessionEnded = false; desk = false;
  if (window.__vr) window.__vr = null;
  Z = null;
  active = false; tearingDown = false;
}

export async function start(Z_) {
  if (active) return;
  active = true; Z = Z_;
  desk = location.hash === '#vrdesk';
  try {
    if (!desk) {
      // requestSession first, so it still runs inside the click's user activation
      if (!navigator.xr) throw new Error('WebXR is not available in this browser.');
      session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
      session.addEventListener('end', () => { sessionEnded = true; teardown(); });
    }
    await document.fonts.ready;
    GRID = Z.N || 10; GOAL = Z.GOAL || 10;

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.xr.enabled = true;
    renderer.setPixelRatio(1);
    canvas = renderer.domElement;
    canvas.setAttribute('data-zimult-vr', '');
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:20;display:block;background:#000;touch-action:none';
    canvas.style.display = desk ? '' : 'none';
    document.body.appendChild(canvas);
    cleanup.push(() => canvas.remove());
    renderer.setSize(innerWidth, innerHeight, false);

    build();
    vrShownN = Z.state ? Z.state.n : 0;                 // do not replay a roll that is already on the board
    updaters.add(mirrorPanel);
    updaters.add(spinGems);
    updaters.add(tweenUpdater);
    updaters.add(pointUpdater);
    unsubState = Z.onState(syncScene);
    cleanup.push(() => { if (unsubState) unsubState(); });

    if (desk) {
      attachDesk();
    } else {
      renderer.xr.setReferenceSpaceType('local-floor');
      renderer.xr.setFramebufferScaleFactor(1.0);
      await renderer.xr.setSession(session);
      canvas.style.display = '';
      attachControllers();
    }
    lastT = performance.now();
    renderer.setAnimationLoop(frame);
    cleanup.push(() => renderer.setAnimationLoop(null));
    window.__vr = {
      get scene() { return scene; }, get camera() { return camera; }, cellMesh,
      get rolling() { return vrRolling; }, get typed() { return typed; },
      get desk() { return desk; }, get active() { return active; },
      end: () => teardown()
    };
  } catch (e) {
    teardown();
    throw e;
  }
}
