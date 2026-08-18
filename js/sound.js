// Audio output: mixes emulated POKEY with a synthesized stand-in for the
// discrete analog sound board (the 0x1840 latch).
//
// Latch bits, from the equates in BZONE.MAC:
//   bit0 EXPLOD  explosion on        bit1 LOX/HIX  explosion pitch
//   bit2 shell fired                 bit3 LOUDSH   loud shell
//   bit4 HIDLE   engine high idle    bit5 LAMP     start-button lamp
//   bit6 lamps off                   bit7 sound/rumble enable
import { Pokey } from "./pokey.js";

export class SoundOutput {
  constructor(cpuHz) {
    this.cpuHz = cpuHz;
    this.pokey = new Pokey(cpuHz);
    this.ctx = null;
    this.playhead = 0;
    this.enabled = false;
    this.volume = 0.5;
    this.latch = 0;

    // discrete-board synth state.  These sounds are NOT emulated from the ROM
    // -- they are the analog board, approximated.  `tone` scales every pitch
    // and filter cutoff here so it can be dialled in by ear; POKEY is
    // unaffected by it.
    this.tone = 1.0;
    this.engPhase = 0;
    this.eng1 = 0; this.eng2 = 0; this.eng3 = 0;
    this.exp1 = 0; this.exp2 = 0; this.exp3 = 0;
    this.sh1 = 0; this.sh2 = 0;
    this.expEnv = 0;
    this.shellEnv = 0;
  }

  // one-pole lowpass coefficient for a cutoff in Hz
  coef(fc, sr) {
    const a = 1 - Math.exp(-2 * Math.PI * fc / sr);
    return a < 1 ? a : 1;
  }

  enable() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
      this.playhead = this.ctx.currentTime + 0.08;
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    this.enabled = true;
  }
  disable() { this.enabled = false; }
  setVolume(v) { this.volume = v; if (this.gain) this.gain.gain.value = v; }

  // one sample of the discrete sound board.  Everything is run through
  // 2-3 cascaded one-pole lowpasses -- a single pole only rolls off 6 dB/oct
  // and leaves far too much high content, which is what made these sing
  // rather than rumble.
  discreteSample(sr) {
    const L = this.latch;
    const t = this.tone;
    let out = 0;
    const noise = Math.random() * 2 - 1;

    // engine: narrow pulse train + noise, heavily lowpassed into a putt-putt
    const engHz = ((L & 0x10) ? 30 : 19) * t;
    this.engPhase += engHz / sr;
    if (this.engPhase >= 1) this.engPhase -= 1;
    if (L & 0x80) {
      const pulse = this.engPhase < 0.28 ? 1 : -0.35;
      const a = this.coef(105 * t, sr);
      this.eng1 += (pulse + noise * 0.8 - this.eng1) * a;
      this.eng2 += (this.eng1 - this.eng2) * a;
      this.eng3 += (this.eng2 - this.eng3) * a;
      out += this.eng3 * 0.15;
    }

    // explosion: deep boom held while the bit is set (bit1 LOX = lower)
    const expTarget = (L & 0x01) ? 1 : 0;
    this.expEnv += (expTarget - this.expEnv) * (expTarget ? 0.02 : 0.004);
    if (this.expEnv > 0.001) {
      const a = this.coef(((L & 0x02) ? 95 : 155) * t, sr);
      this.exp1 += (noise - this.exp1) * a;
      this.exp2 += (this.exp1 - this.exp2) * a;
      this.exp3 += (this.exp2 - this.exp3) * a;
      out += this.exp3 * this.expEnv * 2.3;
    }

    // shell: short lowpassed noise thump, louder when LOUDSH is set
    const shTarget = (L & 0x04) ? ((L & 0x08) ? 1 : 0.55) : 0;
    this.shellEnv += (shTarget - this.shellEnv) * (shTarget ? 0.05 : 0.006);
    if (this.shellEnv > 0.001) {
      const a = this.coef(320 * t, sr);
      this.sh1 += (noise - this.sh1) * a;
      this.sh2 += (this.sh1 - this.sh2) * a;
      out += this.sh2 * this.shellEnv * 0.66;
    }
    return out;
  }

  // Called once per emulated burst. `events` is [{cycle, reg, val, latch}]
  // recorded by the machine, `cycles` is how long the burst was.
  pump(cycles, events) {
    if (!this.enabled || !this.ctx || cycles <= 0) {
      // still apply register writes so state stays correct when muted
      for (const e of events) this.applyEvent(e);
      return;
    }
    const sr = this.ctx.sampleRate;
    const count = Math.max(1, Math.round(cycles * sr / this.cpuHz));
    if (count > sr) { for (const e of events) this.applyEvent(e); return; }  // huge jump: skip

    const buf = this.ctx.createBuffer(1, count, sr);
    const data = buf.getChannelData(0);
    const pk = new Float32Array(count);

    // walk events in order, rendering POKEY up to each event's sample position
    let done = 0, ei = 0;
    const evs = events.slice().sort((a, b) => a.cycle - b.cycle);
    while (ei < evs.length) {
      const e = evs[ei++];
      const pos = Math.min(count, Math.max(0, Math.round(e.cycle * sr / this.cpuHz)));
      if (pos > done) { this.pokey.render(pk, done, pos - done, sr); done = pos; }
      this.applyEvent(e);
    }
    if (done < count) this.pokey.render(pk, done, count - done, sr);

    for (let i = 0; i < count; i++) {
      let v = pk[i] * 0.85 + this.discreteSample(sr);
      data[i] = Math.max(-1, Math.min(1, v));
    }

    const now = this.ctx.currentTime;
    if (this.playhead < now + 0.01) this.playhead = now + 0.06;   // resync after a stall
    // If we're emulating faster than real time the queue would run away and
    // add seconds of latency -- drop the chunk instead of buffering it.
    if (this.playhead > now + 0.35) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start(this.playhead);
    this.playhead += count / sr;
  }

  applyEvent(e) {
    if (e.latch !== undefined) this.latch = e.latch;
    else this.pokey.write(e.reg, e.val);
  }
}
