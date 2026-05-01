/**
 * dump_deep_inspect.jsx
 *
 * Kitchen-sink AE comp + layer state dumper.  Companion to
 * dump_source_range_chain.jsx — that script focuses on the chain math
 * (cut → plate range), THIS script tells you everything else: effects,
 * expressions, transforms, layer markers (with full metadata), source
 * file paths, comp-level metadata, AND a per-frame source-frame trace
 * so you can see exactly what footage frame is on screen at every
 * master frame in the cut + handles.
 *
 * Use cases:
 *   - "Why didn't my effects come over?" → check the EFFECTS block
 *     on every layer in the chain.  If an expected effect isn't on
 *     the layer the script wrapped, it's stripped (or never moved).
 *   - "What frame of C2479 is showing at master t=23.36?" → read the
 *     per-frame trace; it samples every master frame and projects it
 *     through every chain step to the footage.
 *   - "Did precompose preserve my layer markers?" → the marker dump
 *     captures full marker metadata (time, duration, comment, label,
 *     cuePoint, parameters).
 *   - "Is the time-remap eased or LINEAR?" → key dump shows both in/
 *     out interpolation type AND ease speed/influence per key.
 *
 * Output goes to source_deep_<compName>_<tag>.txt next to the .aep
 * (or to Desktop if the project is unsaved).
 *
 * Read-only.  No project mutations.
 */

