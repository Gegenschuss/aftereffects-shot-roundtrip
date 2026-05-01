/*
       _____                          __
      / ___/__ ___ ____ ___  ___ ____/ /  __ _____ ___
     / (_ / -_) _ `/ -_) _ \(_-</ __/ _ \/ // (_-<(_-<
     \___/\__/\_, /\__/_//_/___/\__/_//_/\_,_/___/___/
             /___/

  IMPORT RENDERS & GRADES
  After Effects ExtendScript
================================================================================

PURPOSE
-------
Scans all *_comp compositions in the AE project and imports finished
returns from two sources:

  1. each shot's render/ folder    – VFX returns from Nuke etc.
  2. a flat {shots}/_grade/ folder  – Resolve-graded returns (optional),
                                      matched to shots by filename prefix

Per shot, the script ensures a {shot}_stack precomp exists inside
{shot}_comp (Shot Roundtrip creates it; this tool lazy-creates it if
missing). All reimported variants — grades, VFX renders, denoised
plate variants — stack inside that precomp. The raw plate stays flat
+ locked at the bottom of _comp and is NEVER inside the stack.

Stacking order inside {shot}_stack:

    Top  →  grade   (from _grade/, matched by filename prefix)
            render  (from {shot}/render/)
            plate   (variants from Re-render Plates, if any)

Each new import becomes the topmost layer within its category; layers
below it get disabled so only the freshest one is visible. Users can
re-enable older variants manually for comparison / rollback.

NAMING CONVENTION (STRICT)
--------------------------
This tool relies on the strict _comp suffix to map comps to disk folders:

    {prefix}_010_comp    ->   {shots}/{prefix}_010/
    {prefix}_010_comp_OS ->   {shots}/{prefix}_010/   (overscan variant)

Comps that do not end in _comp (or _comp_OS) are ignored entirely.

Grades in the flat {shots}/_grade/ folder are matched to the correct
comp by filename prefix — a file must begin with the shot name, e.g.
    KM_010_grade_v01.mov  ->  comp "KM_010_comp"

FOLDER STRUCTURE
----------------
The script expects the same layout the Shot Roundtrip creates, plus an
optional flat _grade/ folder for Resolve returns:

    {shots}/              (default: "../Roundtrip")
      {prefix}_010/
        plate/            <- rendered plate (.mov)
        render/           <- VFX return renders go here
      _grade/             <- Resolve graded returns for all shots
        {prefix}_010_grade_v01.mov
        {prefix}_020_grade_v01.mov

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
    if (!proj || !proj.file) { greyAlert("Import Returns", "Save the project first."); return; }

    // ── UI ────────────────────────────────────────────────────────────────────
    var LABEL_W = 120; var FIELD_H = 22;

    var addRow = function (parent, labelText) {
        var g = parent.add("group");
        g.orientation = "row"; g.alignChildren = ["left", "center"]; g.spacing = 8;
        var lbl = g.add("statictext", undefined, labelText);
        lbl.preferredSize = [LABEL_W, FIELD_H];
        return g;
    };

    var dlg = new Window("dialog", "Import Returns");
    dlg.orientation = "column"; dlg.alignChildren = ["fill", "top"];
    dlg.spacing = 10; dlg.margins = 14;

    var about = dlg.add("statictext", undefined,
          "Scans every *_comp composition, pulls finished VFX renders "
        + "from each {shot}/render/ folder and Resolve grades from the "
        + "flat {shots}/_grade/ folder, and imports them back into the "
        + "project. Results land inside each {shot}_footage precomp "
        + "stacked newest-on-top (grade > render > plate), with only "
        + "the topmost per category enabled.",
        { multiline: true });
    about.preferredSize = [520, 72];

    var pnl = dlg.add("panel", undefined, "Settings");
    pnl.orientation = "column"; pnl.alignChildren = ["fill", "top"];
    pnl.spacing = 6; pnl.margins = [10, 15, 10, 10];

    var r1 = addRow(pnl, "Shots Folder:");
    var etShotsFolder = r1.add("edittext", undefined, "../Roundtrip");
    etShotsFolder.preferredSize = [150, FIELD_H];
    var btnBrowseShots = r1.add("button", undefined, "Browse\u2026");
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

    var r2 = addRow(pnl, "File Filter:");
    var etFilter = r2.add("edittext", undefined, "*.mov");
    etFilter.preferredSize = [150, FIELD_H];

    var chkDryRun = pnl.add("checkbox", undefined, "Dry run");
    chkDryRun.value = false;

    // ── Settings persistence ──────────────────────────────
    // Shots Folder and File Filter get round-tripped through app.settings.
    // Dry Run (debug) isn't persisted. Reset restores defaults in the fields
    // without saving until the user clicks Import.
    var IR_SECTION  = "Gegenschuss Import Returns";
    var IR_DEFAULTS = {
        shotsFolder:    "../Roundtrip",
        fileFilter:     "*.mov"
    };
    function irLoad(key, fallback) {
        try {
            if (app.settings.haveSetting(IR_SECTION, key)) return app.settings.getSetting(IR_SECTION, key);
        } catch (e) {}
        return fallback;
    }
    function irSave(key, value) {
        try { app.settings.saveSetting(IR_SECTION, key, String(value)); } catch (e) {}
    }
    function irApply(s) {
        etShotsFolder.text     = s.shotsFolder;
        etFilter.text          = s.fileFilter;
    }
    irApply({
        shotsFolder:   irLoad("shotsFolder",   IR_DEFAULTS.shotsFolder),
        fileFilter:    irLoad("fileFilter",    IR_DEFAULTS.fileFilter)
    });

    var btnGrp = dlg.add("group");
    btnGrp.orientation = "row"; btnGrp.alignment = ["fill", "bottom"]; btnGrp.margins = [0, 4, 0, 0];
    var btnReset  = btnGrp.add("button", undefined, "Reset to Defaults"); btnReset.preferredSize  = [130, 28];
    var btnCancel = btnGrp.add("button", undefined, "Cancel");            btnCancel.preferredSize = [80, 28];
    var btnSpacer = btnGrp.add("statictext", undefined, "");              btnSpacer.alignment = ["fill", "center"];
    var btnOk     = btnGrp.add("button", undefined, "Import Returns"); btnOk.preferredSize = [130, 28];

    btnReset.onClick  = function () { irApply(IR_DEFAULTS); };
    btnOk.onClick     = function () {
        irSave("shotsFolder",   etShotsFolder.text);
        irSave("fileFilter",    etFilter.text);
        dlg.close(1);
    };
    btnCancel.onClick = function () { dlg.close(2); };

    if (dlg.show() !== 1) return;

    // ── Resolve paths ─────────────────────────────────────────────────────────
    var aepFolder = proj.file.parent;
    // Accept either an absolute path (from Browse) or one relative to the
    // .aep's parent (legacy default "../Roundtrip").
    var shotsPathText = etShotsFolder.text;
    var fsShots = /^(\/|[A-Za-z]:)/.test(shotsPathText)
                ? new Folder(shotsPathText)
                : new Folder(aepFolder.fsName + "/" + shotsPathText);
    if (!fsShots.exists) { greyAlert("Import Returns", "Shots folder not found:\n" + fsShots.fsName); return; }

    var fileFilter     = etFilter.text;
    var dryRun         = chkDryRun.value;

    // ── Helpers ───────────────────────────────────────────────────────────────

    // Find or create a folder item in the project.
    function getBinFolder(name) {
        for (var i = 1; i <= proj.numItems; i++) {
            if (proj.item(i).name === name && proj.item(i) instanceof FolderItem) return proj.item(i);
        }
        return proj.items.addFolder(name);
    }

    // Find a child folder by name under a parent bin.
    function getChildBin(parentBin, childName) {
        for (var i = 1; i <= proj.numItems; i++) {
            var it = proj.item(i);
            if (it instanceof FolderItem && it.name === childName && it.parentFolder === parentBin) return it;
        }
        return null;
    }

    // Find or create a child folder under a parent bin.
    function getOrCreateChildBin(parentBin, childName) {
        var existing = getChildBin(parentBin, childName);
        if (existing) return existing;
        var f = proj.items.addFolder(childName);
        f.parentFolder = parentBin;
        return f;
    }

    // Collect all _comp and _comp_OS comps from project.
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

    // Derive the shot name from a comp name: strip _comp or _comp_OS suffix.
    function shotNameFromComp(compName) {
        return compName.replace(/_comp(_OS)?$/i, "");
    }

    // Build a map of file paths already imported as footage in the project.
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

    // Check if a footage item is already used as a layer in a comp.
    function isFootageInComp(comp, footageItem) {
        for (var i = 1; i <= comp.numLayers; i++) {
            try {
                if (comp.layer(i).source === footageItem) return true;
            } catch (e) {}
        }
        return false;
    }

    // Find the plate layer in a comp: bottommost footage layer whose source
    // file path contains /plate/ or whose name contains _plate.
    // Find the plate layer — the reference layer that new renders/grades will
    // be aligned to (startTime + markers copied from it). Four-tier fallback:
    //   1. Tagged plate: path contains /plate/ or filename has _plate.
    //      (the roundtrip's own convention)
    //   2. Non-render/grade footage whose name STARTS WITH THE SHOT NAME
    //      (e.g. plate named "IP_010.mov" in shot "IP_010"). Prevents
    //      unrelated footage that happens to live in the comp (other plates,
    //      reference clips, etc.) from being adopted.
    //   3. Any non-render/grade footage — plate with an unrelated name.
    //   4. Any footage layer at all — last resort so imports still land on
    //      something sensible instead of comp time 0.
    // Each tier picks the BOTTOMMOST match so stacks with plate at the
    // bottom (VFX convention) work without surprises.
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
                // Exclude renders and grades from the untagged-plate fallbacks;
                // those are outputs, not the source plate reference.
                if (/[\/\\]render[\/\\]/i.test(fp) || /[\/\\]_grade[\/\\]/i.test(fp)) continue;
                // Shot-name prefix match (tier 2) — the most likely plate when
                // there are no /plate/ path or _plate. filename tags.
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

    // Return the topmost existing render-or-grade layer (the current "head"
    // of the VFX/grade stack). New grades stack above this anchor; new
    // renders stack above the topmost plate-like layer directly.
    function findTopmostRenderOrGrade(comp) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            if (L.guideLayer) continue;
            try {
                if (L.source instanceof FootageItem && L.source.file) {
                    var fp = L.source.file.fsName;
                    if (/[\/\\]render[\/\\]/i.test(fp) || /[\/\\]_grade[\/\\]/i.test(fp)) return L;
                }
            } catch (e) {}
        }
        return null;
    }

    // Return the topmost footage layer that is NOT a render or grade —
    // the "active plate variant" that new imports should cover. Handles
    // the case where the user rendered a processed plate variant
    // (stabilized, denoised, retimed, …) and sits it above the original
    // plate: both are plate-like, and renders/grades should stack above
    // the topmost one so they actually cover the active variant instead
    // of landing between the two plates.
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

    // Find all layers in a comp whose source path contains the given segment
    // (e.g. "render" for {shot}/render/, "_grade" for {shots}/_grade/).
    // Returns them in top-to-bottom layer order.
    function findLayersByPathSegment(comp, segment) {
        var esc = segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        var re = new RegExp("[\\/\\\\]" + esc + "[\\/\\\\]", "i");
        var result = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            try {
                if (L.source instanceof FootageItem && L.source.file) {
                    if (re.test(L.source.file.fsName)) result.push(L);
                }
            } catch (e) {}
        }
        return result;
    }

    // Save As → next _v## version before the import touches anything.
    // Same VFX-versioning rule shot_roundtrip uses: MyProject_v03.aep →
    // MyProject_v04.aep. If the filename has no _v## suffix, tack on
    // _v01. If the target already exists on disk, bump further. The
    // ORIGINAL file stays untouched as the rollback point; the AE
    // session continues in the new file. Returns the new File on
    // success, or null on failure (caller aborts so the original is
    // never modified).
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
            greyAlert("Import Returns", "Could not find an unused version number for the backup copy.\nAborting so nothing is modified.");
            return null;
        }
        try {
            proj.save();
            proj.save(newFile);
        } catch (eSave) {
            greyAlert("Import Returns", "Failed to save versioned copy —\n" + eSave.message +
                  "\n\nAborting so the original file stays untouched.");
            return null;
        }
        return newFile;
    }

    // Derive the stack-precomp name from a _comp name.
    //   "KM_010_comp"    → "KM_010_stack"
    //   "KM_010_comp_OS" → "KM_010_stack_OS"
    function stackCompNameFor(compName) {
        return compName.replace(/_comp(_OS)?$/i, function (_m, os) {
            return "_stack" + (os || "");
        });
    }

    // Ensure a {shot}_stack precomp exists as a layer at the TOP of `comp`,
    // and return its CompItem. The precomp is empty on first creation — it
    // holds reimported variants only (grades, VFX renders, denoised plate
    // variants). The raw plate stays flat + locked at the bottom of `comp`,
    // never touched. Returns null in readOnly (dry-run) mode when the precomp
    // doesn't exist yet, so the caller can log "would create".
    function ensureStack(comp, shotName, readOnly) {
        var targetName = stackCompNameFor(comp.name);
        // Already exists?
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            try {
                if (L.source instanceof CompItem && L.source.name === targetName) {
                    return L.source;
                }
            } catch (e) {}
        }
        if (readOnly) return null;

        // Create empty CompItem matching `comp`'s dimensions + duration +
        // frame rate so imported variants can be placed at their natural
        // source-time position without further remapping.
        var newComp = proj.items.addComp(
            targetName, comp.width, comp.height, comp.pixelAspect,
            comp.duration, comp.frameRate
        );
        newComp.displayStartTime = 0;

        // File under {Shots}/{shot}/plate/ so it sits next to the plate footage.
        try {
            var shotBin      = getChildBin(binShots, shotName);
            var shotPlateBin = shotBin ? getOrCreateChildBin(shotBin, "plate") : null;
            if (shotPlateBin) newComp.parentFolder = shotPlateBin;
        } catch (eBin) {}

        // Copy outer-comp cut markers so the alignment cascade below (which
        // reads `importTarget.markerProperty`) finds them inside the precomp.
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

        // Add as top layer in _comp, starting at comp time 0.
        var newLayer = comp.layers.add(newComp);
        try { newLayer.moveToBeginning(); } catch (eMB) {}
        try { newLayer.startTime = 0; } catch (eST) {}
        return newComp;
    }

    // ── Main ──────────────────────────────────────────────────────────────────
    var shotComps = collectShotComps();
    if (shotComps.length === 0) { greyAlert("Import Returns", "No *_comp compositions found in the project."); return; }

    var importedFiles = buildImportedFilesMap();
    var binShots = getBinFolder("Shots");

    var statsImported      = 0;
    var statsSkipped       = 0;
    var statsComps         = 0;
    var compsWithNewRenders = [];
    var dryRunLog          = [];
    var errorLog           = [];

    // Save As → next _v## version BEFORE any DOM mutation, matching
    // the shot_roundtrip convention. Every change this script makes
    // lands in the new file; the original sits on disk as the rollback
    // point. Dry-run skips the bump (no mutations to back up).
    var versionedFile = null;
    if (!dryRun) {
        versionedFile = saveAsNextVersion();
        if (!versionedFile) return;   // aborted; original untouched
    }

    if (!dryRun) app.beginUndoGroup("Import Returns");
    try {

        // Two return sources per comp:
        //   render → per-shot folder {shots}/{shot}/render/   (all files)
        //   grade  → flat folder {shots}/_grade/              (files whose name
        //                                                     starts with shot)
        //
        // Processed bottom → top. AE's comp.layers.add() always puts the new
        // layer at the top of the stack, so processing "render" before "grade"
        // guarantees grades end up above VFX returns. Within a category, files
        // are sorted oldest-first so the newest ends up topmost within its group.

        // Pre-read the flat grades folder once per run. Safety-net scaffold
        // in case the user runs this before Shot Roundtrip ever created
        // _grade/. See lib/write_readmes.jsx for the README content.
        var gradesDir = new Folder(fsShots.fsName + "/_grade");
        if (!gradesDir.exists) {
            gradesDir.create();
            try {
                var readmeHelper = new File((new File($.fileName)).parent.parent.fsName + "/lib/write_readmes.jsx");
                if (readmeHelper.exists) $.evalFile(readmeHelper);
                if (typeof writeGradeReadme === "function") writeGradeReadme(gradesDir);
            } catch (eG) { /* non-fatal */ }
        }
        var gradesFiles = gradesDir.getFiles(fileFilter) || [];

        // A filename matches a shot when it starts with the shot name AND the
        // next character is a separator (e.g. "_"), not another letter/digit.
        // Prevents "KM_01" from matching grades for "KM_010".
        function nameStartsWithShot(filename, shotName) {
            var fn = filename.toLowerCase();
            var sn = shotName.toLowerCase();
            if (fn.indexOf(sn) !== 0) return false;
            if (fn.length === sn.length) return true;
            return !/[a-z0-9]/.test(fn.charAt(sn.length));
        }

        function filesForCategory(category, shotName) {
            if (category === "render") {
                var renderDir = new Folder(fsShots.fsName + "/" + shotName + "/render");
                if (!renderDir.exists) return [];
                return renderDir.getFiles(fileFilter) || [];
            }
            // grade: filter flat _grade/ by filename prefix (shot name).
            var matched = [];
            for (var i = 0; i < gradesFiles.length; i++) {
                if (nameStartsWithShot(gradesFiles[i].name, shotName)) {
                    matched.push(gradesFiles[i]);
                }
            }
            return matched;
        }

        var CATEGORIES = ["render", "grade"];

        for (var ci = 0; ci < shotComps.length; ci++) {
            var comp     = shotComps[ci];
            var shotName = shotNameFromComp(comp.name);
            // Skip shots with no files queued to import — don't create empty
            // {shot}_stack precomps just because Import Returns was run.
            var hasAnyFiles = false;
            for (var ck = 0; ck < CATEGORIES.length; ck++) {
                if (filesForCategory(CATEGORIES[ck], shotName).length > 0) { hasAnyFiles = true; break; }
            }
            if (!hasAnyFiles) continue;

            // {shot}_stack precomp holds all reimported variants (grades, VFX
            // renders, denoised plate variants). Lazy-created the first time
            // any variant is imported — the raw plate stays flat + locked at
            // the bottom of _comp and is NEVER inside the precomp.
            var stackComp = ensureStack(comp, shotName, dryRun);
            var importTarget = stackComp || comp;  // dry-run fallback for log/alignment
            if (dryRun && !stackComp) {
                dryRunLog.push(shotName + " [precomp]: would create "
                    + stackCompNameFor(comp.name));
            }
            // Raw plate always lives in `_comp` (locked by Shot Roundtrip).
            // The precomp holds only reimported variants. Find the hero plate
            // in `comp`, not `importTarget`.
            var plateLayer = findPlateLayer(comp, shotName);
            var shotBin    = getChildBin(binShots, shotName);
            var addedAny   = false;
            var foundAnyCategoryFiles = false;

            for (var catIdx = 0; catIdx < CATEGORIES.length; catIdx++) {
                var category = CATEGORIES[catIdx];
                var catFiles = filesForCategory(category, shotName);
                if (catFiles.length === 0) continue;

                // Oldest first → newest ends up as topmost layer within category.
                catFiles.sort(function (a, b) { return a.modified.getTime() - b.modified.getTime(); });

                foundAnyCategoryFiles = true;

                // Destination bin in the AE project panel. Per-shot sub-bins
                // for both renders and grades so each shot's bin contains
                // everything that belongs to it (plate, render, grade)
                // instead of scattering grades into a separate top-level bin.
                var destBin;
                if (category === "render") {
                    destBin = shotBin ? getOrCreateChildBin(shotBin, "render") : null;
                } else {
                    destBin = shotBin ? getOrCreateChildBin(shotBin, "grade")  : null;
                }

                // Stack anchor: new layers will be moved to just above this
                // layer so imports sit directly above the active plate
                // variant (renders) or above the existing render/grade stack
                // (grades). Anchor updates to each new layer so oldest-first
                // processing ends up with newest on top within the category.
                //   - renders: anchor = topmost plate-like layer (so a
                //     stabilized/denoised plate variant sitting above the
                //     original plate still gets covered, not sandwiched).
                //     Falls back to plateLayer if nothing plate-like is
                //     found (defensive — shouldn't happen in practice).
                //   - grades:  anchor = topmost existing render-or-grade,
                //     or topmost plate-like if none exists yet.
                var plateLikeTop = findTopmostPlateLike(importTarget) || plateLayer;
                var stackAnchor = null;
                if (category === "render") {
                    stackAnchor = plateLikeTop;
                } else {
                    stackAnchor = findTopmostRenderOrGrade(importTarget) || plateLikeTop;
                }

                for (var fi = 0; fi < catFiles.length; fi++) {
                    var catFile = catFiles[fi];
                    var fsPath  = catFile.fsName;
                    var footageItem = importedFiles[fsPath] || null;

                    if (footageItem && isFootageInComp(importTarget, footageItem)) {
                        statsSkipped++;
                        continue;
                    }

                    if (dryRun) {
                        dryRunLog.push(shotName + " [" + category + "]: " + catFile.name
                            + (footageItem ? " (add layer)" : " (import + add)"));
                        statsImported++;
                        continue;
                    }

                    if (!footageItem) {
                        try {
                            footageItem = proj.importFile(new ImportOptions(catFile));
                            if (destBin) footageItem.parentFolder = destBin;
                            else if (shotBin) footageItem.parentFolder = shotBin;
                            // Cyan (14) for renders to distinguish from the
                            // plate (green 9). Grades stay purple (11).
                            footageItem.label = (category === "grade") ? 11 : 14;
                            importedFiles[fsPath] = footageItem;
                        } catch (e) {
                            errorLog.push(shotName + " [" + category + "]: failed to import " + catFile.name + " — " + e.message);
                            continue;
                        }
                    }

                    try {
                        var newLayer = importTarget.layers.add(footageItem);
                        // Drop at startTime=0 (local, first frame of the precomp).
                        // Reimported variants are expected to be clip+handles long
                        // — matching the precomp's duration — so they fill the
                        // container exactly. Keeps imports aligned with the plate
                        // already inside without any cut-marker math.
                        try { newLayer.startTime = 0; } catch (eST) {}
                        newLayer.position.setValue([importTarget.width / 2, importTarget.height / 2]);
                        newLayer.label = (category === "grade") ? 11 : 14;
                        // Position the new layer just above the current stack
                        // anchor (plate for renders, topmost existing render/
                        // grade for grades). Then promote the new layer to the
                        // anchor so the next iteration stacks above it — keeps
                        // the "newest on top within category" ordering while
                        // planting the whole group right above the plate.
                        if (stackAnchor) {
                            try { newLayer.moveBefore(stackAnchor); } catch (eMove) {}
                            stackAnchor = newLayer;
                        }
                        // Disable every non-guide layer BELOW the new import so
                        // the freshly-arrived render/grade becomes the visible
                        // one. Old variants stay in the stack but dark — the
                        // user can re-enable any for comparison / rollback.
                        for (var lbI = newLayer.index + 1; lbI <= importTarget.numLayers; lbI++) {
                            var lbL = importTarget.layer(lbI);
                            if (lbL.guideLayer) continue;
                            try { lbL.enabled      = false; } catch (eLbE) {}
                            try { lbL.audioEnabled = false; } catch (eLbA) {}
                        }
                        addedAny = true;
                        statsImported++;
                    } catch (e) {
                        errorLog.push(shotName + " [" + category + "]: failed to add layer " + catFile.name + " — " + e.message);
                    }
                }
            }

            // If no category folder had any files, nothing to do for this comp.
            if (!foundAnyCategoryFiles) continue;

            statsComps++;
            if (dryRun) continue;

            // Within each category, keep only the topmost (newest) layer enabled.
            var CATEGORY_SEGMENTS = { render: "render", grade: "_grade" };
            for (var ck = 0; ck < CATEGORIES.length; ck++) {
                var catLayers = findLayersByPathSegment(importTarget, CATEGORY_SEGMENTS[CATEGORIES[ck]]);
                for (var li = 1; li < catLayers.length; li++) {
                    catLayers[li].enabled = false;
                    catLayers[li].audioEnabled = false;
                }
            }

            // Plate enabled-state is intentionally NOT touched. The user
            // manages plate visibility manually so they can verify the
            // import before hiding the source — see the README "Tools →
            // Import Returns" block for the reasoning.

            if (addedAny) compsWithNewRenders.push(shotName);
        }

    } catch (e) {
        greyAlert("Import Returns", "Error:\n" + e.message + "\nLine: " + e.line);
    }
    if (!dryRun) app.endUndoGroup();

    // ── Summary ───────────────────────────────────────────────────────────────
    var title = dryRun ? "Import Returns — Dry Run" : "Import Returns Complete";

    var msg = "Comps scanned:       " + shotComps.length + "\n"
            + "Comps with renders:  " + statsComps + "\n"
            + "Renders to import:   " + statsImported + "\n"
            + "Already present:     " + statsSkipped;

    if (versionedFile) {
        msg += "\n\nWorking in:          " + versionedFile.displayName
             + "\n(original preserved on disk as the rollback point)";
    }

    if (dryRunLog.length > 0) {
        msg += "\n\nWould import:";
        for (var di = 0; di < dryRunLog.length; di++) msg += "\n  " + dryRunLog[di];
    }

    if (compsWithNewRenders.length > 0) {
        msg += "\n\nNew renders in:";
        for (var ci2 = 0; ci2 < compsWithNewRenders.length; ci2++) msg += "\n  " + compsWithNewRenders[ci2];
    }

    if (errorLog.length > 0) {
        msg += "\n\nErrors:";
        for (var ei = 0; ei < errorLog.length; ei++) msg += "\n  " + errorLog[ei];
    }

    var sumDlg = new Window("dialog", title);
    sumDlg.orientation = "column";
    sumDlg.alignChildren = ["fill", "top"];
    sumDlg.spacing = 10;
    sumDlg.margins = 14;

    var msgLines = msg.split("\n").length;
    var lineH = 18;
    var maxH = $.screens[0].bottom - $.screens[0].top - 200; // leave room for title bar + button
    var textH = Math.min(msgLines * lineH + 10, maxH);

    var sumText = sumDlg.add("edittext", undefined, msg, { multiline: true, readonly: true, scrollable: true });
    sumText.preferredSize = [400, textH];

    var sumBtnGrp = sumDlg.add("group");
    sumBtnGrp.alignment = ["right", "bottom"];
    var sumOk = sumBtnGrp.add("button", undefined, "OK");
    sumOk.onClick = function () { sumDlg.close(); };

    sumDlg.show();

})();
