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

    if (!app.project) {
        alert("Open a project first.");
        return;
    }

    // ─────────────────────────────────────────────────────────────────
    // Project scan: collect every *_container CompItem and analyse its
    // current variant state.
    // ─────────────────────────────────────────────────────────────────
    function detectShotState(containerComp) {
        // Returns { containerComp, shotName, bakeActive, hasBake,
        //          plateLyr, revLyr, bakeInner, ppLayer } or null on
        // structural error (so the row can be shown disabled).
        if (!containerComp || !(containerComp instanceof CompItem)) return null;
        if (containerComp.numLayers < 1) return null;
        var inner = containerComp.layer(1);
        if (!inner || !(inner.source instanceof CompItem)) return null;
        var shotComp = inner.source;

        // Find the *_stack ppLayer in shotComp
        var pp = null;
        for (var i = 1; i <= shotComp.numLayers; i++) {
            var l;
            try { l = shotComp.layer(i); } catch (e) { continue; }
            if (l && l.source instanceof CompItem &&
                /_stack(?:_OS)?$/.test(l.source.name)) {
                pp = l;
                break;
            }
        }
        if (!pp) return null;
        var stackComp = pp.source;

        // Find plate + reversed in the stack
        var plateLyr = null, revLyr = null;
        for (var j = 1; j <= stackComp.numLayers; j++) {
            var sl;
            try { sl = stackComp.layer(j); } catch (e) { continue; }
            if (!sl || !sl.source || !sl.source.name) continue;
            if (!plateLyr && /_plate\.mov$/.test(sl.source.name)) plateLyr = sl;
            if (!revLyr   && /_reversed\.mov$/.test(sl.source.name)) revLyr   = sl;
        }

        var hasBake = !!revLyr;
        var bakeActive = false;
        if (revLyr && revLyr.enabled && (!plateLyr || !plateLyr.enabled)) bakeActive = true;

        // Derive shot name from container name
        var shotName = containerComp.name.replace(/_container(?:_OS)?$/, "");

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
            // Exclude shots that don't have a _reversed.mov in their
            // stack — there's no variant to switch to, so they don't
            // belong in the dialog.  User runs Bake first to add the
            // reversed variant.
            if (st && st.hasBake) out.push(st);
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
        lbl.text = st.shotName + "   —   " + (st.bakeActive ? "bake active" : "plate active");
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
