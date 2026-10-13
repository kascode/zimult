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
const cellMesh = {}, gemFor = {};                   // 'r-c' -> CellProxy (cell, drawn instanced) / Mesh (ore gem)
const SEAT_KEY = 'ttd-vr-seated', SEAT_DROP = 0.35;  // section 9: seated mode lowers the board, numpad and tiles by this much
let seated = false, lift = null, seatTile = null, exitTile = null;
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
function addTile({ parent, x = 0, y = 0, z = 0, rotX = 0, w, h, label, font = FONT_TILE, k = 1, onPress, key }) {
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
  const tile = { obj: grp, mesh, mat, w, h, label: text, onPress, shade: -1, key: key || label };
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

  // lift: seated mode lowers it (board, numpad, FIGHT, PLAY AGAIN, EXIT). The dialogue panel and HP bars stay put.
  lift = new THREE.Group(); scene.add(lift);
  // board group: pedestal, slab, cells, headers, roll bars, labels, gems
  board = new THREE.Group(); lift.add(board);
  const pedGeo = own(new THREE.BoxGeometry(1.3, 0.9, 1.3));
  const ped = new THREE.Mesh(pedGeo, own(new THREE.MeshStandardMaterial({ color: 0x111111 })));
  ped.position.set(0, 0.45, -1.1); board.add(ped);
  const slabGeo = own(new THREE.BoxGeometry(1.2, 0.04, 1.2));
  const slab = new THREE.Mesh(slabGeo, own(new THREE.MeshStandardMaterial({ color: 0x000000 })));
  slab.position.set(0, 0.92, -1.1); board.add(slab);
  const slabEdges = new THREE.LineSegments(own(new THREE.EdgesGeometry(slabGeo)), lineMat);
  slabEdges.position.copy(slab.position); board.add(slabEdges);

  for (let r = 1; r <= GRID; r++) for (let c = 1; c <= GRID; c++) {
    const k = r + '-' + c;
    cellMesh[k] = new CellProxy(k, r, c);             // drawn by flushCells() into one InstancedMesh per material
  }
  // product labels: one atlas texture and one instanced quad per owned cell, laid flat on the cell top
  atlas = buildAtlas();
  const labelGeo = own(new THREE.PlaneGeometry(0.08, 0.08));
  labelGeo.rotateX(-Math.PI / 2);
  labelAttr = new THREE.InstancedBufferAttribute(new Float32Array(GRID * GRID * 2), 2);
  labelGeo.setAttribute('aOff', labelAttr);
  const labelMat = own(new THREE.MeshBasicMaterial({ map: atlas.tex, transparent: true, depthWrite: false }));
  labelMat.onBeforeCompile = sh => {                  // remap each quad's UVs into its own atlas slot
    sh.vertexShader = 'attribute vec2 aOff;\n' + sh.vertexShader.replace('#include <uv_vertex>',
      '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = vMapUv * vec2(' + (1 / atlas.cols) + ', ' + (1 / atlas.rows) + ') + aOff;\n#endif');
  };
  labelMesh = new THREE.InstancedMesh(labelGeo, labelMat, GRID * GRID);
  labelMesh.count = 0; labelMesh.visible = false; labelMesh.frustumCulled = false;
  board.add(labelMesh);
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
  pad = new THREE.Group(); pad.position.set(0.45, 1.15, -0.55); pad.rotation.x = TILT; lift.add(pad);
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
  fightTile = addTile({ parent: lift, x: fightAt.x, y: fightAt.y, z: fightAt.z, rotX: TILT, w: 0.3, h: 0.1, label: 'FIGHT', font: FONT_LABEL, k: 0.6, key: 'fight', onPress: roll });
  fightTile.obj.visible = false;
  againTile = addTile({ parent: lift, x: -0.45, y: 1.2, z: -0.55, rotX: TILT, w: 0.6, h: 0.14, label: 'PLAY AGAIN', font: FONT_LABEL, k: 0.7, key: 'again', onPress: again });
  againTile.obj.visible = false;
  // section 9: EXIT beside the numpad (always shown); SEATED on the pedestal front, so it moves with the board
  const exitAt = pad.localToWorld(new THREE.Vector3(0.22, 0.135, 0));
  exitTile = addTile({ parent: lift, x: exitAt.x, y: exitAt.y, z: exitAt.z, rotX: TILT, w: 0.1, h: 0.08, label: 'EXIT', font: FONT_LABEL, k: 0.6, key: 'exit', onPress: exitVR });
  seatTile = addTile({ parent: board, x: 0, y: 0.6, z: -0.445, w: 0.42, h: 0.1, label: 'SIT DOWN', font: FONT_TILE, k: 0.9, key: 'seat', onPress: toggleSeated });   // 0.25 m above the floor once seated
  applySeated(readSeated());

  msgEl = document.getElementById('msg');
  codeBoxEl = document.getElementById('codebox');
  codeEl = document.getElementById('code');
  buildPresence();                                    // section 7: opponent marker and solo face (scene objects only)
  fxBuild();                                          // section 6: shared effect geometry, particle pool
}

