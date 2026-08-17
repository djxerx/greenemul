// MATH-BOX: bit-level emulation of the AMD 2901-based coprocessor, executing
// the actual microcode from 03617X.SAV (an RT-11 core image: file offset =
// memory address).  Per MBUDOC.DOC:
//   0x6800-0x68FF  uCODE bits 23-16 (A, B register fields)
//   0x6900-0x69FF  uCODE bits 15-8
//   0x6A00-0x6AFF  uCODE bits 7-0
//   0x8400-0x841F  MAPPING ROM: 6502 A0-A4 -> starting uPC
//
// Microword fields:  23-20 A | 19-16 B | 15 I2HI | 14 I2LO | 13-12 I1,I0 |
//   11 STALL | 10-8 I5-I3 (func) | 7 LDAB | 6-4 I8-I6 (dest) | 3 SIGN |
//   2 JMP | 1 MULT | 0 CARIN
export class Mathbox {
  constructor(savBytes) {
    this.ucode = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      this.ucode[i] = (savBytes[0x6800 + i] << 16) |
                      (savBytes[0x6900 + i] << 8) |
                       savBytes[0x6A00 + i];
    }
    this.map = savBytes.slice(0x8400, 0x8420);
    this.regs = new Uint16Array(16);   // 2901 register file
    this.q = 0;
    this.output = 0;                   // Y-bus latch (read at 0x1810/0x1818)
    this.jumpLatch = 0;
    this.prevQ0 = 0;
  }

  // 6502 writes 0x1860+offset: map to uPC and run until STALL.
  start(offset, data) {
    let upc = this.map[offset & 0x1F];
    let dAvail = data;                 // D-bus valid only on the first cycle
    for (let guard = 0; guard < 4096; guard++) {
      const stalled = this.step(upc, dAvail);
      dAvail = 0;                      // floating afterwards
      if (stalled.stall) return;
      upc = stalled.next;
    }
  }

  step(upc, dbyte) {
    const w = this.ucode[upc];
    const A = (w >> 20) & 15, B = (w >> 16) & 15;
    const I2HI = (w >> 15) & 1, I2LO = (w >> 14) & 1;
    let i10 = (w >> 12) & 3;
    const STALL = (w >> 11) & 1;
    const FUNC = (w >> 8) & 7;
    const LDAB = (w >> 7) & 1;
    const DEST = (w >> 4) & 7;
    const SIGN = (w >> 3) & 1;
    const JMP = (w >> 2) & 1;
    const MULT = (w >> 1) & 1;
    const CI = w & 1;

    // CADD: invert I1 if Q0 was 0 last cycle
    if (MULT && this.prevQ0 === 0) i10 ^= 2;
    this.prevQ0 = this.q & 1;          // sample Q0 for the NEXT instruction

    // source operand select per half (I2 differs between byte halves).
    // idx = I2*4 + I1*2 + I0 -> (R,S):
    // 0:(A,Q) 1:(A,B) 2:(0,Q) 3:(0,B) 4:(0,A) 5:(D,A) 6:(D,Q) 7:(D,0)
    const d16 = (dbyte << 8) | dbyte;  // 8-bit D bus feeds both byte halves
    const pick = (i2) => {
      const ra = this.regs[A], rb = this.regs[B], q = this.q;
      switch (i2 * 4 + i10) {
        case 0: return [ra, q];
        case 1: return [ra, rb];
        case 2: return [0, q];
        case 3: return [0, rb];
        case 4: return [0, ra];
        case 5: return [d16, ra];
        case 6: return [d16, q];
        case 7: return [d16, 0];
      }
    };
    const [rHi, sHi] = pick(I2HI);
    const [rLo, sLo] = pick(I2LO);
    const r = (rHi & 0xFF00) | (rLo & 0x00FF);
    const s = (sHi & 0xFF00) | (sLo & 0x00FF);

    // ALU
    let f = 0, cout = 0, ovr = 0;
    const add = (x, y) => {
      const t = x + y + CI;
      cout = t > 0xFFFF ? 1 : 0;
      ovr = ((~(x ^ y) & (x ^ t)) >> 15) & 1;
      return t & 0xFFFF;
    };
    switch (FUNC) {
      case 0: f = add(r, s); break;                    // ADD
      case 1: f = add((~r) & 0xFFFF, s); break;        // SUBR
      case 2: f = add(r, (~s) & 0xFFFF); break;        // SUBS
      case 3: f = (r | s) & 0xFFFF; break;             // OR
      case 4: f = (r & s) & 0xFFFF; break;             // AND
      case 5: f = ((~r) & s) & 0xFFFF; break;          // NOTRS
      case 6: f = (r ^ s) & 0xFFFF; break;             // EXOR
      case 7: f = (~(r ^ s)) & 0xFFFF; break;          // EXNOR
    }

    const msbStar = SIGN ? (((f >> 15) & 1) ^ ovr) : 0;

    // destination / shifts
    let y = f;
    switch (DEST) {
      case 0: this.q = f; break;                                        // QREG
      case 1: break;                                                    // NOP
      case 2: this.regs[B] = f; y = this.regs[A]; break;                // RAMA
      case 3: this.regs[B] = f; break;                                  // RAMF
      case 4: {                                                         // RAMQD
        this.regs[B] = ((f >> 1) | (msbStar << 15)) & 0xFFFF;
        this.q = ((this.q >> 1) | ((f & 1) << 15)) & 0xFFFF;
        break;
      }
      case 5: this.regs[B] = ((f >> 1) | (msbStar << 15)) & 0xFFFF; break; // RAMD
      case 6: {                                                         // RAMQU
        this.regs[B] = ((f << 1) | ((this.q >> 15) & 1)) & 0xFFFF;
        this.q = (this.q << 1) & 0xFFFF;                                // Q0 forced 0
        break;
      }
      case 7: this.regs[B] = (f << 1) & 0xFFFF; break;                  // RAMU (lsb "garbage" -> 0)
    }
    this.output = y & 0xFFFF;

    // jump / latch
    if (LDAB) this.jumpLatch = (A << 4) | B;
    let next = (upc + 1) & 0xFF;
    if (JMP && msbStar === 0) next = this.jumpLatch;
    return { stall: STALL === 1, next };
  }

  readStatus() { return 0; }            // computation is instantaneous here
  readLow() { return this.output & 0xFF; }
  readHigh() { return (this.output >> 8) & 0xFF; }
}
