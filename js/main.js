// BATTLEZONE EMULATOR -- boots the original 1980 ROMs.
// Reference tool for tuning the remake (../battlezone-remake), not the main game.
import { Machine, CPU_HZ } from "./machine.js";
import { SoundOutput } from "./sound.js";
import { readState, drawTopView, panelGeom, hitTest } from "./topview.js";

const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");

let machine = null;
let running = true;
let speed = 0.93;                  // default machine speed (slider 0.60-1.00)
let lastLines = [];
const sound = new SoundOutput(CPU_HZ);

// Advance the machine and feed the audio renderer in one place.
// `wallSeconds` is the real elapsed time the burst stands for; audio buffers
// are sized from it so playback never starves when the machine runs slowed.
function advance(cycles, wallSeconds) {
  const f = machine.run(cycles);
  sound.pump(cycles, machine.audioEvents, wallSeconds);
  if (f) lastLines = f;
  return f;
}

// ---------------------------------------------------------------- boot
async function loadRoms() {
  const names = ["036409.01", "036410.01", "036411.01", "036412.01",
                 "036413.01", "036414.02", "036421.01", "036422.01",
                 "03617X.SAV"];
  const roms = {};
  for (const n of names) {
    const r = await fetch("roms/" + n);
    if (!r.ok) throw new Error("missing ROM " + n);
    roms[n] = new Uint8Array(await r.arrayBuffer());
  }
  return roms;
}

// ---------------------------------------------------------------- video
function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  layoutTouchControls();
}
// Keep the tread sticks and FIRE clear of the toolbar however many rows it
// wraps to on a narrow screen.
function layoutTouchControls() {
  const c = document.getElementById("controls");
  if (!c) return;
  const h = c.getBoundingClientRect().height || 44;
  document.documentElement.style.setProperty("--touch-bottom",
    Math.max(96, Math.round(h) + 26) + "px");
}
addEventListener("resize", resize);
resize();

