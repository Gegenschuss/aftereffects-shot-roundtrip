# diagnostics/

Read-only inspection scripts for debugging the shot-roundtrip pipeline.
None of these mutate the project — they just dump state.

## `dump_deep_inspect.jsx`

Single-shot kitchen-sink dumper.  Captures every layer's full state
(effects, expressions, transforms, time-remap with ease info, markers,
flags, blend mode, parent linkage), every nested precomp, runs a
per-frame source-frame trace through every chain, scans the project
for `*_stack` precomps, and flags mismatches between what each stack
actually covers and what the chain math says it should cover.

Replaces the old `dump_source_range_chain.jsx` — Pass 3's mismatch
flagging is the same logic that script's Pass 2 used, just folded
into the larger dump.

### Protocol

Run *before* the roundtrip to capture ground-truth source ranges,
then *after* each version to see what the script produced.  Diff the
two text files; the `*** MISMATCH ***` lines in Pass 3 directly
localise broken plates.

1. Open the comp (mainComp).  Make it the active item.
2. `Window > GegenschussShotRoundtrip > ⊕ Deep Inspect`
   (or `File > Scripts > Run Script File…` → `dump_deep_inspect.jsx`).
3. Tag the snapshot — e.g. `before`, `after_v6`, `after_bake`.
4. Set handle frames to match the roundtrip's setting (default 50).
   Optionally: trace step (1 = every frame, 5 = every 5th frame —
   smaller files for big projects).
5. Snapshot lands next to the `.aep` as
   `deep_inspect_<compName>_<tag>.txt`.
6. Repeat after the next pipeline step.

### What's captured

**Pass 1 — full layer state, recursively for the active comp + every
nested precomp:**

- Layer name, source, in/out/startTime/stretch (4-decimal seconds)
- All flags: enabled, solo, guide, adjustment, locked, shy, hasVideo,
  hasAudio, label, blendingMode, threeDLayer, motionBlur,
  frameBlending, samplingQuality
- Parent layer (or none)
- Source: file path for footage; precomp name + duration for precomps
- Transform values: anchor, position, scale, rotation, opacity (CURRENT
  values, not just expressions)
- Time-remap state + every keyframe with FULL ease info (in/out
  interpolation type + temporal-ease speed + influence per key)
- Layer markers (with full metadata: comment, duration, label, cuePoint)
- Every effect: name, matchName, enabled, first 12 sub-property values
  + any expressions on those sub-properties
- Expressions on Anchor / Position / Scale / Rotation / Opacity / Time
  Remap

Per comp: name, duration, frameRate, frameDuration, displayStartTime,
work area, comp markers (full metadata).

**Pass 2 — per-frame source-frame trace, per top-level layer:**

For every top-level visible layer, walks the chain to deepest footage
and samples the master timeline at every Nth frame in
`[cut_in − handle, cut_out + handle]`.  For each sample prints the
source time + source frame at every chain step + the final footage
frame.

So instead of inferring "at master t=23.36 we should see C2479 frame
~190" from the chain math, the trace prints it explicitly:

```
master_t (s)  | master_f  | step[0] s    f      | step[1] s    f
0.9200        |    23     | 0.9200    23        | 190.5600 4764
0.9600        |    24     | 0.9600    24        | 190.5600 4764
0.9997        |    25     | 0.9997    25        | 190.5600 4764  <-- cut_in
1.0397        |    26     | 1.0397    26        | 190.4310 4761
...
```

Pass 2 also tracks min/max footage frame within the cut window so
Pass 3 can flag plate-range mismatches.

**Pass 3 — every `*_stack` precomp in the project:**

- Stack duration, frame rate, cut markers, head/tail handle
- Per AVLayer in the stack: source, startTime, in/out, stretch,
  source frame range covered
- Cross-referenced against Pass 2's expected plate range:
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

diff deep_inspect_mainComp_before.txt deep_inspect_mainComp_after_v6.txt
```

Or open both side-by-side in any text-diff tool (BBEdit, Kaleidoscope,
VS Code).  Look for `*** MISMATCH ***` lines in Pass 3 first — they
directly point at broken plates.  If no mismatches, work backward
through the per-frame trace in Pass 2 to find where chain math
diverges.

### Sending the dump for help

When asking me to debug, attach both `_before.txt` and `_after_<v>.txt`.
No screenshots needed — the text shows exact key times, values,
interpolation modes, and source frame ranges at every chain level.
