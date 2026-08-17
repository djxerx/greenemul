// Analog Vector Generator interpreter.  Instruction encodings match the
// VGMC.MAC macros exactly (words little-endian at 0x2000 + wordaddr*2):
//   000x VCTR:  w1 = dy (13-bit 2's comp), w2 = intensity<<13 | dx
//   001x HALT
//   010x SVEC:  short vector: dy in bits 8-12 (5-bit 2's comp, x2),
//               intensity bits 5-7, dx bits 0-4 (5-bit 2's comp, x2)
//   0110 STAT:  bit10=1: set intensity only; bit10=0: window op
//               (bit9 hi/low corner, bit8 in/out) -- intensity bits 4-7
//   0111 SCAL:  binary scale bits 8-10, linear scale bits 0-7
//   100x CNTR
//   101x JSRL   (12-bit word address, 5-level stack)
//   110x RTSL
//   111x JMPL
// Produces a line list [{x1,y1,x2,y2,z}] in beam coords (0-1023 x 0-767, y up).
export class AVG {
  constructor(readWord) {
    this.readWord = readWord;      // (wordAddr 0..0xFFF) -> 16-bit
    this.lines = [];
    this.halted = true;
  }

  run() {
    this.lines = [];
    let pc = 0;                    // word address; GO always starts at 0x2000
    const stack = [];
    let x = 512, y = 384;          // beam
    let statZ = 0;
    let bscale = 0, lscale = 0;
    // clip window state: two corners + in/out mode
    let winX0 = -1e9, winY0 = -1e9, winX1 = 1e9, winY1 = 1e9, winOut = false;
    let winActive = false;

    const sext = (v, bits) => (v & (1 << (bits - 1))) ? v - (1 << bits) : v;
    // deltas land on the screen at 2x the naive binary scale: the game runs
    // at SCAL 1 ("half") yet fills the display -- e.g. the radar ring center
    // at game y=316 sits at beam y=632 of 768, the very top, as on hardware
    const scale = () => Math.pow(2, 1 - bscale) * (256 - lscale) / 256;

    const emit = (nx, ny, z) => {
      if (z > 0) {
        if (!winActive) {
          this.lines.push({ x1: x, y1: y, x2: nx, y2: ny, z });
        } else {
          clipEmit(this.lines, x, y, nx, ny, z,
                   winX0, winY0, winX1, winY1, winOut);
        }
      }
      x = nx; y = ny;
    };

    for (let guard = 0; guard < 32768; guard++) {
      const w = this.readWord(pc);
      const op = w >> 13;
      pc = (pc + 1) & 0xFFF;
      switch (op) {
        case 0: {                                    // VCTR (2 words)
          const dy = sext(w & 0x1FFF, 13);
          const w2 = this.readWord(pc);
          pc = (pc + 1) & 0xFFF;
          const dx = sext(w2 & 0x1FFF, 13);
          let z = (w2 >> 13) & 7;
          if (z === 1) z = statZ; else z = z * 2;
          const s = scale();
          emit(x + dx * s, y + dy * s, z);
          break;
        }
        case 1:                                      // HALT
          this.halted = true;
          return this.lines;
        case 2: {                                    // SVEC
          const dx = sext(w & 0x1F, 5) * 2;
          const dy = sext((w >> 8) & 0x1F, 5) * 2;
          let z = (w >> 5) & 7;
          if (z === 1) z = statZ; else z = z * 2;
          const s = scale();
          emit(x + dx * s, y + dy * s, z);
          break;
        }
        case 3: {
          if (w & 0x1000) {                          // SCAL
            bscale = (w >> 8) & 7;
            lscale = w & 0xFF;
          } else {                                   // STAT
            statZ = (w >> 4) & 0xF;
            if (!(w & 0x400)) {
              // window op: current beam position defines a corner
              if (w & 0x200) { winX1 = x; winY1 = y; }   // hi: upper-right
              else { winX0 = x; winY0 = y; }             // lo: lower-left
              winOut = !!(w & 0x100);
              winActive = true;
            }
          }
          break;
        }
        case 4:                                      // CNTR
          x = 512; y = 384;
          break;
        case 5:                                      // JSRL
          if (stack.length < 5) stack.push(pc);
          pc = w & 0xFFF;
          break;
        case 6:                                      // RTSL
          if (!stack.length) return this.lines;
          pc = stack.pop();
          break;
        case 7:                                      // JMPL
          pc = w & 0xFFF;
          break;
      }
    }
    return this.lines;                               // guard tripped
  }
}

// Clip segment (x1,y1)-(x2,y2) to rect; emit inside part (or outside parts).
function clipEmit(out, x1, y1, x2, y2, z, rx0, ry0, rx1, ry1, outside) {
  if (rx0 > rx1) [rx0, rx1] = [rx1, rx0];
  if (ry0 > ry1) [ry0, ry1] = [ry1, ry0];
  // Liang-Barsky
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  let ok = true;
  const clip = (p, q) => {
    if (p === 0) { if (q < 0) ok = false; return; }
    const t = q / p;
    if (p < 0) { if (t > t1) ok = false; else if (t > t0) t0 = t; }
    else { if (t < t0) ok = false; else if (t < t1) t1 = t; }
  };
  clip(-dx, x1 - rx0); clip(dx, rx1 - x1);
  clip(-dy, y1 - ry0); clip(dy, ry1 - y1);

  if (!outside) {
    if (!ok) return;
    out.push({ x1: x1 + t0 * dx, y1: y1 + t0 * dy,
               x2: x1 + t1 * dx, y2: y1 + t1 * dy, z });
  } else {
    if (!ok) {           // entirely outside: draw whole segment
      out.push({ x1, y1, x2, y2, z });
      return;
    }
    if (t0 > 0) out.push({ x1, y1, x2: x1 + t0 * dx, y2: y1 + t0 * dy, z });
    if (t1 < 1) out.push({ x1: x1 + t1 * dx, y1: y1 + t1 * dy, x2, y2, z });
  }
}