function paint(lines) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = innerWidth, h = innerHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  const s = Math.min(w / 1024, h / 768);
  // beam space: 0-1023 x, 0-767 y (y up)
  ctx.setTransform(dpr * s, 0, 0, -dpr * s,
                   dpr * (w - 1024 * s) / 2, dpr * (h + 768 * s) / 2);
  ctx.lineCap = "round";
  const passes = [{ lw: 5.0, am: 0.22 }, { lw: 1.5, am: 1.0 }];
  for (const pass of passes) {
    for (let z = 1; z <= 15; z++) {
      const seg = lines.filter(l => Math.round(l.z) === z);
      if (!seg.length) continue;
      ctx.strokeStyle = "#20ff40";
      ctx.globalAlpha = Math.min(1, (0.2 + 0.8 * z / 15) * pass.am);
      ctx.lineWidth = pass.lw / s;
      ctx.beginPath();
      for (const l of seg) {
        // VGDOT emits a zero-length vector to paint a single dot (radar blip,
        // explosion sparks). Canvas won't stroke a zero-length subpath, so
        // nudge it into a minimal segment and let the round cap draw the dot.
        if (l.x1 === l.x2 && l.y1 === l.y2) {
          ctx.moveTo(l.x1 - 0.5, l.y1);
          ctx.lineTo(l.x2 + 0.5, l.y2);
        } else {
          ctx.moveTo(l.x1, l.y1);
          ctx.lineTo(l.x2, l.y2);
        }
      }
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // read-only top-down overlay (never touches emulation state)
  if (topView && machine) {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTopView(ctx, readState(machine), {
      half: topHalf, rangeWu: topRangeWu / topZoom, fovDeg: 60,
      origin: topFrozen, pos: topPos,
    });
  }
  if (machine) {
    const dpr2 = Math.min(devicePixelRatio || 1, 2);
    ctx.setTransform(dpr2, 0, 0, dpr2, 0, 0);
    drawMuteCues(ctx);
  }
}

let topView = false, topZoom = 1, topHalf = 110;
let topPos = null;                 // {x,y} top-left once the panel has been moved
let topFrozen = null;              // {x,y,a} world frame when the map is frozen
const topRangeWu = 20000;
const geom = () => panelGeom(topHalf, topPos);

// Z freezes the field in place so the player icon moves within the window;
// pressing Z again re-centres on the player.
function toggleFreeze() {
  if (!machine) return;
  if (topFrozen) { topFrozen = null; return; }
  const st = readState(machine);
  topFrozen = { x: st.px, y: st.py, a: st.pa };
}

// ---------------------------------------------------------------- input
// moveBits: bit0 R-fwd, bit1 R-back, bit2 L-fwd, bit3 L-back
const DIR_KEYS = {
  ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down",
  ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right",
};
// direct tread levers (authentic). X mirrors Z, because Z is the top-view
// freeze key whenever the overlay is showing.
const LEVER_KEYS = {
  KeyQ: 0b0100, KeyZ: 0b1000, KeyX: 0b1000,   // left tread fwd / back
  KeyP: 0b0001, Slash: 0b0010,                // right tread fwd / back
};

const heldKeys = new Set();
let touchBits = 0;

// touch control scheme: "dual" tread sliders or a floating 8-way "thumb" pad,
// with FIRE on the configured side (thumb pad sits on the opposite side)
let ctrl = { scheme: "dual", fireSide: "right" };
try { Object.assign(ctrl, JSON.parse(localStorage.getItem("bz.emu.ctrl") || "{}")); } catch {}
function applyCtrlScheme() {
  const thumb = ctrl.scheme === "thumb";
  document.getElementById("tread-left").style.visibility = thumb ? "hidden" : "";
  document.getElementById("tread-right").style.visibility = thumb ? "hidden" : "";
  document.getElementById("btn-fire").classList.toggle("left", ctrl.fireSide === "left");
  const sch = document.getElementById("ctrl-scheme");
  const sid = document.getElementById("ctrl-side");
  if (sch) sch.textContent = thumb ? "THUMB PAD" : "DUAL STICKS";
  if (sid) sid.textContent = ctrl.fireSide.toUpperCase();
  try { localStorage.setItem("bz.emu.ctrl", JSON.stringify(ctrl)); } catch {}
}

// Arrow/WASD combinations, chosen to land on the ROM's own MTAB routines.
// Held alone the arrows pivot in place; held with up/down they drive ONE
// tread, which is how the original steers while moving:
//   up+left   -> R-fwd  only = M.LTF (left turn forward)
//   up+right  -> L-fwd  only = M.RTF (right turn forward)
//   down+left -> L-back only = M.LTR (left turn reverse)
//   down+right-> R-back only = M.RTR (right turn reverse)
// so left always turns left and right always turns right, both ways.
function arrowBits() {
  let up = false, down = false, left = false, right = false;
  for (const k of heldKeys) {
    switch (DIR_KEYS[k]) {
      case "up": up = true; break;
      case "down": down = true; break;
      case "left": left = true; break;
      case "right": right = true; break;
    }
  }
  if (up && down) up = down = false;          // opposing keys cancel
  if (left && right) left = right = false;
  if (up && left) return 0b0001;
  if (up && right) return 0b0100;
  if (down && left) return 0b1000;
  if (down && right) return 0b0010;
  if (up) return 0b0101;                      // M.FF  both treads forward
  if (down) return 0b1010;                    // M.FR  both treads back
  if (left) return 0b1001;                    // M.PL  pivot left
  if (right) return 0b0110;                   // M.PR  pivot right
  return 0;
}

function updateMoveBits() {
  let bits = arrowBits() | touchBits;
  for (const k of heldKeys) {
    const lv = LEVER_KEYS[k];
    if (lv !== undefined) bits |= lv;
  }
  if (machine) machine.moveBits = bits;
}

addEventListener("keydown", (e) => {
  if (e.repeat || !machine) return;
  // Z freezes the map while the overlay is up; use X for the left tread there
  if (e.code === "KeyZ" && topView) { toggleFreeze(); syncTopBtn(); e.preventDefault(); return; }
  if (DIR_KEYS[e.code] !== undefined || LEVER_KEYS[e.code] !== undefined) {
    heldKeys.add(e.code); updateMoveBits(); e.preventDefault();
  }
  if (e.code === "Space") { machine.fire = true; e.preventDefault(); }
  if (e.code === "Enter" || e.code === "Digit1") machine.start = true;
  if (e.code === "KeyC") machine.insertCoin();
  if (e.code === "KeyF") togglePause();
  if (e.code === "KeyT") { topView = !topView; syncTopBtn(); }
  if (topView && (e.code === "Equal" || e.code === "NumpadAdd")) topZoom = Math.min(6, topZoom * 1.25);
  if (topView && (e.code === "Minus" || e.code === "NumpadSubtract")) topZoom = Math.max(0.25, topZoom / 1.25);
  if (topView && e.code === "BracketRight") topHalf = Math.min(340, topHalf + 20);
  if (topView && e.code === "BracketLeft") topHalf = Math.max(70, topHalf - 20);
});
addEventListener("keyup", (e) => {
  if (!machine) return;
  if (heldKeys.delete(e.code)) updateMoveBits();
  if (e.code === "Space") machine.fire = false;
  if (e.code === "Enter" || e.code === "Digit1") machine.start = false;
});

// on-screen buttons
function bindHold(id, down, up) {
  const el = document.getElementById(id);
  el.addEventListener("pointerdown", (e) => {
    down();
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}
bindHold("btn-start", () => machine && (machine.start = true), () => machine && (machine.start = false));
const fireEl = document.getElementById("btn-fire");
bindHold("btn-fire",
  () => { if (machine) machine.fire = true; fireEl.classList.add("lit"); },
  () => { if (machine) machine.fire = false; fireEl.classList.remove("lit"); });
document.getElementById("btn-coin").onclick = () => machine && machine.insertCoin();
document.getElementById("btn-pause").onclick = togglePause;
const speedSlider = document.getElementById("speed");
const speedVal = document.getElementById("speedval");
speedSlider.oninput = () => {
  speed = parseFloat(speedSlider.value);
  speedVal.textContent = speed.toFixed(2) + "x";
};
function togglePause() {
  running = !running;
  document.getElementById("btn-pause").textContent = running ? "❚❚" : "▶";
}
document.getElementById("btn-step").onclick = () => {
  if (!running && machine) {
    advance(Math.round(CPU_HZ / 250));                     // one NMI period
    paint(lastLines);
  }
};

const toneSlider = document.getElementById("tone");
const toneVal = document.getElementById("toneval");
sound.tone = parseFloat(toneSlider.value);
toneVal.textContent = sound.tone.toFixed(2) + "x";
toneSlider.oninput = () => {
  sound.tone = parseFloat(toneSlider.value);
  toneVal.textContent = sound.tone.toFixed(2) + "x";
};

// ---------------------------------------------------------- pointer router
// One set of canvas handlers covers: top-view widgets (+/-, grip, Z), panning
// the frozen map (mouse drag or two-finger drag), the floating thumb pad, and
// tap-anywhere-to-START.
const ptrs = new Map();     // pointerId -> {kind, x, y, x0, y0, t0}
let thumbId = null, thumbBase = null, thumbBits = 0;
const thumbBaseEl = document.getElementById("thumb-base");
const thumbKnobEl = document.getElementById("thumb-knob");

// 8-way thumb: angle -> the ROM's MTAB movement patterns (same as the arrows)
function thumbBitsFor(dx, dy) {
  if (Math.hypot(dx, dy) < 18) return 0;
  const deg = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360;
  const oct = Math.round(deg / 45) % 8;
  return [0b0110,          // 0   right      M.PR pivot right
          0b0100,          // 45  up-right   M.RTF (left tread fwd)
          0b0101,          // 90  up         M.FF  both fwd
          0b0001,          // 135 up-left    M.LTF (right tread fwd)
          0b1001,          // 180 left       M.PL  pivot left
          0b1000,          // 225 down-left  M.LTR (left tread back)
          0b1010,          // 270 down       M.FR  both back
          0b0010][oct];    // 315 down-right M.RTR (right tread back)
}
function setThumb(bits) {
  thumbBits = bits;
  touchBits = bits;         // feeds updateMoveBits alongside the tread sliders
  updateMoveBits();
}
function thumbSide() { return ctrl.fireSide === "right" ? "left" : "right"; }
function inThumbZone(x) {
  return thumbSide() === "left" ? x < innerWidth * 0.45 : x > innerWidth * 0.55;
}

// pan the (frozen) top-view by a screen-pixel delta
function panTopView(dsx, dsy) {
  if (!topFrozen) { toggleFreeze(); syncTopBtn(); }
  if (!topFrozen) return;
  const sPx = topHalf / (topRangeWu / topZoom);       // px per world unit
  const a = topFrozen.a;
  const A = Math.sin(a) * (-dsx / sPx) + Math.cos(a) * (dsy / sPx);
  const B = Math.cos(a) * (dsx / sPx) + Math.sin(a) * (dsy / sPx);
  topFrozen.x = ((topFrozen.x + A) % 65536 + 65536) % 65536;
  topFrozen.y = ((topFrozen.y + B) % 65536 + 65536) % 65536;
}

function panelTouches() {
  return [...ptrs.values()].filter(q => q.kind === "panelTouch");
}

function pulseStart() {
  if (!machine) return;
  machine.start = true;
  setTimeout(() => { if (machine) machine.start = false; }, 180);
}

canvas.addEventListener("pointerdown", (e) => {
  if (!machine) return;
  const rec = { kind: "tap", x: e.clientX, y: e.clientY,
                x0: e.clientX, y0: e.clientY, t0: performance.now() };
  const hit = topView ? hitTest(e.clientX, e.clientY, geom()) : null;
  if (hit === "plus") { topZoom = Math.min(6, topZoom * 1.25); rec.kind = "widget"; }
  else if (hit === "minus") { topZoom = Math.max(0.25, topZoom / 1.25); rec.kind = "widget"; }
  else if (hit === "zbtn") { toggleFreeze(); syncTopBtn(); rec.kind = "widget"; }
  else if (hit === "grip") rec.kind = "grip";
  else if (hit === "move") {
    const g = geom();
    topPos = { x: g.left, y: g.top };
    rec.kind = "move";
  }
  else if (hit === "panel") {
    // mouse drags pan directly; touches pan when two fingers are down
    rec.kind = e.pointerType === "mouse" ? "pan" : "panelTouch";
  } else if (e.pointerType !== "mouse" && ctrl.scheme === "thumb" && inThumbZone(e.clientX)) {
    rec.kind = "thumb";
    thumbId = e.pointerId;
    thumbBase = [e.clientX, e.clientY];
    thumbBaseEl.style.left = e.clientX + "px"; thumbBaseEl.style.top = e.clientY + "px";
    thumbKnobEl.style.left = e.clientX + "px"; thumbKnobEl.style.top = e.clientY + "px";
    thumbBaseEl.classList.remove("hidden"); thumbKnobEl.classList.remove("hidden");
    setThumb(0);
  }
  ptrs.set(e.pointerId, rec);
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
});

canvas.addEventListener("pointermove", (e) => {
  const q = ptrs.get(e.pointerId);
  if (!q) return;
  const dx = e.clientX - q.x, dy = e.clientY - q.y;
  if (q.kind === "tap" && Math.hypot(e.clientX - q.x0, e.clientY - q.y0) > 12) q.kind = "dead";
  if (q.kind === "grip") {
    const g = geom();
    const half = Math.max(e.clientX - g.left, e.clientY - g.top) / 2;
    topHalf = Math.max(70, Math.min(340, half));
  } else if (q.kind === "move") {
    // keep a grabbable strip on screen rather than forcing the whole panel
    // inside, so a panel larger than the window can still be dragged
    const w = topHalf * 2, keep = 90;
    topPos = {
      x: Math.max(keep - w, Math.min(innerWidth - keep, topPos.x + dx)),
      y: Math.max(0, Math.min(Math.max(0, innerHeight - 40), topPos.y + dy)),
    };
  } else if (q.kind === "pan") {
    panTopView(dx, dy);
  } else if (q.kind === "panelTouch") {
    q.x = e.clientX; q.y = e.clientY;
    const pts = panelTouches();
    if (pts.length >= 2) {
      // pan by the average motion of the two fingers (this one moved by dx,dy)
      panTopView(dx / 2, dy / 2);
    }
    return;                 // x/y already updated
  } else if (q.kind === "thumb" && e.pointerId === thumbId) {
    const tx = e.clientX - thumbBase[0], ty = e.clientY - thumbBase[1];
    const d = Math.hypot(tx, ty), max = 48;
    const k = d > max ? max / d : 1;
    thumbKnobEl.style.left = (thumbBase[0] + tx * k) + "px";
    thumbKnobEl.style.top = (thumbBase[1] + ty * k) + "px";
    setThumb(thumbBitsFor(tx, ty));
  }
  q.x = e.clientX; q.y = e.clientY;
});

for (const ev of ["pointerup", "pointercancel"]) {
  canvas.addEventListener(ev, (e) => {
    const q = ptrs.get(e.pointerId);
    ptrs.delete(e.pointerId);
    if (!q) return;
    if (q.kind === "thumb" || e.pointerId === thumbId) {
      thumbId = null;
      thumbBaseEl.classList.add("hidden"); thumbKnobEl.classList.add("hidden");
      setThumb(0);
    }
    // a short, stationary tap anywhere on the play area presses START --
    // handy on the iPad, where the word START is right there on the screen
    if ((q.kind === "tap" || (q.kind === "thumb" && thumbBits === 0)) &&
        ev === "pointerup" && performance.now() - q.t0 < 300 &&
        Math.hypot(e.clientX - q.x0, e.clientY - q.y0) < 12) {
      pulseStart();
    }
  });
}

// gear popover, hide/show of the whole control bar, control-scheme options
const gearPanel = document.getElementById("gearpanel");
document.getElementById("btn-gear").onclick = () =>
  gearPanel.classList.toggle("hidden");
const showUi = document.getElementById("show-ui");
document.getElementById("btn-hide").onclick = () => {
  document.getElementById("controls").style.display = "none";
  gearPanel.classList.add("hidden");
  const help = document.getElementById("help");
  if (help) help.style.display = "none";
  showUi.classList.remove("hidden");
  layoutTouchControls();
};
showUi.onclick = () => {
  document.getElementById("controls").style.display = "";
  const help = document.getElementById("help");
  if (help) help.style.display = "";
  showUi.classList.add("hidden");
  layoutTouchControls();
};
document.getElementById("ctrl-scheme").onclick = () => {
  ctrl.scheme = ctrl.scheme === "dual" ? "thumb" : "dual";
  applyCtrlScheme();
};
document.getElementById("ctrl-side").onclick = () => {
  ctrl.fireSide = ctrl.fireSide === "right" ? "left" : "right";
  applyCtrlScheme();
};
applyCtrlScheme();

// ---------------------------------------------------------------- trainer
// Everything below pokes emulated RAM from the outside, the way a cheat
// cartridge would. The ROM is never modified.
//   HSCTBL 0x300 (10 x 3 bytes, BCD score)   INITLS 0x31E (10 x 3 chars)
//   NOR2D3 0x2EC  missiles seen this game, starts at -1; TR7CHK gives super
//                 tanks once it reaches 5 -- i.e. after the 6th missile
//   R2D3FL 0xCB   -1 while the current enemy is a missile
//   STATE  0xC5   0x80 = attack     EXPOSZ+C/D 0x2E4/0x2E5 = missile altitude
//   SAUCER 0xDE   nonzero while the saucer is on the field (and warbling)
//   FIRECT+2 0x26 enemy shell timer, set to 0x7F the moment it fires
const AD = { HSCTBL: 0x300, INITLS: 0x31E, NOR2D3: 0x2EC, R2D3FL: 0xCB,
             STATE: 0xC5, EXPOSZ: 0x2D8, SAUCER: 0xDE, EFIRE: 0x26,
             ATRACT: 0xCE, TANGLE2: 0x2C, FTIMER: 0xD1, EIRNGE: 0xC9 };

let train = { superTanks: false, missilesOnly: false, saveScores: true };
try { Object.assign(train, JSON.parse(localStorage.getItem("bz.emu.train") || "{}")); } catch {}
function saveTrain() {
  try { localStorage.setItem("bz.emu.train", JSON.stringify(train)); } catch {}
  for (const [k, id] of [["superTanks","tr-super"],["missilesOnly","tr-missile"],
                         ["saveScores","tr-savescores"]]) {
    const el = document.getElementById(id);
    if (el) { el.textContent = train[k] ? "ON" : "OFF";
              el.style.opacity = train[k] ? "1" : "0.55"; }
  }
}

// --- high scores kept in localStorage and injected back into RAM ---
function readScores() {
  if (!machine) return null;
  return { s: [...machine.ram.slice(AD.HSCTBL, AD.HSCTBL + 30)],
           i: [...machine.ram.slice(AD.INITLS, AD.INITLS + 30)] };
}
function writeScores(o) {
  if (!machine || !o || !o.s || o.s.length !== 30) return;
  machine.ram.set(Uint8Array.from(o.s), AD.HSCTBL);
  machine.ram.set(Uint8Array.from(o.i), AD.INITLS);
}
function persistScores() {
  const o = readScores();
  if (o) try { localStorage.setItem("bz.emu.scores", JSON.stringify(o)); } catch {}
}
function clearScores() {
  try { localStorage.removeItem("bz.emu.scores"); } catch {}
  // restore the ROM's own defaults: ten entries of 5000, blank-ish initials
  if (machine) {
    for (let i = 0; i < 10; i++) {
      machine.ram[AD.HSCTBL + i*3] = 0x05;
      machine.ram[AD.HSCTBL + i*3 + 1] = 0x00;
      machine.ram[AD.HSCTBL + i*3 + 2] = 0x00;
    }
  }
}
let scoresInjected = false, scoreSaveTimer = 0;

// --- per-frame trainer poke, called once per rendered frame ---
let prevEnemyFire = 0, lastEnemyShotAt = -99, prevSaucer = 0;
function trainerTick(dtSec) {
  if (!machine) return;
  const r = machine.ram;
  // inject saved high scores once the ROM has finished its own table setup
  if (!scoresInjected && machine.cpu.cycles > CPU_HZ * 2) {
    scoresInjected = true;
    if (train.saveScores) {
      try { const o = JSON.parse(localStorage.getItem("bz.emu.scores") || "null");
            if (o) writeScores(o); } catch {}
    }
  }
  if (train.saveScores && scoresInjected) {
    scoreSaveTimer += dtSec;
    if (scoreSaveTimer > 3) { scoreSaveTimer = 0; persistScores(); }
  }
  const inGame = r[AD.ATRACT] === 0xFF;
  if (inGame) {
    // skip straight to super tanks: TR7CHK wants NOR2D3 >= 5
    if (train.superTanks && r[AD.NOR2D3] !== 0xFF && r[AD.NOR2D3] < 5) r[AD.NOR2D3] = 5;
    if (train.superTanks && r[AD.NOR2D3] === 0xFF) r[AD.NOR2D3] = 5;
    // Missiles only: whenever the live enemy is a tank, replace it with a
    // missile by replicating R2D3CK's ENTIRE spawn, not just the flags.
    //
    // An earlier version converted the tank in place, keeping its position and
    // its old goal angle. BUZBOM slews RGOAL toward the player at only +/-2
    // angle units per 64 ms tick, so a missile born sideways-on flew huge arcs
    // and circles -- behaviour the real game never shows, because R2D3CK
    // always spawns missiles IN FRONT of the player, already aimed at them.
    // Measured from a genuine spawn: distance exactly 24576 (0.75 x 32768),
    // bearing = player heading +/- (rand & 0x0F), TANGLE+2 = RGOAL = bearing
    // back to the player, altitude STARTZ = 0x1800.
    if (train.missilesOnly && !(r[AD.R2D3FL] & 0x80) && r[0x14] === 0) {
      const w16 = a => r[a] | (r[a + 1] << 8);
      const px = w16(0x2D), py = w16(0x31);
      const off = Math.floor(Math.random() * 16) * (Math.random() < 0.5 ? 1 : -1);
      const ang = (r[0x2A] + off + 256) & 0xFF;          // spawn bearing (game units)
      const rad = ang * Math.PI / 128;
      const ex = (px + Math.round(24576 * Math.cos(rad)) + 65536) & 0xFFFF;
      const ey = (py + Math.round(24576 * Math.sin(rad)) + 65536) & 0xFFFF;
      r[0x2F] = ex & 0xFF; r[0x30] = ex >> 8;            // TPOSX+2
      r[0x33] = ey & 0xFF; r[0x34] = ey >> 8;            // TPOSY+2
      const back = (ang + 128) & 0xFF;                   // bearing to player
      r[AD.TANGLE2] = back;                              // TANGLE+2
      r[0xBC] = back;                                    // RGOAL
      r[AD.R2D3FL] = 0xFF;
      r[AD.STATE] = 0x80;
      r[AD.EXPOSZ + 0x0C] = 0x00;                        // STARTZ = 0x1800
      r[AD.EXPOSZ + 0x0D] = 0x18;
      r[AD.FTIMER] = 0; r[AD.EIRNGE] = 0;
      r[0xCA] = 0;                                       // OBJCOL+2 (hop latch)
      r[AD.NOR2D3] = (r[AD.NOR2D3] + 1) & 0xFF;          // INC NOR2D3, as R2D3CK
      // the missile whine: R2D3CK writes POKEY CHAN3F/CHAN4F
      machine.writeByte(0x1824, 0xFF);
      machine.writeByte(0x1826, 0xFE);
    }
  }
  // cues for playing muted
  const ef = r[AD.EFIRE];
  if (ef !== 0 && prevEnemyFire === 0) lastEnemyShotAt = performance.now();
  prevEnemyFire = ef;
  prevSaucer = r[AD.SAUCER];
}

// --- missile track readout ---
// BUZBOM's weave: heading = RGOAL +/- (FRAME & 0x1F), sign from FRAME bit 3,
// active only while TDIST exceeds a score-shrinking threshold, and never for
// the first missile (NOR2D3 == 0). The "track" is the frame-counter phase
// (0-31) at the moment weave mode begins -- that phase is what makes one
// approach look different from another.
let mslTrack = null, mslWasWeaving = false;
function missileInfo() {
  const r = machine.ram;
  if (!(r[AD.R2D3FL] & 0x80) || r[0x14] !== 0) { mslTrack = null; mslWasWeaving = false; return null; }
  const frame = r[0xC6], tdist = r[0x2E8], nor = r[AD.NOR2D3];
  const first = nor === 0;
  // threshold, as the ROM computes it (BCD add, clamped to a floor of 8)
  let thr = 8;
  if (!first && r[0xB9] === 0) {
    const mis = [0x05, 0x10, 0x20, 0x30][(machine.dsw0 >> 2) & 3];
    const bcdAdd = (a, b) => { let lo = (a & 15) + (b & 15), hi = (a >> 4) + (b >> 4);
      if (lo > 9) { lo -= 10; hi++; } return ((hi % 10) << 4) | lo; };
    const t = bcdAdd(mis, 0x25) - r[0xB8];
    thr = (t < 8) ? 8 : t;
  }
  const weaving = !first && tdist > thr;
  if (weaving && !mslWasWeaving) mslTrack = frame & 0x1F;   // phase at weave entry
  mslWasWeaving = weaving;
  const off = frame & 0x1F;
  const sign = (frame & 0x08) ? -1 : 1;
  return { first, weaving, off: sign * off, track: mslTrack, tdist, thr };
}

// --- on-screen cues so a muted game still tells you what the audio would ---
function drawMuteCues(c) {
  if (!machine) return;
  const r = machine.ram;
  const x = innerWidth - 46, y = innerHeight - 150;
  // missile track readout, bottom centre
  const mi = missileInfo();
  if (mi) {
    c.save();
    c.fillStyle = "rgba(255,150,80,0.9)";
    c.font = "12px 'Courier New', monospace";
    c.textAlign = "center";
    const label = mi.first ? "MISSILE 1 · STRAIGHT"
      : mi.weaving ? "MISSILE · TRACK " + mi.track + " · WEAVE " + (mi.off >= 0 ? "+" : "") + mi.off
      : "MISSILE · TRACK " + (mi.track ?? "-") + " · TERMINAL";
    // sit just above the toolbar (or near the bottom when the bar is hidden)
    const bar = document.getElementById("controls");
    const help = document.getElementById("help");
    let yTxt = innerHeight - 14;
    if (bar && bar.style.display !== "none") yTxt = bar.getBoundingClientRect().top - 10;
    if (help && help.style.display !== "none" && getComputedStyle(help).display !== "none") {
      yTxt = Math.min(yTxt, help.getBoundingClientRect().top - 8);
    }
    c.fillText(label, innerWidth / 2, yTxt);
    c.textAlign = "left";
    c.restore();
  }
  if (r[AD.SAUCER]) {                       // saucer on the field = warble
    c.save();
    c.strokeStyle = "rgba(120,200,255,0.95)"; c.lineWidth = 2;
    c.beginPath(); c.ellipse(x, y, 16, 6, 0, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.ellipse(x, y - 5, 8, 5, 0, Math.PI, Math.PI * 2); c.stroke();
    c.restore();
  }
  if (performance.now() - lastEnemyShotAt < 1000) {   // enemy fired, 1 s cue
    const y2 = y + 44;
    c.save();
    c.globalAlpha = 1 - (performance.now() - lastEnemyShotAt) / 1000;
    c.strokeStyle = "rgba(255,80,60,1)"; c.lineWidth = 2.5;
    c.beginPath();
    c.moveTo(x - 14, y2); c.lineTo(x + 8, y2);
    c.moveTo(x + 8, y2); c.lineTo(x + 1, y2 - 6);
    c.moveTo(x + 8, y2); c.lineTo(x + 1, y2 + 6);
    c.stroke();
    c.restore();
  }
}

// ---- cabinet DIP switches (the OPTION bank at 0x0A00) ----
// dsw0 = (lives-2) | missileIdx<<2 | bonusIdx<<4 | langIdx<<6
const DIP_CHOICES = {
  lives:   { labels: ["2", "3", "4", "5"], def: 1 },
  missile: { labels: ["5000", "10000", "20000", "30000"], def: 0 },
  bonus:   { labels: ["NONE", "15000 + 100K", "25000 + 100K", "50000 + 100K"], def: 1 },
  lang:    { labels: ["ENGLISH", "GERMAN", "FRENCH", "SPANISH"], def: 0 },
};
let dips = { lives: 1, missile: 0, bonus: 1, lang: 0 };
try { Object.assign(dips, JSON.parse(localStorage.getItem("bz.emu.dips") || "{}")); } catch {}
function applyDips() {
  if (machine) {
    machine.dsw0 = (dips.lives & 3) | ((dips.missile & 3) << 2) |
                   ((dips.bonus & 3) << 4) | ((dips.lang & 3) << 6);
  }
  for (const k of Object.keys(DIP_CHOICES)) {
    const el = document.getElementById("dip-" + k);
    if (el) el.textContent = DIP_CHOICES[k].labels[dips[k] & 3];
  }
  try { localStorage.setItem("bz.emu.dips", JSON.stringify(dips)); } catch {}
}
for (const k of Object.keys(DIP_CHOICES)) {
  const el = document.getElementById("dip-" + k);
  if (el) el.onclick = () => { dips[k] = (dips[k] + 1) & 3; applyDips(); };
}
applyDips();

// ---- volume group sliders ----
for (const [id, key] of [["vol-engine","volEngine"],["vol-shots","volShots"],["vol-other","volOther"]]) {
  const el = document.getElementById(id), lab = document.getElementById(id + "-v");
  if (!el) continue;
  const saved = parseFloat(localStorage.getItem("bz.emu." + key) || "1");
  el.value = saved; sound[key] = saved; lab.textContent = saved.toFixed(2);
  el.oninput = () => {
    const v = parseFloat(el.value);
    sound[key] = v; lab.textContent = v.toFixed(2);
    try { localStorage.setItem("bz.emu." + key, String(v)); } catch {}
  };
}

// ---- training options + high score persistence ----
document.getElementById("tr-super").onclick = () => {
  train.superTanks = !train.superTanks; saveTrain();
};
document.getElementById("tr-missile").onclick = () => {
  train.missilesOnly = !train.missilesOnly; saveTrain();
};
document.getElementById("tr-savescores").onclick = () => {
  train.saveScores = !train.saveScores;
  if (!train.saveScores) { try { localStorage.removeItem("bz.emu.scores"); } catch {} }
  saveTrain();
};
document.getElementById("tr-clearscores").onclick = () => clearScores();
saveTrain();

const btnTop = document.getElementById("btn-top");
const btnFreeze = document.getElementById("btn-freeze");
function syncTopBtn() {
  btnTop.style.opacity = topView ? "1" : "0.55";
  btnFreeze.classList.toggle("hidden", !topView);
  btnFreeze.style.opacity = topFrozen ? "1" : "0.55";
}
btnTop.onclick = () => { topView = !topView; if (!topView) topFrozen = null; syncTopBtn(); };
btnFreeze.onclick = () => { toggleFreeze(); syncTopBtn(); };
syncTopBtn();

// Sound is on by default, but a browser will not start an AudioContext until
// the page has seen a real user gesture -- so arm it now and unlock on the
// first click/tap/keypress, rather than making the user find the button.
const btnSound = document.getElementById("btn-sound");
let soundWanted = true;
function syncSoundBtn() {
  btnSound.textContent = soundWanted ? "MUTE" : "SOUND";
  btnSound.style.opacity = soundWanted ? "1" : "0.55";
}
btnSound.onclick = () => {
  soundWanted = !soundWanted;
  if (soundWanted) sound.enable(); else sound.disable();
  syncSoundBtn();
};
syncSoundBtn();
function unlockAudio() {
  if (soundWanted) sound.enable();
  removeEventListener("pointerdown", unlockAudio, true);
  removeEventListener("keydown", unlockAudio, true);
}
addEventListener("pointerdown", unlockAudio, true);
addEventListener("keydown", unlockAudio, true);

// touch tread sliders (twin sticks) for iPad
const touchState = { left: 0, right: 0 };
function applyTouch() {
  let bits = 0;
  if (touchState.left > 0.3) bits |= 0b0100;
  if (touchState.left < -0.3) bits |= 0b1000;
  if (touchState.right > 0.3) bits |= 0b0001;
  if (touchState.right < -0.3) bits |= 0b0010;
  touchBits = bits;
  updateMoveBits();
}
for (const side of ["left", "right"]) {
  const el = document.getElementById("tread-" + side);
  const knob = el.querySelector(".knob");
  let base = null;
  const setKnob = () => {
    knob.style.transform = "translateY(" + (-touchState[side] * 58) + "px)";
  };
  el.addEventListener("pointerdown", (e) => {
    base = e.clientY;
    try { el.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (base === null) return;
    touchState[side] = Math.max(-1, Math.min(1, (base - e.clientY) / 70));
    setKnob();
    applyTouch();
  });
  const end = () => { base = null; touchState[side] = 0; setKnob(); applyTouch(); };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

// ---------------------------------------------------------------- loop
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (machine && running) { advance(Math.round(CPU_HZ * dt * speed), dt); trainerTick(dt); }
  paint(lastLines);
}

loadRoms().then(roms => {
  machine = new Machine(roms);
  applyDips();                        // cabinet DIP switches from saved settings
  window.EMU = machine;               // debug handle
  // headless driving/rendering hooks (used for testing and measurement)
  window.EMUDBG = {
    run: (cycles) => advance(cycles),
    paint: () => paint(lastLines),
    lines: () => lastLines,
    sound,
    topState: () => ({ topView, topZoom, topHalf, pos: topPos, frozen: topFrozen }),
    tick: (dt) => trainerTick(dt),
    train: () => train,
  };
  statusEl.textContent = "";
  requestAnimationFrame(frame);
}).catch(err => {
  statusEl.textContent = "ROM load failed: " + err.message;
});
