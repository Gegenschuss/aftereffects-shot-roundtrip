# diagnostics/

Read-only inspection scripts for debugging the shot-roundtrip pipeline.
None of these mutate the project — they just dump state.

## `dump_source_range_chain.jsx`

Source-frame-range tracer. For every top-level visible layer in the
active comp, walks down through every nested precomp + time-effect
(stretch / time-remap) and reports the FOOTAGE source frame range the
master cut should be showing — with the math at every step. Then
scans the project for `*_stack` precomps and reports what footage
range each one *actually* covers, flagging mismatches against the
expected range.

The point is to localize where the roundtrip's plate-range / time-
remap math diverges from "min/max source frames + handle = plate".
Each chain step prints the time-effect, the comp-time window entering
it, and the source-time window leaving it — so the level where the
math goes wrong is immediately visible.

### Protocol

Run *before* the roundtrip to capture ground-truth source ranges,
then *after* each version to see what the script produced. Diff the
two text files and read Pass 2's `*** MISMATCH ***` lines.

1. Open the comp (mainComp). Make it the active item.
2. `Window > GegenschussShotRoundtrip > ⌕ Dump Source-Range Chain`
   (or `File > Scripts > Run Script File…` →
   `dump_source_range_chain.jsx`).
3. Tag the snapshot — e.g. `before`, `after_v6`, `after_bake`.
4. Set handle frames to match the roundtrip's setting (default 50).
5. Snapshot lands next to the `.aep` as
   `source_chain_<compName>_<tag>.txt`.
6. Repeat after the next pipeline step.

### What's captured

**Pass 1 — per top-level layer in the active comp:**

- Layer name, source, in/out/startTime/stretch
- Step-by-step trace through every nested precomp:
  - Time-effect at this level (`stretch=N%`, or `time-remap (K keys,
    DIRECTION)` with all keyframes dumped as `t=… v=…`)
  - Comp-time window entering this level
  - Source-time window leaving this level
  - `[REVERSED]` tag if direction flipped at this step
- At the deepest **footage** layer:
  - Source file name + source duration
  - Visible source frame range `[a, b]` (with frame counts)
  - Direction (`FORWARD` / `REVERSE`)
  - Expected plate range with `handleFrames` of leading + trailing
    handle, clamped to source duration
  - `*** WARNING` lines if either handle is short of the requested
    handleFrames

**Pass 2 — every `*_stack` precomp in the project:**

- Stack duration, frame rate, cut markers, head/tail handle
- Per AVLayer in the stack: source, startTime, in/out, stretch,
  source frame range covered
- Cross-referenced against Pass 1's expected plate range:
  - `✓ matches expected plate range` when a stack's footage layer
    covers the right source frames
  - `*** MISMATCH ***` lines when a stack was extracted from the
    wrong source range — with delta-start / delta-end so it's clear
    which way it drifted

### Example workflow

```
# 1. Open the original .aep, run diagnostic, tag "before"
# 2. Run roundtrip, save as _v06
# 3. Open the v06 .aep, run diagnostic, tag "after_v6"

diff source_chain_mainComp_before.txt source_chain_mainComp_after_v6.txt
```

Or open both side-by-side in any text-diff tool (BBEdit, Kaleidoscope,
VS Code). Look for Pass 2 mismatches first — they directly point at
broken plates.

### Sending the dump for help

When asking me to debug, attach both `_before.txt` and `_after_<v>.txt`.
No screenshots needed — the text shows exact key times, values,
interpolation modes, and source frame ranges at every chain level.

## `dump_deep_inspect.jsx`

Kitchen-sink AE state dumper.  Companion to the source-range chain
script above — that one focuses on the chain math (cut → plate
range), this one tells you everything else.  Use when "wait, where
did my effect go?" or "what frame is on screen at master t=23.36?"
needs a definitive answer.

### What it captures

Per layer (recursively, for the active comp + every nested precomp):

- in/out/startTime/stretch (4-decimal seconds)
- All flags: enabled, solo, guide, adjustment, locked, shy, hasVideo,
  hasAudio, label, blendingMode, threeDLayer, motionBlur, frameBlending
- Parent layer (or none)
- Source: file path for footage; precomp name + duration for precomps
- Transform values: anchor, position, scale, rotation, opacity (current
  values, not just expressions)
- Time-remap state + every keyframe with FULL ease info (in/out
  interpolation type, in/out temporal-ease speed + influence)
- Layer markers (with full metadata: comment, duration, label, cuePoint)
- Every Effect: name, matchName, enabled state, first 12 sub-property
  values + any expressions on those sub-properties
- Expressions on Anchor Point / Position / Scale / Rotation / Opacity
  / Time Remap

Per comp: name, duration, frameRate, frameDuration, displayStartTime,
work area, comp markers (with full metadata).

### Per-frame source trace

After the state dump, for every top-level visible layer, walks the
chain to deepest footage and samples the master timeline at every
Nth frame in `[cut_in - handle, cut_out + handle]`.  For each sample
prints the source time + source frame at every chain step plus the
final footage frame.

So instead of inferring "at master t=23.36 we should see C2479 frame
~190" from the chain math, the trace prints it explicitly:

```
master_t (s)  | master_f  | step[0] s    f      | step[1] s    f
0.0000        |    0      | 0.0000   0          | 190.5600 4764
0.0400        |    1      | 0.0400   1          | 190.5600 4764
0.0800        |    2      | 0.0800   2          | 190.5600 4764
...
```

Then you can pin down which chain step is producing the wrong frame.

### Protocol

Run this on the original (pre-roundtrip) project to capture
ground-truth — what frame the master cut WAS showing.  Then run on
the roundtripped project to see what the roundtrip produced.  Diff
or eyeball.

1. Open the comp.
2. `Window > GegenschussShotRoundtrip > ⊕ Deep Inspect`.
3. Tag, set handle frames + frame-trace step (1 = every frame, 5 =
   every 5th).
4. Snapshot lands next to the `.aep` as
   `deep_inspect_<compName>_<tag>.txt`.