// ---------- cells drawn instanced (section 9 budget) ----------
// Each cell is a CellProxy. Effects keep writing cell.scale.y, cell.position.y and cell.material as before; flushCells()
// packs all cells into one InstancedMesh per material (free, p1, p2, crater, target, creeper, glitch greys), so the
// board is a handful of draw calls. Product labels are one InstancedMesh sampling one atlas texture.
const cellBuckets = new Map();                       // material -> InstancedMesh holding every cell with that material
const UNIT_Q = new THREE.Quaternion(), _cm = new THREE.Matrix4(), _cp = new THREE.Vector3(), _cs = new THREE.Vector3();
let cellsDirty = true, labelMesh = null, labelAttr = null, atlas = null;
class CellProxy {
  constructor(k, r, c) {
    this.key = k; this.x = cellX(c); this.z = cellZ(r);
    this.mat = matFree; this.sy = 1; this.py = 0.95; this.product = 0;
    const me = this;
    this.scale = { get y() { return me.sy; }, set y(v) { me.sy = v; cellsDirty = true; } };
    this.position = { get y() { return me.py; }, set y(v) { me.py = v; cellsDirty = true; } };
  }
  get material() { return this.mat; }
  set material(m) { this.mat = m; cellsDirty = true; }
}
function buildAtlas() {                              // every product that can appear on this grid, one canvas
  const prods = [...new Set(Array.from({ length: GRID * GRID }, (_, i) => (Math.floor(i / GRID) + 1) * (i % GRID + 1)))].sort((a, b) => a - b);
  const cols = 8, rows = Math.ceil(prods.length / cols), px = 128;
  const cv = document.createElement('canvas'); cv.width = cols * px; cv.height = rows * px;
  const g = cv.getContext('2d');
  g.font = '84px "VT323", monospace'; g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const index = new Map();
  prods.forEach((p, i) => { index.set(p, i); g.fillText(String(p), (i % cols) * px + px / 2, Math.floor(i / cols) * px + px / 2 + 4); });
  const tex = own(new THREE.CanvasTexture(cv)); tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
  return { tex, cols, rows, index };
}
function cellBucket(mat) {
  let b = cellBuckets.get(mat);
  if (!b) {
    b = new THREE.InstancedMesh(cellGeo, mat, GRID * GRID);
    b.count = 0; b.visible = false; b.frustumCulled = false;
    board.add(b); cellBuckets.set(mat, b);
  }
  return b;
}
function flushCells() {
  if (!cellsDirty || !board) return;
  cellsDirty = false;
  for (const b of cellBuckets.values()) b.count = 0;
  let L = 0;
  for (const k in cellMesh) {
    const c = cellMesh[k], b = cellBucket(c.mat);
    _cp.set(c.x, c.py, c.z); _cs.set(1, c.sy, 1);
    b.setMatrixAt(b.count++, _cm.compose(_cp, UNIT_Q, _cs));
    if (c.product) {
      const i = atlas.index.get(c.product), col = i % atlas.cols, row = Math.floor(i / atlas.cols);
      _cp.set(c.x, topY(c.sy) + 0.002, c.z); _cs.set(1, 1, 1);
      labelMesh.setMatrixAt(L, _cm.compose(_cp, UNIT_Q, _cs));
      labelAttr.setXY(L, col / atlas.cols, 1 - (row + 1) / atlas.rows);
      L++;
    }
  }
  for (const b of cellBuckets.values()) { b.instanceMatrix.needsUpdate = true; b.visible = b.count > 0; }
  labelMesh.count = L; labelMesh.visible = L > 0;
  labelMesh.instanceMatrix.needsUpdate = true; labelAttr.needsUpdate = true;
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
    cell.material = mat; if (!scaleLock.has(k)) cell.scale.y = sy;
    cell.product = owner != null ? r * c : 0;          // product label, drawn from the atlas by flushCells()
  }
  cellsDirty = true;

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

  fxSync(S);                                          // section 6: effects, each guarded by its own vr* variable
  // section 7 (opponent marker, solo face) and section 9 (seated, EXIT) are per-frame / tile-driven, see presenceUpdater
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
  if (s.pressed && !shown(s.pressed.obj)) s.pressed = null;          // tile hidden while held (numpad closed, say)
  if (s.pressed) { const f = faceDist(s.pressed, v3); if (!f.inside || f.dz > 0.03) s.pressed = null; }   // released once the tip leaves
  else if (best && bf.dz < 0.015) { s.pressed = best; press(best); }  // pressed within 1.5 cm of the front face
  s.hover = s.pressed || best;
}

