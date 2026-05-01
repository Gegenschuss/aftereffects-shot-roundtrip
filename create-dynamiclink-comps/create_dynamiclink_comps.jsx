/*
 *       _____                          __
 *      / ___/__ ___ ____ ___  ___ ____/ /  __ _____ ___
 *     / (_ / -_) _ `/ -_) _ \(_-</ __/ _ \/ // (_-<(_-<
 *     \___/\__/\_, /\__/_//_/___/\__/_//_/\_,_/___/___/
 *             /___/
 */

/**
 * Create dynamicLink Comps (standalone)
 *
 * For each selected layer in the active comp whose source is a CompItem
 * (precomp) or an imported footage file, builds a new wrapper comp named
 * "<source>_dynamicLink" in /Shots/_dynamicLink with duration exactly
 * cut + 2 × handleFrames. Uses the proven extend → wrap → contract sequence
 * so time-remap / time-stretch layers get correct source offsets, and any
 * handle time lost to comp-edge clamping is padded with black automatically
 * (source out of range renders as black in AE).
 *
 * This mirrors the dynamicLink Build phase that runs at the end of the
 * main Shot Roundtrip script — use this standalone when a project is
 * already rendered and you just need to (re-)build the dynamicLink wrappers.
 *
 * Single undo step.
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

    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) {
        greyAlert("Create dynamicLink Comps", "Please open a composition first.");
        return;
    }

    var selected = comp.selectedLayers;
    if (selected.length === 0) {
        greyAlert("Create dynamicLink Comps", "Select at least one layer.");
        return;
    }

    // Filter to usable layers — comp source OR a real footage item.
    // Skips solids/shapes/text/nulls/cameras/lights.
    var targets = [];
    for (var i = 0; i < selected.length; i++) {
        var l = selected[i];
        var src = null;
        try { src = l.source; } catch (eSrc) { continue; }
        if (!src) continue;
        var ok = false;
        if (src instanceof CompItem) ok = true;
        else {
            try { if (src.mainSource && src.mainSource.file) ok = true; } catch (eFS) {}
        }
        if (ok) targets.push(l);
    }
    if (targets.length === 0) {
        greyAlert("Create dynamicLink Comps", "No selected layer points at a comp or a file footage item.");
        return;
    }

    // ── prompt for handle frames ───────────────────────────────────────────────

    var handleFrames = promptHandleFrames(50);
    if (handleFrames === null) return; // user cancelled

    // ── folders ────────────────────────────────────────────────────────────────

    var proj = app.project;

    // "cut in"/"cut out" markers use protectedRegion so time-remapping the
    // underlying layer doesn't drift the marker off its frame.
    function cutMarker(comment) { var m = new MarkerValue(comment); m.protectedRegion = true; return m; }

    function findChildFolder(parent, name) {
        for (var i = 1; i <= proj.numItems; i++) {
            var it = proj.item(i);
            if (it instanceof FolderItem && it.name === name && it.parentFolder === parent) return it;
        }
        return null;
    }
    function findOrCreateFolder(parent, name) {
        var existing = findChildFolder(parent, name);
        if (existing) return existing;
        var f = proj.items.addFolder(name);
        f.parentFolder = parent;
        return f;
    }

    var binShots   = findOrCreateFolder(proj.rootFolder, "Shots");
    var binDynLink = findOrCreateFolder(binShots, "_dynamicLink");

    // ── time mapping ───────────────────────────────────────────────────────────

    function mapTimeToSource(layer, compTime) {
        if (layer.timeRemapEnabled) {
            try { return layer.property("Time Remap").valueAtTime(compTime, false); } catch (e) {}
        }
        var stretch = (layer.stretch !== 0) ? layer.stretch : 100;
        return (compTime - layer.startTime) * (100 / stretch);
    }

    // ── version bump ───────────────────────────────────────────────────────────
    // Same VFX-versioning rule as Shot Roundtrip / Import Returns:
    // MyProject_v03.aep → MyProject_v04.aep before any mutation, so the
    // original file is the rollback point if anything goes sideways. If
    // the project hasn't been saved yet, abort — there's no anchor to
    // version off.
    if (!proj.file) {
        greyAlert("Create dynamicLink Comps", "Save the project first so it can be versioned before any changes.");
        return;
    }
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
            greyAlert("Create dynamicLink Comps", "Could not find an unused version number for the backup copy.\nAborting so nothing is modified.");
            return null;
        }
        try {
            proj.save();
            proj.save(newFile);
        } catch (eSave) {
            greyAlert("Create dynamicLink Comps", "Failed to save versioned copy —\n" + eSave.message +
                  "\n\nAborting so the original file stays untouched.");
            return null;
        }
        return newFile;
    }
    var versionedFile = saveAsNextVersion();
    if (!versionedFile) return;

    // ── build ──────────────────────────────────────────────────────────────────

    var handleSec = handleFrames / comp.frameRate;
    var built     = 0;
    var errors    = [];

    app.beginUndoGroup("Create dynamicLink Comps");

    try {
        for (var t = 0; t < targets.length; t++) {
            var layer = targets[t];
            var origIn, origOut;

            try {
                origIn  = layer.inPoint;
                origOut = layer.outPoint;
                var cutSec = origOut - origIn;

                // Step 1 — extend (captured-target pattern)
                var extTargetOut = Math.min(comp.duration, origOut + handleSec);
                layer.inPoint  = Math.max(0, origIn - handleSec);
                layer.outPoint = extTargetOut;

                // Measure any comp-edge clamping
                var actualLead  = origIn - layer.inPoint;
                var leadLostSec = handleSec - actualLead;

                // Step 2 — create dynamicLink comp
                var src    = layer.source;
                var srcAtIn = mapTimeToSource(layer, layer.inPoint);
                var dlDur   = cutSec + 2 * handleSec; // always full length

                var dlComp = proj.items.addComp(
                    src.name + "_dynamicLink",
                    src.width, src.height, src.pixelAspect,
                    dlDur, src.frameRate
                );
                dlComp.displayStartTime = 0;
                dlComp.parentFolder     = binDynLink;
                dlComp.label            = 14; // Cyan

                var inner = dlComp.layers.add(src);
                // At dynCompTime = handleSec the inner layer shows the cut-start frame.
                inner.startTime = leadLostSec - srcAtIn;

                dlComp.markerProperty.setValueAtTime(handleSec,          cutMarker("cut in"));
                dlComp.markerProperty.setValueAtTime(handleSec + cutSec, cutMarker("cut out"));

                // Step 3 — contract back (captured-target, mirrors contract_layer_trim)
                var contractTarget = origOut;
                layer.inPoint  = origIn;
                layer.outPoint = contractTarget;

                built++;
            } catch (e) {
                var tag = "layer " + t;
                try { tag = layer.name; } catch (eN) {}
                errors.push(tag + ": " + e.toString());
                // Best-effort rollback
                try { layer.inPoint = origIn; layer.outPoint = origOut; } catch (eRb) {}
            }
        }
    } finally {
        app.endUndoGroup();
    }

    // ── report ─────────────────────────────────────────────────────────────────

    var msg = "dynamicLink comps built: " + built;
    if (errors.length > 0) {
        msg += "\n\nErrors (" + errors.length + "):\n" + errors.join("\n");
    }
    greyAlert("Create dynamicLink Comps", msg);

    // ── prompt helper ──────────────────────────────────────────────────────────

    function promptHandleFrames(defaultVal) {
        var dlg = new Window("dialog", "Create dynamicLink Comps");
        dlg.orientation = "column"; dlg.alignChildren = ["fill", "top"];
        dlg.margins = 14; dlg.spacing = 10;

        var about = dlg.add("statictext", undefined,
              "For each selected precomp or footage layer, builds a wrapper "
            + "comp named \"<source>_dynamicLink\" in /Shots/_dynamicLink. "
            + "Wrapper duration is cut + 2× handles (missing frames are "
            + "black-padded). Used by Premiere to Dynamic Link each shot "
            + "back into the cut with safe handles for re-trim.",
            { multiline: true });
        about.preferredSize = [440, 72];

        dlg.add("statictext", undefined, "Handle length for the new dynamicLink comps.");

        var row = dlg.add("group");
        row.orientation = "row"; row.alignChildren = ["left", "center"]; row.spacing = 8;
        row.add("statictext", undefined, "Handle frames:");
        var input = row.add("edittext", undefined, "" + defaultVal);
        input.characters = 6;
        input.active = true;

        var hint = dlg.add("statictext", undefined,
            "Total comp duration will be cut + 2\u00d7handles. Missing frames (source out of range or comp edges) become black.",
            { multiline: true });
        hint.preferredSize = [380, 36];

        var btnGrp = dlg.add("group");
        btnGrp.orientation = "row"; btnGrp.alignment = ["fill", "bottom"];
        btnGrp.add("statictext", undefined, "").alignment = ["fill", "center"];
        var btnCancel = btnGrp.add("button", undefined, "Cancel"); btnCancel.preferredSize = [80, 28];
        var btnOK     = btnGrp.add("button", undefined, "Build");  btnOK.preferredSize     = [100, 28];

        var picked = null;
        btnCancel.onClick = function () { dlg.close(2); };
        btnOK.onClick = function () {
            var n = parseInt(input.text, 10);
            if (isNaN(n) || n < 0) { greyAlert("Create dynamicLink Comps", "Handle frames must be a non-negative integer."); return; }
            picked = n;
            dlg.close(1);
        };

        if (dlg.show() !== 1) return null;
        return picked;
    }

})();