(function () {

    // Grey ScriptUI dialog — replaces alert() so messages render in AE's
    // dark panel theme instead of the macOS system alert with the Ae app
    // icon slapped on top.
    function greyAlert(title, msg) {
        var dlg = new Window("dialog", title);
        dlg.orientation = "column"; dlg.alignChildren = ["fill", "top"];
        dlg.spacing = 10; dlg.margins = 14;
        var p = dlg.add("panel", undefined, "");
        p.orientation = "column"; p.alignChildren = ["fill", "top"];
        p.margins = [12, 12, 12, 12]; p.spacing = 4;
        var lines = String(msg).split("\n");
        for (var i = 0; i < lines.length; i++) {
            p.add("statictext", undefined, lines[i]);
        }
        var bg = dlg.add("group");
        bg.orientation = "row"; bg.alignment = ["fill", "bottom"];
        bg.add("statictext", undefined, "").alignment = ["fill", "center"];
        var ok = bg.add("button", undefined, "OK", { name: "ok" });
        ok.preferredSize = [90, 28];
        ok.onClick = function () { dlg.close(1); };
        dlg.show();
    }

    if (!app.project || !app.project.activeItem ||
        !(app.project.activeItem instanceof CompItem)) {
        greyAlert("Deep Inspect", "Open a comp first, then run this script.");
        return;
    }
    var topComp = app.project.activeItem;

    // ── Tag dialog ──────────────────────────────────────────────────────
    var w = new Window("dialog", "Deep inspect");
    w.alignChildren = ["fill", "top"];
    w.margins = 14; w.spacing = 8;
    w.add("statictext", undefined, "Tag for this snapshot:");
    var inp = w.add("edittext", undefined, "deep");
    inp.preferredSize.width = 280;
    w.add("statictext", undefined, "Handle length (frames, for the per-frame trace window):");
    var inpH = w.add("edittext", undefined, "50");
    inpH.preferredSize.width = 80;
    w.add("statictext", undefined, "Frame-trace step (1 = every frame, 5 = every 5th frame):");
    var inpStep = w.add("edittext", undefined, "1");
    inpStep.preferredSize.width = 80;
    var grp = w.add("group");
    grp.alignment = "right";
    var btnCancel = grp.add("button", undefined, "Cancel");
    var btnOK     = grp.add("button", undefined, "Save dump");
    btnOK.preferredSize     = [110, 24];
    btnCancel.preferredSize = [90,  24];
    btnOK.onClick     = function () { w.close(1); };
    btnCancel.onClick = function () { w.close(2); };
    if (w.show() !== 1) return;

    var tag = (inp.text || "deep").replace(/[^a-zA-Z0-9_-]/g, "_");
    var handleFrames = parseInt(inpH.text, 10);
    if (isNaN(handleFrames) || handleFrames < 0) handleFrames = 50;
    var frameStep = parseInt(inpStep.text, 10);
    if (isNaN(frameStep) || frameStep < 1) frameStep = 1;

    // ── Output buffer ───────────────────────────────────────────────────
    var lines = [];
    function L(s) { lines.push(s == null ? "" : String(s)); }
    function fmt(n, d) {
        if (typeof n !== "number" || isNaN(n)) return String(n);
        if (typeof d !== "number") d = 4;
        return n.toFixed(d);
    }
    function pad(n, w) { var s = String(n); while (s.length < w) s = " " + s; return s; }
    function indent(d) { var s = ""; for (var i = 0; i < d; i++) s += "  "; return s; }
    function safeName(s) { return String(s || "").replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 60); }

    function blendModeName(mode) {
        try {
            for (var k in BlendingMode) {
                if (BlendingMode[k] === mode) return k;
            }
        } catch (e) {}
        return "?(" + mode + ")";
    }
    function interpName(t) {
        try {
            if (t === KeyframeInterpolationType.LINEAR) return "linear";
            if (t === KeyframeInterpolationType.BEZIER) return "bezier";
            if (t === KeyframeInterpolationType.HOLD)   return "hold";
        } catch (e) {}
        return "?(" + t + ")";
    }
    function classifyLayer(lyr) {
        try { if (lyr instanceof CameraLayer) return "Camera"; } catch (e) {}
        try { if (lyr instanceof LightLayer)  return "Light";  } catch (e) {}
        try { if (lyr instanceof TextLayer)   return "Text";   } catch (e) {}
        try { if (lyr instanceof ShapeLayer)  return "Shape";  } catch (e) {}
        try { if (lyr.nullLayer)              return "Null";   } catch (e) {}
        try { if (lyr.adjustmentLayer)        return "Adjust"; } catch (e) {}
        try { if (lyr.source instanceof CompItem) return "Precomp"; } catch (e) {}
        try {
            if (lyr.source && lyr.source.mainSource) {
                if (lyr.source.mainSource instanceof SolidSource) return "Solid";
                if (lyr.source.mainSource instanceof FileSource)  return "Footage";
            }
        } catch (e) {}
        return "Layer";
    }

    L("# dump_deep_inspect.jsx");
    L("# tag:           " + tag);
    L("# date:          " + (new Date()).toString());
    L("# project:       " + (app.project.file ? app.project.file.fsName : "<unsaved>"));
    L("# top comp:      " + topComp.name + "  (" + topComp.frameRate + " fps)");
    L("# AE version:    " + app.version);
    L("# handleFrames:  " + handleFrames);
    L("# frameStep:     " + frameStep);
    L("");

    // ──────────────────────────────────────────────────────────────────
    // Time-effect helpers (mirror shot_roundtrip.jsx mapTimeToSource so
    // the per-frame trace lines up with what the script would compute).
    // ──────────────────────────────────────────────────────────────────
    function mapOneTime(layer, t) {
        try {
            if (layer.timeRemapEnabled) {
                return layer.property("ADBE Time Remapping").valueAtTime(t, false);
            }
        } catch (e) {}
        var stretch = 100;
        try { stretch = (layer.stretch !== 0) ? layer.stretch : 100; } catch (e) {}
        var startT = 0;
        try { startT = layer.startTime; } catch (e) {}
        var result = (t - startT) * (100 / stretch);
        // negative-stretch frame-anchor correction (matches shot_roundtrip)
        if (stretch < 0) {
            var fd = 1.0 / 25;
            try { if (layer.containingComp && layer.containingComp.frameDuration) fd = layer.containingComp.frameDuration; } catch (eFd) {}
            result -= fd;
        }
        return result;
    }

    // ──────────────────────────────────────────────────────────────────
    // EFFECTS dump for one layer
    // ──────────────────────────────────────────────────────────────────
    function dumpEffects(lyr, depth) {
        var prefix = indent(depth);
        var fxg;
        try { fxg = lyr.property("ADBE Effect Parade"); } catch (e) { return; }
        if (!fxg) return;
        var n = 0;
        try { n = fxg.numProperties; } catch (e) {}
        if (n === 0) {
            L(prefix + "  effects:        (none)");
            return;
        }
        L(prefix + "  effects:        " + n);
        for (var i = 1; i <= n; i++) {
            var fx;
            try { fx = fxg.property(i); } catch (eF) { continue; }
            if (!fx) continue;
            var fxName = "?", fxMatch = "?", fxEnabled = true;
            try { fxName = fx.name; } catch (e) {}
            try { fxMatch = fx.matchName; } catch (e) {}
            try { fxEnabled = fx.enabled; } catch (e) {}
            L(prefix + "    " + pad(i, 2) + ". '" + fxName + "'  [" + fxMatch + "]" +
              (fxEnabled ? "" : "  DISABLED"));

            // First few sub-properties so we can see effect parameters.
            var nSub = 0;
            try { nSub = fx.numProperties; } catch (e) {}
            for (var j = 1; j <= nSub && j <= 12; j++) {
                var sp;
                try { sp = fx.property(j); } catch (eSP) { continue; }
                if (!sp) continue;
                var spName = "?";
                try { spName = sp.name; } catch (e) {}
                var spVal = "";
                try {
                    var v = sp.value;
                    if (typeof v === "number") spVal = fmt(v);
                    else if (v && v.length != null) {
                        var arr = [];
                        for (var vi = 0; vi < v.length && vi < 6; vi++) arr.push(fmt(v[vi]));
                        spVal = "[" + arr.join(", ") + "]";
                    } else if (typeof v === "string") {
                        spVal = "'" + v.substring(0, 80) + "'";
                    } else if (typeof v === "boolean") {
                        spVal = String(v);
                    } else if (v && v.fsName) {
                        spVal = "<File: " + v.fsName + ">";
                    } else {
                        spVal = "(" + typeof(v) + ")";
                    }
                } catch (eVal) { spVal = "(no value)"; }
                var hasExpr = false, exprTxt = "";
                try {
                    if (sp.canSetExpression && sp.expressionEnabled) {
                        hasExpr = true;
                        exprTxt = sp.expression || "";
                    }
                } catch (eE) {}
                L(prefix + "         " + spName + " = " + spVal +
                  (hasExpr ? "  [expr: " + exprTxt.replace(/\n/g, " ⏎ ").substring(0, 80) + "]" : ""));
            }
            if (nSub > 12) L(prefix + "         ... " + (nSub - 12) + " more sub-properties");
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // EXPRESSIONS dump on Transform + TimeRemap properties
    // ──────────────────────────────────────────────────────────────────
    function dumpExpressions(lyr, depth) {
        var prefix = indent(depth);
        var hits = [];
        function check(propPath, label) {
            try {
                var p = lyr.property(propPath);
                if (p && p.canSetExpression && p.expressionEnabled && p.expression) {
                    hits.push({ label: label, expr: p.expression });
                }
            } catch (e) {}
        }
        check("ADBE Transform Group->ADBE Anchor Point",      "Anchor Point");
        check("ADBE Transform Group->ADBE Position",           "Position");
        check("ADBE Transform Group->ADBE Scale",              "Scale");
        check("ADBE Transform Group->ADBE Rotate Z",           "Rotation");
        check("ADBE Transform Group->ADBE Opacity",            "Opacity");
        check("ADBE Time Remapping",                           "Time Remap");
        check("ADBE Layer Overrides->ADBE Layer Time Remap",   "Layer Time Remap");

        if (hits.length === 0) return;
        L(prefix + "  expressions:    " + hits.length);
        for (var i = 0; i < hits.length; i++) {
            var oneline = hits[i].expr.replace(/\n/g, " ⏎ ");
            if (oneline.length > 120) oneline = oneline.substring(0, 117) + "...";
            L(prefix + "    " + hits[i].label + ": " + oneline);
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // TRANSFORM values dump
    // ──────────────────────────────────────────────────────────────────
    function dumpTransform(lyr, depth) {
        var prefix = indent(depth);
        function v(propPath) {
            try {
                var p = lyr.property(propPath);
                if (!p) return null;
                return p.value;
            } catch (e) { return null; }
        }
        var ap   = v("ADBE Transform Group->ADBE Anchor Point");
        var pos  = v("ADBE Transform Group->ADBE Position");
        var sc   = v("ADBE Transform Group->ADBE Scale");
        var rot  = v("ADBE Transform Group->ADBE Rotate Z");
        var op   = v("ADBE Transform Group->ADBE Opacity");
        function fmtVec(x) {
            if (x == null) return "?";
            if (typeof x === "number") return fmt(x);
            var a = [];
            for (var i = 0; i < x.length; i++) a.push(fmt(x[i]));
            return "[" + a.join(", ") + "]";
        }
        L(prefix + "  transform:      anchor=" + fmtVec(ap) + "  position=" + fmtVec(pos) +
                                 "  scale=" + fmtVec(sc) + "  rotation=" + fmtVec(rot) +
                                 "  opacity=" + fmtVec(op));
    }

    // ──────────────────────────────────────────────────────────────────
    // TIME-REMAP keyframes (full ease info)
    // ──────────────────────────────────────────────────────────────────
    function dumpTimeRemap(lyr, depth) {
        var prefix = indent(depth);
        var on = false;
        try { on = !!lyr.timeRemapEnabled; } catch (e) {}
        L(prefix + "  timeRemap:      " + (on ? "ENABLED" : "off"));
        if (!on) return;
        var tr;
        try { tr = lyr.property("Time Remap"); } catch (e) { return; }
        if (!tr) return;
        var n = 0;
        try { n = tr.numKeys; } catch (e) {}
        L(prefix + "    keys:         " + n);
        for (var k = 1; k <= n; k++) {
            var kt = 0, kv = 0, kI = -1, kO = -1;
            try { kt = tr.keyTime(k);                 } catch (e) {}
            try { kv = tr.keyValue(k);                } catch (e) {}
            try { kI = tr.keyInInterpolationType(k);  } catch (e) {}
            try { kO = tr.keyOutInterpolationType(k); } catch (e) {}
            var ti = "", to = "";
            try {
                var ie = tr.keyInTemporalEase(k);
                if (ie && ie[0]) ti = "  in[s=" + fmt(ie[0].speed) + ",i=" + fmt(ie[0].influence) + "]";
            } catch (e) {}
            try {
                var oe = tr.keyOutTemporalEase(k);
                if (oe && oe[0]) to = "  out[s=" + fmt(oe[0].speed) + ",i=" + fmt(oe[0].influence) + "]";
            } catch (e) {}
            L(prefix + "      " + pad(k, 2) + ": t=" + fmt(kt) + "  v=" + fmt(kv) +
              "  interp=" + interpName(kI) + "/" + interpName(kO) + ti + to);
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // MARKERS (full metadata: comment, duration, label, cuePoint)
    // ──────────────────────────────────────────────────────────────────
    function dumpLayerMarkers(lyr, depth) {
        var prefix = indent(depth);
        try {
            var m = lyr.property("Marker");
            if (!m || !m.numKeys) return;
            L(prefix + "  layerMarkers:   " + m.numKeys);
            for (var i = 1; i <= m.numKeys; i++) {
                var t = 0, mv = null;
                try { t = m.keyTime(i); } catch (e) {}
                try { mv = m.keyValue(i); } catch (e) {}
                var c = (mv && mv.comment) ? mv.comment : "";
                var dur = (mv && typeof mv.duration === "number") ? mv.duration : 0;
                var lbl = (mv && typeof mv.label === "number") ? mv.label : 0;
                var cue = (mv && mv.cuePointName) ? mv.cuePointName : "";
                L(prefix + "    @ " + fmt(t) + "  '" + c + "'" +
                  (dur ? "  dur=" + fmt(dur) : "") +
                  (lbl ? "  label=" + lbl : "") +
                  (cue ? "  cue='" + cue + "'" : ""));
            }
        } catch (e) {}
    }
    function dumpCompMarkers(comp, depth) {
        var prefix = indent(depth);
        try {
            if (!comp.markerProperty || !comp.markerProperty.numKeys) return;
            L(prefix + "  compMarkers:    " + comp.markerProperty.numKeys);
            for (var i = 1; i <= comp.markerProperty.numKeys; i++) {
                var t = comp.markerProperty.keyTime(i);
                var mv = comp.markerProperty.keyValue(i);
                var c = (mv && mv.comment) ? mv.comment : "";
                var dur = (mv && typeof mv.duration === "number") ? mv.duration : 0;
                var lbl = (mv && typeof mv.label === "number") ? mv.label : 0;
                L(prefix + "    @ " + fmt(t) + "  '" + c + "'" +
                  (dur ? "  dur=" + fmt(dur) : "") +
                  (lbl ? "  label=" + lbl : ""));
            }
        } catch (e) {}
    }

    // ──────────────────────────────────────────────────────────────────
    // Comp-level info
    // ──────────────────────────────────────────────────────────────────
    function dumpCompHeader(comp, depth) {
        var prefix = indent(depth);
        L(prefix + "COMP: '" + comp.name + "'");
        try { L(prefix + "  duration:       " + fmt(comp.duration) + "s"); } catch (e) {}
        try { L(prefix + "  frameRate:      " + comp.frameRate + " fps  (frameDuration=" + fmt(1 / comp.frameRate) + "s)"); } catch (e) {}
        try { L(prefix + "  size:           " + comp.width + " x " + comp.height + "  par=" + fmt(comp.pixelAspect)); } catch (e) {}
        try { L(prefix + "  displayStartTime: " + fmt(comp.displayStartTime)); } catch (e) {}
        try { L(prefix + "  workArea:       start=" + fmt(comp.workAreaStart) + "  dur=" + fmt(comp.workAreaDuration)); } catch (e) {}
        try { L(prefix + "  numLayers:      " + comp.numLayers); } catch (e) {}
        dumpCompMarkers(comp, depth);
    }

    // ──────────────────────────────────────────────────────────────────
    // Source info
    // ──────────────────────────────────────────────────────────────────
    function dumpSource(src, depth) {
        var prefix = indent(depth);
        if (!src) {
            L(prefix + "  source:         <none>");
            return;
        }
        if (src instanceof CompItem) {
            L(prefix + "  source:         '" + src.name + "'  [Precomp]  dur=" + fmt(src.duration) + "s  fps=" + src.frameRate);
            return;
        }
        var path = "";
        try {
            if (src.mainSource && src.mainSource.file) path = src.mainSource.file.fsName;
        } catch (e) {}
        L(prefix + "  source:         '" + src.name + "'  [Footage]");
        try { L(prefix + "    duration:     " + fmt(src.duration) + "s"); } catch (e) {}
        try { L(prefix + "    frameRate:    " + src.frameRate + " fps"); } catch (e) {}
        try { L(prefix + "    size:         " + src.width + " x " + src.height); } catch (e) {}
        try { L(prefix + "    hasVideo/hasAudio: " + src.hasVideo + " / " + src.hasAudio); } catch (e) {}
        if (path) L(prefix + "    file:         " + path);
    }

    // ──────────────────────────────────────────────────────────────────
    // Layer dump (full)
    // ──────────────────────────────────────────────────────────────────
    function dumpLayer(lyr, depth, idxLabel) {
        var prefix = indent(depth);
        var typ = classifyLayer(lyr);
        L(prefix + "Layer " + idxLabel + ": '" + lyr.name + "'  [" + typ + "]");
        try { L(prefix + "  inPoint:        " + fmt(lyr.inPoint)); } catch (e) {}
        try { L(prefix + "  outPoint:       " + fmt(lyr.outPoint)); } catch (e) {}
        try { L(prefix + "  duration:       " + fmt(lyr.outPoint - lyr.inPoint) + "s"); } catch (e) {}
        try { L(prefix + "  startTime:      " + fmt(lyr.startTime)); } catch (e) {}
        try { L(prefix + "  stretch:        " + lyr.stretch + "%"); } catch (e) {}
        try {
            L(prefix + "  flags:          enabled=" + lyr.enabled +
                                    "  solo=" + lyr.solo +
                                    "  guide=" + lyr.guideLayer +
                                    "  adjust=" + lyr.adjustmentLayer +
                                    "  locked=" + lyr.locked +
                                    "  shy=" + lyr.shy +
                                    "  hasVideo=" + lyr.hasVideo +
                                    "  hasAudio=" + lyr.hasAudio);
        } catch (e) {}
        try {
            L(prefix + "  flags2:         label=" + lyr.label +
                                    "  blendingMode=" + blendModeName(lyr.blendingMode) +
                                    "  3D=" + lyr.threeDLayer +
                                    "  motionBlur=" + lyr.motionBlur +
                                    "  frameBlending=" + lyr.frameBlendingType);
        } catch (e) {}
        try { L(prefix + "  parent:         " + (lyr.parent ? "'" + lyr.parent.name + "'" : "<none>")); } catch (e) {}
        dumpSource(lyr.source, depth);
        dumpTransform(lyr, depth);
        dumpTimeRemap(lyr, depth);
        dumpLayerMarkers(lyr, depth);
        dumpEffects(lyr, depth);
        dumpExpressions(lyr, depth);
        L("");
    }

    // ──────────────────────────────────────────────────────────────────
    // PASS 1 — exhaustive dump of active comp + every nested precomp,
    // every layer, every effect, every marker.
    // ──────────────────────────────────────────────────────────────────
    L("=================================================================");
    L("=== Pass 1: full state dump (active comp + every nested precomp)");
    L("=================================================================");
    L("");

    var visited = {};
    function dumpCompTree(comp, depth, breadcrumb) {
        var key = "c" + (comp.id || comp.name);
        if (visited[key]) {
            L(indent(depth) + "(comp '" + comp.name + "' already dumped above; skipping recursion)");
            L("");
            return;
        }
        visited[key] = true;

        L(indent(depth) + "================================================");
        if (breadcrumb && breadcrumb.length) L(indent(depth) + "via:  " + breadcrumb.join(" > "));
        dumpCompHeader(comp, depth);
        L("");

        var precomps = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var lyr;
            try { lyr = comp.layer(i); } catch (e) { continue; }
            if (!lyr) continue;
            dumpLayer(lyr, depth + 1, pad(i, 3));
            try {
                if (lyr.source instanceof CompItem) {
                    precomps.push({ comp: lyr.source, layerName: lyr.name });
                }
            } catch (e) {}
        }
        for (var pi = 0; pi < precomps.length; pi++) {
            dumpCompTree(precomps[pi].comp, depth + 1,
                         (breadcrumb || []).concat([comp.name + " > " + precomps[pi].layerName]));
        }
    }
    dumpCompTree(topComp, 0, []);

    // ──────────────────────────────────────────────────────────────────
    // PASS 2 — per-frame source-frame trace
    //
    // For every top-level visible layer in the active comp, walks the
    // chain to deepest footage WITHOUT mutating anything, then samples
    // every Nth frame in [masterIn-handle, masterOut+handle] and prints
    // the source frame at every chain step + final footage frame.
    // ──────────────────────────────────────────────────────────────────
    L("");
    L("=================================================================");
    L("=== Pass 2: per-frame source-frame trace");
    L("=================================================================");
    L("");

    var fps = topComp.frameRate;
    var handleSec = handleFrames / fps;

    // Accumulator for Pass 3's mismatch flagging — for each top-level
    // layer, capture the deepest footage's name + the expected plate
    // range (visible source ± handles, clamped to source duration).
    var expected = [];

    function walkChainForTrace(masterLayer) {
        var chain = [];
        var current = masterLayer;
        var rawIn  = masterLayer.inPoint, rawOut = masterLayer.outPoint;
        var tIn  = Math.min(rawIn, rawOut);
        var tOut = Math.max(rawIn, rawOut);
        var sIn = rawIn, sOut = rawOut;
        while (true) {
            chain.push(current);
            sIn  = mapOneTime(current, sIn);
            sOut = mapOneTime(current, sOut);
            var sLo = Math.min(sIn, sOut), sHi = Math.max(sIn, sOut);
            var srcIsFile = false, srcIsComp = false;
            try {
                if (current.source) {
                    if (current.source instanceof CompItem) srcIsComp = true;
                    else if (current.source.mainSource && current.source.mainSource.file) srcIsFile = true;
                }
            } catch (e) {}
            if (srcIsFile) return { chain: chain, footage: current.source };
            if (!srcIsComp) return null;
            var subComp = current.source;
            var pick = null;
            for (var li = 1; li <= subComp.numLayers; li++) {
                var sub;
                try { sub = subComp.layer(li); } catch (e) { continue; }
                if (!sub || !sub.hasVideo) continue;
                try { if (sub.guideLayer || sub.adjustmentLayer || sub.nullLayer) continue; } catch (e) {}
                try { if (sub.source === null) continue; } catch (e) {}
                try { if (!sub.enabled) continue; } catch (e) {}
                var subInP = Math.min(sub.inPoint, sub.outPoint);
                var subOutP = Math.max(sub.inPoint, sub.outPoint);
                if (Math.max(sLo, subInP) >= Math.min(sHi, subOutP) - 1e-4) continue;
                pick = sub; break;
            }
            if (!pick) return null;
            current = pick;
        }
    }

    for (var ti = 1; ti <= topComp.numLayers; ti++) {
        var topL;
        try { topL = topComp.layer(ti); } catch (e) { continue; }
        if (!topL || !topL.hasVideo) continue;
        try { if (topL.guideLayer || topL.adjustmentLayer || topL.nullLayer) continue; } catch (e) {}
        if (!topL.source) continue;

        var walked = walkChainForTrace(topL);
        L("Layer " + pad(ti, 3) + ": '" + topL.name + "'");
        if (!walked) {
            L("  (no footage reached)");
            L("");
            continue;
        }
        var chain = walked.chain;
        var footage = walked.footage;
        var srcDur = footage.duration || 0;
        var srcFR  = footage.frameRate || 25;

        L("  chain (" + chain.length + " step" + (chain.length === 1 ? "" : "s") + "):");
        for (var ci = 0; ci < chain.length; ci++) {
            var cl = chain[ci];
            var ctype = "Layer";
            try {
                if (cl.source instanceof CompItem) ctype = "Precomp";
                else if (cl.source && cl.source.mainSource && cl.source.mainSource.file) ctype = "Footage";
            } catch (e) {}
            var stretchStr = "stretch=" + fmt(cl.stretch || 100, 1);
            var trStr = (cl.timeRemapEnabled ? "  time-remap" : "");
            L("    [" + ci + "] '" + cl.name + "'  [" + ctype + "]  " + stretchStr + trStr +
              "  startTime=" + fmt(cl.startTime));
        }
        L("  footage: '" + footage.name + "'  srcDur=" + fmt(srcDur) + "s  srcFR=" + fmt(srcFR, 2));
        try {
            if (footage.mainSource && footage.mainSource.file) {
                L("    file: " + footage.mainSource.file.fsName);
            }
        } catch (eF) {}

        var masterIn = Math.min(topL.inPoint, topL.outPoint);
        var masterOut = Math.max(topL.inPoint, topL.outPoint);
        var traceLo = Math.max(0, masterIn - handleSec);
        var traceHi = Math.min(topComp.duration, masterOut + handleSec);

        L("  trace window: master [" + fmt(traceLo) + ", " + fmt(traceHi) + "]  (cut [" +
          fmt(masterIn) + ", " + fmt(masterOut) + "])");

        // Header
        var hdr = "  master_t (s)  | master_f";
        for (var ch = 0; ch < chain.length; ch++) hdr += "  | step[" + ch + "] s    f";
        L(hdr);
        L("  " + (new Array(hdr.length - 2)).join("-"));

        var stepFrames = frameStep;
        var loFrame = Math.round(traceLo * fps);
        var hiFrame = Math.round(traceHi * fps);
        // Track min/max of the deepest source value across the cut
        // window for the Pass 3 mismatch comparison.
        var visMin = Infinity, visMax = -Infinity;
        var cutLo = Math.round(masterIn * fps);
        var cutHi = Math.round(masterOut * fps);
        for (var f = loFrame; f <= hiFrame; f += stepFrames) {
            var mt = f / fps;
            var marker = "";
            if (Math.abs(mt - masterIn)  < 1e-4) marker = "  <-- cut_in";
            if (Math.abs(mt - masterOut) < 1e-4) marker = "  <-- cut_out";
            var row = "  " + fmt(mt) + "  | " + pad(f, 7);
            // Project step by step
            var t = mt;
            for (var ci2 = 0; ci2 < chain.length; ci2++) {
                t = mapOneTime(chain[ci2], t);
                var fr = Math.round(t * srcFR); // approximate; final step uses footage fps
                row += "  | " + fmt(t) + "  " + pad(fr, 6);
            }
            row += marker;
            L(row);
            // Track visible source range only across the cut window
            // proper (handles excluded) so the expected plate range
            // reflects what the cut shows, not what the dynamicLink
            // wrapper extends to.
            if (f >= cutLo - 1 && f <= cutHi + 1) {
                if (t < visMin) visMin = t;
                if (t > visMax) visMax = t;
            }
        }
        L("");

        // Save expected plate range for Pass 3 cross-reference.
        if (visMin !== Infinity && visMax !== -Infinity) {
            var srcHandle = handleFrames / srcFR; // handle in source-time units
            var plateLo = Math.max(0,      visMin - srcHandle);
            var plateHi = Math.min(srcDur, visMax + srcHandle);
            expected.push({
                topLayerName: topL.name,
                footageName:  footage.name,
                plateStart:   plateLo,
                plateEnd:     plateHi,
                srcDur:       srcDur
            });
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // PASS 3 — *_stack inspection (same as dump_source_range_chain.jsx
    // Pass 2 — kept here so this single dump answers everything)
    // ──────────────────────────────────────────────────────────────────
    L("");
    L("=================================================================");
    L("=== Pass 3: *_stack precomp contents");
    L("=================================================================");
    L("");

    function getCutMarkers(comp) {
        var inT = null, outT = null;
        try {
            if (comp.markerProperty && comp.markerProperty.numKeys) {
                for (var i = 1; i <= comp.markerProperty.numKeys; i++) {
                    var mt = comp.markerProperty.keyTime(i);
                    var mv = comp.markerProperty.keyValue(i);
                    var c = (mv && mv.comment) ? String(mv.comment).toLowerCase() : "";
                    if (c.indexOf("cut in") >= 0) inT = mt;
                    else if (c.indexOf("cut out") >= 0) outT = mt;
                }
            }
        } catch (e) {}
        return { inT: inT, outT: outT };
    }
    var stacks = [];
    for (var pi = 1; pi <= app.project.numItems; pi++) {
        var it = app.project.item(pi);
        if (!(it instanceof CompItem)) continue;
        if (!/_stack(?:_OS)?$/.test(it.name)) continue;
        stacks.push(it);
    }
    if (stacks.length === 0) {
        L("(no *_stack precomps in project)");
        L("");
    }
    for (var si = 0; si < stacks.length; si++) {
        var st = stacks[si];
        var mks = getCutMarkers(st);
        L("Stack: '" + st.name + "'  dur=" + fmt(st.duration) + "s  fps=" + st.frameRate);
        if (mks.inT !== null && mks.outT !== null) {
            L("  cut markers: in=" + fmt(mks.inT) + "  out=" + fmt(mks.outT) +
              "  cutDur=" + fmt(mks.outT - mks.inT));
            L("  head handle: " + fmt(mks.inT));
            L("  tail handle: " + fmt(st.duration - mks.outT));
        }
        for (var li = 1; li <= st.numLayers; li++) {
            var lyr;
            try { lyr = st.layer(li); } catch (e) { continue; }
            if (!lyr || !lyr.source) continue;
            var role = "";
            try { if (lyr.guideLayer)  role += " GUIDE"; } catch (e) {}
            try { if (!lyr.enabled)    role += " DISABLED"; } catch (e) {}
            var stretch = 100;
            try { stretch = (lyr.stretch !== 0) ? lyr.stretch : 100; } catch (e) {}
            var srcAtIn  = (lyr.inPoint  - lyr.startTime) * (100 / stretch);
            var srcAtOut = (lyr.outPoint - lyr.startTime) * (100 / stretch);
            var srcLo = Math.min(srcAtIn, srcAtOut), srcHi = Math.max(srcAtIn, srcAtOut);
            var isFile = false;
            try { if (lyr.source.mainSource && lyr.source.mainSource.file) isFile = true; } catch (e) {}
            L("    " + pad(li, 2) + ": '" + lyr.source.name + "'" + role +
              "  startTime=" + fmt(lyr.startTime) +
              "  in=" + fmt(lyr.inPoint) + "  out=" + fmt(lyr.outPoint) +
              "  stretch=" + Math.round(stretch));
            if (isFile) {
                L("           covers source: [" + fmt(srcLo) + ", " + fmt(srcHi) +
                  "]  (srcDur=" + fmt(lyr.source.duration) + ")");
                // Cross-reference against Pass 2's expected plate ranges
                // and flag mismatches — same logic the old
                // dump_source_range_chain.jsx used in its Pass 2.
                for (var ei = 0; ei < expected.length; ei++) {
                    var ex = expected[ei];
                    if (ex.footageName !== lyr.source.name) continue;
                    var dLo = Math.abs(ex.plateStart - srcLo);
                    var dHi = Math.abs(ex.plateEnd   - srcHi);
                    if (dLo > 0.04 || dHi > 0.04) {
                        L("           *** MISMATCH vs Pass 2 expected plate range for top layer '" + ex.topLayerName + "'");
                        L("               expected: [" + fmt(ex.plateStart) + ", " + fmt(ex.plateEnd) + "]");
                        L("               actual:   [" + fmt(srcLo)         + ", " + fmt(srcHi)         + "]");
                        L("               delta:    start=" + fmt(srcLo - ex.plateStart) +
                          "  end=" + fmt(srcHi - ex.plateEnd));
                    } else {
                        L("           ✓ matches expected plate range for top layer '" + ex.topLayerName + "'");
                    }
                }
            }
        }
        L("");
    }

    // ── Save ────────────────────────────────────────────────────────────
    var saveDir;
    if (app.project.file) saveDir = app.project.file.parent;
    else                  saveDir = Folder.desktop;
    var fname = "deep_inspect_" + safeName(topComp.name) + "_" + tag + ".txt";
    var f = new File(saveDir.fsName + "/" + fname);
    f.encoding = "UTF-8";
    f.open("w");
    f.write(lines.join("\n"));
    f.close();

    greyAlert("Deep Inspect", "Wrote " + lines.length + " lines:\n\n" + f.fsName +
          "\n\nIncludes effects, expressions, transforms, layer markers, comp markers, source files, and a per-frame source-frame trace through every chain.");
})();
