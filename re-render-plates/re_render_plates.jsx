/*
       _____                          __
      / ___/__ ___ ____ ___  ___ ____/ /  __ _____ ___
     / (_ / -_) _ `/ -_) _ \(_-</ __/ _ \/ // (_-<(_-<
     \___/\__/\_, /\__/_//_/___/\__/_//_/\_,_/___/___/
             /___/

  RE-RENDER PLATES
  After Effects ExtendScript
================================================================================

PURPOSE
-------
Re-render the ORIGINAL plate out of every shot comp to a new filename,
ready to be handed to an external tool (Neat Video, Mocha, a stabilizer,
etc.) and brought back in. The suffix (default "denoised") tags the
output:

    {shots}/{shot}/plate/{shot}_{suffix}.mov
    {shots}/{shot}/plate/{shot}_{suffix}_OS.mov   (overscan variant)

The file lives next to the original plate so it travels with the shot
on handoff — Import Returns' plate-detection picks it up
automatically as a plate variant (path contains /plate/).

WORKFLOW
--------
1. Run this script. It scans every {shot}_comp (and {shot}_comp_OS)
   for a {shot}_stack precomp and shows a Confirm Shots dialog so
   you can pick which ones to re-render. Confirmed plates get
   {shot}_{suffix}.mov written next to them.
2. The rendered file is imported back into the {shot}_stack precomp
   AND stacked above the original plate — below any renders/grades.
3. Take the rendered file to the external tool, process it, and
   overwrite in place (keep the filename).
4. In AE: select the newly imported footage item and Reload Footage
   (File → Reload Footage) — the processed pixels appear instantly in
   every shot that references it, above the original plate but below
   any VFX returns / grades, so the full stack keeps working.

On re-runs, the script always re-renders the ORIGINAL plate (the
bottom-most tagged plate inside the precomp), never a previously
imported variant — so running it twice gives you a fresh raw plate,
not a copy of whatever the last external pass produced.

WHAT GETS RENDERED
------------------
The outer {shot}_comp, over its full cut+handles range — the same
range Shot Roundtrip rendered the original plate over (NOT the _comp
work area, which is the editorial cut only). Every layer except the raw plate is disabled
for the duration of the render (guide layers are already excluded by
AE), so the output is the pristine plate — never a grade, render, or
plate variant. Enabled states are restored via try/finally.

Shot Roundtrip leaves the raw plate flat + locked at the bottom of
`_comp`. The `{shot}_stack` precomp is created lazily — this script
creates it at import time (first reimport lands inside it) so the
round-tripped variant stacks in the same container as grades and VFX
renders.

VERSIONING
----------
Because we mutate the project (precompose + add layers), the script
Save-As's the .aep to the next _v## before any DOM change. Your
original is preserved as the rollback point. Dry-run skips the bump
and runs in detect-only mode.

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
    if (!proj || !proj.file) { greyAlert("Re-render Plates", "Save the project first."); return; }

    // ── UI ────────────────────────────────────────────────────────────────────
    var LABEL_W = 120; var FIELD_H = 22;

    var addRow = function (parent, labelText) {
        var g = parent.add("group");
        g.orientation = "row"; g.alignChildren = ["left", "center"]; g.spacing = 8;
        var lbl = g.add("statictext", undefined, labelText);
        lbl.preferredSize = [LABEL_W, FIELD_H];
        return g;
    };

    var dlg = new Window("dialog", "Re-render Plates");
    dlg.orientation = "column"; dlg.alignChildren = ["fill", "top"];
    dlg.spacing = 10; dlg.margins = 14;

    var about = dlg.add("statictext", undefined,
          "Re-renders every shot's original plate layer to "
        + "{shot}_{suffix}.mov (ProRes) at the shot's full cut+handles "
        + "range. Intended handoff to external denoise / stabilize tools. "
        + "After rendering, the returns are auto-imported back into each "
        + "{shot}_footage precomp as plate variants on top of the original.",
        { multiline: true });
    about.preferredSize = [520, 64];

    var pnl = dlg.add("panel", undefined, "Settings");
    pnl.orientation = "column"; pnl.alignChildren = ["fill", "top"];
    pnl.spacing = 6; pnl.margins = [10, 15, 10, 10];

    var r1 = addRow(pnl, "Suffix:");
    var etSuffix = r1.add("edittext", undefined, "denoised");
    etSuffix.preferredSize = [150, FIELD_H];

    var r2 = addRow(pnl, "Shots Folder:");
    var etShotsFolder = r2.add("edittext", undefined, "../Roundtrip");
    etShotsFolder.preferredSize = [150, FIELD_H];
    var btnBrowseShots = r2.add("button", undefined, "Browse\u2026");
    btnBrowseShots.preferredSize = [80, FIELD_H];
    btnBrowseShots.onClick = function () {
        var seed = null;
        try {
            var txt = etShotsFolder.text || "";
            var candidate = /^(\/|[A-Za-z]:)/.test(txt)
                          ? new Folder(txt)
                          : (proj && proj.file ? new Folder(proj.file.parent.fsName + "/" + txt) : null);
            if (candidate && candidate.exists) seed = candidate;
        } catch (eSeed) {}
        var picked = (seed ? seed : Folder.desktop).selectDlg("Select Shots Folder");
        if (picked) etShotsFolder.text = picked.fsName;
    };

    var r3 = addRow(pnl, "OM Template:");
    var etOM = r3.add("edittext", undefined, "ProRes 422 HQ");
    etOM.preferredSize = [150, FIELD_H];

    var chkDryRun = pnl.add("checkbox", undefined, "Dry run");
    chkDryRun.value = false;

    // ── Settings persistence ──────────────────────────────
    // Suffix, Shots Folder, and OM Template round-trip through app.settings.
    // Dry Run (debug) isn't persisted. Reset restores defaults in the fields
    // without saving until the user clicks Re-render.
    var RR_SECTION  = "Gegenschuss Re-render Plates";
    var RR_DEFAULTS = {
        suffix:      "denoised",
        shotsFolder: "../Roundtrip",
        omTemplate:  "ProRes 422 HQ"
    };
    function rrLoad(key, fallback) {
        try {
            if (app.settings.haveSetting(RR_SECTION, key)) return app.settings.getSetting(RR_SECTION, key);
        } catch (e) {}
        return fallback;
    }
    function rrSave(key, value) {
        try { app.settings.saveSetting(RR_SECTION, key, String(value)); } catch (e) {}
    }
    function rrApply(s) {
        etSuffix.text      = s.suffix;
        etShotsFolder.text = s.shotsFolder;
        etOM.text          = s.omTemplate;
    }
    rrApply({
        suffix:      rrLoad("suffix",      RR_DEFAULTS.suffix),
        shotsFolder: rrLoad("shotsFolder", RR_DEFAULTS.shotsFolder),
        omTemplate:  rrLoad("omTemplate",  RR_DEFAULTS.omTemplate)
    });

    var btnGrp = dlg.add("group");
    btnGrp.orientation = "row"; btnGrp.alignment = ["fill", "bottom"]; btnGrp.margins = [0, 4, 0, 0];
    var btnReset  = btnGrp.add("button", undefined, "Reset to Defaults"); btnReset.preferredSize  = [130, 28];
    var btnCancel = btnGrp.add("button", undefined, "Cancel");            btnCancel.preferredSize = [80, 28];
    var btnSpacer = btnGrp.add("statictext", undefined, "");              btnSpacer.alignment = ["fill", "center"];
    var btnOk     = btnGrp.add("button", undefined, "Re-render Plates");  btnOk.preferredSize = [140, 28];

    btnReset.onClick  = function () { rrApply(RR_DEFAULTS); };
    btnOk.onClick     = function () {
        rrSave("suffix",      etSuffix.text);
        rrSave("shotsFolder", etShotsFolder.text);
        rrSave("omTemplate",  etOM.text);
        dlg.close(1);
    };
    btnCancel.onClick = function () { dlg.close(2); };

    if (dlg.show() !== 1) return;

    // ── Resolve inputs ────────────────────────────────────────────────────────
    var suffix = String(etSuffix.text || "").replace(/^[\s_]+|[\s_]+$/g, "");
    if (!suffix) { greyAlert("Re-render Plates", "Suffix is required."); return; }
    // Sanitise for a filename segment — strip anything a filesystem hates and
    // collapse internal whitespace to underscores.
    suffix = suffix.replace(/\s+/g, "_").replace(/[\/\\:*?"<>|]/g, "");

    var aepFolder = proj.file.parent;
    var shotsPathText = etShotsFolder.text;
    var fsShots = /^(\/|[A-Za-z]:)/.test(shotsPathText)
                ? new Folder(shotsPathText)
                : new Folder(aepFolder.fsName + "/" + shotsPathText);
    if (!fsShots.exists) { greyAlert("Re-render Plates", "Shots folder not found:\n" + fsShots.fsName); return; }

    var omTemplate = etOM.text;
    var dryRun     = chkDryRun.value;

    // ── Project helpers ───────────────────────────────────────────────────────

    function getBinFolder(name) {
        for (var i = 1; i <= proj.numItems; i++) {
            if (proj.item(i).name === name && proj.item(i) instanceof FolderItem) return proj.item(i);
        }
        return proj.items.addFolder(name);
    }

    function getChildBin(parentBin, childName) {
        for (var i = 1; i <= proj.numItems; i++) {
            var it = proj.item(i);
            if (it instanceof FolderItem && it.name === childName && it.parentFolder === parentBin) return it;
        }
        return null;
    }

    function getOrCreateChildBin(parentBin, childName) {
        var existing = getChildBin(parentBin, childName);
        if (existing) return existing;
        var f = proj.items.addFolder(childName);
        f.parentFolder = parentBin;
        return f;
    }

    function collectShotComps() {
        var result = [];
        for (var i = 1; i <= proj.numItems; i++) {
            var item = proj.item(i);
            if (item instanceof CompItem && /_comp(_OS)?$/i.test(item.name)) {
                result.push(item);
            }
        }
        result.sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
        return result;
    }

    function shotNameFromComp(compName) {
        return compName.replace(/_comp(_OS)?$/i, "");
    }

    function isOvercan(compName) {
        return /_comp_OS$/i.test(compName);
    }

    function buildImportedFilesMap() {
        var map = {};
        for (var i = 1; i <= proj.numItems; i++) {
            var item = proj.item(i);
            if (item instanceof FootageItem && item.file) {
                map[item.file.fsName] = item;
            }
        }
        return map;
    }

    function isFootageInComp(comp, footageItem) {
        for (var i = 1; i <= comp.numLayers; i++) {
            try {
                if (comp.layer(i).source === footageItem) return true;
            } catch (e) {}
        }
        return false;
    }

    // Mirror of import_renders.jsx findPlateLayer: four-tier fallback to
    // locate the SOURCE plate — the one we want to render out, never a
    // previously imported variant. Tier 1 (path contains /plate/ or filename
    // ends _plate.) is what Shot Roundtrip's own plates match, so re-runs
    // always hit the pristine original.
    function findPlateLayer(comp, shotName) {
        var shotPrefix = (shotName || "").toLowerCase();
        var tagged = null, shotMatch = null, untagged = null, anyFootage = null;
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            if (L.guideLayer) continue;
            try {
                if (!(L.source instanceof FootageItem) || !L.source.file) continue;
                var fp = L.source.file.fsName;
                anyFootage = L;
                if (/[\/\\]plate[\/\\]/i.test(fp) || /_plate\./i.test(L.source.name)) {
                    tagged = L;
                    continue;
                }
                if (/[\/\\]render[\/\\]/i.test(fp) || /[\/\\]_grade[\/\\]/i.test(fp)) continue;
                if (shotPrefix && L.source.name &&
                    L.source.name.toLowerCase().indexOf(shotPrefix) === 0) {
                    shotMatch = L;
                    continue;
                }
                untagged = L;
            } catch (e) {}
        }
        return tagged || shotMatch || untagged || anyFootage;
    }

    // Topmost plate-like layer (non-render, non-grade) — anchor for where
    // newly imported plate variants stack. Mirrors import_renders.jsx.
    function findTopmostPlateLike(comp) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            if (L.guideLayer) continue;
            try {
                if (!(L.source instanceof FootageItem) || !L.source.file) continue;
                var fp = L.source.file.fsName;
                if (/[\/\\]render[\/\\]/i.test(fp) || /[\/\\]_grade[\/\\]/i.test(fp)) continue;
                return L;
            } catch (e) {}
        }
        return null;
    }

    // Derive the plate-precomp name from a _comp name.
    function stackCompNameFor(compName) {
        return compName.replace(/_comp(_OS)?$/i, function (_m, os) {
            return "_stack" + (os || "");
        });
    }

    // Ensure a {shot}_stack precomp exists as a layer at the TOP of `comp`.
    // Empty on first creation — holds only reimported variants (grades, VFX,
    // denoised plates). Raw plate stays flat + locked at the bottom of `comp`.
    // Mirror of import_renders.jsx's ensureStack so Re-render Plates can
    // land its output in the same place. readOnly returns null if missing.
    function ensureStack(comp, shotName, readOnly) {
        var targetName = stackCompNameFor(comp.name);
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            try {
                if (L.source instanceof CompItem && L.source.name === targetName) return L.source;
            } catch (e) {}
        }
        if (readOnly) return null;
        var newComp = proj.items.addComp(
            targetName, comp.width, comp.height, comp.pixelAspect,
            comp.duration, comp.frameRate
        );
        newComp.displayStartTime = 0;
        try {
            var shotBin      = getChildBin(binShots, shotName);
            var shotPlateBin = shotBin ? getOrCreateChildBin(shotBin, "plate") : null;
            if (shotPlateBin) newComp.parentFolder = shotPlateBin;
        } catch (eBin) {}
        try {
            if (comp.markerProperty && comp.markerProperty.numKeys > 0) {
                var dstMkr = newComp.markerProperty;
                for (var mi = 1; mi <= comp.markerProperty.numKeys; mi++) {
                    try {
                        dstMkr.setValueAtTime(
                            comp.markerProperty.keyTime(mi),
                            comp.markerProperty.keyValue(mi)
                        );
                    } catch (e) {}
                }
            }
        } catch (eCM) {}
        var newLayer = comp.layers.add(newComp);
        try { newLayer.moveToBeginning(); } catch (eMB) {}
        try { newLayer.startTime = 0; } catch (eST) {}
        return newComp;
    }

    // Confirm Shots preflight: lets the user toggle which shots to re-render.
    // Pre-check logic — if any stack precomps are flagged via their Re-render
    // checkbox effect, default-check only those; otherwise default-check all
    // (classic opt-out). User can still toggle any row with Space or the
    // Toggle button. Mirrors shot_roundtrip.jsx's Confirm Shots pattern.
    function showConfirmDialog(plan) {
        var anyFlagged = false, flagCount = 0;
        for (var fl = 0; fl < plan.length; fl++) {
            if (plan[fl].flagged) { anyFlagged = true; flagCount++; }
        }

        var win = new Window("dialog", "Re-render Plates \u2014 Confirm");
        win.orientation = "column"; win.alignChildren = ["fill", "top"];
        win.spacing = 8; win.margins = 14;

        win.add("statictext", undefined,
            plan.length + " plate" + (plan.length === 1 ? "" : "s")
            + " ready. Select rows and click Enabled / Disabled (or press Space to toggle "
            + "individual rows). Checked rows render.");
        if (anyFlagged) {
            win.add("statictext", undefined,
                flagCount + " shot" + (flagCount === 1 ? "" : "s")
                + " flagged via the Re-render checkbox on the stack precomp layer \u2014 only those are pre-checked."
                + " Flags auto-reset after a successful re-render.");
        } else {
            win.add("statictext", undefined,
                "Tip: tick the \u201cRe-render\u201d Checkbox Control on a {shot}_stack precomp layer "
                + "(Effect Controls panel) during editing to flag it for re-render on the next run.");
        }

        // Column widths auto-sized from content.
        var shotMax = 0, plateMax = 0, outMax = 0;
        for (var ml = 0; ml < plan.length; ml++) {
            var sn = plan[ml].shotName + (plan[ml].isOS ? " [OS]" : "");
            if (sn.length > shotMax) shotMax = sn.length;
            var pn = (plan[ml].plateLayer.source && plan[ml].plateLayer.source.name) ? plan[ml].plateLayer.source.name : "?";
            if (pn.length > plateMax) plateMax = pn.length;
            var on = plan[ml].outFile.name;
            if (on.length > outMax) outMax = on.length;
        }
        var shotW  = Math.max(Math.min(shotMax  * 8 + 24, 200),  90);
        var plateW = Math.max(Math.min(plateMax * 7 + 24, 340), 160);
        var outW   = Math.max(Math.min(outMax   * 7 + 24, 400), 180);
        var checkW = 60, flagW = 50, framesW = 70;

        // Pre-compute derived display fields + checked state ON the plan[]
        // entries themselves, so sorting plan[] reorders the checkbox state
        // correctly (no parallel index array to keep in sync with the list).
        for (var pi0 = 0; pi0 < plan.length; pi0++) {
            plan[pi0].selected = anyFlagged ? !!plan[pi0].flagged : true;
            plan[pi0].displayShot  = plan[pi0].shotName + (plan[pi0].isOS ? " [OS]" : "");
            plan[pi0].displayPlate = (plan[pi0].plateLayer.source && plan[pi0].plateLayer.source.name)
                                      ? plan[pi0].plateLayer.source.name : "?";
            var fr0 = plan[pi0].stackComp.frameRate;
            var pDur0 = 0; try { pDur0 = plan[pi0].stackComp.duration; } catch (eWA0) {}
            plan[pi0].displayFrames = (fr0 > 0 && pDur0 > 0) ? Math.round(pDur0 * fr0) : 0;
            plan[pi0].displayOutput = plan[pi0].outFile.name;
        }

        var shotsPnl = win.add("panel", undefined, "Shots");
        shotsPnl.orientation = "column"; shotsPnl.alignChildren = ["fill", "top"];
        shotsPnl.margins = [10, 12, 10, 10]; shotsPnl.spacing = 4;

        // Sort controls. Columns: 0 Render(check), 1 Flag, 2 Shot, 3 Plate,
        // 4 Frames, 5 Output. Default: unsorted (plan's scan order).
        var planSortKey = -1, planSortDir = 1;
        function planSortList() {
            if (planSortKey < 0) return;
            plan.sort(function (a, b) {
                var av, bv, isNum = false;
                if (planSortKey === 0)      { av = a.selected ? 1 : 0; bv = b.selected ? 1 : 0; isNum = true; }
                else if (planSortKey === 1) { av = a.flagged ? 1 : 0;  bv = b.flagged ? 1 : 0;  isNum = true; }
                else if (planSortKey === 2) { av = a.displayShot;      bv = b.displayShot; }
                else if (planSortKey === 3) { av = a.displayPlate;     bv = b.displayPlate; }
                else if (planSortKey === 4) { av = a.displayFrames;    bv = b.displayFrames; isNum = true; }
                else                        { av = a.displayOutput;    bv = b.displayOutput; }
                if (isNum) {
                    if (av !== bv) return (av < bv ? -1 : 1) * planSortDir;
                    return 0;
                }
                av = String(av || "").toLowerCase(); bv = String(bv || "").toLowerCase();
                if (av !== bv) return (av < bv ? -1 : 1) * planSortDir;
                return 0;
            });
        }
        var planSortRow = shotsPnl.add("group");
        planSortRow.orientation = "row"; planSortRow.alignChildren = ["left", "center"];
        planSortRow.spacing = 4;
        planSortRow.add("statictext", undefined, "Sort:");
        var PLAN_LABELS = ["Render", "Flag", "Shot", "Plate", "Frames", "Output"];
        var planBtns = [];
        for (var ps = 0; ps < PLAN_LABELS.length; ps++) {
            var pb = planSortRow.add("button", undefined, PLAN_LABELS[ps]);
            pb.preferredSize = [82, 22];
            pb.onClick = (function (col) {
                return function () {
                    if (planSortKey === col) planSortDir = -planSortDir;
                    else { planSortKey = col; planSortDir = 1; }
                    planSortList();
                    planRepopulate();
                    planRefreshBtns();
                };
            })(ps);
            planBtns.push(pb);
        }
        function planRefreshBtns() {
            for (var i = 0; i < planBtns.length; i++) {
                var arrow = (i === planSortKey) ? (planSortDir === 1 ? "  ↓" : "  ↑") : "";
                planBtns[i].text = PLAN_LABELS[i] + arrow;
            }
        }

        var lb = shotsPnl.add("listbox", undefined, [], {
            multiselect: true,
            numberOfColumns: 6,
            showHeaders: true,
            columnTitles: ["Render", "Flag", "Shot", "Plate", "Frames", "Output"],
            columnWidths: [checkW, flagW, shotW, plateW, framesW, outW]
        });
        var lbH = Math.min(Math.max(plan.length * 22 + 40, 180), 520);
        lb.preferredSize = [checkW + flagW + shotW + plateW + framesW + outW + 40, lbH];

        function planRepopulate() {
            try { lb.removeAll(); } catch (eRA) {}
            for (var pi2 = 0; pi2 < plan.length; pi2++) {
                var itm = lb.add("item", plan[pi2].selected ? "✓" : "");
                itm.subItems[0].text = plan[pi2].flagged ? "●" : "";
                itm.subItems[1].text = plan[pi2].displayShot;
                itm.subItems[2].text = plan[pi2].displayPlate;
                itm.subItems[3].text = String(plan[pi2].displayFrames);
                itm.subItems[4].text = plan[pi2].displayOutput;
            }
        }
        planRepopulate();
        planRefreshBtns();


        function setSelected(value) {
            var sel = lb.selection;
            if (!sel) return;
            var arr = (sel.length !== undefined) ? sel : [sel];
            var idxs = [];
            for (var si = 0; si < arr.length; si++) idxs.push(arr[si].index);
            for (var j = 0; j < idxs.length; j++) {
                var idx = idxs[j];
                plan[idx].selected = value;
                lb.items[idx].text = value ? "\u2713" : "";
            }
            // ScriptUI doesn't repaint selected rows until the selection
            // changes — bounce it to force the checkmark column to refresh.
            try { lb.selection = null; lb.selection = idxs; } catch (eSel) {}
        }

        var btnGrp = win.add("group");
        btnGrp.orientation = "row"; btnGrp.alignment = ["fill", "bottom"];
        var spacer = btnGrp.add("statictext", undefined, ""); spacer.alignment = ["fill", "center"];
        var btnEnable  = btnGrp.add("button", undefined, "Enabled");   btnEnable.preferredSize  = [90, 28];
        var btnDisable = btnGrp.add("button", undefined, "Disabled");  btnDisable.preferredSize = [90, 28];
        var btnCancel  = btnGrp.add("button", undefined, "Cancel");    btnCancel.preferredSize  = [80, 28];
        var btnOk      = btnGrp.add("button", undefined, "Re-render"); btnOk.preferredSize      = [110, 28];

        btnEnable.onClick  = function () { setSelected(true);  };
        btnDisable.onClick = function () { setSelected(false); };
        btnCancel.onClick  = function () { win.close(2); };
        btnOk.onClick      = function () { win.close(1); };

        // Space still toggles a single-row selection (quickest for one row).
        win.addEventListener("keydown", function (e) {
            if (e.keyName === "Space") {
                e.preventDefault();
                var sel = lb.selection;
                if (!sel) return;
                var arr = (sel.length !== undefined) ? sel : [sel];
                for (var si = 0; si < arr.length; si++) {
                    var idx = arr[si].index;
                    plan[idx].selected = !plan[idx].selected;
                    lb.items[idx].text = plan[idx].selected ? "\u2713" : "";
                }
            }
        });

        if (win.show() !== 1) return null;

        var filtered = [];
        for (var fi = 0; fi < plan.length; fi++) {
            if (plan[fi].selected) filtered.push(plan[fi]);
        }
        return filtered;
    }

    // Save As → next _v## version (same pattern as import_renders.jsx).
    function pad(n, s) { var str = "" + n; while (str.length < s) str = "0" + str; return str; }
    function saveAsNextVersion() {
        var cur = proj.file;
        if (!cur) return null;
        var baseName = cur.name.replace(/\.aep$/i, "");
        var m = baseName.match(/^(.*?)(_?v)(\d+)$/);
        var stem, prefix, width, next;
        if (m) {
            stem = m[1]; prefix = m[2]; width = m[3].length;
            next = parseInt(m[3], 10) + 1;
        } else {
            stem = baseName; prefix = "_v"; width = 2; next = 1;
        }
        var newFile = null;
        while (next < 10000) {
            var candidate = new File(cur.parent.fsName + "/" + stem + prefix + pad(next, width) + ".aep");
            if (!candidate.exists) { newFile = candidate; break; }
            next++;
        }
        if (!newFile) {
            greyAlert("Re-render Plates", "Could not find an unused version number for the backup copy.\nAborting so nothing is modified.");
            return null;
        }
        try { proj.save(); proj.save(newFile); }
        catch (eSave) {
            greyAlert("Re-render Plates", "Failed to save versioned copy —\n" + eSave.message +
                  "\n\nAborting so the original file stays untouched.");
            return null;
        }
        return newFile;
    }

    function waitForFile(file, tries) {
        for (var i = 0; i < tries; i++) {
            if (file.exists && file.length > 0) return true;
            $.sleep(500);
        }
        return false;
    }

    // ── Main ──────────────────────────────────────────────────────────────────
    // Users flag a shot for re-render via a "Re-render" Checkbox Control effect
    // on the stack precomp layer in _comp. The Confirm dialog below pre-checks
    // only flagged shots if any exist; otherwise all rows default-checked.
    // Successfully re-rendered shots get their checkbox auto-reset so the flag
    // doesn't linger into the next run.
    var RR_EFFECT_NAME = "Re-render";

    // Read the Re-render checkbox on the {shot}_stack outer layer in comp.
    // Returns false when there's no stack precomp yet, no effect, or the
    // checkbox is unchecked. Never throws.
    function rerenderFlagOn(comp) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            try {
                if (!(L.source instanceof CompItem)) continue;
                if (!/_stack(_OS)?$/i.test(L.source.name)) continue;
                var eff = L.Effects.property(RR_EFFECT_NAME);
                if (!eff) return false;
                var cb = eff.property(1);  // index 1 = the Checkbox parameter (locale-safe)
                if (!cb) return false;
                return cb.value === 1 || cb.value === true;
            } catch (e) {}
        }
        return false;
    }

    // Reset the Re-render checkbox on the {shot}_stack outer layer after a
    // successful re-render. Silent no-op if the effect is missing.
    function rerenderFlagReset(comp) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            try {
                if (!(L.source instanceof CompItem)) continue;
                if (!/_stack(_OS)?$/i.test(L.source.name)) continue;
                var eff = L.Effects.property(RR_EFFECT_NAME);
                if (!eff) return;
                var cb = eff.property(1);  // index 1 = the Checkbox parameter (locale-safe)
                if (cb) cb.setValue(0);
                return;
            } catch (e) {}
        }
    }

    var shotComps = collectShotComps();
    if (shotComps.length === 0) { greyAlert("Re-render Plates", "No *_comp compositions found in the project."); return; }

    var binShots = getBinFolder("Shots");

    // Scan to build renderPlan. No project mutations here so the user can
    // still cancel at the Confirm dialog below with nothing touched.
    var dryRunLog  = [];
    var errorLog   = [];
    var renderPlan = [];  // { comp, stackComp, plateLayer, outFile, shotName, isOS }

    try {
        for (var ci = 0; ci < shotComps.length; ci++) {
            var comp     = shotComps[ci];
            var shotName = shotNameFromComp(comp.name);
            var isOS     = isOvercan(comp.name);

            // Render target: _comp, with only the {shot}_stack precomp layer
            // enabled. This bakes any effects the user applied to the plate-
            // precomp layer (degrain, stabilize, etc.) into the output. After
            // import we disable those effects on the layer so the next pass
            // doesn't double-apply. Need references to: the precomp (for the
            // reimport destination), the outer precomp layer in _comp (for
            // solo + FX disable), and the plate inside (display only).
            var stackComp = ensureStack(comp, shotName, true);
            if (!stackComp) {
                errorLog.push(shotName + (isOS ? " [OS]" : "")
                    + ": no " + shotName + "_stack precomp (re-run Shot Roundtrip); skipped.");
                continue;
            }
            var ppOuter = null;
            for (var oi = 1; oi <= comp.numLayers; oi++) {
                try { if (comp.layer(oi).source === stackComp) { ppOuter = comp.layer(oi); break; } } catch (eOi) {}
            }
            if (!ppOuter) {
                errorLog.push(shotName + (isOS ? " [OS]" : "")
                    + ": " + stackComp.name + " has no matching layer in " + comp.name + "; skipped.");
                continue;
            }
            var srcPlate = findTopmostPlateLike(stackComp);
            if (!srcPlate) {
                errorLog.push(shotName + (isOS ? " [OS]" : "")
                    + ": " + stackComp.name + " has no plate-like layer inside; skipped.");
                continue;
            }

            var flagged = rerenderFlagOn(comp);

            var outName = shotName + "_" + suffix + (isOS ? "_OS" : "") + ".mov";
            var outFile = new File(fsShots.fsName + "/" + shotName + "/plate/" + outName);

            if (dryRun) {
                dryRunLog.push(shotName + (isOS ? " [OS]" : "") + ": "
                    + "would render " + comp.name + " (solo " + stackComp.name + ") \u2192 " + outFile.fsName
                    + " (plate: " + srcPlate.source.name + ")"
                    + (flagged ? " [flagged]" : ""));
                continue;
            }

            renderPlan.push({
                comp:             comp,
                stackComp:     stackComp,
                stackLayer: ppOuter,
                plateLayer:       srcPlate,
                outFile:          outFile,
                shotName:         shotName,
                isOS:             isOS,
                flagged:          flagged,
                // Full plate range (cut + handles), captured from the actual
                // geometry: the outer stack layer sits at startTime=fullStart
                // and the _stack precomp's duration IS fullDurationSec (see
                // shot_roundtrip.jsx stack-precomp build). Render this range,
                // NOT comp.workArea (which is the editorial cut only).
                fullStart:        ppOuter.startTime,
                fullDuration:     stackComp.duration
            });
        }
    } catch (ePrep) {
        errorLog.push("PREP: " + ePrep.message + " (line " + ePrep.line + ")");
    }

    // ── Dry-run exit ──────────────────────────────────────────────────────────
    if (dryRun) {
        var dMsg = "Dry run — no changes made.\n\n"
                 + "Comps scanned:        " + shotComps.length + "\n"
                 + "Plates to render:     " + dryRunLog.length;
        if (dryRunLog.length > 0) {
            dMsg += "\n\nWould render:";
            for (var di = 0; di < dryRunLog.length; di++) dMsg += "\n  " + dryRunLog[di];
        }
        if (errorLog.length > 0) {
            dMsg += "\n\nWarnings:";
            for (var ei = 0; ei < errorLog.length; ei++) dMsg += "\n  " + errorLog[ei];
        }
        showSummary("Re-render Plates — Dry Run", dMsg);
        return;
    }

    if (renderPlan.length === 0) {
        showSummary("Re-render Plates", "No plates to render.\n\n"
            + (errorLog.length > 0 ? ("Warnings:\n  " + errorLog.join("\n  ")) : ""));
        return;
    }

    // ── Confirm Shots ────────────────────────────────────────────────────────
    // User picks which plates to re-render. Cancel aborts cleanly — nothing
    // has been mutated yet (no version bump, no layer disabling).
    var confirmed = showConfirmDialog(renderPlan);
    if (confirmed === null) return;
    renderPlan = confirmed;
    if (renderPlan.length === 0) {
        showSummary("Re-render Plates", "No shots selected \u2014 nothing to render.");
        return;
    }

    // ── Version bump (AFTER confirm, so cancelled runs don't leave a copy) ───
    var versionedFile = saveAsNextVersion();
    if (!versionedFile) return;

    // ── Isolate plate-precomp layer in _comp + ensure output dirs ──────────
    // Snapshot _comp layer enabled-states. Solo the plate-precomp layer so
    // the render bakes any FX the user put on it (degrain, stabilize, etc.)
    // into the output. Guide layers are auto-excluded by AE at render time.
    app.beginUndoGroup("Re-render Plates: isolate");
    try {
        for (var pi = 0; pi < renderPlan.length; pi++) {
            var rp = renderPlan[pi];

            var shotDir = new Folder(fsShots.fsName + "/" + rp.shotName);
            if (!shotDir.exists) shotDir.create();
            var plateDir = new Folder(shotDir.fsName + "/plate");
            if (!plateDir.exists) plateDir.create();

            var restoreStates = [];
            for (var li = 1; li <= rp.comp.numLayers; li++) {
                var L = rp.comp.layer(li);
                restoreStates.push({
                    layer:   L,
                    enabled: L.enabled,
                    audio:   L.audioEnabled
                });
                if (L !== rp.stackLayer && !L.guideLayer) {
                    try { L.enabled = false; } catch (eEn) {}
                    try { L.audioEnabled = false; } catch (eAu) {}
                }
            }
            try { rp.stackLayer.enabled = true; } catch (ePE) {}
            rp.restoreStates = restoreStates;
        }
    } finally {
        app.endUndoGroup();
    }

    // ── Queue renders ─────────────────────────────────────────────────────────
    // Clear leftover items (previous runs, user-added comps) so only this
    // run's plates render. Iterate backward to keep indices valid on remove.
    try {
        for (var rqi = proj.renderQueue.numItems; rqi >= 1; rqi--) {
            try { proj.renderQueue.item(rqi).remove(); } catch (eRqr) {}
        }
    } catch (eRqClr) {}

    var queueErrors = [];
    for (var qi = 0; qi < renderPlan.length; qi++) {
        var entry = renderPlan[qi];
        try {
            // Render _comp over the FULL plate range (cut + handles),
            // mirroring how Shot Roundtrip rendered the original plate
            // (shot_roundtrip.jsx: timeSpanStart=fullStart, duration=
            // fullDurationSec). The _comp work area is the editorial CUT
            // ONLY, so rendering over it would drop the head+tail handles
            // and shift the plate by handleSec — breaking alignment for
            // every downstream tool. Only the plate-precomp layer is enabled
            // (above), so any FX on that layer get baked into the output.
            var rq = proj.renderQueue.items.add(entry.comp);
            // Epsilon pushes timeSpanStart past the frame boundary (matches Shot Roundtrip).
            rq.timeSpanStart    = entry.fullStart + 0.0001;
            rq.timeSpanDuration = entry.fullDuration;
            var om = rq.outputModule(1);
            var foundT = false;
            for (var t = 0; t < om.templates.length; t++) if (om.templates[t] === omTemplate) foundT = true;
            if (foundT) om.applyTemplate(omTemplate);
            om.file = entry.outFile;
            entry.rqItem = rq;
        } catch (eQ) {
            queueErrors.push(entry.shotName + (entry.isOS ? " [OS]" : "") + ": queue failed — " + eQ.message);
            entry.queueFailed = true;
        }
    }

    // ── Render ────────────────────────────────────────────────────────────────
    // AE blocks during renderQueue.render(); the render window takes over.
    var renderSucceeded = false;
    try {
        proj.save();
        proj.renderQueue.render();
        renderSucceeded = true;
    } catch (eR) {
        errorLog.push("RENDER: " + eR.message + " — check OM Template and disk space.");
    }

    // ── Restore layer states (always, even on render failure) ─────────────────
    app.beginUndoGroup("Re-render Plates: restore + import");
    try {
        for (var rI = 0; rI < renderPlan.length; rI++) {
            var e = renderPlan[rI];
            for (var rs = 0; rs < e.restoreStates.length; rs++) {
                var st = e.restoreStates[rs];
                try { st.layer.enabled      = st.enabled; } catch (eR1) {}
                try { st.layer.audioEnabled = st.audio;   } catch (eR2) {}
            }
        }
    } catch (eRestore) {
        errorLog.push("RESTORE: " + eRestore.message);
    }

    // ── Import rendered plates back into the _stack precomp ──────────────────
    var imported = 0;
    var reloaded = 0;
    var skipped  = 0;

    if (renderSucceeded) {
        var importedFiles = buildImportedFilesMap();
        for (var iI = 0; iI < renderPlan.length; iI++) {
            var ent = renderPlan[iI];
            if (ent.queueFailed) continue;
            if (!waitForFile(ent.outFile, 20)) {
                errorLog.push(ent.shotName + (ent.isOS ? " [OS]" : "")
                    + ": rendered file not found at " + ent.outFile.fsName);
                continue;
            }

            var fsPath = ent.outFile.fsName;
            var footageItem = importedFiles[fsPath] || null;
            var shotBin = getChildBin(binShots, ent.shotName);
            var plateBin = shotBin ? getOrCreateChildBin(shotBin, "plate") : null;

            if (!footageItem) {
                try {
                    footageItem = proj.importFile(new ImportOptions(ent.outFile));
                    if (plateBin) footageItem.parentFolder = plateBin;
                    footageItem.label = 12; // Sandstone — plate variant (neither grade nor render)
                    importedFiles[fsPath] = footageItem;
                    imported++;
                } catch (eIm) {
                    errorLog.push(ent.shotName + (ent.isOS ? " [OS]" : "")
                        + ": import failed — " + eIm.message);
                    continue;
                }
            } else {
                // File may have been overwritten by a prior run — refresh source.
                try { footageItem.replace(ent.outFile); reloaded++; } catch (eRl) {}
            }

            // Reimported variant goes back inside the same precomp we rendered.
            if (isFootageInComp(ent.stackComp, footageItem)) {
                skipped++;
                continue;
            }
            try {
                var newLayer = ent.stackComp.layers.add(footageItem);
                // The render now spans the full cut+handles range, which
                // equals the _stack precomp's duration, so the new layer at
                // startTime=0 fills it exactly (precomp-time 0 == leading
                // handle frame == source-TC fullStart via displayStartTime).
                try { newLayer.startTime = 0; } catch (eST) {}
                newLayer.position.setValue([ent.stackComp.width / 2, ent.stackComp.height / 2]);
                newLayer.label = 12;
                // Plate variants sit above existing plate-like layers but
                // below any renders/grades — matches import_renders.jsx's
                // stack-above-topmost-plate-like convention.
                var plateTop = findTopmostPlateLike(ent.stackComp);
                if (plateTop && plateTop !== newLayer) {
                    try { newLayer.moveBefore(plateTop); } catch (eMv) {}
                }
                // Disable every non-guide layer BELOW the new variant so the
                // fresh render becomes the active plate. Earlier variants stay
                // in the stack (user can re-enable if they want to roll back).
                for (var lb = newLayer.index + 1; lb <= ent.stackComp.numLayers; lb++) {
                    var bL = ent.stackComp.layer(lb);
                    if (bL.guideLayer) continue;
                    try { bL.enabled      = false; } catch (eDisE) {}
                    try { bL.audioEnabled = false; } catch (eDisA) {}
                }

                // Disable every effect on the plate-precomp layer in _comp —
                // they've been baked into the newly-rendered variant, so
                // leaving them live would double-apply on the next pass (e.g.
                // degraining the already-degrained plate). Keep the "Re-render"
                // Checkbox Control so the flag UX still works.
                if (ent.stackLayer) {
                    try {
                        var effs = ent.stackLayer.Effects;
                        for (var ei = 1; ei <= effs.numProperties; ei++) {
                            var eff = effs.property(ei);
                            if (eff && eff.name === RR_EFFECT_NAME) continue;
                            try { eff.enabled = false; } catch (eDisFX) {}
                        }
                    } catch (eEffs) {}
                }
            } catch (eAdd) {
                errorLog.push(ent.shotName + (ent.isOS ? " [OS]" : "")
                    + ": failed to add layer — " + eAdd.message);
            }

            // Auto-reset the Re-render checkbox on success so the flag doesn't
            // linger into the next run. Silent no-op if the effect is missing.
            if (ent.flagged) { rerenderFlagReset(ent.comp); }
        }
    }
    app.endUndoGroup();

    // ── Summary ───────────────────────────────────────────────────────────────
    var queued = renderPlan.length - queueErrors.length;
    showSummaryStructured("Re-render Plates Complete", {
        stats: [
            ["Comps scanned:",        shotComps.length],
            ["Plates queued:",        queued],
            ["Rendered + imported:",  imported],
            ["Reloaded (overwrite):", reloaded],
            ["Already in precomp:",   skipped]
        ],
        workingIn:   versionedFile ? versionedFile.displayName : null,
        queueErrors: queueErrors,
        errors:      errorLog
    });

    function showSummaryStructured(title, data) {
        var dlg = new Window("dialog", title);
        dlg.orientation = "column"; dlg.alignChildren = ["fill", "top"];
        dlg.spacing = 10; dlg.margins = 14;

        var LABEL_W = 170;
        var statsPnl = dlg.add("panel", undefined, "Summary");
        statsPnl.orientation = "column";
        statsPnl.alignChildren = ["fill", "top"];
        statsPnl.margins = [12, 12, 12, 12]; statsPnl.spacing = 4;
        for (var si = 0; si < data.stats.length; si++) {
            var row = statsPnl.add("group");
            row.orientation = "row"; row.alignChildren = ["left", "center"]; row.spacing = 8;
            var lbl = row.add("statictext", undefined, data.stats[si][0]);
            lbl.preferredSize = [LABEL_W, 18];
            row.add("statictext", undefined, String(data.stats[si][1]));
        }

        if (data.workingIn) {
            var fPnl = dlg.add("panel", undefined, "File");
            fPnl.orientation = "column";
            fPnl.alignChildren = ["fill", "top"];
            fPnl.margins = [12, 12, 12, 12]; fPnl.spacing = 4;
            var fRow = fPnl.add("group");
            fRow.orientation = "row"; fRow.alignChildren = ["left", "center"]; fRow.spacing = 8;
            var fLbl = fRow.add("statictext", undefined, "Working in:");
            fLbl.preferredSize = [LABEL_W, 18];
            fRow.add("statictext", undefined, data.workingIn);
            fPnl.add("statictext", undefined, "Original preserved on disk as the rollback point.");
        }

        var hasErrs = (data.queueErrors && data.queueErrors.length > 0) ||
                      (data.errors      && data.errors.length      > 0);
        if (hasErrs) {
            var ePnl = dlg.add("panel", undefined, "Errors / warnings");
            ePnl.orientation = "column";
            ePnl.alignChildren = ["fill", "top"];
            ePnl.margins = [12, 12, 12, 12]; ePnl.spacing = 4;
            var body = "";
            if (data.queueErrors && data.queueErrors.length > 0) {
                body += "Queue errors:\n";
                for (var qi2 = 0; qi2 < data.queueErrors.length; qi2++) body += "  " + data.queueErrors[qi2] + "\n";
                if (data.errors && data.errors.length > 0) body += "\n";
            }
            if (data.errors) {
                for (var ei2 = 0; ei2 < data.errors.length; ei2++) body += "  " + data.errors[ei2] + "\n";
            }
            var lines = body.split("\n").length;
            var maxH  = $.screens[0].bottom - $.screens[0].top - 360;
            var textH = Math.min(Math.max(lines * 15 + 10, 60), maxH);
            var txt = ePnl.add("edittext", undefined, body,
                { multiline: true, readonly: true, scrollable: true });
            txt.preferredSize = [460, textH];
        }

        var btnRow = dlg.add("group");
        btnRow.alignment = ["right", "bottom"];
        var ok = btnRow.add("button", undefined, "OK"); ok.preferredSize = [80, 28];
        ok.onClick = function () { dlg.close(); };
        dlg.show();
    }

    function showSummary(title, body) {
        var sumDlg = new Window("dialog", title);
        sumDlg.orientation = "column";
        sumDlg.alignChildren = ["fill", "top"];
        sumDlg.spacing = 10;
        sumDlg.margins = 14;

        var lines = body.split("\n").length;
        var maxH = $.screens[0].bottom - $.screens[0].top - 200;
        var textH = Math.min(lines * 18 + 10, maxH);

        var txt = sumDlg.add("edittext", undefined, body,
            { multiline: true, readonly: true, scrollable: true });
        txt.preferredSize = [460, textH];

        var row = sumDlg.add("group");
        row.alignment = ["right", "bottom"];
        var ok = row.add("button", undefined, "OK");
        ok.onClick = function () { sumDlg.close(); };
        sumDlg.show();
    }

})();
