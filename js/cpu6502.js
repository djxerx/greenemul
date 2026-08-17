// NMOS 6502 interpreter: documented opcodes, decimal mode, NMI/IRQ/reset.
// read(addr) / write(addr, val) are provided by the machine.
export class CPU6502 {
  constructor(read, write) {
    this.read = read;
    this.write = write;
    this.a = 0; this.x = 0; this.y = 0; this.s = 0xFD;
    this.pc = 0;
    this.n = 0; this.v = 0; this.d = 0; this.i = 1; this.z = 0; this.c = 0;
    this.cycles = 0;
    this.jammed = false;
  }

  reset() {
    this.pc = this.read(0xFFFC) | (this.read(0xFFFD) << 8);
    this.s = 0xFD; this.i = 1; this.d = 0;
    this.jammed = false;
    this.cycles += 7;
  }

  nmi() {
    this.push(this.pc >> 8); this.push(this.pc & 0xFF);
    this.push(this.flags() & ~0x10);
    this.i = 1;
    this.pc = this.read(0xFFFA) | (this.read(0xFFFB) << 8);
    this.cycles += 7;
  }

  irq() {
    if (this.i) return;
    this.push(this.pc >> 8); this.push(this.pc & 0xFF);
    this.push(this.flags() & ~0x10);
    this.i = 1;
    this.pc = this.read(0xFFFE) | (this.read(0xFFFF) << 8);
    this.cycles += 7;
  }

  flags() {
    return (this.n ? 0x80 : 0) | (this.v ? 0x40 : 0) | 0x20 | 0x10 |
           (this.d ? 0x08 : 0) | (this.i ? 0x04 : 0) |
           (this.z ? 0x02 : 0) | (this.c ? 0x01 : 0);
  }
  setFlags(p) {
    this.n = p & 0x80; this.v = p & 0x40; this.d = p & 0x08;
    this.i = p & 0x04; this.z = p & 0x02; this.c = p & 0x01;
  }

  push(v) { this.write(0x100 + this.s, v & 0xFF); this.s = (this.s - 1) & 0xFF; }
  pull() { this.s = (this.s + 1) & 0xFF; return this.read(0x100 + this.s); }

  nz(v) { v &= 0xFF; this.n = v & 0x80; this.z = v === 0 ? 2 : 0; return v; }

