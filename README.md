# BATTLEZONE Emulator

Runs the **actual 1980 Atari Battlezone ROMs** (copied from `../battlezone-source/`)
in the browser. This is the reference for fine-tuning the remake in
`../battlezone-remake/` — the remake is the main project; this is the ground truth.

## What's emulated

- **6502 CPU** at 1.512 MHz, including decimal mode (scores are BCD)
- **NMI at 250 Hz** — the game's own timing: main loop syncs every 16 NMIs
  (64 ms), the vector display restarts every 6 NMIs (24 ms)
- **Mathbox** — bit-level AMD 2901 emulation executing the *actual microcode*
  extracted from `03617X.SAV` (ucode pages at file offsets 0x6800/0x6900/0x6A00,
  mapping ROM at 0x8400), per the field layout in `MBUDOC.DOC`
- **Analog Vector Generator** — interprets the real display lists from vector
  RAM/ROM (VCTR/SVEC/STAT/SCAL/CNTR/JSRL/RTSL/JMPL with clip windows),
  rendered with a phosphor-glow canvas
- **POKEY** (partial): ALLPOT input port (tank sticks, fire, start) and the
  RANDOM LFSR the game uses for all randomness
- **DIP switches**: free play, 3 lives, missile at 5000, English

Not emulated: sound (the latch at 0x1840 is captured but no synthesis is
attached yet), self-test, coin counters, EAROM.

## Running

```
python3 devserver.py 8322
```

then open `http://localhost:8322`. Free play is set: press **START** (or Enter).

## Controls

- Arrows/WASD: drive (up = both treads forward, left/right = pivot)
- **Q/Z** and **P/?**: individual left/right tread levers (authentic)
- **SPACE** fire · **ENTER** start · **C** coin (not needed on free play)
- **F** pause · **>|** step one 4 ms NMI period while paused · speed slider
  (0.1×–1×) slows the whole machine for study
- On touch screens: two tread sliders + FIRE button appear

## Using it to tune the remake

Run both side by side (remake on :8321, emulator on :8322). The pause/step
and speed slider help measure the original's real rates — e.g. pivot speed,
shell flight time, enemy reaction delays, radar sweep period — which can then
be dialed into the remake's settings panel.