// ---------- effects (section 6): the 2D events, each guarded by its own vr* variable ----------
const PMAX = 400;                                    // pooled cubes: one InstancedMesh, one draw call
const FONT_BIG = '260px "VT323", monospace';
const ACH = {                                        // mirrors ACH in index.html (the bridge does not expose it)
  'first-blood': { title:'First blood', icon:'🩸' },
  'nine-master': { title:'Nine-master', icon:'9️⃣' },
  'speedrun':    { title:'Gotta go fast', icon:'💨' },
  'full-stack':  { title:'Full stack', icon:'📦' },
  'sixty-seven': { title:'Six seven', icon:'🎰' },
  'knockout':    { title:'A knockout!', icon:'🥊' },
  'comeback':    { title:'Comeback kid', icon:'🔁' },
  'diamond':     { title:'Diamonds!', icon:'💎' },
  'creeper':     { title:'Creeper survivor', icon:'💥' },
  'steamboat':   { title:'Steamboat', icon:'🚢' },
  'abstracted':  { title:'Abstracted', icon:'🌀' },
};
let vrFxN = 0, vr67N = 0, vrBoomN = 0, vrGlitchN = 0, vrWhistleN = 0, vrWin = false;
const vrAchShown = new Set();                        // 'id:slot:n' keys already toasted
const fxDrops = new Set();                           // drop() of every live per-instance effect object; teardown calls them all
const scaleLock = new Set();                         // cell keys whose scale.y a tween owns (syncScene leaves them alone)
const pool = [];                                     // particle slots {life, max, g, spin, pos, vel, rot, size}
const greyMats = [], toastList = [];                 // glitch greys (shared); live toasts, index = stack position
let pMesh = null, pGeo = null, pMat = null, pLive = 0;
let earGeo = null, earMat = null, ears = null, toastGeo = null, toastEdgeGeo = null, shakeCancel = null;
const GOLD = new THREE.Color(0xffd800), WHITE = new THREE.Color(0xffffff);
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const sym = () => Math.random() * 2 - 1;
const backOut = p => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };
function bounceOut(x) {
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}
function fxBuild() {
  pGeo = own(new THREE.BoxGeometry(1, 1, 1));
  pMat = own(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  pMesh = new THREE.InstancedMesh(pGeo, pMat, PMAX);
  pMesh.frustumCulled = false;
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  pool.length = 0;
  for (let i = 0; i < PMAX; i++) {
    pMesh.setMatrixAt(i, hidden); pMesh.setColorAt(i, WHITE);
    pool.push({ life: 0, max: 0, g: 0, spin: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Vector3(), size: new THREE.Vector3(1, 1, 1) });
  }
  board.add(pMesh);
  earGeo = own(new THREE.SphereGeometry(0.03, 12, 8));
  earMat = own(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  toastGeo = own(new THREE.PlaneGeometry(0.5, 0.15));
  toastEdgeGeo = own(new THREE.PlaneGeometry(0.52, 0.17));
  greyMats.length = 0;
  for (const g of [0x444444, 0x777777, 0xaaaaaa]) greyMats.push(own(new THREE.MeshStandardMaterial({ color: g })));
}
// Guards start from the state on screen, so VR joining mid-match does not replay old events.
function fxSeed(S) {
  if (!S) return;
  vrFxN = S.n; vr67N = S.n; vrBoomN = S.n; vrGlitchN = S.n; vrWhistleN = S.n; vrWin = S.winner != null;
  for (const a of S.ach) vrAchShown.add(a.id + ':' + a.slot + ':' + a.n);
}
// Stops every live effect at once (session end, Escape, failed start). Board and tweens are dropped by the caller.
function fxReset() {
  for (const d of [...fxDrops]) d();
  fxDrops.clear();
  removeEars();
  pool.length = 0; pLive = 0; pMesh = null; greyMats.length = 0; toastList.length = 0;
  scaleLock.clear(); shakeCancel = null;
  if (board) board.position.set(0, 0, 0);
  vrFxN = vr67N = vrBoomN = vrGlitchN = vrWhistleN = 0; vrWin = false; vrAchShown.clear();
}
// Sprite with a per-instance material. The cached text texture is shared, so only the material is disposed.
function fxText(parent, text, opts = {}) {
  const sp = makeText(text, opts);
  if (opts.w) sp.scale.multiplyScalar(opts.w / sp.scale.x);
  parent.add(sp);
  const drop = () => { if (!fxDrops.delete(drop)) return; sp.removeFromParent(); sp.material.dispose(); };
  fxDrops.add(drop);
  return { sp, drop };
}
// Flat overlay on a cell (shared cell geometry, per-instance material).
function fxMesh(parent, geo, color, x, y, z, sx, sz) {
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z); m.scale.set(sx, 1, sz); parent.add(m);
  const drop = () => { if (!fxDrops.delete(drop)) return; m.removeFromParent(); mat.dispose(); };
  fxDrops.add(drop);
  return { mat, drop };
}
// Pooled cube, board-local coordinates. Dead slots are scaled to zero, so nothing is created or disposed per particle.
function spawnPart(x, y, z, vx, vy, vz, life, g, size, color, spin) {
  const i = pool.findIndex(p => p.life <= 0);
  if (i < 0 || !pMesh) return;
  const p = pool[i];
  p.life = p.max = life; p.g = g; p.spin = spin;
  p.pos.set(x, y, z); p.vel.set(vx, vy, vz); p.size.set(size[0], size[1], size[2]);
  p.rot.set(Math.random() * 6, Math.random() * 6, 0);
  pMesh.setColorAt(i, color); pMesh.instanceColor.needsUpdate = true;
  _q.setFromEuler(_e.set(p.rot.x, p.rot.y, 0));
  pMesh.setMatrixAt(i, _m.compose(p.pos, _q, p.size));
  pLive++;
}
function makeEars() {                                // 1928 ears: two white spheres, on the roll cursor or the target cell
  ears = new THREE.Group();
  for (const x of [-0.06, 0.06]) { const m = new THREE.Mesh(earGeo, earMat); m.position.x = x; ears.add(m); }
  ears.visible = false; board.add(ears);
}
function removeEars() { if (ears) { ears.removeFromParent(); ears = null; } }
// Board-only shake. The camera never moves.
function shake(amp, ms) {
  if (shakeCancel) { shakeCancel(); shakeCancel = null; }
  shakeCancel = animate(ms, p => { const k = amp * (1 - p); board.position.set(sym() * k, sym() * k, 0); },
    () => { board.position.set(0, 0, 0); shakeCancel = null; });
}

function fxClaim(S, key) {                           // claim: the cell bounces from 6 down to 4, cubes burst in the owner's colour
  const [r, c] = key.split('-').map(Number), cell = cellMesh[key], x = cellX(c), z = cellZ(r);
  const col = matP[S.last.slot].emissive, ore = (S.ore || []).includes(key);
  scaleLock.add(key); cell.scale.y = 6;
  animate(400, p => { cell.scale.y = 6 + (4 - 6) * backOut(p); }, () => { cell.scale.y = 4; scaleLock.delete(key); });
  for (let i = 0; i < 40; i++) spawnPart(x, 1.0, z, sym() * 0.4, 0.8 + Math.random() * 1.4, sym() * 0.4, 1.2, 2.5, [0.01, 0.01, 0.01], col, Math.random() * 8);
  const t = fxText(board, ore ? '+2' : '+1', { k: 1.2, color: ore ? '#5fe6ff' : '#' + col.getHexString() });
  t.sp.position.set(x, 1.0, z);
  animate(1200, p => { t.sp.position.y = 1.0 + 0.15 * ease(p); t.sp.material.opacity = 1 - p; }, () => t.drop());
}
function fxMiss(key) {                               // miss: red flash on the cell, grey MISS rises, board shakes 1 cm
  const [r, c] = key.split('-').map(Number), x = cellX(c), z = cellZ(r);
  const f = fxMesh(board, cellGeo, 0xff2a2a, x, 0.98, z, 1.05, 1.05);
  animate(400, p => { f.mat.opacity = 1 - p; }, () => f.drop());
  const t = fxText(board, 'MISS', { color: '#9e9e9e', k: 1.0 }); t.sp.position.set(x, 1.0, z);
  animate(900, p => { t.sp.position.y = 1.0 + 0.15 * ease(p); t.sp.material.opacity = 1 - p; }, () => t.drop());
  shake(0.01, 300);
}
function fxBoom(boom) {                              // creeper: white flash, lost blocks fly off, board shakes 2 cm
  const [r, c] = boom.key.split('-').map(Number);
  const f = fxMesh(board, cellGeo, 0xffffff, cellX(c), 0.98, cellZ(r), 1.05, 1.05);
  animate(400, p => { f.mat.opacity = 1 - p; }, () => f.drop());
  for (const l of boom.lost) {
    const [lr, lc] = l.key.split('-').map(Number);
    spawnPart(cellX(lc), 1.0, cellZ(lr), sym() * 1.2, 1.5 + Math.random() * 1.5, sym() * 1.2, 1.5, 3, [0.1, 0.08, 0.1], matP[l.slot].emissive, 6 + Math.random() * 4);
  }
  shake(0.02, 400);
}
function fxGlitch() {                                // answer 0: 2 s of jitter and grey cells; #msg scramble reaches the panel by itself
  const keys = Object.keys(cellMesh);
  let tick = -1, hit = [];
  animate(2000, p => {
    const t = Math.floor(p * 2000 / 90);
    if (t === tick) return; tick = t;
    for (const m of hit) m.position.y = 0.95;
    hit = [];
    for (let i = 0; i < 25; i++) {
      const m = cellMesh[keys[Math.random() * keys.length | 0]];
      m.position.y = 0.95 + sym() * 0.02; m.material = greyMats[Math.random() * greyMats.length | 0];
      hit.push(m);
    }
  }, () => { for (const m of hit) m.position.y = 0.95; syncScene(Z.state); });
}
function fxWhistle() {                               // ears pop in; they stay for the rest of the match (makeEars / removeEars)
  const g = ears; if (!g) return;
  g.scale.setScalar(0.01);
  animate(300, p => g.scale.setScalar(Math.max(0.01, ease(p))));
}
function fxWin() {                                   // 200 cubes fountain from the board
  const cols = [matP[0].emissive, matP[1].emissive, GOLD, WHITE];
  let spawned = 0;
  animate(1200, p => {
    const want = Math.floor(p * 200);
    while (spawned < want) {
      spawned++;
      spawnPart(sym() * 0.2, 0.95, -1.1 + sym() * 0.2, sym() * 1.1, 2.6 + Math.random() * 1.2, sym() * 1.1, 3, 3.5, [0.012, 0.012, 0.012], cols[Math.random() * cols.length | 0], Math.random() * 8);
    }
  });
}
function fx67() {                                    // 67: rows and columns 6 and 7 bob, SIX then SEVEN! drop in, 60 digits fall
  const bobs = [];
  for (const k in cellMesh) { const [r, c] = k.split('-').map(Number); if (r === 6 || r === 7 || c === 6 || c === 7) bobs.push({ m: cellMesh[k], s: (r + c) % 2 ? 1 : -1 }); }
  const falls = [];
  for (let i = 0; i < 60; i++) {
    const f = fxText(scene, i % 2 ? '7' : '6', { k: 2, color: i % 2 ? '#ffd800' : '#ffffff' });
    f.sp.position.set(-1.8 + Math.random() * 3.6, 0, -2.0 + Math.random() * 2.6);
    falls.push({ sp: f.sp, drop: f.drop, y0: 3.2 + Math.random(), v: 0.6 + Math.random() * 0.6 });
  }
  const six = fxText(scene, 'SIX', { font: FONT_BIG, lh: 230, color: '#ffd800', w: 2 });
  six.sp.position.set(0, 4, -1.6);
  let seven = null;
  animate(3000, p => {
    const t = p * 3000;
    for (const b of bobs) b.m.position.y = 0.95 + 0.03 * Math.sin(t * 0.0113) * b.s;   // about 1.8 Hz
    for (const f of falls) { f.sp.position.y = f.y0 - f.v * t / 1000; f.sp.visible = f.sp.position.y > 0; }
    if (t < 750) { six.sp.position.y = 4 - 1.4 * bounceOut(Math.min(1, t / 600)); return; }
    six.drop();
    if (!seven) { seven = fxText(scene, 'SEVEN!', { font: FONT_BIG, lh: 230, color: '#ffd800', w: 2 }); seven.sp.position.set(0, 4, -1.6); }
    seven.sp.position.y = 4 - 1.4 * bounceOut(Math.min(1, (t - 750) / 600));
  }, () => {
    for (const b of bobs) b.m.position.y = 0.95;
    for (const f of falls) f.drop();
    six.drop(); if (seven) seven.drop();
  });
}
function achToast(a) {                               // achievement: panel slides in from the left, stays 3 s, fades
  const def = ACH[a.id];
  if (!def || !scene) return;
  if (toastList.length >= 3) toastList[0].drop();
  const grp = new THREE.Group(); grp.position.set(-1.5, 1.4, -1.3); scene.add(grp);
  const bgMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, depthWrite: false });
  const edgeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false });
  const edge = new THREE.Mesh(toastEdgeGeo, edgeMat); edge.position.z = -0.001;
  grp.add(edge, new THREE.Mesh(toastGeo, bgMat));
  const head = fxText(grp, 'ACHIEVEMENT GET!', { k: 0.45, color: '#bbbbbb' }); head.sp.position.set(0, 0.05, 0.002);
  const title = fxText(grp, def.icon + '  ' + def.title, { k: 0.9, box: [0.46, 0.055] }); title.sp.position.set(0, 0, 0.002);
  const who = fxText(grp, Z.name(a.slot), { k: 0.5, color: '#bbbbbb', box: [0.46, 0.04] }); who.sp.position.set(0, -0.05, 0.002);
  const sprites = [head.sp, title.sp, who.sp];
  const item = { drop: null };
  const drop = () => {
    if (!fxDrops.delete(drop)) return;
    const i = toastList.indexOf(item); if (i >= 0) toastList.splice(i, 1);
    grp.removeFromParent(); bgMat.dispose(); edgeMat.dispose();
    head.drop(); title.drop(); who.drop();
  };
  item.drop = drop; fxDrops.add(drop); toastList.push(item);
  animate(3400, p => {
    const t = p * 3400;
    grp.position.x = -1.5 + 0.6 * ease(Math.min(1, t / 250));
    grp.position.y = 1.4 - 0.18 * Math.max(0, toastList.indexOf(item));
    const fade = t < 3000 ? 1 : Math.max(0, 1 - (t - 3000) / 400);
    bgMat.opacity = 0.85 * fade; edgeMat.opacity = fade;
    for (const s of sprites) s.material.opacity = fade;
  }, () => drop());
}
// Runs on every state callback. Guards first, then effects; effects wait while a roll replay is in progress,
// and syncScene runs again when the replay lands, so claim / miss / 67 / boom play after the roll.
function fxSync(S) {
  if (S.n === 0) { vrFxN = vr67N = vrBoomN = vrGlitchN = vrWhistleN = 0; vrWin = false; if (!S.ach.length) vrAchShown.clear(); }
  for (const a of S.ach) { const k = a.id + ':' + a.slot + ':' + a.n; if (!vrAchShown.has(k)) { vrAchShown.add(k); achToast(a); } }
  if (S.ears) { if (!ears) makeEars(); } else removeEars();
  if (vrRolling) return;
  if (S.ev67 && S.ev67.n === S.n && vr67N !== S.n && (S.ev67.kind === 'roll' || S.phase === 'idle')) { vr67N = S.n; fx67(); }
  if (S.boom && S.boom.n === S.n && vrBoomN !== S.n) { vrBoomN = S.n; fxBoom(S.boom); }
  if (S.glitch && S.glitch.n === S.n && vrGlitchN !== S.n) { vrGlitchN = S.n; fxGlitch(); }
  if (S.evWhistle && S.evWhistle.n === S.n && vrWhistleN !== S.n) { vrWhistleN = S.n; fxWhistle(); }
  if (S.last) {
    if (vrFxN !== S.n) { vrFxN = S.n; if (S.last.ok) fxClaim(S, S.last.r + '-' + S.last.c); else fxMiss(S.last.r + '-' + S.last.c); }
  } else vrFxN = 0;
  if (S.winner != null) { if (!vrWin) { vrWin = true; fxWin(); } } else vrWin = false;
}
// Per-frame: ears follow the roll cursor (or the target cell while answering), and live particles step with dt.
function fxUpdater(now, dt) {
  if (ears) {
    const st = Z.state;
    let x = null, z = null;
    if (rowBar.visible) { x = colBar.position.x; z = rowBar.position.z; }
    else if (st && st.roll && st.phase === 'answer' && !vrRolling) { x = cellX(st.roll.c); z = cellZ(st.roll.r); }
    ears.visible = x !== null;
    if (x !== null) ears.position.set(x, 1.03, z);
  }
  if (!pLive) return;
  for (let i = 0; i < PMAX; i++) {
    const p = pool[i];
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.life = 0; pLive--; pMesh.setMatrixAt(i, _m.makeScale(0, 0, 0)); continue; }
    p.vel.y -= p.g * dt;
    p.pos.addScaledVector(p.vel, dt);
    p.rot.x += p.spin * dt; p.rot.y += p.spin * 0.6 * dt;
    _q.setFromEuler(_e.set(p.rot.x, p.rot.y, 0));
    pMesh.setMatrixAt(i, _m.compose(p.pos, _q, p.size));
  }
  pMesh.instanceMatrix.needsUpdate = true;
}

