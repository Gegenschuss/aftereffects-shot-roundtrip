/**
 * switch_variant.jsx
 *
 * Per-shot variant switcher.  For each selected mainComp shot
 * `_container` layer, toggles which footage in the corresponding
 * `_stack` is the active source — `{shot}_plate.mov` (the forward
 * render) ↔ `{shot}_reversed.mov` (the bake variant) — AND flips the
 * container's time-remap values around the plate-range midpoint at
 * the same time so the cut keeps playing the same beats at the same
 * master times.  Click once to swap, click again to swap back.
 *
 * Why this exists:
 *
 *   The source-frame-first roundtrip writes a DESCENDING time-remap
 *   on `{shot}_comp` (the inner layer of `{shot}_container`) for any
 *   reversed cut.  Default state: `_plate.mov` enabled, `_reversed.mov`
 *   disabled.  The container plays the forward plate backward via the
 *   descending time-remap → the cut visual matches the original
 *   reverse-playback cut.
 *
 *   The Bake step renders `_reversed.mov` as the time-mirror of
 *   `_plate.mov`.  Flipping the active variant to `_reversed.mov`
 *   without changing anything else would DOUBLE-REVERSE the visual:
 *   container plays `_reversed.mov` backward → forward content of the
 *   already-time-reversed file → forward visual (wrong direction).
 *
 *   The fix: when the user wants `_reversed.mov` to be active, also
 *   flip the container's time-remap from descending to ascending.
 *   The flip is a mirror around `(ppLayer.startTime + ppLayer.outPoint)`
 *   — the plate-range midpoint in shotComp's source-frame domain —
 *   not the simple `srcDur - oldV` mirror that the old roundtrip's
 *   bake-flip used (that one assumed a different stack positioning).
 *
 *   This script does the swap atomically so diff-key A/B is one
 *   click.  Same content shows on screen either way; only the source
 *   file feeding the cut changes.
 *
 * Usage:
 *
 *   1. Open mainComp.
 *   2. Select one or more `shot_NNN_container` layers.
 *   3. Click `Switch Variant` in the panel (or run this script
 *      directly).
 *
 * Skips:
 *
 *   - selected layers that aren't `_container` precomps
 *   - shots without a `_reversed.mov` in the stack (Bake hasn't run)
 *   - shots with no time-remap on the inner layer (forward-only cuts;
 *     the variant swap still happens but no time-remap flip is needed)
 */

