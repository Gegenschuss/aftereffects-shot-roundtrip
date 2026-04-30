/**
 * dump_source_range_chain.jsx
 *
 * Source-frame-range tracer.  For every top-level visible layer in the
 * active comp, walk down through every nested precomp + time-effect
 * (stretch and/or time-remap) and report the FOOTAGE source frame range
 * the master cut should be showing.
 *
 * Why this script exists:
 *   The roundtrip's mapTimeToSource chain compounds time effects level
 *   by level.  When the math goes wrong in the middle of the chain
 *   (e.g. a stretch=-100 precomp wrapping another precomp), the symptom
 *   only shows up at render time as "wrong frames in the plate" or
 *   "1-frame visible range".  This script prints the full chain so the
 *   exact level where the math diverges is visible.
 *
 * What it prints, per top-level layer:
 *   - Layer name / kind / in / out / startTime / stretch / time-remap state
 *   - Step-by-step trace through every nested precomp:
 *       depth N  comp 'X' > layer 'Y'
 *         entering with t-window [tIn, tOut]
 *         time-effect: <none | stretch=Z | time-remap (K keys, dir)>
 *         leaving  with t-window [tIn', tOut']
 *   - At the deepest FOOTAGE layer:
 *       source file, source duration
 *       VISIBLE SOURCE FRAME RANGE: [a, b]  (s)  (a-b in frames)
 *       direction (FORWARD / REVERSE)
 *       expected plate range with 50f handles: [a-2s, b+2s]
 *
 * After the per-layer pass, scans the project for *_stack precomps and
 * prints what frame range each stack ACTUALLY covers (based on the
 * guide layer's startTime), so it can be compared with the expected
 * range above.  Mismatches are flagged with "*** MISMATCH ***".
 *
 * Run BEFORE the roundtrip to capture ground-truth (what the plate
 * should be); run AFTER to see what the script produced.  Diff the two
 * to localize the bug.
 *
 * No external dependencies.  Read-only.
 */

