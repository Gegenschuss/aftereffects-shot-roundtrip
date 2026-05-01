/**
 * switch_variant.jsx
 *
 * Project-wide preflight dialog: lists every `*_container` in the
 * project with a checkbox showing which variant is currently active
 * (☐ = plate, ☑ = bake).  Click a row's checkbox to swap that shot's
 * active variant atomically (toggles enabled flags on plate.mov +
 * reversed.mov in the stack AND mirrors the container's time-remap
 * values around the plate-range midpoint so the cut keeps playing
 * the same content at the same master times).  UI updates the
 * instant the click happens — no re-render dance.
 *
 * Bulk buttons:
 *   - "All → Bake"  flips every plate-active shot to bake-active.
 *   - "All → Plate" flips every bake-active shot to plate-active.
 *   - "Refresh"     re-scans the project (in case you did something
 *                   manually that changed state).
 *
 * Skips:
 *   - containers without a `_reversed.mov` in the stack (Bake hasn't
 *     run for them) — listed but disabled.
 *   - containers without a recognisable plate.mov / reversed.mov
 *     pair — listed in a "could not detect" section.
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

    if (!app.project) {
        greyAlert("Switch Variant", "Open a project first.");
        return;
    }
    var proj = app.project;
    if (!proj.file) {
        greyAlert("Switch Variant", "Save the project first so it can be versioned before any changes.");
        return;
    }

    // ── version bump ─────────────────────────────────────────────────
    // Same VFX-versioning rule the other roundtrip tools use:
    // MyProject_v03.aep → MyProject_v04.aep before the first mutation.
    // Bumped once on script start so a single Switch Variant session
    // produces one new AEP regardless of how many rows the user clicks.
    function pad(n, s) { var str = "" + n; while (str.length < s) str = "0" + str; return str; }
    function saveAsNextVersion() {
        var cur = proj.file;
        if (!cur) return null;
        var baseName = cur.name.replace(/\.aep$/i, "");
        var m = baseName.match(/^(.*?)(_?v)(\d+)$/);
        var stem, prefix, width, next;
        if (m) {
            stem   = m[1];
            prefix = m[2];
            width  = m[3].length;
            next   = parseInt(m[3], 10) + 1;
        } else {
            stem   = baseName;
            prefix = "_v";
            width  = 2;
            next   = 1;
        }
        var newFile = null;
        while (next < 10000) {
            var candidate = new File(cur.parent.fsName + "/" + stem + prefix + pad(next, width) + ".aep");
            if (!candidate.exists) { newFile = candidate; break; }
            next++;
        }
        if (!newFile) {
            greyAlert("Switch Variant", "Could not find an unused version number for the backup copy.\nAborting so nothing is modified.");
            return null;
        }
        try {
            proj.save();
            proj.save(newFile);
        } catch (eSave) {
            greyAlert("Switch Variant", "Failed to save versioned copy —\n" + eSave.message +
                  "\n\nAborting so the original file stays untouched.");
            return null;
        }
        return newFile;
    }
    if (!saveAsNextVersion()) return;

    // ─────────────────────────────────────────────────────────────────
    // Project scan: collect every *_container CompItem and analyse its
    // current variant state.  Strict shot-name + structure match so
    // stale stacks from previous rounds don't show up in the dialog.
    // ─────────────────────────────────────────────────────────────────
    function findCompByName(name) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it;
            try { it = app.project.item(i); } catch (e) { continue; }
            if (it instanceof CompItem && it.name === name) return it;
        }
        return null;
    }
    function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

    function detectShotState(containerComp) {
        // Returns { containerComp, shotName, bakeActive, hasBake,
        //          plateLyr, revLyr, bakeInner, ppLayer } or null when
        // the shot doesn't have a clean wrap-path setup with a current-
        // round bake (= precomp-path shots are filtered too because
        // their bake-flip math requires a different chain layer than
        // containerInner — Switch Variant doesn't handle that yet).
        if (!containerComp || !(containerComp instanceof CompItem)) return null;
        if (containerComp.numLayers < 1) return null;

        // Strict by-name lookup of the matching *_comp + *_stack.
        var nameMatch = containerComp.name.match(/^(.+)_container(_OS)?$/);
        if (!nameMatch) return null;
        var shotName = nameMatch[1];
        var osSuffix = nameMatch[2] || "";

        var shotComp  = findCompByName(shotName + "_comp"  + osSuffix);
        var stackComp = findCompByName(shotName + "_stack" + osSuffix);
        if (!shotComp || !stackComp) return null;

        // containerInner must drive shotComp directly.  If
        // containerInner.source is some intermediate precomp instead
        // (i.e. precomp-path with chain.length > 2), the time-remap
        // that would need flipping lives at a different chain depth
        // than containerInner — out of scope for the simple flip we
        // do here.
        var inner = containerComp.layer(1);
        if (!inner || inner.source !== shotComp) return null;

        // Find ppLayer in shotComp (must point at stackComp by identity).
        var pp = null;
        for (var i = 1; i <= shotComp.numLayers; i++) {
            var l;
            try { l = shotComp.layer(i); } catch (e) { continue; }
            if (l && l.source === stackComp) { pp = l; break; }
        }
        if (!pp) return null;

        // Strict {shotName}_plate.mov / {shotName}_reversed.mov match
        // so OLD layers (e.g. shot_010_reversed.mov in a stack
        // belonging to shot_020) don't surface here.
        var plateRx = new RegExp("^" + escapeRx(shotName) + "_plate\\.mov$");
        var revRx   = new RegExp("^" + escapeRx(shotName) + "_reversed\\.mov$");
        var plateLyr = null, revLyr = null;
        for (var j = 1; j <= stackComp.numLayers; j++) {
            var sl;
            try { sl = stackComp.layer(j); } catch (e) { continue; }
            if (!sl || !sl.source || !sl.source.name) continue;
            if (!plateLyr && plateRx.test(sl.source.name)) plateLyr = sl;
            if (!revLyr   && revRx.test(sl.source.name))   revLyr   = sl;
        }

        var hasBake = !!revLyr;
        var bakeActive = false;
        if (revLyr && revLyr.enabled && (!plateLyr || !plateLyr.enabled)) bakeActive = true;

        return {
            containerComp: containerComp,
            shotComp:      shotComp,
            stackComp:     stackComp,
            shotName:      shotName,
            bakeActive:    bakeActive,
            hasBake:       hasBake,
            plateLyr:      plateLyr,
            revLyr:        revLyr,
            bakeInner:     inner,
            ppLayer:       pp
        };
    }
    function scan() {
        var out = [];
        for (var i = 1; i <= app.project.numItems; i++) {
            var it;
            try { it = app.project.item(i); } catch (e) { continue; }
            if (!(it instanceof CompItem)) continue;
            if (!/_container(?:_OS)?$/.test(it.name)) continue;
            var st = detectShotState(it);
            // List every wrap-path shot.  Shots without a _reversed.mov
            // appear with the checkbox disabled (nothing to switch to —
            // user runs Bake first to add the reversed variant).
            if (st) out.push(st);
        }
        out.sort(function (a, b) {
            var an = a.shotName.toLowerCase(), bn = b.shotName.toLowerCase();
            return an < bn ? -1 : (an > bn ? 1 : 0);
        });
        return out;
    }

    // ─────────────────────────────────────────────────────────────────
    // Per-shot flip — toggles enabled flags + mirrors time-remap values
    // around plate-range midpoint.  Idempotent.
    // ─────────────────────────────────────────────────────────────────
    function flipShot(state) {
        if (!state.hasBake) return false;
        var midSum = state.ppLayer.startTime + state.ppLayer.outPoint;

        if (state.plateLyr) { try { state.plateLyr.enabled = !state.plateLyr.enabled; } catch (e) {} }
        if (state.revLyr)   { try { state.revLyr.enabled   = !state.revLyr.enabled;   } catch (e) {} }

        if (state.bakeInner.timeRemapEnabled) {
            var tr;
            try { tr = state.bakeInner.property("Time Remap"); } catch (eTR) { return true; }
            var sDur = 0;
            try { sDur = state.shotComp.duration; } catch (eD) {}
            if (sDur <= 0) sDur = midSum;
            var n = 0;
            try { n = tr.numKeys; } catch (eN) {}
            for (var k = 1; k <= n; k++) {
                var oldV;
                try { oldV = tr.keyValue(k); } catch (eKV) { continue; }
                var newV = midSum - oldV;
                if (newV < 0)    newV = 0;
                if (newV > sDur) newV = sDur;
                try { tr.setValueAtKey(k, newV); } catch (eSV) {}
            }
        }

        // Update state to reflect new active variant
        state.bakeActive = !state.bakeActive;
        return true;
    }

    // Make a "set to specific state" helper so bulk buttons converge to
    // a known target rather than blindly toggling (which would double-
    // flip already-correct shots).
    function setShotState(state, wantBake) {
        if (!state.hasBake) return false;
        if (state.bakeActive === wantBake) return false; // already there
        return flipShot(state);
    }

    // ─────────────────────────────────────────────────────────────────
    // UI
    // ─────────────────────────────────────────────────────────────────
    var w = new Window("dialog", "Switch Variant");
    w.orientation = "column";
    w.alignChildren = ["fill", "top"];
    w.spacing = 10;
    w.margins = 14;

    var hdr = w.add("statictext", undefined,
        "Toggle which variant is active in each shot's _stack:  ☐ plate (forward render)   ☑ bake (reversed variant)");
    hdr.preferredSize.width = 600;

    var rowsPanel = w.add("panel", undefined, "Shots");
    rowsPanel.orientation = "column";
    rowsPanel.alignChildren = ["fill", "top"];
    rowsPanel.margins = [10, 12, 10, 10];
    rowsPanel.spacing = 2;

    // Row state — maps shotName → { state, checkbox, labelText }
    var rowControls = [];

    function buildRows(states) {
        // Clear existing
        for (var c = rowsPanel.children.length - 1; c >= 0; c--) {
            try { rowsPanel.remove(rowsPanel.children[c]); } catch (eR) {}
        }
        rowControls = [];

        if (!states.length) {
            var none = rowsPanel.add("statictext", undefined,
                "No *_container precomps in the project. Run Shot Roundtrip first.");
            return;
        }

        for (var i = 0; i < states.length; i++) {
            (function (idx, st) {
                var row = rowsPanel.add("group");
                row.orientation = "row";
                row.alignChildren = ["left", "center"];
                row.spacing = 8;

                var cb = row.add("checkbox", undefined, "");
                cb.value = st.bakeActive;
                cb.preferredSize.width = 20;

                var lbl = row.add("statictext", undefined, "");
                lbl.preferredSize.width = 480;
                redrawLabel(lbl, st);

                if (!st.hasBake) {
                    cb.enabled = false;
                    lbl.graphics.foregroundColor = lbl.graphics.newPen(
                        lbl.graphics.PenType.SOLID_COLOR, [0.55, 0.55, 0.55, 1], 1);
                }

                cb.onClick = function () {
                    if (!st.hasBake) { cb.value = false; return; }
                    app.beginUndoGroup("Switch Variant — " + st.shotName);
                    var ok = flipShot(st);
                    app.endUndoGroup();
                    if (!ok) {
                        cb.value = st.bakeActive; // revert visual state
                        return;
                    }
                    // cb.value already matches new state because the
                    // user click set it; just refresh the label and
                    // force a layout pass so the static text repaints
                    // immediately on macOS Aqua.
                    cb.value = st.bakeActive;
                    redrawLabel(lbl, st);
                    forceUpdate(w);
                };

                rowControls.push({ state: st, cb: cb, lbl: lbl });
            })(i, states[i]);
        }
    }

    function redrawLabel(lbl, st) {
        var status;
        if (!st.hasBake)        status = "plate active  (no reversed variant — run Bake first)";
        else if (st.bakeActive) status = "bake active";
        else                    status = "plate active";
        lbl.text = st.shotName + "   —   " + status;
    }

    // Force ScriptUI to repaint immediately so the user sees state
    // changes the instant the click lands, not after they tap another
    // control.  layout(true) re-flows children; update() walks the
    // window's invalidation list.
    function forceUpdate(win) {
        try { win.layout.layout(true); } catch (e1) {}
        try { win.update(); } catch (e2) {}
    }

    // Bulk + close buttons
    var btnRow = w.add("group");
    btnRow.orientation = "row";
    btnRow.alignment = ["fill", "bottom"];
    btnRow.alignChildren = ["left", "center"];
    btnRow.spacing = 6;
    btnRow.margins = [0, 6, 0, 0];

    var btnAllBake = btnRow.add("button", undefined, "All → Bake");
    btnAllBake.preferredSize = [110, 24];
    btnAllBake.helpTip = "Set every bake-able shot to bake-active";

    var btnAllPlate = btnRow.add("button", undefined, "All → Plate");
    btnAllPlate.preferredSize = [110, 24];
    btnAllPlate.helpTip = "Set every shot to plate-active";

    var btnRefresh = btnRow.add("button", undefined, "Refresh");
    btnRefresh.preferredSize = [90, 24];
    btnRefresh.helpTip = "Rescan the project (use if you toggled enable flags manually)";

    var spacer = btnRow.add("statictext", undefined, "");
    spacer.alignment = ["fill", "center"];

    var btnClose = btnRow.add("button", undefined, "Close");
    btnClose.preferredSize = [90, 24];

    function applyBulk(wantBake) {
        app.beginUndoGroup("Switch Variant — All " + (wantBake ? "Bake" : "Plate"));
        var changed = 0;
        for (var i = 0; i < rowControls.length; i++) {
            var rc = rowControls[i];
            if (setShotState(rc.state, wantBake)) {
                rc.cb.value = rc.state.bakeActive;
                redrawLabel(rc.lbl, rc.state);
                changed++;
            }
        }
        app.endUndoGroup();
        forceUpdate(w);
    }

    btnAllBake.onClick  = function () { applyBulk(true); };
    btnAllPlate.onClick = function () { applyBulk(false); };
    btnRefresh.onClick  = function () { buildRows(scan()); forceUpdate(w); };
    btnClose.onClick    = function () { w.close(); };

    // Initial population
    buildRows(scan());

    w.center();
    w.show();
})();