// ---------- opponent presence and solo face (section 7) ----------
// Coordinates arrive in the sender's local-floor space, where the sender stands at the origin facing -z. We stand at the
// origin too, so the opponent maps to a point at z = -2.2 facing us: a 180 degree turn about the vertical axis through
// the board centre (x -> -x, z -> -2.2 - z), and the head quaternion is turned the same way.
const POSE_EVERY = 100, POSE_STALE = 3000, POSE_FADE = 0.3;
const MIRROR_Z = -2.2, FACE_POS = new THREE.Vector3(0, 2.3, -2.2);   // above the dialogue panel (top at y 2.0)
const FACE_BY_CPU = { Dummy: '•_•', Robot: '[o_o]', Boss: '[>_<]' };  // S.names[1] in solo is the CPU's name (difficulty)
const _pq = new THREE.Quaternion(), _pv = new THREE.Vector3(), _pe = new THREE.Vector3(), _hv = new THREE.Vector3();
let presenceAcc = 0, poseTgt = null, poseAt = 0;
let marker = null, heartMesh = null, heartMat = null, handMat = null, handMeshes = [], handLive = [false, false], markerLive = false;
let faceMesh = null, faceMat = null, faceGeo = null, faceText = '', faceTilt = [0, 0];
function heartGeo() {                                 // extruded heart, 10 cm wide and 1 cm deep, facing +z
  const pts = [], k = 0.1 / 32;
  for (let i = 0; i < 64; i++) {
    const t = i / 64 * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3), y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push(new THREE.Vector2(x * k, (y + 2.5) * k));  // the curve spans y -17..12, so +2.5 centres it
  }
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: 0.01, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -0.005);
  return g;
}
function buildPresence() {
  heartMat = own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false }));
  handMat = own(new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, depthWrite: false }));
  marker = new THREE.Group(); marker.visible = false; scene.add(marker);
  heartMesh = new THREE.Mesh(own(heartGeo()), heartMat); marker.add(heartMesh);
  const handGeo = own(new THREE.SphereGeometry(0.02, 8, 6));       // 4 cm across
  handMeshes = [0, 1].map(() => { const m = new THREE.Mesh(handGeo, handMat); m.visible = false; scene.add(m); return m; });
  faceMat = own(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
  faceGeo = own(new THREE.PlaneGeometry(1, 1));
  faceMesh = new THREE.Mesh(faceGeo, faceMat); faceMesh.position.copy(FACE_POS); faceMesh.visible = false; scene.add(faceMesh);
  faceText = ''; setFace('•_•');
}
function setFace(t) {
  if (t === faceText) return;
  faceText = t;
  const tex = textTexture(t, { font: '150px "VT323", monospace', color: '#ffffff', pad: 12, maxW: 0, lh: 150 });
  faceMat.map = tex; faceMat.needsUpdate = true;
  const w = tex.userData.w * MM * 1.6, h = tex.userData.h * MM * 1.6, f = Math.min(1, 0.6 / w, 0.4 / h);
  faceMesh.scale.set(w * f, h * f, 1);
}
function readPose(p) {                                // validates the wire format {h:[x,y,z,qx,qy,qz,qw], l, r}
  if (!p || !Array.isArray(p.h) || p.h.length < 7) return null;
  const h = p.h.slice(0, 7).map(Number);
  if (h.some(v => !Number.isFinite(v))) return null;
  const hand = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? a : null;
  return { h, hands: [hand(p.l), hand(p.r)] };
}
function mirrorPose(p) {                              // sender space -> our space, precomputed on arrival
  const h = p.h, mv = a => new THREE.Vector3(-a[0], a[1], MIRROR_Z - a[2]);
  // pi-turn about y applied to the orientation: (qx, qy, qz, qw) -> (qz, qw, -qx, -qy)
  return { pos: mv(h), quat: new THREE.Quaternion(h[5], h[6], -h[3], -h[4]), hands: p.hands.map(a => a ? mv(a) : null) };
}
function handPoint(i) {                               // wrist of a tracked hand, else the controller, else null
  const hand = renderer.xr.getHand(i), wr = hand && hand.joints && hand.joints.wrist;
  let o = wr && wr.visible ? wr : null;
  if (!o) { const ctrl = renderer.xr.getController(i); o = ctrl && ctrl.visible ? ctrl : null; }
  if (!o) return null;
  o.getWorldPosition(_hv);
  return [_hv.x, _hv.y, _hv.z];
}
function localPose() {
  // XR: the ArrayCamera's matrixWorld is the head pose (set by WebXRManager). Desktop: the fixed camera stands in for it.
  let cam = renderer.xr.getCamera();
  if (desk) { camera.updateMatrixWorld(); cam = camera; }     // the desktop camera is not in the scene graph
  cam.matrixWorld.decompose(_pv, _pq, _pe);
  const hands = desk ? [null, null] : [handPoint(0), handPoint(1)];   // l = hand/controller 0, r = 1
  return { h: [_pv.x, _pv.y, _pv.z, _pq.x, _pq.y, _pq.z, _pq.w], l: hands[0], r: hands[1] };
}
// Per frame: send the pose every 100 ms, and derive the marker and face from the current mode and seats.
function presenceUpdater(now, dt) {
  presenceAcc += dt * 1000;
  if (presenceAcc >= POSE_EVERY) {
    presenceAcc %= POSE_EVERY;
    if (Z.mode === 'host' || Z.mode === 'guest') Z.sendPose(localPose());   // the bridge drops it when no peer is open
  }
  const st = Z.state, opp = Z.mySlot === 0 ? 1 : 0;
  const inP2P = (Z.mode === 'host' || Z.mode === 'guest') && Z.mySlot >= 0 && !!st && !!st.seats && !!st.seats[opp];
  const want = inP2P && !!poseTgt;
  const k = 1 - Math.pow(0.8, dt * 60);               // lerp factor 0.2 per 1/60 s, frame-rate independent
  if (want) {
    const col = matP[opp].emissive;
    heartMat.color.copy(col); handMat.color.copy(col);
    if (!markerLive) { marker.position.copy(poseTgt.pos); marker.quaternion.copy(poseTgt.quat); markerLive = true; }
    marker.position.lerp(poseTgt.pos, k); marker.quaternion.slerp(poseTgt.quat, k);
  } else markerLive = false;
  marker.visible = want;
  const op = want && now - poseAt > POSE_STALE ? POSE_FADE : 1;   // 30 % after 3 s without a pose
  heartMat.opacity = op; handMat.opacity = op;
  for (let i = 0; i < 2; i++) {
    const hp = want ? poseTgt.hands[i] : null, m = handMeshes[i];
    m.visible = !!hp;
    if (!hp) { handLive[i] = false; continue; }
    if (!handLive[i]) { m.position.copy(hp); handLive[i] = true; }
    m.position.lerp(hp, k);
  }
  // solo face: the CPU, with its expression for the difficulty, bobs and leans toward its target while it answers
  const solo = Z.mode === 'solo' && !!st;
  faceMesh.visible = solo;
  if (solo) {
    setFace(FACE_BY_CPU[st.names && st.names[1]] || FACE_BY_CPU.Dummy);
    faceMesh.position.set(FACE_POS.x, FACE_POS.y + 0.02 * Math.sin(now / 1000 * Math.PI), FACE_POS.z);   // +-2 cm, 2 s period
    let tx = 0, ty = 0;
    if (st.phase === 'answer' && st.turn === 1 && st.roll) {
      const dx = cellX(st.roll.c) - FACE_POS.x, dy = topY(1) - FACE_POS.y, dz = cellZ(st.roll.r) - FACE_POS.z;
      ty = 0.5 * Math.atan2(dx, dz); tx = 0.5 * Math.atan2(-dy, dz);
    }
    const kf = 1 - Math.pow(0.85, dt * 60);
    faceTilt[0] += (tx - faceTilt[0]) * kf; faceTilt[1] += (ty - faceTilt[1]) * kf;
    faceMesh.rotation.set(faceTilt[0], faceTilt[1], 0);
  }
}