(function () {

    if (!app.project || !app.project.activeItem ||
        !(app.project.activeItem instanceof CompItem)) {
        alert("Open a comp first, then run this script.");
        return;
    }
    var topComp = app.project.activeItem;

    // ── Tag dialog ──────────────────────────────────────────────────────
    var w = new Window("dialog", "Dump source-range chain");
    w.alignChildren = ["fill", "top"];
    w.margins = 14; w.spacing = 8;
    w.add("statictext", undefined, "Tag for this snapshot (used in the filename):");
    var inp = w.add("edittext", undefined, "before");
    inp.preferredSize.width = 280;
    w.add("statictext", undefined, "Handle length (frames, used to compute expected plate range):");
    var inpH = w.add("edittext", undefined, "50");
    inpH.preferredSize.width = 80;
    var grp = w.add("group");
    grp.alignment = "right";
    var btnCancel = grp.add("button", undefined, "Cancel");
    var btnOK     = grp.add("button", undefined, "Save dump");
    btnOK.preferredSize     = [110, 24];
    btnCancel.preferredSize = [90,  24];
    btnOK.onClick     = function () { w.close(1); };
    btnCancel.onClick = function () { w.close(2); };
    if (w.show() !== 1) return;

    var tag         = (inp.text  || "snapshot").replace(/[^a-zA-Z0-9_-]/g, "_");
    var handleFrames = parseInt(inpH.text, 10);
    if (isNaN(handleFrames) || handleFrames < 0) handleFrames = 50;

    // ── Output buffer ───────────────────────────────────────────────────
    var lines = [];
    function L(s) { lines.push(s == null ? "" : String(s)); }
    function fmt(n, d) {
        if (typeof n !== "number" || isNaN(n)) return String(n);
        if (typeof d !== "number") d = 4;
        return n.toFixed(d);
    }
    function fr(t, fps) {  // seconds → frames @ fps, formatted
        if (typeof t !== "number" || isNaN(t)) return "?";
        return Math.round(t * fps) + "f";
    }
    function safeName(s) { return String(s || "").replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 60); }
    function pad(n, w) { var s=String(n); while(s.length<w) s=" "+s; return s; }
    function indent(d) { var s=""; for (var i=0;i<d;i++) s+="  "; return s; }

    L("# dump_source_range_chain.jsx");
    L("# tag:           " + tag);
    L("# date:          " + (new Date()).toString());
    L("# project:       " + (app.project.file ? app.project.file.fsName : "<unsaved>"));
    L("# top comp:      " + topComp.name + "  (" + topComp.frameRate + " fps)");
    L("# AE version:    " + app.version);
    L("# handleFrames:  " + handleFrames);
    L("");

    // ──────────────────────────────────────────────────────────────────
    // Time-effect classifier (mirrors shot_roundtrip's describeTimeEffect
    // closely enough to label the chain step).
    // ──────────────────────────────────────────────────────────────────
    function classifyTimeEffect(layer) {
        var info = { kind: "none", reversed: false, label: "(no time effect)",
                     stretch: 100, remapKeys: null, remapNumKeys: 0 };
        try { info.stretch = layer.stretch; } catch (e) {}
        var hasStretch = false, stretchRev = false;
        try { hasStretch = (Math.abs(layer.stretch - 100) > 0.01); stretchRev = (layer.stretch < 0); } catch (e) {}
        var hasRemap = false;
        try { hasRemap = !!layer.timeRemapEnabled; } catch (e) {}

        if (hasRemap) {
            var keys = [];
            try {
                var tr = layer.property("Time Remap");
                var n = tr.numKeys;
                info.remapNumKeys = n;
                for (var k = 1; k <= n; k++) {
                    keys.push({ t: tr.keyTime(k), v: tr.keyValue(k) });
                }
            } catch (e) {}
            info.remapKeys = keys;
            // Direction at the layer's cut window — sample at in/out.
            try {
                var trS = layer.property("Time Remap");
                var vIn  = trS.valueAtTime(layer.inPoint,  false);
                var vOut = trS.valueAtTime(layer.outPoint, false);
                info.reversed = (vOut < vIn - 1e-6);
            } catch (e) {}
            info.kind = info.reversed ? "time-remap-reverse" : "time-remap-forward";
            info.label = "time-remap (" + info.remapNumKeys + " keys, " +
                         (info.reversed ? "DESCENDING" : "ASCENDING") + ")";
        } else if (hasStretch) {
            info.kind = stretchRev ? "stretch-reverse" : "stretch-forward";
            info.reversed = stretchRev;
            info.label = "stretch=" + Math.round(layer.stretch) + "%" +
                         (stretchRev ? " REVERSED" : "");
        }
        return info;
    }

    // Map a single comp-time `t` through this layer's time effect.
    // Same semantics as shot_roundtrip.jsx mapTimeToSource.
    function mapOneTime(layer, t) {
        try {
            if (layer.timeRemapEnabled) {
                var tr = layer.property("ADBE Time Remapping");
                return tr.valueAtTime(t, false);
            }
        } catch (e) {}
        var stretch = 100;
        try { stretch = (layer.stretch !== 0) ? layer.stretch : 100; } catch (e) {}
        var startT = 0;
        try { startT = layer.startTime; } catch (e) {}
        return (t - startT) * (100 / stretch);
    }

    // ──────────────────────────────────────────────────────────────────
    // Walk a layer chain from outer to inner.  At each step, print the
    // before/after time window and the effect that transformed it.
    //
    // Returns { footage, srcRange } for the deepest footage hit, or
    // null if no footage was reached (e.g. the layer is a solid).
    // ──────────────────────────────────────────────────────────────────
    function walkChain(outerLayer, depth) {
        depth = depth || 0;
        var traceLines = [];

        var tIn  = 0, tOut = 0;
        try { tIn  = outerLayer.inPoint;  } catch (e) {}
        try { tOut = outerLayer.outPoint; } catch (e) {}
        if (tIn > tOut) { var sw = tIn; tIn = tOut; tOut = sw; }

        traceLines.push(indent(depth) + "ENTRY  layer '" + outerLayer.name + "'");
        traceLines.push(indent(depth) + "       comp-time window: [" +
                        fmt(tIn) + ", " + fmt(tOut) + "]  (" +
                        fmt(tOut - tIn) + "s)");

        return walkRecursive(outerLayer, tIn, tOut, depth, traceLines);
    }

    // Recursive worker.  `current` is the layer to descend into; tIn/tOut
    // are the comp-time bounds (in the comp containing `current`) we want
    // to know about.
    function walkRecursive(current, tIn, tOut, depth, traceLines) {
        if (!current) return null;

        var fx = classifyTimeEffect(current);
        traceLines.push(indent(depth) + "       time-effect: " + fx.label);
        if (fx.remapKeys && fx.remapKeys.length) {
            for (var ki = 0; ki < fx.remapKeys.length; ki++) {
                var kk = fx.remapKeys[ki];
                traceLines.push(indent(depth) + "         key " + (ki+1) +
                                ": t=" + fmt(kk.t) + " v=" + fmt(kk.v));
            }
        }

        // Apply this layer's time effect to map (tIn, tOut) into the
        // layer's source-time domain.
        var sIn  = mapOneTime(current, tIn);
        var sOut = mapOneTime(current, tOut);
        var sLo = Math.min(sIn, sOut), sHi = Math.max(sIn, sOut);

        traceLines.push(indent(depth) + "       → source-time window: [" +
                        fmt(sLo) + ", " + fmt(sHi) + "]  (" +
                        fmt(sHi - sLo) + "s)" +
                        (sIn > sOut ? "  [REVERSED]" : ""));

        // Reached a footage layer?
        var srcIsFile = false, srcIsComp = false;
        try {
            if (current.source) {
                if (current.source instanceof CompItem) srcIsComp = true;
                else if (current.source.mainSource && current.source.mainSource.file) srcIsFile = true;
            }
        } catch (e) {}

        if (srcIsFile) {
            traceLines.push(indent(depth) + "       FOOTAGE  '" + current.source.name +
                            "'  srcDur=" + fmt(current.source.duration) + "s");
            return {
                footageLayer: current,
                srcRange: { start: sLo, end: sHi, reversed: (sIn > sOut) },
                trace: traceLines
            };
        }

        if (!srcIsComp) {
            traceLines.push(indent(depth) + "       (non-precomp source — chain ends)");
            return { footageLayer: null, srcRange: null, trace: traceLines };
        }

        // Descend into the precomp.  The (sLo, sHi) values are now in the
        // precomp's local timeline.  Iterate every visible AVLayer inside
        // the precomp; the script's main loop ALSO iterates these, so we
        // mirror the same behavior for diagnostic fidelity.
        var subComp = current.source;
        traceLines.push(indent(depth) + "       PRECOMP  '" + subComp.name +
                        "'  dur=" + fmt(subComp.duration) + "s  " +
                        subComp.numLayers + " layers");

        var deepest = null;
        for (var li = 1; li <= subComp.numLayers; li++) {
            var sub = null;
            try { sub = subComp.layer(li); } catch (e) { continue; }
            if (!sub || !sub.hasVideo) continue;
            // Skip guide / null / adjustment layers — they're never the
            // footage we're trying to extract.
            try { if (sub.guideLayer) continue; } catch (e) {}
            try { if (sub.adjustmentLayer) continue; } catch (e) {}
            try { if (sub.nullLayer) continue; } catch (e) {}
            try { if (sub.source === null) continue; } catch (e) {}

            // Only descend into layers whose visible window overlaps the
            // (sLo, sHi) we care about.  Otherwise we'd recurse into
            // siblings that don't contribute to the master cut.
            var subInP = 0, subOutP = 0;
            try { subInP  = sub.inPoint;  } catch (e) {}
            try { subOutP = sub.outPoint; } catch (e) {}
            if (subInP > subOutP) { var sw = subInP; subInP = subOutP; subOutP = sw; }

            var overlapLo = Math.max(sLo, subInP);
            var overlapHi = Math.min(sHi, subOutP);
            if (overlapLo >= overlapHi - 1e-4) continue;  // no overlap

            traceLines.push(indent(depth + 1) + "DESCEND layer '" + sub.name +
                            "'  in=[" + fmt(subInP) + "," + fmt(subOutP) +
                            "]  overlap=[" + fmt(overlapLo) + "," + fmt(overlapHi) + "]");

            var hit = walkRecursive(sub, overlapLo, overlapHi, depth + 1, traceLines);
            if (hit && hit.footageLayer) {
                if (!deepest) deepest = hit;
                // Multiple footage layers may overlap (stacks).  Keep
                // them all (we only return the first for now; could
                // extend if needed).
            }
        }

        return deepest || { footageLayer: null, srcRange: null, trace: traceLines };
    }

    // ──────────────────────────────────────────────────────────────────
    // Pass 1: walk every top-level visible layer in the active comp.
    // ──────────────────────────────────────────────────────────────────
    L("=================================================================");
    L("=== Pass 1: source-range chain for each top-level layer");
    L("=================================================================");
    L("");

    var fps = topComp.frameRate;
    var handleSec = handleFrames / fps;

    // Capture per-top-layer expected ranges so Pass 2 can compare them
    // against actual *_stack contents.
    var expected = [];

    for (var ti = 1; ti <= topComp.numLayers; ti++) {
        var topL;
        try { topL = topComp.layer(ti); } catch (e) { continue; }
        if (!topL || !topL.hasVideo) continue;
        var skipReason = null;
        try { if (topL.guideLayer)      skipReason = "guide"; } catch (e) {}
        try { if (topL.adjustmentLayer) skipReason = "adjustment"; } catch (e) {}
        try { if (topL.nullLayer)       skipReason = "null"; } catch (e) {}
        if (skipReason) {
            L("Layer " + pad(ti, 3) + ": '" + topL.name + "'  [" + skipReason + " — skipped]");
            L("");
            continue;
        }

        L("Layer " + pad(ti, 3) + ": '" + topL.name + "'");
        try { L("  source:        '" + (topL.source ? topL.source.name : "<none>") + "'"); } catch (e) {}
        try {
            L("  inPoint:        " + fmt(topL.inPoint) +
              "  outPoint: " + fmt(topL.outPoint) +
              "  startTime: " + fmt(topL.startTime) +
              "  stretch: " + topL.stretch);
        } catch (e) {}

        var result = walkChain(topL, 1);
        if (result && result.trace) {
            for (var tl = 0; tl < result.trace.length; tl++) L(result.trace[tl]);
        }

        if (result && result.footageLayer && result.srcRange) {
            var fL = result.footageLayer;
            var sR = result.srcRange;
            // Plate range with handles, clamped to source duration.
            var srcDur = (fL.source && fL.source.duration) ? fL.source.duration : 0;
            var plateLo = Math.max(0,      sR.start - handleSec);
            var plateHi = Math.min(srcDur, sR.end   + handleSec);
            var leadingHandle  = sR.start - plateLo;
            var trailingHandle = plateHi  - sR.end;

            L("");
            L("  ── DEEPEST FOOTAGE: '" + fL.source.name + "' ─────────────");
            L("    visible source range:  [" + fmt(sR.start) + ", " + fmt(sR.end) + "]  (" +
              fmt(sR.end - sR.start) + "s, " + fr(sR.end - sR.start, fps) + ")");
            L("    direction:             " + (sR.reversed ? "REVERSE" : "FORWARD"));
            L("    source duration:       " + fmt(srcDur) + "s");
            L("    expected plate range:  [" + fmt(plateLo) + ", " + fmt(plateHi) + "]  (" +
              fmt(plateHi - plateLo) + "s, " + fr(plateHi - plateLo, fps) + ")");
            L("    leading handle:        " + fmt(leadingHandle) + "s  (" + fr(leadingHandle, fps) + ")");
            L("    trailing handle:       " + fmt(trailingHandle) + "s  (" + fr(trailingHandle, fps) + ")");
            if (leadingHandle  < handleSec - 1e-4) L("    *** WARNING: leading handle short of " + handleFrames + "f");
            if (trailingHandle < handleSec - 1e-4) L("    *** WARNING: trailing handle short of " + handleFrames + "f");

            expected.push({
                topLayerName:   topL.name,
                footageName:    fL.source.name,
                srcStart:       sR.start,
                srcEnd:         sR.end,
                reversed:       sR.reversed,
                plateStart:     plateLo,
                plateEnd:       plateHi,
                srcDur:         srcDur
            });
        } else {
            L("");
            L("  ── No footage reached (skipped or non-file source) ──");
        }
        L("");
    }

    // ──────────────────────────────────────────────────────────────────
    // Pass 2: scan project for *_stack precomps and report what footage
    // frame range they ACTUALLY cover.  Compare against the expected
    // plate ranges from Pass 1.
    // ──────────────────────────────────────────────────────────────────
    L("=================================================================");
    L("=== Pass 2: actual *_stack contents (compare with Pass 1)");
    L("=================================================================");
    L("");

    function findStackPrecomps() {
        var hits = [];
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (!(it instanceof CompItem)) continue;
            if (!/_stack(?:_OS)?$/.test(it.name)) continue;
            hits.push(it);
        }
        return hits;
    }

    function getCutMarkers(comp) {
        var inT = null, outT = null;
        try {
            if (comp.markerProperty && comp.markerProperty.numKeys > 0) {
                for (var mi = 1; mi <= comp.markerProperty.numKeys; mi++) {
                    var mt = comp.markerProperty.keyTime(mi);
                    var mv = comp.markerProperty.keyValue(mi);
                    var mc = (mv && mv.comment) ? String(mv.comment).toLowerCase() : "";
                    if      (mc.indexOf("cut in")  >= 0) inT  = mt;
                    else if (mc.indexOf("cut out") >= 0) outT = mt;
                }
            }
        } catch (e) {}
        return { inT: inT, outT: outT };
    }

    var stacks = findStackPrecomps();
    if (stacks.length === 0) {
        L("(no *_stack precomps found — run roundtrip first if you expect them)");
        L("");
    }

    for (var si = 0; si < stacks.length; si++) {
        var st = stacks[si];
        var mks = getCutMarkers(st);
        L("Stack: '" + st.name + "'  dur=" + fmt(st.duration) + "s  fps=" + st.frameRate);
        if (mks.inT !== null && mks.outT !== null) {
            var stackCutDur  = mks.outT - mks.inT;
            var stackHeadHnd = mks.inT;
            var stackTailHnd = st.duration - mks.outT;
            L("  cut markers:    in=" + fmt(mks.inT) + "  out=" + fmt(mks.outT) +
              "  cutDur=" + fmt(stackCutDur) + "  (" + fr(stackCutDur, st.frameRate) + ")");
            L("  head handle:    " + fmt(stackHeadHnd) + "s  (" + fr(stackHeadHnd, st.frameRate) + ")");
            L("  tail handle:    " + fmt(stackTailHnd) + "s  (" + fr(stackTailHnd, st.frameRate) + ")");
            if (Math.abs(stackHeadHnd - handleSec) > 1e-3) L("    *** stack head handle ≠ " + handleFrames + "f");
            if (Math.abs(stackTailHnd - handleSec) > 1e-3) L("    *** stack tail handle ≠ " + handleFrames + "f");
        } else {
            L("  cut markers:    (missing — expected 'cut in' and 'cut out')");
        }

        // Each AV layer in the stack: report what footage frame range it covers.
        for (var li = 1; li <= st.numLayers; li++) {
            var lyr;
            try { lyr = st.layer(li); } catch (e) { continue; }
            if (!lyr || !lyr.source) continue;
            var isFile = false;
            try { if (lyr.source.mainSource && lyr.source.mainSource.file) isFile = true; } catch (e) {}
            if (!isFile) {
                L("    layer " + pad(li, 2) + ": '" + lyr.name + "'  [" +
                  (lyr.source instanceof CompItem ? "Precomp" : "Other") + "]  (skipped)");
                continue;
            }
            var srcDurL = lyr.source.duration;
            // Source frames covered = (layer_in_in_stack - layer.startTime) to (layer_out_in_stack - layer.startTime),
            // adjusted for stretch (negative startTime = guide layer offset to align footage frames).
            var stretch  = 100;
            try { stretch = (lyr.stretch !== 0) ? lyr.stretch : 100; } catch (e) {}
            var lyrIn    = lyr.inPoint;
            var lyrOut   = lyr.outPoint;
            var lyrStart = lyr.startTime;
            // Source time at layer's inPoint / outPoint:
            var srcAtIn  = (lyrIn  - lyrStart) * (100 / stretch);
            var srcAtOut = (lyrOut - lyrStart) * (100 / stretch);
            var srcLo = Math.min(srcAtIn, srcAtOut), srcHi = Math.max(srcAtIn, srcAtOut);
            var role  = "";
            try { if (lyr.guideLayer)         role += " GUIDE";        } catch (e) {}
            try { if (!lyr.enabled)           role += " DISABLED";     } catch (e) {}
            L("    layer " + pad(li, 2) + ": '" + lyr.source.name + "'" + role +
              "  startTime=" + fmt(lyrStart) +
              "  in=" + fmt(lyrIn) + "  out=" + fmt(lyrOut) +
              "  stretch=" + Math.round(stretch));
            L("                   covers source: [" + fmt(srcLo) + ", " + fmt(srcHi) +
              "]  (srcDur=" + fmt(srcDurL) + ")");

            // Compare with Pass 1 expected plate range for this footage.
            for (var ei = 0; ei < expected.length; ei++) {
                var ex = expected[ei];
                if (ex.footageName !== lyr.source.name) continue;
                var dLo = Math.abs(ex.plateStart - srcLo);
                var dHi = Math.abs(ex.plateEnd   - srcHi);
                if (dLo > 0.04 || dHi > 0.04) {
                    L("                   *** MISMATCH vs Pass 1 for top layer '" + ex.topLayerName + "'");
                    L("                       expected plate range: [" + fmt(ex.plateStart) + ", " + fmt(ex.plateEnd) + "]");
                    L("                       actual               : [" + fmt(srcLo)         + ", " + fmt(srcHi)         + "]");
                    L("                       delta start: " + fmt(srcLo - ex.plateStart) +
                      "s   delta end: " + fmt(srcHi - ex.plateEnd) + "s");
                } else {
                    L("                   ✓ matches expected plate range for top layer '" + ex.topLayerName + "'");
                }
            }
        }
        L("");
    }

    // ── Save ────────────────────────────────────────────────────────────
    var saveDir;
    if (app.project.file) saveDir = app.project.file.parent;
    else                  saveDir = Folder.desktop;
    var fname = "source_chain_" + safeName(topComp.name) + "_" + tag + ".txt";
    var f = new File(saveDir.fsName + "/" + fname);
    f.encoding = "UTF-8";
    f.open("w");
    f.write(lines.join("\n"));
    f.close();

    alert("Wrote " + lines.length + " lines:\n\n" + f.fsName +
          "\n\nRun again with a different tag (e.g. 'after_v6') after the next step.");
})();
