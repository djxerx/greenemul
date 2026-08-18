// POKEY audio emulation (the sound half of the chip).
//
// Battlezone drives POKEY directly: BZSOUN.MAC writes AUDF1/AUDC1..AUDC4 to
// play the eight named effects (radar beep, boing, blocked, bonus, warning,
// disintegrate, saucer, super bonus), and BZONE.MAC drives channels 3 and 4
// (CHAN3F/V, CHAN4F/V = POKEY+4..+7) for the enemy tank motor, with DRADAR
// setting the volume from TDIST -- the distance cue you hear before you see it.
//
// Registers (offsets from 0x1820): 0/2/4/6 = AUDF1-4, 1/3/5/7 = AUDC1-4,
// 8 = AUDCTL.
//   AUDC: bit4 volume-only, bits0-3 volume, bits5-7 distortion:
//         bit7 = bypass 5-bit poly, bit6 = use 4-bit poly, bit5 = pure tone
//   AUDCTL: bit0 = 15 kHz base clock (else 64 kHz), bit3 = join ch4+ch3 (16-bit),
//           bit4 = join ch2+ch1, bit5 = ch3 at full clock, bit6 = ch1 at full
//           clock, bit7 = 9-bit poly instead of 17-bit
const VOL_ONLY = 0x10, PURETONE = 0x20, POLY4 = 0x40, NOTPOLY5 = 0x80;

export class Pokey {
  constructor(clockHz) {
    this.clock = clockHz;
    this.audf = new Uint8Array(4);
    this.audc = new Uint8Array(4);
    this.audctl = 0;
    this.cnt = new Int32Array(4);       // channel divider countdowns
    this.out = new Uint8Array(4);       // output flip-flops
    this.baseCnt = 28;
    this.p4 = 0x0F; this.p5 = 0x1F; this.p9 = 0x1FF; this.p17 = 0x1FFFF;
    this.clockAcc = 0;
    this.dc = 0;                        // DC-blocker state
    this.dcIn = 0;
  }

  write(reg, val) {
    reg &= 0x0F;
    val &= 0xFF;
    if (reg < 8) {
      const ch = reg >> 1;
      if (reg & 1) this.audc[ch] = val; else this.audf[ch] = val;
      this.reload(ch);
    } else if (reg === 8) {
      this.audctl = val;
    }
  }

  basePeriod() { return (this.audctl & 1) ? 114 : 28; }

  // divider reload value for a channel, honoring 16-bit joins and fast clocks
  reload(ch) {
    if (this.cnt[ch] <= 0) this.cnt[ch] = this.period(ch);
  }
  period(ch) {
    const ac = this.audctl;
    if (ch === 0 && (ac & 0x10)) return 0;            // low half of a 16-bit pair
    if (ch === 2 && (ac & 0x08)) return 0;
    if (ch === 1 && (ac & 0x10)) {                     // 16-bit: ch2:ch1
      const n = this.audf[0] | (this.audf[1] << 8);
      return n + ((ac & 0x40) ? 7 : 1);
    }
    if (ch === 3 && (ac & 0x08)) {                     // 16-bit: ch4:ch3
      const n = this.audf[2] | (this.audf[3] << 8);
      return n + ((ac & 0x20) ? 7 : 1);
    }
    if (ch === 0 && (ac & 0x40)) return this.audf[0] + 4;   // ch1 at full clock
    if (ch === 2 && (ac & 0x20)) return this.audf[2] + 4;   // ch3 at full clock
    return this.audf[ch] + 1;
  }
  // does this channel count at the master clock rather than the base clock?
  fastClock(ch) {
    const ac = this.audctl;
    if (ch === 0) return !!(ac & 0x40);
    if (ch === 2) return !!(ac & 0x20);
    if (ch === 1 && (ac & 0x10)) return !!(ac & 0x40);
    if (ch === 3 && (ac & 0x08)) return !!(ac & 0x20);
    return false;
  }

  stepPolys() {
    let b;
    b = (this.p4 ^ (this.p4 >> 1)) & 1;
    this.p4 = ((this.p4 >> 1) | (b << 3)) & 0x0F;
    b = (this.p5 ^ (this.p5 >> 2)) & 1;
    this.p5 = ((this.p5 >> 1) | (b << 4)) & 0x1F;
    b = (this.p9 ^ (this.p9 >> 4)) & 1;
    this.p9 = ((this.p9 >> 1) | (b << 8)) & 0x1FF;
    b = (this.p17 ^ (this.p17 >> 5)) & 1;
    this.p17 = ((this.p17 >> 1) | (b << 16)) & 0x1FFFF;
  }

  // fire one channel's divider expiry: decide whether the output flips
  clockChannel(ch) {
    const c = this.audc[ch];
    if (!(c & NOTPOLY5) && !(this.p5 & 1)) return;   // gated by 5-bit poly
    if (c & PURETONE) this.out[ch] ^= 1;
    else if (c & POLY4) this.out[ch] = this.p4 & 1;
    else this.out[ch] = (this.audctl & 0x80) ? (this.p9 & 1) : (this.p17 & 1);
  }

  stepClock() {
    this.stepPolys();
    let baseTick = false;
    if (--this.baseCnt <= 0) { this.baseCnt = this.basePeriod(); baseTick = true; }
    for (let ch = 0; ch < 4; ch++) {
      const p = this.period(ch);
      if (p === 0) continue;                          // slaved low half of a pair
      if (!(this.fastClock(ch) || baseTick)) continue;
      if (--this.cnt[ch] <= 0) { this.cnt[ch] = p; this.clockChannel(ch); }
    }
  }

  sample() {
    let v = 0;
    for (let ch = 0; ch < 4; ch++) {
      const c = this.audc[ch];
      const vol = c & 0x0F;
      if (!vol) continue;
      v += (c & VOL_ONLY) ? vol : (this.out[ch] ? vol : 0);
    }
    // 0..60 -> roughly -1..1, then DC-block so steady tones don't offset
    const x = v / 60;
    const y = x - this.dcIn + 0.995 * this.dc;
    this.dcIn = x; this.dc = y;
    return y;
  }

  // Render `count` samples into buf[offset..], advancing the chip.
  render(buf, offset, count, sampleRate) {
    const perSample = this.clock / sampleRate;
    for (let i = 0; i < count; i++) {
      this.clockAcc += perSample;
      let steps = this.clockAcc | 0;
      this.clockAcc -= steps;
      while (steps-- > 0) this.stepClock();
      buf[offset + i] = this.sample();
    }
  }
}