  fetch() { const v = this.read(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  fetch16() { const lo = this.fetch(); return lo | (this.fetch() << 8); }

  // addressing modes returning effective address
  zp() { return this.fetch(); }
  zpx() { return (this.fetch() + this.x) & 0xFF; }
  zpy() { return (this.fetch() + this.y) & 0xFF; }
  abs() { return this.fetch16(); }
  abx(pen) { const b = this.fetch16(); const a = (b + this.x) & 0xFFFF; if (pen && (b & 0xFF00) !== (a & 0xFF00)) this.cycles++; return a; }
  aby(pen) { const b = this.fetch16(); const a = (b + this.y) & 0xFFFF; if (pen && (b & 0xFF00) !== (a & 0xFF00)) this.cycles++; return a; }
  izx() { const p = (this.fetch() + this.x) & 0xFF; return this.read(p) | (this.read((p + 1) & 0xFF) << 8); }
  izy(pen) { const p = this.fetch(); const b = this.read(p) | (this.read((p + 1) & 0xFF) << 8); const a = (b + this.y) & 0xFFFF; if (pen && (b & 0xFF00) !== (a & 0xFF00)) this.cycles++; return a; }

  adc(m) {
    if (this.d) {
      // NMOS decimal ADC
      let lo = (this.a & 0x0F) + (m & 0x0F) + (this.c ? 1 : 0);
      let hi = (this.a >> 4) + (m >> 4);
      if (lo > 9) { lo += 6; hi++; }
      const bin = (this.a + m + (this.c ? 1 : 0)) & 0xFF;
      this.z = bin === 0 ? 2 : 0;
      this.n = (hi & 0x08) << 4;
      this.v = ((~(this.a ^ m) & (this.a ^ (hi << 4)) & 0x80)) ? 0x40 : 0;
      if (hi > 9) hi += 6;
      this.c = hi > 15 ? 1 : 0;
      this.a = ((hi << 4) | (lo & 0x0F)) & 0xFF;
    } else {
      const r = this.a + m + (this.c ? 1 : 0);
      this.v = (~(this.a ^ m) & (this.a ^ r) & 0x80) ? 0x40 : 0;
      this.c = r > 0xFF ? 1 : 0;
      this.a = this.nz(r);
    }
  }

  sbc(m) {
    if (this.d) {
      const bin = this.a - m - (this.c ? 0 : 1);
      let lo = (this.a & 0x0F) - (m & 0x0F) - (this.c ? 0 : 1);
      let hi = (this.a >> 4) - (m >> 4);
      if (lo < 0) { lo -= 6; hi--; }
      if (hi < 0) hi -= 6;
      this.v = ((this.a ^ m) & (this.a ^ bin) & 0x80) ? 0x40 : 0;
      this.c = bin >= 0 ? 1 : 0;
      this.nz(bin & 0xFF);
      this.a = ((hi << 4) | (lo & 0x0F)) & 0xFF;
    } else {
      this.adc((~m) & 0xFF);
    }
  }

  cmp(r, m) { const t = r - m; this.c = t >= 0 ? 1 : 0; this.nz(t & 0xFF); }

  branch(cond) {
    const off = this.fetch();
    if (cond) {
      const t = (this.pc + ((off & 0x80) ? off - 256 : off)) & 0xFFFF;
      this.cycles += ((t & 0xFF00) !== (this.pc & 0xFF00)) ? 2 : 1;
      this.pc = t;
    }
  }

  asl(v) { this.c = (v >> 7) & 1; return this.nz(v << 1); }
  lsr(v) { this.c = v & 1; return this.nz(v >> 1); }
  rol(v) { const c = this.c ? 1 : 0; this.c = (v >> 7) & 1; return this.nz((v << 1) | c); }
  ror(v) { const c = this.c ? 0x80 : 0; this.c = v & 1; return this.nz((v >> 1) | c); }

  rmw(addr, fn) { const v = this.read(addr); this.write(addr, fn.call(this, v)); }

  step() {
    if (this.jammed) { this.cycles += 2; return; }
    const op = this.fetch();
    switch (op) {
      // loads
      case 0xA9: this.a = this.nz(this.fetch()); this.cycles += 2; break;
      case 0xA5: this.a = this.nz(this.read(this.zp())); this.cycles += 3; break;
      case 0xB5: this.a = this.nz(this.read(this.zpx())); this.cycles += 4; break;
      case 0xAD: this.a = this.nz(this.read(this.abs())); this.cycles += 4; break;
      case 0xBD: this.a = this.nz(this.read(this.abx(1))); this.cycles += 4; break;
      case 0xB9: this.a = this.nz(this.read(this.aby(1))); this.cycles += 4; break;
      case 0xA1: this.a = this.nz(this.read(this.izx())); this.cycles += 6; break;
      case 0xB1: this.a = this.nz(this.read(this.izy(1))); this.cycles += 5; break;
      case 0xA2: this.x = this.nz(this.fetch()); this.cycles += 2; break;
      case 0xA6: this.x = this.nz(this.read(this.zp())); this.cycles += 3; break;
      case 0xB6: this.x = this.nz(this.read(this.zpy())); this.cycles += 4; break;
      case 0xAE: this.x = this.nz(this.read(this.abs())); this.cycles += 4; break;
      case 0xBE: this.x = this.nz(this.read(this.aby(1))); this.cycles += 4; break;
      case 0xA0: this.y = this.nz(this.fetch()); this.cycles += 2; break;
      case 0xA4: this.y = this.nz(this.read(this.zp())); this.cycles += 3; break;
      case 0xB4: this.y = this.nz(this.read(this.zpx())); this.cycles += 4; break;
      case 0xAC: this.y = this.nz(this.read(this.abs())); this.cycles += 4; break;
      case 0xBC: this.y = this.nz(this.read(this.abx(1))); this.cycles += 4; break;
      // stores
      case 0x85: this.write(this.zp(), this.a); this.cycles += 3; break;
      case 0x95: this.write(this.zpx(), this.a); this.cycles += 4; break;
      case 0x8D: this.write(this.abs(), this.a); this.cycles += 4; break;
      case 0x9D: this.write(this.abx(0), this.a); this.cycles += 5; break;
      case 0x99: this.write(this.aby(0), this.a); this.cycles += 5; break;
      case 0x81: this.write(this.izx(), this.a); this.cycles += 6; break;
      case 0x91: this.write(this.izy(0), this.a); this.cycles += 6; break;
      case 0x86: this.write(this.zp(), this.x); this.cycles += 3; break;
      case 0x96: this.write(this.zpy(), this.x); this.cycles += 4; break;
      case 0x8E: this.write(this.abs(), this.x); this.cycles += 4; break;
      case 0x84: this.write(this.zp(), this.y); this.cycles += 3; break;
      case 0x94: this.write(this.zpx(), this.y); this.cycles += 4; break;
      case 0x8C: this.write(this.abs(), this.y); this.cycles += 4; break;
      // transfers
      case 0xAA: this.x = this.nz(this.a); this.cycles += 2; break;
      case 0xA8: this.y = this.nz(this.a); this.cycles += 2; break;
      case 0x8A: this.a = this.nz(this.x); this.cycles += 2; break;
      case 0x98: this.a = this.nz(this.y); this.cycles += 2; break;
      case 0xBA: this.x = this.nz(this.s); this.cycles += 2; break;
      case 0x9A: this.s = this.x; this.cycles += 2; break;
      // stack
      case 0x48: this.push(this.a); this.cycles += 3; break;
      case 0x68: this.a = this.nz(this.pull()); this.cycles += 4; break;
      case 0x08: this.push(this.flags()); this.cycles += 3; break;
      case 0x28: this.setFlags(this.pull()); this.cycles += 4; break;
      // logic
      case 0x29: this.a = this.nz(this.a & this.fetch()); this.cycles += 2; break;
      case 0x25: this.a = this.nz(this.a & this.read(this.zp())); this.cycles += 3; break;
      case 0x35: this.a = this.nz(this.a & this.read(this.zpx())); this.cycles += 4; break;
      case 0x2D: this.a = this.nz(this.a & this.read(this.abs())); this.cycles += 4; break;
      case 0x3D: this.a = this.nz(this.a & this.read(this.abx(1))); this.cycles += 4; break;
      case 0x39: this.a = this.nz(this.a & this.read(this.aby(1))); this.cycles += 4; break;
      case 0x21: this.a = this.nz(this.a & this.read(this.izx())); this.cycles += 6; break;
      case 0x31: this.a = this.nz(this.a & this.read(this.izy(1))); this.cycles += 5; break;
      case 0x09: this.a = this.nz(this.a | this.fetch()); this.cycles += 2; break;
      case 0x05: this.a = this.nz(this.a | this.read(this.zp())); this.cycles += 3; break;
      case 0x15: this.a = this.nz(this.a | this.read(this.zpx())); this.cycles += 4; break;
      case 0x0D: this.a = this.nz(this.a | this.read(this.abs())); this.cycles += 4; break;
      case 0x1D: this.a = this.nz(this.a | this.read(this.abx(1))); this.cycles += 4; break;
      case 0x19: this.a = this.nz(this.a | this.read(this.aby(1))); this.cycles += 4; break;
      case 0x01: this.a = this.nz(this.a | this.read(this.izx())); this.cycles += 6; break;
      case 0x11: this.a = this.nz(this.a | this.read(this.izy(1))); this.cycles += 5; break;
      case 0x49: this.a = this.nz(this.a ^ this.fetch()); this.cycles += 2; break;
      case 0x45: this.a = this.nz(this.a ^ this.read(this.zp())); this.cycles += 3; break;
      case 0x55: this.a = this.nz(this.a ^ this.read(this.zpx())); this.cycles += 4; break;
      case 0x4D: this.a = this.nz(this.a ^ this.read(this.abs())); this.cycles += 4; break;
      case 0x5D: this.a = this.nz(this.a ^ this.read(this.abx(1))); this.cycles += 4; break;
      case 0x59: this.a = this.nz(this.a ^ this.read(this.aby(1))); this.cycles += 4; break;
      case 0x41: this.a = this.nz(this.a ^ this.read(this.izx())); this.cycles += 6; break;
      case 0x51: this.a = this.nz(this.a ^ this.read(this.izy(1))); this.cycles += 5; break;
      // arithmetic
      case 0x69: this.adc(this.fetch()); this.cycles += 2; break;
      case 0x65: this.adc(this.read(this.zp())); this.cycles += 3; break;
      case 0x75: this.adc(this.read(this.zpx())); this.cycles += 4; break;
      case 0x6D: this.adc(this.read(this.abs())); this.cycles += 4; break;
      case 0x7D: this.adc(this.read(this.abx(1))); this.cycles += 4; break;
      case 0x79: this.adc(this.read(this.aby(1))); this.cycles += 4; break;
      case 0x61: this.adc(this.read(this.izx())); this.cycles += 6; break;
      case 0x71: this.adc(this.read(this.izy(1))); this.cycles += 5; break;
      case 0xE9: this.sbc(this.fetch()); this.cycles += 2; break;
      case 0xE5: this.sbc(this.read(this.zp())); this.cycles += 3; break;
      case 0xF5: this.sbc(this.read(this.zpx())); this.cycles += 4; break;
      case 0xED: this.sbc(this.read(this.abs())); this.cycles += 4; break;
      case 0xFD: this.sbc(this.read(this.abx(1))); this.cycles += 4; break;
      case 0xF9: this.sbc(this.read(this.aby(1))); this.cycles += 4; break;
      case 0xE1: this.sbc(this.read(this.izx())); this.cycles += 6; break;
      case 0xF1: this.sbc(this.read(this.izy(1))); this.cycles += 5; break;
      // compares
      case 0xC9: this.cmp(this.a, this.fetch()); this.cycles += 2; break;
      case 0xC5: this.cmp(this.a, this.read(this.zp())); this.cycles += 3; break;
      case 0xD5: this.cmp(this.a, this.read(this.zpx())); this.cycles += 4; break;
      case 0xCD: this.cmp(this.a, this.read(this.abs())); this.cycles += 4; break;
      case 0xDD: this.cmp(this.a, this.read(this.abx(1))); this.cycles += 4; break;
      case 0xD9: this.cmp(this.a, this.read(this.aby(1))); this.cycles += 4; break;
      case 0xC1: this.cmp(this.a, this.read(this.izx())); this.cycles += 6; break;
      case 0xD1: this.cmp(this.a, this.read(this.izy(1))); this.cycles += 5; break;
      case 0xE0: this.cmp(this.x, this.fetch()); this.cycles += 2; break;
      case 0xE4: this.cmp(this.x, this.read(this.zp())); this.cycles += 3; break;
      case 0xEC: this.cmp(this.x, this.read(this.abs())); this.cycles += 4; break;
      case 0xC0: this.cmp(this.y, this.fetch()); this.cycles += 2; break;
      case 0xC4: this.cmp(this.y, this.read(this.zp())); this.cycles += 3; break;
      case 0xCC: this.cmp(this.y, this.read(this.abs())); this.cycles += 4; break;
      // inc/dec
      case 0xE6: this.rmw(this.zp(), v => this.nz(v + 1)); this.cycles += 5; break;
      case 0xF6: this.rmw(this.zpx(), v => this.nz(v + 1)); this.cycles += 6; break;
      case 0xEE: this.rmw(this.abs(), v => this.nz(v + 1)); this.cycles += 6; break;
      case 0xFE: this.rmw(this.abx(0), v => this.nz(v + 1)); this.cycles += 7; break;
      case 0xC6: this.rmw(this.zp(), v => this.nz(v - 1)); this.cycles += 5; break;
      case 0xD6: this.rmw(this.zpx(), v => this.nz(v - 1)); this.cycles += 6; break;
      case 0xCE: this.rmw(this.abs(), v => this.nz(v - 1)); this.cycles += 6; break;
      case 0xDE: this.rmw(this.abx(0), v => this.nz(v - 1)); this.cycles += 7; break;
      case 0xE8: this.x = this.nz(this.x + 1); this.cycles += 2; break;
      case 0xC8: this.y = this.nz(this.y + 1); this.cycles += 2; break;
      case 0xCA: this.x = this.nz(this.x - 1); this.cycles += 2; break;
      case 0x88: this.y = this.nz(this.y - 1); this.cycles += 2; break;
      // shifts
      case 0x0A: this.a = this.asl(this.a); this.cycles += 2; break;
      case 0x06: this.rmw(this.zp(), this.asl); this.cycles += 5; break;
      case 0x16: this.rmw(this.zpx(), this.asl); this.cycles += 6; break;
      case 0x0E: this.rmw(this.abs(), this.asl); this.cycles += 6; break;
      case 0x1E: this.rmw(this.abx(0), this.asl); this.cycles += 7; break;
      case 0x4A: this.a = this.lsr(this.a); this.cycles += 2; break;
      case 0x46: this.rmw(this.zp(), this.lsr); this.cycles += 5; break;
      case 0x56: this.rmw(this.zpx(), this.lsr); this.cycles += 6; break;
      case 0x4E: this.rmw(this.abs(), this.lsr); this.cycles += 6; break;
      case 0x5E: this.rmw(this.abx(0), this.lsr); this.cycles += 7; break;
      case 0x2A: this.a = this.rol(this.a); this.cycles += 2; break;
      case 0x26: this.rmw(this.zp(), this.rol); this.cycles += 5; break;
      case 0x36: this.rmw(this.zpx(), this.rol); this.cycles += 6; break;
      case 0x2E: this.rmw(this.abs(), this.rol); this.cycles += 6; break;
      case 0x3E: this.rmw(this.abx(0), this.rol); this.cycles += 7; break;
      case 0x6A: this.a = this.ror(this.a); this.cycles += 2; break;
      case 0x66: this.rmw(this.zp(), this.ror); this.cycles += 5; break;
      case 0x76: this.rmw(this.zpx(), this.ror); this.cycles += 6; break;
      case 0x6E: this.rmw(this.abs(), this.ror); this.cycles += 6; break;
      case 0x7E: this.rmw(this.abx(0), this.ror); this.cycles += 7; break;
      // bit
      case 0x24: { const v = this.read(this.zp()); this.n = v & 0x80; this.v = v & 0x40; this.z = (v & this.a) === 0 ? 2 : 0; this.cycles += 3; break; }
      case 0x2C: { const v = this.read(this.abs()); this.n = v & 0x80; this.v = v & 0x40; this.z = (v & this.a) === 0 ? 2 : 0; this.cycles += 4; break; }
      // jumps
      case 0x4C: this.pc = this.fetch16(); this.cycles += 3; break;
      case 0x6C: { const p = this.fetch16(); const lo = this.read(p); const hi = this.read((p & 0xFF00) | ((p + 1) & 0xFF)); this.pc = lo | (hi << 8); this.cycles += 5; break; }
      case 0x20: { const t = this.fetch16(); const r = (this.pc - 1) & 0xFFFF; this.push(r >> 8); this.push(r & 0xFF); this.pc = t; this.cycles += 6; break; }
      case 0x60: { const lo = this.pull(); const hi = this.pull(); this.pc = ((lo | (hi << 8)) + 1) & 0xFFFF; this.cycles += 6; break; }
      case 0x40: { this.setFlags(this.pull()); const lo = this.pull(); const hi = this.pull(); this.pc = lo | (hi << 8); this.cycles += 6; break; }
      case 0x00: { this.fetch(); this.push(this.pc >> 8); this.push(this.pc & 0xFF); this.push(this.flags()); this.i = 1; this.pc = this.read(0xFFFE) | (this.read(0xFFFF) << 8); this.cycles += 7; break; }
      // branches
      case 0x10: this.branch(!this.n); this.cycles += 2; break;
      case 0x30: this.branch(this.n); this.cycles += 2; break;
      case 0x50: this.branch(!this.v); this.cycles += 2; break;
      case 0x70: this.branch(this.v); this.cycles += 2; break;
      case 0x90: this.branch(!this.c); this.cycles += 2; break;
      case 0xB0: this.branch(this.c); this.cycles += 2; break;
      case 0xD0: this.branch(!this.z); this.cycles += 2; break;
      case 0xF0: this.branch(this.z); this.cycles += 2; break;
      // flags
      case 0x18: this.c = 0; this.cycles += 2; break;
      case 0x38: this.c = 1; this.cycles += 2; break;
      case 0x58: this.i = 0; this.cycles += 2; break;
      case 0x78: this.i = 1; this.cycles += 2; break;
      case 0xB8: this.v = 0; this.cycles += 2; break;
      case 0xD8: this.d = 0; this.cycles += 2; break;
      case 0xF8: this.d = 1; this.cycles += 2; break;
      case 0xEA: this.cycles += 2; break;
      default:
        // treat undocumented opcodes as NOPs of plausible length
        this.cycles += 2;
        break;
    }
  }
}