// ---------- frame loop ----------
function frame() {
  if (!renderer) return;
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000) || 0;
  lastT = now;
  scene.updateMatrixWorld();
  for (const fn of updaters) fn(now, dt);
  if (!renderer) return;                              // an updater may have ended the session (EXIT in desktop mode)
  // section 6 / 7 / 9 updaters register into `updaters` in their own build step
  paintTiles();
  flushCells();
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

// ---------- seated mode and EXIT (section 9) ----------
function readSeated() { try { return localStorage.getItem(SEAT_KEY) === '1'; } catch (_) { return false; } }
function writeSeated(on) { try { localStorage.setItem(SEAT_KEY, on ? '1' : '0'); } catch (_) {} }
function applySeated(on) {
  seated = on;
  lift.position.y = on ? -SEAT_DROP : 0;
  if (seatTile) seatTile.label.setText(on ? 'STAND UP' : 'SIT DOWN');
}
function toggleSeated() { applySeated(!seated); writeSeated(seated); }
// XR: end the session; the 'end' listener tears down. Desktop: tear down directly.
function exitVR() {
  if (desk || !session) { teardown(); return; }
  session.end().catch(() => teardown());
}

// ---------- lifecycle ----------
function disposeObject(o) {
  if (o.isInstancedMesh) o.dispose();                 // frees the instance matrix / colour buffers (they are not geometry)
  if (o.geometry) o.geometry.dispose();
  const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
  for (const m of ms) { if (m.map) m.map.dispose(); m.dispose(); }
}
// Idempotent. Used on session end, Escape in desktop mode, and when start() fails part-way.
function teardown() {
  if (!active || tearingDown) return;
  tearingDown = true;
  abortRoll(); tweens.clear(); updaters.clear(); fxReset();
  if (session && !sessionEnded) { try { session.end().catch(() => {}); } catch (_) {} }
  for (const fn of cleanup.splice(0).reverse()) { try { fn(); } catch (_) {} }
  if (scene) scene.traverse(disposeObject);
  for (const tex of textCache.values()) tex.dispose();
  textCache.clear();
  if (renderer) { try { renderer.dispose(); renderer.forceContextLoss(); } catch (_) {} }
  renderer = scene = camera = session = canvas = board = null;
  for (const k in cellMesh) delete cellMesh[k];
  for (const k in gemFor) delete gemFor[k];
  tiles.length = 0; sources.length = 0; hpBars = [];
  tileGeo = edgeGeo = cellGeo = gemGeo = lineMat = null;
  matFree = matCrater = matTarget = matCreeper = matGem = null; matP = [];
  rowBar = colBar = flash = targetLabel = glowTex = null;
  panel = roomLabel = pad = padDisplay = fightTile = againTile = null;
  cellBuckets.clear(); cellsDirty = true; labelMesh = labelAttr = atlas = null;
  lift = seatTile = exitTile = null; seated = false;
  marker = heartMesh = heartMat = handMat = faceMesh = faceMat = faceGeo = null;
  handMeshes = []; handLive = [false, false]; markerLive = false;
  poseTgt = null; poseAt = 0; presenceAcc = 0; faceText = ''; faceTilt = [0, 0];
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
    fxSeed(Z.state);                                    // nor a claim, 67, boom, glitch, whistle, win or achievement already on the board
    updaters.add(mirrorPanel);
    updaters.add(spinGems);
    updaters.add(tweenUpdater);
    updaters.add(pointUpdater);
    updaters.add(fxUpdater);
    updaters.add(presenceUpdater);
    unsubState = Z.onState(syncScene);
    cleanup.push(() => { if (unsubState) unsubState(); });
    // Z.onPose holds one listener; teardown puts a no-op back (cleanup runs before Z is cleared)
    Z.onPose(p => { const r = readPose(p); if (!r) return; poseTgt = mirrorPose(r); poseAt = performance.now(); });
    cleanup.push(() => Z.onPose(() => {}));

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
      get fx() { return fxDrops.size + pLive; },        // live effect objects (for leak checks)
      get lowered() { return lift ? lift.position.y : null; }, get seated() { return seated; },
      // screen position (CSS px) of a pressable tile by key, for desktop tests
      screenOf: key => {
        const t = tiles.find(x => x.key === key && shown(x.obj));
        if (!t || !camera) return null;
        const v = t.obj.getWorldPosition(new THREE.Vector3()).project(camera);
        return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight };
      },
      presence: () => ({ marker: !!marker && marker.visible, pos: marker ? marker.position.toArray().map(v => +v.toFixed(3)) : null,
        quat: marker ? marker.quaternion.toArray().map(v => +v.toFixed(3)) : null,
        opacity: heartMat ? heartMat.opacity : null, color: heartMat ? heartMat.color.getHexString() : null,
        hands: handMeshes.map(m => m.visible), handPos: handMeshes.map(m => m.visible ? m.position.toArray().map(v => +v.toFixed(3)) : null) }),
      face: () => ({ visible: !!faceMesh && faceMesh.visible, text: faceText, y: faceMesh ? +faceMesh.position.y.toFixed(3) : null,
        tilt: faceTilt.map(v => +v.toFixed(3)) }),
      cells: () => ({ buckets: [...cellBuckets.values()].map(b => b.count), labels: labelMesh ? labelMesh.count : 0 }),
      info: () => renderer ? { calls: renderer.info.render.calls, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures } : null,
      end: () => teardown()
    };
  } catch (e) {
    teardown();
    throw e;
  }
}
