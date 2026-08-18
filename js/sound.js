// Audio output: mixes emulated POKEY with a synthesized stand-in for the
// discrete analog sound board (the 0x1840 latch).
//
// Latch bits, from the equates in BZONE.MAC:
//   bit0 EXPLOD  explosion on        bit1 LOX/HIX  explosion pitch
//   bit2 shell fired                 bit3 LOUDSH   loud shell
//   bit4 HIDLE   engine high idle    bit5 LAMP     start-button lamp
//   bit6 lamps off                   bit7 sound/rumble enable
import { Pokey } from "./pokey.js";

// How loud POKEY (the beeps, warning tone, saucer warble, missile whine) sits
// against the analog-board sounds (engine rumble, shell, explosion).
// Measured, POKEY is already the quieter of the two by RMS -- but the board
// sounds live at 35-50 Hz where the ear is ~30 dB less sensitive, so equal
// energy is nowhere near equal loudness. Pulled down to match by ear.
const POKEY_MIX = 0.38;

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
    this.tone = 0.6;   // default set to taste; see the TONE slider
    this.engPhase = 0;
    this.throbPhase = 0;
    this.engEnv = 0;
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

    // Engine: a low but AUDIBLE drone -- fundamental plus two harmonics,
    // amplitude-modulated by a slow throb for motor character.  An earlier
    // version ran a hard-edged pulse at 19 Hz; that is below hearing, so each
    // edge landed as a separate click and the whole thing read as static.
    // The waveform is continuous and the filters are always driven (even when
    // the rumble bit is low) so switching it on and off cannot click either.
    const engHz = ((L & 0x10) ? 82 : 58) * t;
    this.engPhase += engHz / sr;
    if (this.engPhase >= 1) this.engPhase -= 1;
    this.throbPhase += (engHz / 4) / sr;
    if (this.throbPhase >= 1) this.throbPhase -= 1;
    const engTarget = (L & 0x80) ? 1 : 0;
    this.engEnv += (engTarget - this.engEnv) * 0.003;
    {
      const ph = this.engPhase * 2 * Math.PI;
      const wave = Math.sin(ph) + 0.45 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph);
      const throb = 0.78 + 0.22 * Math.sin(this.throbPhase * 2 * Math.PI);
      const a = this.coef(320 * t, sr);
      this.eng1 += (wave * throb + noise * 0.3 - this.eng1) * a;
      this.eng2 += (this.eng1 - this.eng2) * a;
      out += this.eng2 * this.engEnv * 0.13;
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

  // Called once per emulated burst.  `events` is [{cycle, reg, val, latch}]
  // recorded by the machine, `cycles` is the emulated length of the burst, and
  // `wallSeconds` is how much REAL time it represents.
  //
  // The buffer must be sized by wall time, not emulated time.  Sizing it by
  // emulated time meant that at the default 0.93x machine speed we produced 7%
  // less audio than the speaker consumed, the queue starved, and the playhead
  // resynced with a hole in it roughly every 0.7 s -- an audible tick-tick.
  // Rendering the emulated interval stretched across the wall interval also
  // gives the physically right result: a machine running slow sounds lower.
  pump(cycles, events, wallSeconds) {
    if (!this.enabled || !this.ctx || cycles <= 0) {
      // still apply register writes so state stays correct when muted
      for (const e of events) this.applyEvent(e);
      return;
    }
    const sr = this.ctx.sampleRate;
    const emuSeconds = cycles / this.cpuHz;
    const wall = (wallSeconds && wallSeconds > 0) ? wallSeconds : emuSeconds;
    const count = Math.max(1, Math.round(wall * sr));
    if (count > sr) { for (const e of events) this.applyEvent(e); return; }  // huge jump: skip
    // effective rate the chip is sampled at so `emuSeconds` fills `count` samples
    const srEff = count / emuSeconds;

    const buf = this.ctx.createBuffer(1, count, sr);
    const data = buf.getChannelData(0);
    const pk = new Float32Array(count);

    // walk events in order, rendering POKEY up to each event's sample position
    let done = 0, ei = 0;
    const evs = events.slice().sort((a, b) => a.cycle - b.cycle);
    while (ei < evs.length) {
      const e = evs[ei++];
      const pos = Math.min(count, Math.max(0, Math.round(e.cycle / cycles * count)));
      if (pos > done) { this.pokey.render(pk, done, pos - done, srEff); done = pos; }
      this.applyEvent(e);
    }
    if (done < count) this.pokey.render(pk, done, count - done, srEff);

    for (let i = 0; i < count; i++) {
      const v = pk[i] * POKEY_MIX + this.discreteSample(srEff);
      data[i] = Math.max(-1, Math.min(1, v));
    }

    const now = this.ctx.currentTime;
    // Keep ~100 ms of lead so an occasional long frame cannot starve the queue.
    if (this.playhead < now + 0.02) this.playhead = now + 0.10;   // resync after a stall
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
