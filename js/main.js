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

// advance the machine and feed the audio renderer in one place
function advance(cycles) {
  const f = machine.run(cycles);
  sound.pump(cycles, machine.audioEvents);
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
      origin: topFrozen,
    });
  }
}

let topView = false, topZoom = 1, topHalf = 110;
let topFrozen = null;              // {x,y,a} world frame when the map is frozen
const topRangeWu = 20000;

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
toneSlider.oninput = () => {
  sound.tone = parseFloat(toneSlider.value);
  toneVal.textContent = sound.tone.toFixed(2) + "x";
};

// overlay widgets: click +/- to zoom, drag the top-right grip to resize
let gripDrag = null;
canvas.addEventListener("pointerdown", (e) => {
  if (!topView || !machine) return;
  const hit = hitTest(e.clientX, e.clientY, panelGeom(topHalf));
  if (!hit) return;
  e.preventDefault();
  if (hit === "plus") topZoom = Math.min(6, topZoom * 1.25);
  else if (hit === "minus") topZoom = Math.max(0.25, topZoom / 1.25);
  else if (hit === "grip") {
    gripDrag = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch {}
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (gripDrag !== e.pointerId) return;
  // anchored bottom-left at (14, innerHeight-62): grow with x, or upward with y
  const bottom = innerHeight - 62;
  const half = Math.max((e.clientX - 14) / 2, (bottom - e.clientY) / 2);
  topHalf = Math.max(70, Math.min(340, half));
});
for (const ev of ["pointerup", "pointercancel"]) {
  canvas.addEventListener(ev, (e) => { if (gripDrag === e.pointerId) gripDrag = null; });
}

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

const btnSound = document.getElementById("btn-sound");
btnSound.onclick = () => {
  if (sound.enabled) { sound.disable(); btnSound.textContent = "SOUND"; }
  else { sound.enable(); btnSound.textContent = "MUTE"; }
};

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
  if (machine && running) advance(Math.round(CPU_HZ * dt * speed));
  paint(lastLines);
}

loadRoms().then(roms => {
  machine = new Machine(roms);
  window.EMU = machine;               // debug handle
  // headless driving/rendering hooks (used for testing and measurement)
  window.EMUDBG = {
    run: (cycles) => advance(cycles),
    paint: () => paint(lastLines),
    lines: () => lastLines,
    sound,
    topState: () => ({ topView, topZoom, topHalf, frozen: topFrozen }),
  };
  statusEl.textContent = "";
  requestAnimationFrame(frame);
}).catch(err => {
  statusEl.textContent = "ROM load failed: " + err.message;
});
