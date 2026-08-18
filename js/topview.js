// Top-down overlay for the emulator.
//
// Strictly READ-ONLY: it peeks at emulated zero-page RAM and draws on top of
// the vector display. It never writes memory, never advances the CPU, and is
// not visible to the game -- the emulation runs identically with it on or off.
//
// Zero-page addresses derived from the .BSECT layout in BZONE.MAC:
//   0x2A TANGLE  player angle        0x2C TANGLE+2 enemy angle
//   0x2D TPOSX   player X (16-bit)   0x2F TPOSX+2  enemy X
//   0x31 TPOSY   player Y            0x33 TPOSY+2  enemy Y
//   0xA8 SHELLX  player/enemy shell X pair, 0xAC SHELLY
//   0xCB R2D3FL  missile active      0xD5/0xD7 SAPOSX/SAPOSY, 0xDE SAUCER
import { OBSTACLES } from "./playfield.js";

const A = {
  TANGLE: 0x2A, ETANGLE: 0x2C,
  TPOSX: 0x2D, TPOSY: 0x31,
  SHELLX: 0xA8, SHELLY: 0xAC,
  FIRECT: 0x24, R2D3FL: 0xCB, ECOLFLG: 0x14,
  SAPOSX: 0xD5, SAPOSY: 0xD7, SAUCER: 0xDE,
};
const WORLD = 65536;

const topZoomLabel = (rangeWu) => Math.round(rangeWu / 256) + "u";
const w16 = (ram, a) => ram[a] | (ram[a + 1] << 8);
function wdelta(a, b) {
  let d = (b - a) % WORLD;
  if (d > WORLD / 2) d -= WORLD;
  if (d < -WORLD / 2) d += WORLD;
  return d;
}

export function readState(machine) {
  const r = machine.ram;
  return {
    px: w16(r, A.TPOSX), py: w16(r, A.TPOSY),
    pa: r[A.TANGLE] * Math.PI * 2 / 256,
    ex: w16(r, A.TPOSX + 2), ey: w16(r, A.TPOSY + 2),
    ea: r[A.ETANGLE] * Math.PI * 2 / 256,
    isMissile: !!(r[A.R2D3FL] & 0x80),
    edead: r[A.ECOLFLG] !== 0,          // COLFLG+2: nonzero while blowing up
    shells: [
      { x: w16(r, A.SHELLX), y: w16(r, A.SHELLY), live: r[A.FIRECT] !== 0 },
      { x: w16(r, A.SHELLX + 2), y: w16(r, A.SHELLY + 2), live: true },
    ],
    saucer: r[A.SAUCER] ? { x: w16(r, A.SAPOSX), y: w16(r, A.SAPOSY) } : null,
  };
}

// Panel rectangle, anchored to the bottom-left of the window.
export function panelGeom(half) {
  const cx = 14 + half, cy = innerHeight - 62 - half;
  return { cx, cy, half,
           left: cx - half, right: cx + half, top: cy - half, bottom: cy + half };
}

// Clickable widgets: zoom buttons at the panel's top-left, resize grip at the
// top-right (the panel is anchored bottom-left, so dragging up/right grows it).
export const BTN = 20;
export function hitTest(x, y, g) {
  const B = BTN;
  if (y >= g.top + 4 && y <= g.top + 4 + B) {
    if (x >= g.left + 4 && x <= g.left + 4 + B) return "minus";
    if (x >= g.left + 8 + B && x <= g.left + 8 + 2 * B) return "plus";
  }
  if (Math.abs(x - g.right) < 18 && Math.abs(y - g.top) < 18) return "grip";
  if (x >= g.right - B - 4 && x <= g.right - 4 &&
      y >= g.bottom - B - 4 && y <= g.bottom - 4) return "zbtn";
  if (x >= g.left && x <= g.right && y >= g.top && y <= g.bottom) return "panel";
  return null;
}