(function () {

    if (!app.project || !app.project.activeItem ||
        !(app.project.activeItem instanceof CompItem)) {
        alert("Open mainComp first, then select one or more shot_NNN_container layers.");
        return;
    }
    var mainComp = app.project.activeItem;

    var sel = mainComp.selectedLayers || [];
    if (sel.length === 0) {
        alert("Select one or more shot_NNN_container layers in mainComp first.");
        return;
    }

    app.beginUndoGroup("Switch Variant (plate ↔ reversed)");

    var ok = [];
    var skipped = [];

    try {
        for (var i = 0; i < sel.length; i++) {
            var lyr = sel[i];
            var why = togglePerShot(lyr);
            if (why === null) ok.push(lyr.name);
            else               skipped.push(lyr.name + " — " + why);
        }
    } catch (e) {
        alert("Error: " + e.toString() + (e.line ? "  (line " + e.line + ")" : ""));
    } finally {
        app.endUndoGroup();
    }

    var msg = "Switched " + ok.length + " shot" + (ok.length === 1 ? "" : "s");
    if (ok.length)      msg += ":\n  " + ok.join("\n  ");
    if (skipped.length) msg += "\n\nSkipped " + skipped.length + ":\n  " + skipped.join("\n  ");
    alert(msg);


    // ─────────────────────────────────────────────────────────────────
    // Per-shot worker — returns null on success, otherwise a string
    // describing why the toggle was skipped for this layer.
    // ─────────────────────────────────────────────────────────────────
    function togglePerShot(containerLayer) {

        // Validate: must be a *_container precomp layer
        if (!(containerLayer.source instanceof CompItem)) return "not a precomp layer";
        if (!/_container(?:_OS)?$/.test(containerLayer.source.name)) return "source is not a *_container";

        var containerComp = containerLayer.source;
        if (containerComp.numLayers < 1) return "container precomp is empty";

        // The inner layer in containerComp is what actually carries the
        // time-remap that maps mainComp time → shotComp source frame.
        var containerInner = containerComp.layer(1);
        if (!containerInner || !(containerInner.source instanceof CompItem)) return "inner layer source is not a precomp";

        var shotComp = containerInner.source;
        if (!/_comp(?:_OS)?$/.test(shotComp.name)) return "inner source is not a *_comp";

        // Find the ppLayer (the *_stack precomp layer) inside shotComp.
        // Its startTime + outPoint give the plate-range bounds in
        // shotComp's source-frame domain — exactly the values we need
        // to mirror the time-remap around.
        var ppLayer = null;
        for (var pi = 1; pi <= shotComp.numLayers; pi++) {
            var pl;
            try { pl = shotComp.layer(pi); } catch (eP) { continue; }
            if (pl && pl.source instanceof CompItem &&
                /_stack(?:_OS)?$/.test(pl.source.name)) {
                ppLayer = pl;
                break;
            }
        }
        if (!ppLayer) return "no *_stack layer in " + shotComp.name;
        var stackComp = ppLayer.source;

        var plateLo = ppLayer.startTime;
        var plateHi = ppLayer.outPoint;
        var midSum  = plateLo + plateHi;

        // Find the plate.mov + reversed.mov layers inside the stack.
        // We swap their `enabled` flags atomically.
        var plateLyr = null, reversedLyr = null;
        for (var sj = 1; sj <= stackComp.numLayers; sj++) {
            var sl;
            try { sl = stackComp.layer(sj); } catch (eS) { continue; }
            if (!sl || !sl.source || !sl.source.name) continue;
            if (!plateLyr    && /_plate\.mov$/.test(sl.source.name))    plateLyr    = sl;
            if (!reversedLyr && /_reversed\.mov$/.test(sl.source.name)) reversedLyr = sl;
        }
        if (!reversedLyr) return "no _reversed.mov in " + stackComp.name + " — run Bake first";

        // Toggle enabled flags.  After this:
        //   plate enabled → disabled, reversed disabled → enabled (or vice versa)
        if (plateLyr)    { try { plateLyr.enabled    = !plateLyr.enabled;    } catch (ePE) {} }
        if (reversedLyr) { try { reversedLyr.enabled = !reversedLyr.enabled; } catch (eRE) {} }

        // Forward-only cuts have no time-remap on containerInner; the
        // variant swap doesn't need a remap flip.  Just leave keys
        // alone.
        var trEn = false;
        try { trEn = !!containerInner.timeRemapEnabled; } catch (eTRen) {}
        if (!trEn) return null;

        var tr;
        try { tr = containerInner.property("Time Remap"); } catch (eTR) { return "couldn't read Time Remap"; }
        if (!tr) return null;
        var n = 0;
        try { n = tr.numKeys; } catch (eN) {}
        if (n < 2) return null;

        // Mirror every key value around the plate-range midpoint.
        // Clamp to shotComp.duration so AE doesn't reject negative or
        // out-of-comp values; in practice all values land cleanly
        // inside [plateLo, plateHi] when the original cut's chainKeys
        // were already clamped to source duration.
        var sDur = 0;
        try { sDur = shotComp.duration; } catch (eD) {}
        if (sDur <= 0) sDur = midSum;

        for (var k = 1; k <= n; k++) {
            var oldV;
            try { oldV = tr.keyValue(k); } catch (eKV) { continue; }
            var newV = midSum - oldV;
            if (newV < 0)     newV = 0;
            if (newV > sDur)  newV = sDur;
            try { tr.setValueAtKey(k, newV); } catch (eSV) {}
        }

        return null;
    }
})();
