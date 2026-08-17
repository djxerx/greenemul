// BATTLEZONE EMULATOR -- boots the original 1980 ROMs.
// Reference tool for tuning the remake (../battlezone-remake), not the main game.
import { Machine, CPU_HZ } from "./machine.js";

const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");

let machine = null;
let running = true;
let speed = 1.0;
let lastLines = [];

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
        ctx.moveTo(l.x1, l.y1);
        ctx.lineTo(l.x2, l.y2);
      }
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- input
// moveBits: bit0 R-fwd, bit1 R-back, bit2 L-fwd, bit3 L-back
const KEYMAP = () => ({
  // combined driving on arrows/WASD
  ArrowUp: 0b0101, KeyW: 0b0101,       // both forward
  ArrowDown: 0b1010, KeyS: 0b1010,     // both back
  ArrowLeft: 0b0110, KeyA: 0b0110,     // pivot left: L-back + R-fwd? (see note)
  ArrowRight: 0b1001, KeyD: 0b1001,
  // direct tread levers (authentic)
  KeyQ: 0b0100, KeyZ: 0b1000,          // left tread fwd/back
  KeyP: 0b0001, Slash: 0b0010,         // right tread fwd/back
});
let heldMoves = new Map();

function updateMoveBits() {
  let bits = 0;
  for (const b of heldMoves.values()) bits |= b;
  if (machine) machine.moveBits = bits;
}

addEventListener("keydown", (e) => {
  if (e.repeat || !machine) return;
  const m = KEYMAP()[e.code];
  if (m !== undefined) { heldMoves.set(e.code, m); updateMoveBits(); e.preventDefault(); }
  if (e.code === "Space") { machine.fire = true; e.preventDefault(); }
  if (e.code === "Enter" || e.code === "Digit1") machine.start = true;
  if (e.code === "KeyC") machine.insertCoin();
  if (e.code === "KeyF") togglePause();
});
addEventListener("keyup", (e) => {
  if (!machine) return;
  if (heldMoves.delete(e.code)) updateMoveBits();
  if (e.code === "Space") machine.fire = false;
  if (e.code === "Enter" || e.code === "Digit1") machine.start = false;
});

// on-screen buttons
function bindHold(id, down, up) {
  const el = document.getElementById(id);
  el.addEventListener("pointerdown", (e) => { down(); el.setPointerCapture(e.pointerId); });
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}
bindHold("btn-start", () => machine && (machine.start = true), () => machine && (machine.start = false));
bindHold("btn-fire", () => machine && (machine.fire = true), () => machine && (machine.fire = false));
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
    const frame = machine.run(Math.round(CPU_HZ / 250));   // one NMI period
    if (frame) lastLines = frame;
    paint(lastLines);
  }
};

// touch tread sliders (twin sticks) for iPad
const touchState = { left: 0, right: 0 };
function touchBits() {
  let bits = 0;
  if (touchState.left > 0.3) bits |= 0b0100;
  if (touchState.left < -0.3) bits |= 0b1000;
  if (touchState.right > 0.3) bits |= 0b0001;
  if (touchState.right < -0.3) bits |= 0b0010;
  heldMoves.set("__touch", bits);
  updateMoveBits();
}
for (const side of ["left", "right"]) {
  const el = document.getElementById("tread-" + side);
  let base = null;
  el.addEventListener("pointerdown", (e) => {
    base = e.clientY;
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener("pointermove", (e) => {
    if (base === null) return;
    touchState[side] = Math.max(-1, Math.min(1, (base - e.clientY) / 70));
    touchBits();
  });
  const end = () => { base = null; touchState[side] = 0; touchBits(); };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

// ---------------------------------------------------------------- loop
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (machine && running) {
    const f = machine.run(Math.round(CPU_HZ * dt * speed));
    if (f) lastLines = f;
  }
  paint(lastLines);
}

loadRoms().then(roms => {
  machine = new Machine(roms);
  window.EMU = machine;               // debug handle
  statusEl.textContent = "";
  requestAnimationFrame(frame);
}).catch(err => {
  statusEl.textContent = "ROM load failed: " + err.message;
});
