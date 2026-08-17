// Battlezone machine: memory map and peripherals, per the equates in the
// original BZONE.MAC source:
//   0x0000-0x03FF RAM          0x0800 IN0 (bit0 = VG halt, self-test, slam, coin)
//   0x0A00 DSW "OPTION"        0x0C00 DSW "OPTON2" (coinage; 0 = free play)
//   0x1200 VG GO               0x1400 watchdog      0x1600 VG reset
//   0x1800 mathbox status      0x1810/0x1818 mathbox result lo/hi
//   0x1820-0x182F POKEY        0x1840 sound latch   0x1860-0x187F mathbox start
//   0x2000-0x2FFF vector RAM   0x3000-0x3FFF vector ROM
//   0x5000-0x7FFF program ROM  (mirrored into 0x8000-0xFFFF: A15 undecoded)
import { CPU6502 } from "./cpu6502.js";
import { Mathbox } from "./mathbox.js";
import { AVG } from "./avg.js";

export const CPU_HZ = 1512000;
const NMI_PERIOD = Math.round(CPU_HZ / 250);   // 4 ms

export class Machine {
  constructor(roms) {
    this.ram = new Uint8Array(0x400);
    this.vram = new Uint8Array(0x1000);
    this.vrom = new Uint8Array(0x1000);
    this.prom = new Uint8Array(0x3000);
    this.vrom.set(roms["036422.01"], 0x0000);   // 0x3000
    this.vrom.set(roms["036421.01"], 0x0800);   // 0x3800
    this.prom.set(roms["036414.02"], 0x0000);   // 0x5000
    this.prom.set(roms["036413.01"], 0x0800);   // 0x5800
    this.prom.set(roms["036412.01"], 0x1000);   // 0x6000
    this.prom.set(roms["036411.01"], 0x1800);   // 0x6800
    this.prom.set(roms["036410.01"], 0x2000);   // 0x7000
    this.prom.set(roms["036409.01"], 0x2800);   // 0x7800

    this.mathbox = new Mathbox(roms["03617X.SAV"]);
    this.avg = new AVG((wa) => {
      const a = 0x2000 + wa * 2;
      const rd = (ad) => ad < 0x3000 ? this.vram[ad - 0x2000] : this.vrom[ad - 0x3000];
      return rd(a) | (rd(a + 1) << 8);
    });

    // inputs
    this.moveBits = 0;         // bit0 R-fwd, bit1 R-back, bit2 L-fwd, bit3 L-back (pressed)
    this.fire = false;
    this.start = false;
    this.coinPulse = 0;
    this.selfTest = false;
    // DIPs: OPTION 0xA00 bits0-1 lives (+2 => 01 = 3), bits2-3 missile score,
    // bits4-5 bonus, bits6-7 language (00 = English)
    this.dsw0 = 0x01;
    this.dsw1 = 0x00;          // OPTON2: low 2 bits 0 = FREE PLAY
    this.soundLatch = 0;
    this.onSound = null;       // callback(soundByte)

    this.vgHalted = true;
    this.pendingLines = null;  // most recent completed AVG frame

    this.pokeyRandom = 0x1FFFF;

    this.cpu = new CPU6502(this.readByte.bind(this), this.writeByte.bind(this));
    this.cpu.reset();
    this.nextNmi = NMI_PERIOD;
  }

  // ---------------------------------------------------------------- bus
  readByte(addr) {
    addr &= 0x7FFF;                              // A15 undecoded
    if (addr < 0x0400) return this.ram[addr];
    if (addr >= 0x5000) return this.prom[addr - 0x5000];
    if (addr >= 0x3000 && addr < 0x4000) return this.vrom[addr - 0x3000];
    if (addr >= 0x2000 && addr < 0x3000) return this.vram[addr - 0x2000];

    if ((addr & 0xFF00) === 0x0800) {
      // IN0: bit0 VG halt (1 = halted); self-test bit4 (active low -> 1 = off);
      // slam bit3 (1 = ok); coin switches active low on bits 5-7 (unused
      // in free play, pulsed low briefly when the COIN button is pressed)
      let v = 0x18 | 0xE0;
      if (this.vgHalted) v |= 0x01;
      if (this.selfTest) v &= ~0x10;
      if (this.coinPulse > 0) v &= ~0x20;
      return v;
    }
    if ((addr & 0xFF00) === 0x0A00) return this.dsw0;
    if ((addr & 0xFF00) === 0x0C00) return this.dsw1;

    if (addr === 0x1800) return this.mathbox.readStatus();
    if (addr === 0x1810) return this.mathbox.readLow();
    if (addr === 0x1818) return this.mathbox.readHigh();

    if (addr >= 0x1820 && addr < 0x1830) return this.pokeyRead(addr & 0x0F);
    return 0;
  }

  writeByte(addr, val) {
    addr &= 0x7FFF;
    if (addr < 0x0400) { this.ram[addr] = val; return; }
    if (addr >= 0x2000 && addr < 0x3000) { this.vram[addr - 0x2000] = val; return; }

    if (addr === 0x1200) {                        // VG GO
      this.vgHalted = false;
      this.pendingLines = this.avg.run();
      this.vgHalted = true;                       // instantaneous draw
      return;
    }
    if (addr === 0x1600) { this.vgHalted = true; return; }   // VG reset
    if (addr === 0x1400) return;                  // watchdog
    if (addr === 0x1000) return;                  // coin counters
    if (addr === 0x1840) {                        // sound latch
      this.soundLatch = val;
      this.onSound && this.onSound(val);
      return;
    }
    if (addr >= 0x1860 && addr < 0x1880) {
      this.mathbox.start(addr - 0x1860, val);
      return;
    }
    if (addr >= 0x1820 && addr < 0x1830) return;  // POKEY writes (POTGO etc.)
  }

  // ---------------------------------------------------------------- POKEY
  pokeyRead(reg) {
    if (reg === 0x08) {                           // ALLPOT
      // movement switches active LOW in the low nibble; fire bit4 and
      // start bit5 active HIGH
      let v = (~this.moveBits) & 0x0F;
      if (this.fire) v |= 0x10;
      if (this.start) v |= 0x20;
      return v;
    }
    if (reg === 0x0A) {                           // RANDOM: 17-bit poly LFSR
      for (let i = 0; i < 8; i++) {
        const bit = ((this.pokeyRandom >> 16) ^ (this.pokeyRandom >> 11)) & 1;
        this.pokeyRandom = ((this.pokeyRandom << 1) | bit) & 0x1FFFF;
      }
      return (this.pokeyRandom >> 1) & 0xFF;
    }
    return 0;
  }

  // ---------------------------------------------------------------- run
  // Run `cycles` of CPU time; fires NMIs on schedule.  Returns the latest
  // completed vector frame (line list) or null.
  run(cycles) {
    const target = this.cpu.cycles + cycles;
    let frame = null;
    while (this.cpu.cycles < target) {
      if (this.cpu.cycles >= this.nextNmi) {
        if (!this.selfTest) this.cpu.nmi();
        this.nextNmi += NMI_PERIOD;
      }
      this.cpu.step();
      if (this.pendingLines) { frame = this.pendingLines; this.pendingLines = null; }
    }
    if (this.coinPulse > 0) this.coinPulse -= cycles;
    return frame;
  }

  insertCoin() { this.coinPulse = CPU_HZ / 8; }   // ~125 ms low pulse
}