// Draw into a 2-D context already set to CSS-pixel space (y down).
// `origin` (optional) freezes the map to a world frame; when omitted the map
// is centred on the player and rotated so their facing points up.
export function drawTopView(ctx, st, opts) {
  const { half, rangeWu, fovDeg, origin } = opts;
  const g = panelGeom(half);
  const { cx, cy } = g;
  const s = half / rangeWu;
  const o = origin || { x: st.px, y: st.py, a: st.pa };
  const cos = Math.cos(o.a), sin = Math.sin(o.a);
  // world -> panel. Frame axes: x = forward, y = left.
  // forward maps up the screen (-y), left maps to -x.
  const map = (wx, wy) => {
    const dx = wdelta(o.x, wx), dy = wdelta(o.y, wy);
    const fx = dx * cos + dy * sin;
    const fy = -dx * sin + dy * cos;
    return [cx - fy * s, cy - fx * s];
  };
  const inside = (p, m = 0) =>
    p[0] > g.left + m && p[0] < g.right - m && p[1] > g.top + m && p[1] < g.bottom - m;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.fillRect(g.left, g.top, half * 2, half * 2);
  ctx.strokeStyle = origin ? "rgba(255,200,60,0.9)" : "rgba(32,255,64,0.85)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(g.left, g.top, half * 2, half * 2);

  // --- obstacles ---
  ctx.strokeStyle = "rgba(32,255,64,0.75)";
  ctx.lineWidth = 1.2;
  for (const ob of OBSTACLES) {
    const p = map(ob.x, ob.y);
    if (!inside(p, 3)) continue;
    const r = (ob.t === "tallPyramid" || ob.t === "cube") ? 6 : 5;
    ctx.beginPath();
    if (ob.t === "cube" || ob.t === "shortBox") {
      ctx.rect(p[0] - r, p[1] - r, r * 2, r * 2);
    } else {
      ctx.moveTo(p[0], p[1] - r); ctx.lineTo(p[0] + r, p[1] + r);
      ctx.lineTo(p[0] - r, p[1] + r); ctx.closePath();
    }
    ctx.stroke();
  }

  // --- player: filled triangle + FOV wedge, at its mapped position ---
  const pp = map(st.px, st.py);
  const prel = st.pa - o.a;
  // unit direction vectors in panel space
  const fwd = [-Math.sin(prel), -Math.cos(prel)];
  const lft = [-Math.cos(prel), Math.sin(prel)];
  const at = (d, k) => [pp[0] + d[0] * k, pp[1] + d[1] * k];

  if (inside(pp, -half)) {          // draw even if slightly clipped
    const hf = (fovDeg / 2) * Math.PI / 180;
    const L = half * 0.95;
    ctx.strokeStyle = "rgba(32,255,64,0.32)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const sgn of [-1, 1]) {
      const a = prel + sgn * hf;
      ctx.moveTo(pp[0], pp[1]);
      ctx.lineTo(pp[0] - Math.sin(a) * L, pp[1] - Math.cos(a) * L);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(32,255,64,0.18)";
    ctx.beginPath();
    ctx.moveTo(pp[0], pp[1]);
    const c = at(fwd, L);
    ctx.lineTo(c[0], c[1]);
    ctx.stroke();

    const tip = at(fwd, 11);
    const bl = [pp[0] - fwd[0] * 6 + lft[0] * 7, pp[1] - fwd[1] * 6 + lft[1] * 7];
    const br = [pp[0] - fwd[0] * 6 - lft[0] * 7, pp[1] - fwd[1] * 6 - lft[1] * 7];
    ctx.beginPath();
    ctx.moveTo(tip[0], tip[1]); ctx.lineTo(bl[0], bl[1]); ctx.lineTo(br[0], br[1]);
    ctx.closePath();
    ctx.fillStyle = "rgba(32,255,64,0.85)";
    ctx.fill();
    ctx.strokeStyle = "rgba(180,255,190,1)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // --- enemy: red wedge oriented by its heading; hidden the moment it dies
  // (COLFLG+2 goes nonzero at the hit, well before the debris clears) ---
  const ep = map(st.ex, st.ey);
  if (!st.edead && inside(ep, 3)) {
    const erel = st.ea - o.a;
    const efwd = [-Math.sin(erel), -Math.cos(erel)];
    const elft = [-Math.cos(erel), Math.sin(erel)];
    if (st.isMissile) {
      ctx.strokeStyle = "rgba(255,120,60,0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ep[0] - 5, ep[1] - 5); ctx.lineTo(ep[0] + 5, ep[1] + 5);
      ctx.moveTo(ep[0] - 5, ep[1] + 5); ctx.lineTo(ep[0] + 5, ep[1] - 5);
      ctx.stroke();
    } else {
      const tip = [ep[0] + efwd[0] * 10, ep[1] + efwd[1] * 10];
      const bl = [ep[0] - efwd[0] * 5 + elft[0] * 6, ep[1] - efwd[1] * 5 + elft[1] * 6];
      const br = [ep[0] - efwd[0] * 5 - elft[0] * 6, ep[1] - efwd[1] * 5 - elft[1] * 6];
      ctx.beginPath();
      ctx.moveTo(tip[0], tip[1]); ctx.lineTo(bl[0], bl[1]); ctx.lineTo(br[0], br[1]);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,60,60,0.8)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,150,150,1)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  // --- saucer ---
  if (st.saucer) {
    const sp = map(st.saucer.x, st.saucer.y);
    if (inside(sp, 3)) {
      ctx.strokeStyle = "rgba(120,200,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sp[0], sp[1] - 5); ctx.lineTo(sp[0] + 5, sp[1]);
      ctx.lineTo(sp[0], sp[1] + 5); ctx.lineTo(sp[0] - 5, sp[1]);
      ctx.closePath(); ctx.stroke();
    }
  }

  // --- shells ---
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  for (const sh of st.shells) {
    if (!sh.live) continue;
    const p = map(sh.x, sh.y);
    if (!inside(p, 2)) continue;
    ctx.beginPath(); ctx.arc(p[0], p[1], 2, 0, Math.PI * 2); ctx.fill();
  }

  // --- widgets: zoom buttons (top-left) + resize grip (top-right) ---
  const B = BTN;
  const btn = (x, label) => {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x, g.top + 4, B, B);
    ctx.strokeStyle = "rgba(32,255,64,0.7)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, g.top + 4, B, B);
    ctx.fillStyle = "rgba(32,255,64,0.9)";
    ctx.font = "15px 'Courier New', monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, x + B / 2, g.top + 4 + B / 2 + 1);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  };
  btn(g.left + 4, "−");
  btn(g.left + 8 + B, "+");
  ctx.strokeStyle = "rgba(32,255,64,0.7)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(g.right - 14, g.top); ctx.lineTo(g.right, g.top + 14);
  ctx.moveTo(g.right - 7, g.top); ctx.lineTo(g.right, g.top + 7);
  ctx.stroke();

  // freeze toggle button (bottom-right): replicates the Z key
  {
    const zx = g.right - B - 4, zy = g.bottom - B - 4;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(zx, zy, B, B);
    ctx.strokeStyle = origin ? "rgba(255,200,60,0.95)" : "rgba(32,255,64,0.7)";
    ctx.lineWidth = 1;
    ctx.strokeRect(zx, zy, B, B);
    ctx.fillStyle = origin ? "rgba(255,200,60,0.95)" : "rgba(32,255,64,0.9)";
    ctx.font = "13px 'Courier New', monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("Z", zx + B / 2, zy + B / 2 + 1);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  }

  ctx.fillStyle = origin ? "rgba(255,200,60,0.95)" : "rgba(32,255,64,0.65)";
  ctx.font = "10px 'Courier New', monospace";
  ctx.fillText(origin ? "FROZEN (Z)" : "TOP VIEW  " + (topZoomLabel(rangeWu)),
               g.left + 5, g.bottom - 6);
  ctx.restore();
}
