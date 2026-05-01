/*
       _____                          __
      / ___/__ ___ ____ ___  ___ ____/ /  __ _____ ___
     / (_ / -_) _ `/ -_) _ \(_-</ __/ _ \/ // (_-<(_-<
     \___/\__/\_, /\__/_//_/___/\__/_//_/\_,_/___/___/
             /___/

  SELECT VERSION
  After Effects ExtendScript
================================================================================

PURPOSE
-------
Central "pick the active variant" UI for every shot in the project.
Scans all *_comp / *_comp_OS compositions, finds their inner _stack or
_footage precomp, and lists each shot in a scrollable listbox. Pick a
variant for the selected row(s) via a dropdown below the list, or use
bulk buttons to set Latest / Disable across selection or all rows.

Applying enables only the picked layer per shot and disables every
other non-guide layer in that footage precomp — the same invariant
Import Returns + Re-render Plates maintain.

WORKFLOW
--------
1. Run the tool from the GegenschussShotRoundtrip panel.
2. Select one or more rows in the listbox.
3. Pick the desired variant from the dropdown below, or use:
      Set Selected to Latest  — selected rows → topmost (newest)
      Disable Selected        — selected rows → disable-all
      Set All to Latest       — every row    → topmost
      Disable All             — every row    → disable-all
   The listbox updates live; the "Active Variant" column shows the
   pending state.
4. OK applies every row's current pick. Cancel leaves the project
   untouched.

Shots without a footage precomp or with only a guide layer inside are
silently skipped — there's nothing to choose from.

For multi-selection pick: the dropdown lists the FIRST selected row's
variants; picking variant at index N sets every selected row to that
shot's variant at the same index (clamped if the row has fewer
variants). Disable entry applies to all selected rows.

Single undo step on OK.

================================================================================
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

    var proj = app.project;
    if (!proj) { greyAlert("Select Version", "Open a project first."); return; }

    // ── Collect shots + their footage-precomp variants ───────────────────────
    var SHOT_REGEX    = /_comp(_OS)?$/i;
    var FOOTAGE_REGEX = /_(stack|footage)(_OS)?$/i;

    var shots = []; // { shotComp, footageComp, layers[], currentActiveIndex }
    for (var pi = 1; pi <= proj.numItems; pi++) {
        var it = proj.item(pi);
        if (!(it instanceof CompItem) || !SHOT_REGEX.test(it.name)) continue;

        // Find the footage precomp layer inside this shot comp.
        var footageLayer = null;
        for (var li = 1; li <= it.numLayers; li++) {
            try {
                var L = it.layer(li);
                if (L.source instanceof CompItem && FOOTAGE_REGEX.test(L.source.name)) {
                    footageLayer = L;
                    break;
                }
            } catch (eL) {}
        }
        if (!footageLayer) continue;
        var footageComp = footageLayer.source;

        // Layers top-to-bottom, skipping guide layers (the DO NOT MODIFY null).
        var layerList = [];
        for (var fi = 1; fi <= footageComp.numLayers; fi++) {
            var fL = footageComp.layer(fi);
            if (fL.guideLayer) continue;
            layerList.push(fL);
        }
        if (layerList.length === 0) continue;

        // Topmost enabled layer is the "current active" version.
        var activeIdx = -1;
        for (var ai = 0; ai < layerList.length; ai++) {
            if (layerList[ai].enabled) { activeIdx = ai; break; }
        }

        shots.push({
            shotComp:           it,
            footageComp:        footageComp,
            layers:             layerList,
            currentActiveIndex: activeIdx
        });
    }

    if (shots.length === 0) {
        greyAlert("Select Version", "No shots with a _footage / _stack precomp and variants found.\n"
            + "Run Import Returns (or Re-render Plates) first so there's something to pick from.");
        return;
    }

    // Sort shots alphabetically by name for predictable ordering.
    shots.sort(function (a, b) {
        return a.shotComp.name < b.shotComp.name ? -1
             : a.shotComp.name > b.shotComp.name ?  1 : 0;
    });

    // desired[i] = index into shots[i].layers for the picked variant, or
    // -1 for "disable all". Initialised to each shot's current active.
    var desired = [];
    for (var di = 0; di < shots.length; di++) desired.push(shots[di].currentActiveIndex);

    function variantLabel(sh, idx) {
        if (idx < 0 || idx >= sh.layers.length) return "(disabled)";
        return sh.layers[idx].name;
    }

    // ── Dialog ───────────────────────────────────────────────────────────────
    var DISABLE_OPTION = "— (disable all) —";

    var dlg = new Window("dialog", "Select Active Version per Shot");
    dlg.orientation = "column";
    dlg.alignChildren = ["fill", "top"];
    dlg.spacing = 10;
    dlg.margins = 14;

    var about = dlg.add("statictext", undefined,
          "Central picker for every shot's active variant. Each shot's "
        + "_footage/_stack precomp stacks variants top=newest; this tool "
        + "lets you see and set which variant is enabled across the whole "
        + "project. Bulk-set selected to latest, set ALL to latest, or "
        + "disable everything in one click. Like Nuke Studio's "
        + "select-version, but project-wide.",
        { multiline: true });
    about.preferredSize = [660, 72];

    dlg.add("statictext", undefined,
        shots.length + " shot" + (shots.length === 1 ? "" : "s")
        + " with variants. Select rows and pick a variant below, or use the bulk buttons.");

    // Sort controls. Click a column to sort; click same column again to flip
    // direction. shots[] and desired[] are parallel arrays — we reorder both
    // in lock-step via an index permutation so all existing desired[i]
    // lookups stay correct.
    var svSortKey = -1, svSortDir = 1;
    function svSortLists() {
        if (svSortKey < 0) return;
        var idx = [];
        for (var i = 0; i < shots.length; i++) idx.push(i);
        idx.sort(function (ai, bi) {
            var av, bv;
            if (svSortKey === 0) {
                av = shots[ai].shotComp.name;
                bv = shots[bi].shotComp.name;
            } else {
                av = variantLabel(shots[ai], desired[ai]);
                bv = variantLabel(shots[bi], desired[bi]);
            }
            av = String(av || "").toLowerCase(); bv = String(bv || "").toLowerCase();
            if (av !== bv) return (av < bv ? -1 : 1) * svSortDir;
            return 0;
        });
        var newShots = [], newDesired = [];
        for (var k = 0; k < idx.length; k++) {
            newShots.push(shots[idx[k]]);
            newDesired.push(desired[idx[k]]);
        }
        for (var m = 0; m < idx.length; m++) {
            shots[m]   = newShots[m];
            desired[m] = newDesired[m];
        }
    }
    var svSortRow = dlg.add("group");
    svSortRow.orientation = "row"; svSortRow.alignChildren = ["left", "center"];
    svSortRow.spacing = 4;
    svSortRow.add("statictext", undefined, "Sort:");
    var SV_LABELS = ["Shot", "Active Variant"];
    var svBtns = [];
    for (var svs = 0; svs < SV_LABELS.length; svs++) {
        var svb = svSortRow.add("button", undefined, SV_LABELS[svs]);
        svb.preferredSize = [120, 22];
        svb.onClick = (function (col) {
            return function () {
                if (svSortKey === col) svSortDir = -svSortDir;
                else { svSortKey = col; svSortDir = 1; }
                svSortLists();
                svRepopulate();
                svRefreshBtns();
            };
        })(svs);
        svBtns.push(svb);
    }
    function svRefreshBtns() {
        for (var i = 0; i < svBtns.length; i++) {
            var arrow = (i === svSortKey) ? (svSortDir === 1 ? "  ↓" : "  ↑") : "";
            svBtns[i].text = SV_LABELS[i] + arrow;
        }
    }

    // Scrollable list: native listbox with multi-select.
    var lb = dlg.add("listbox", undefined, undefined, {
        multiselect:     true,
        numberOfColumns: 2,
        showHeaders:     true,
        columnTitles:    ["Shot", "Active Variant (top = newest)"],
        columnWidths:    [220, 420]
    });
    lb.preferredSize = [660, 420];

    function populateRow(i) {
        var sh   = shots[i];
        var item = lb.add("item", sh.shotComp.name);
        item.subItems[0].text = variantLabel(sh, desired[i]);
    }
    function svRepopulate() {
        try { lb.removeAll(); } catch (eRA) {}
        for (var rI = 0; rI < shots.length; rI++) populateRow(rI);
    }
    svRepopulate();
    svRefreshBtns();

    function refreshRow(i) {
        try {
            lb.items[i].subItems[0].text = variantLabel(shots[i], desired[i]);
        } catch (e) {}
    }

    // ScriptUI quirk: subItem text edits don't repaint while the row stays
    // selected. Nudging the selection forces the redraw without changing
    // which rows are selected.
    function forceRepaint() {
        var selIdx = getSelectedIndices();
        try { lb.selection = null; } catch (eSR) {}
        if (selIdx.length > 0) {
            try { lb.selection = selIdx; } catch (eRR) {}
        }
    }
    function getSelectedIndices() {
        var out = [];
        var sel = lb.selection;
        if (!sel) return out;
        if (!(sel instanceof Array)) sel = [sel];
        for (var i = 0; i < sel.length; i++) out.push(sel[i].index);
        return out;
    }

    // Per-selection dropdown.
    var ddGrp = dlg.add("group");
    ddGrp.orientation = "row"; ddGrp.alignChildren = ["left", "center"]; ddGrp.spacing = 8;
    var ddLbl = ddGrp.add("statictext", undefined, "Active variant for selected shot(s):");
    ddLbl.preferredSize = [260, 22];
    var dd = ddGrp.add("dropdownlist", undefined, []);
    dd.preferredSize = [380, 22];

    // Strip the shot-name prefix from a variant name — turns
    // "shot_100_plate.mov" into "plate.mov" for multi-select, where
    // showing the first shot's full file names would be misleading
    // (each selected shot gets its OWN variant at the same index, not
    // the literal filename shown).
    function stripShotPrefix(sh, name) {
        var shotPrefix = sh.shotComp.name.replace(/_comp(_OS)?$/i, "");
        if (shotPrefix && name.toLowerCase().indexOf(shotPrefix.toLowerCase()) === 0) {
            var rest = name.substring(shotPrefix.length);
            if (rest.charAt(0) === "_") rest = rest.substring(1);
            return rest || name;
        }
        return name;
    }

    var syncingDD = false;
    function rebuildDropdown() {
        dd.removeAll();
        var idx = getSelectedIndices();
        if (idx.length === 0) { dd.enabled = false; return; }
        dd.enabled = true;
        var firstSh = shots[idx[0]];
        var multi   = (idx.length > 1);
        var active  = firstSh.currentActiveIndex;
        for (var o = 0; o < firstSh.layers.length; o++) {
            var nm = firstSh.layers[o].name;
            if (multi) {
                // Multi-select: strip the shot-name prefix and mark the
                // active variant with "* " (two-space alignment on the
                // rest). Single selection is shown verbatim.
                nm = stripShotPrefix(firstSh, nm);
                nm = (o === active ? "* " : "  ") + nm;
            }
            dd.add("item", nm);
        }
        dd.add("item", multi ? "  " + DISABLE_OPTION : DISABLE_OPTION);
        syncingDD = true;
        var cur = desired[idx[0]];
        dd.selection = (cur >= 0) ? cur : (dd.items.length - 1);
        syncingDD = false;
    }

    lb.onChange = function () { rebuildDropdown(); };

    dd.onChange = function () {
        if (syncingDD) return;
        if (!dd.selection) return;
        var idx = getSelectedIndices();
        if (idx.length === 0) return;
        var ddSel  = dd.selection.index;
        var first  = shots[idx[0]];
        var isDisable = (ddSel >= first.layers.length);
        for (var i = 0; i < idx.length; i++) {
            var ri = idx[i];
            var sh = shots[ri];
            desired[ri] = isDisable ? -1 : Math.min(ddSel, sh.layers.length - 1);
            refreshRow(ri);
        }
        forceRepaint();
    };

    // Bulk buttons.
    var bulkGrp = dlg.add("group");
    bulkGrp.orientation = "row"; bulkGrp.alignChildren = ["left", "center"]; bulkGrp.spacing = 8;
    var btnSelLatest  = bulkGrp.add("button", undefined, "Set Selected to Latest"); btnSelLatest.preferredSize  = [170, 24];
    var btnSelDisable = bulkGrp.add("button", undefined, "Disable Selected");       btnSelDisable.preferredSize = [140, 24];
    bulkGrp.add("statictext", undefined, "").preferredSize = [20, 1];
    var btnAllLatest  = bulkGrp.add("button", undefined, "Set All to Latest");      btnAllLatest.preferredSize  = [150, 24];
    var btnAllDisable = bulkGrp.add("button", undefined, "Disable All");            btnAllDisable.preferredSize = [110, 24];

    function applyToIndices(indices, fn) {
        for (var i = 0; i < indices.length; i++) {
            fn(indices[i]);
            refreshRow(indices[i]);
        }
        rebuildDropdown();
        forceRepaint();
    }
    function allIndices() {
        var out = []; for (var i = 0; i < shots.length; i++) out.push(i); return out;
    }
    btnSelLatest.onClick  = function () { applyToIndices(getSelectedIndices(), function (ri) { desired[ri] = 0; }); };
    btnSelDisable.onClick = function () { applyToIndices(getSelectedIndices(), function (ri) { desired[ri] = -1; }); };
    btnAllLatest.onClick  = function () { applyToIndices(allIndices(),         function (ri) { desired[ri] = 0; }); };
    btnAllDisable.onClick = function () { applyToIndices(allIndices(),         function (ri) { desired[ri] = -1; }); };

    // ── OK / Cancel ──────────────────────────────────────────────────────────
    var okGrp = dlg.add("group");
    okGrp.orientation = "row"; okGrp.alignment = ["fill", "bottom"]; okGrp.margins = [0, 4, 0, 0];
    okGrp.add("statictext", undefined, "").alignment = ["fill", "center"];
    var btnCancel = okGrp.add("button", undefined, "Cancel"); btnCancel.preferredSize = [100, 28];
    var btnOk     = okGrp.add("button", undefined, "OK");     btnOk.preferredSize     = [100, 28];

    btnCancel.onClick = function () { dlg.close(2); };
    btnOk.onClick     = function () { dlg.close(1); };

    rebuildDropdown(); // initial disabled state
    if (dlg.show() !== 1) return;

    // ── Apply ────────────────────────────────────────────────────────────────
    var shotsTouched       = 0;
    var layerStatesChanged = 0;

    app.beginUndoGroup("Select Active Version");
    try {
        for (var ai2 = 0; ai2 < shots.length; ai2++) {
            var sh2       = shots[ai2];
            var targetIdx = (desired[ai2] >= 0 && desired[ai2] < sh2.layers.length) ? desired[ai2] : -1;

            var shotChanged = false;
            for (var li2 = 0; li2 < sh2.layers.length; li2++) {
                var L2   = sh2.layers[li2];
                var want = (li2 === targetIdx);
                if (L2.enabled !== want) {
                    try { L2.enabled = want; } catch (eE) {}
                    layerStatesChanged++;
                    shotChanged = true;
                }
                try {
                    if (L2.hasAudio && L2.audioEnabled !== want) {
                        L2.audioEnabled = want;
                    }
                } catch (eA) {}
            }
            if (shotChanged) shotsTouched++;
        }
    } finally { app.endUndoGroup(); }

    greyAlert("Select Version",
        shotsTouched + " shot" + (shotsTouched === 1 ? "" : "s")
        + " changed (" + layerStatesChanged + " layer state change"
        + (layerStatesChanged === 1 ? "" : "s") + ").");

})();
