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
- **POKEY**: ALLPOT input port (tank sticks, fire, start), the RANDOM LFSR the
  game uses for all randomness, and the **audio side** — 4 channels with
  AUDF/AUDC/AUDCTL, the 4/5/9/17-bit polynomial counters, 16-bit channel joins
  and the fast-clock modes. Verified against theory: AUDF=100 pure tone gives
  265 Hz (1512000 ÷ 28 ÷ 101 ÷ 2 = 267 Hz).
- **Discrete sound board** (the 0x1840 latch) — synthesized, not netlist-
  simulated: engine idle/rumble (`LIDLE`/`HIDLE`), explosion with LOX/HIX
  pitch, and soft/loud shell fire.
- **DIP switches**: free play, 3 lives, missile at 5000, English

Press **SOUND** in the toolbar to enable audio (browsers require a click
before starting an AudioContext). The **TONE** slider retunes only the three
analog-board sounds (engine, shell, explosion), because those are approximated
rather than emulated — POKEY's pitches come from real register values and are
never touched by it. What you'll hear: your engine rumble
changing pitch as you drive, shell fire, explosions, the radar beep, warning
and saucer tones, and — most useful for tuning — the **enemy tank motor**,
whose volume POKEY channels 3/4 modulate by distance (`DRADAR` sets
`CHAN3V`/`CHAN4V` from `TDIST`), exactly as the arcade did.

Not emulated: the analog discrete circuit at netlist level (MAME does this;
here it's approximated), self-test, coin counters, EAROM.

## Running

```
python3 devserver.py 8322
```

then open `http://localhost:8322`. Free play is set: press **START** (or Enter).

## Controls

- Arrows/WASD: up/down = both treads forward/back, left/right alone = pivot in
  place. Held **together** they drive a single tread, which is how the original
  steers on the move — and they hit the ROM's own routines:

  | keys | tread | ROM routine |
  |---|---|---|
  | up + left | right tread forward | `M.LTF` left turn forward |
  | up + right | left tread forward | `M.RTF` right turn forward |
  | down + left | left tread back | `M.LTR` left turn reverse |
  | down + right | right tread back | `M.RTR` right turn reverse |

  So left always turns left and right always turns right, forward or reverse.
  Opposing keys (up+down, left+right) cancel to `M.STOP`.
- **Q/Z** and **P/?**: individual left/right tread levers (authentic).
  **X** duplicates Z, since Z freezes the top-down map while it is showing.
- **SPACE** fire · **ENTER** start · **C** coin (not needed on free play)
- **T** or the **TOP** button: read-only top-down overlay (see below).
  **Z** freezes the field · **+**/**−** or the on-panel buttons zoom ·
  drag the panel's top-right corner (or **[** / **]**) to resize.
  While the overlay is up, **X** is the left tread lever instead of Z.
- **F** pause · **>|** step one 4 ms NMI period while paused · **SPD** slider
  (0.1×–1×) slows the whole machine for study · **TONE** slider adjusts the
  pitch of the engine/shell/explosion only (see the sound note below)
### On an iPad

Touch controls appear automatically on any touch device: **two vertical tread
sliders** (left and right, each with a knob and a centre detent — push both up
to drive, opposite ways to pivot, exactly like the arcade's twin sticks) and a
**FIRE** button. Everything else — COIN, START, pause, step, SOUND, TOP, FRZ,
and the SPD/TONE sliders — is in the toolbar, which wraps to fit narrow screens;
the sticks automatically lift to stay clear of it. **FRZ** is the touch
equivalent of the Z freeze key, and the top-down panel's own **−/+** buttons and
corner grip are tappable.

Serve the folder from your computer and open `http://<computer-ip>:8322` in
Safari on the same Wi-Fi. "Add to Home Screen" gives a full-screen app.

## Top-down overlay

**T** toggles a map in the bottom-left showing the player as a filled triangle
with its field-of-view wedge, plus obstacles, the enemy tank (or missile, in
orange), the saucer and shells in flight — the same calibration aid the remake
has.

**Z freezes the field.** Normally the map is centred on the player and rotates
with them. Press Z and the map locks to the world frame where you stood, so the
player triangle drives around inside the window while the terrain holds still —
useful for watching a manoeuvre or an enemy's approach path as a track. The
border and label turn amber while frozen; press Z again to re-centre.

It is strictly **read-only**: it peeks at emulated zero-page RAM (`TPOSX`/
`TPOSY`/`TANGLE` at 0x2D/0x31/0x2A and friends), never writes memory and never
advances the CPU. Verified by snapshotting PC, cycle count and RAM across
repeated overlay renders — byte-identical. The game cannot tell it is there.

## Using it to tune the remake

Run both side by side (remake on :8321, emulator on :8322). The pause/step
and speed slider help measure the original's real rates — e.g. pivot speed,
shell flight time, enemy reaction delays, radar sweep period — which can then
be dialed into the remake's settings panel.
