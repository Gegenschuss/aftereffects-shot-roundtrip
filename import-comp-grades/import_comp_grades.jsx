/*
 *       _____                          __
 *      / ___/__ ___ ____ ___  ___ ____/ /  __ _____ ___
 *     / (_ / -_) _ `/ -_) _ \(_-</ __/ _ \/ // (_-<(_-<
 *     \___/\__/\_, /\__/_//_/___/\__/_//_/\_,_/___/___/
 *             /___/
 */

/**
 * Import Comp Grades
 *
 * Complementary importer for Export Shot XML's "Active composition" mode —
 * the Comp Grade Roundtrip (one-comp counterpart to the project-wide
 * Shot Roundtrip workflow).
 *
 * Workflow:
 *   1. Open the comp you want to grade.
 *   2. Run Export Shot XML → "Active composition" → hand the XML to Resolve.
 *   3. Grade in Resolve, render the graded returns into an `_grade/` folder
 *      next to the AEP (or any folder you prefer — you'll be able to pick).
 *      Filenames must start with the source file stem (Resolve's default
 *      clip-naming does this — e.g. "VS_004_plate" → "VS_004_plate_Iris_v01.mov").
 *   4. Back in AE, open the same comp, run this script. A small dialog
 *      lets you confirm or change the source folder (defaults to `_grade/`
 *      next to the AEP). For each footage layer it finds a matching
 *      graded file and drops it in as a NEW layer directly ABOVE the
 *      original, aligned by embedded source timecode. The grade replaces
 *      the plate visually; the plate stays in place as a safety net.
 *
 * Folder override: the source folder defaults to `_grade/` next to the
 * AEP, but any folder works (denoised plates, stabilized reruns, any
 * external delivery). Point the dialog at it and the same stem-prefix
 * matching + TC alignment apply.
 *
 * Matching rule: graded file name must START WITH the source file stem
 * followed by a non-alphanumeric separator. Same convention as
 * Import Returns uses for shots-mode grades. Resolve's "Use Unique
 * Filenames" appends something like `_V1-0064` — still matches, because
 * everything after the stem is just a suffix. Multiple matches → newest
 * wins by file modification time (most-recently-rendered).
 *
 * Placement rule (primary — TC-based): read embedded start TC from both
 * the source file and the graded file (QuickTime moov/tmcd atom), plus
 * the source layer's stretch, and compute startTime so the grade plays
 * the same source TC at the same comp time as the plate. Robust against
 * Resolve handles (the grade file extends before/after the plate's cut,
 * but the layer's in/out are trimmed to the plate's span so it looks
 * identical in the comp — the handles are available if you pull them).
 *
 * Placement rule (fallback): if either file isn't QuickTime, TC can't be
 * read, source layer has time-remap enabled, or the TCs don't overlap,
 * fall back to aligning by layer.inPoint (grade frame 0 at source's
 * inPoint). A warning is logged per fallback.
 *
 * Single undo step.
 */

(function () {

    // ── helpers ────────────────────────────────────────────────────────

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

    function isFootageLayer(layer) {
        if (!(layer instanceof AVLayer)) return false;
        if (!layer.source) return false;
        if (!(layer.source instanceof FootageItem)) return false;
        if (!layer.source.file) return false;
        return true;
    }

    function baseName(fsName) {
        var slash = Math.max(fsName.lastIndexOf("/"), fsName.lastIndexOf("\\"));
        return slash >= 0 ? fsName.substring(slash + 1) : fsName;
    }

    function stemOf(filename) {
        var dot = filename.lastIndexOf(".");
        return dot > 0 ? filename.substring(0, dot) : filename;
    }

    // "foo" matches "foo_graded.mov" but not "foobar_graded.mov" —
    // same prefix+separator rule the Shots-mode importer uses.
    function nameStartsWithStem(filename, stem) {
        var fn = filename.toLowerCase();
        var sn = stem.toLowerCase();
        if (fn.indexOf(sn) !== 0) return false;
        if (fn.length === sn.length) return true;
        return !/[a-z0-9]/.test(fn.charAt(sn.length));
    }

    function fileFilter(f) {
        if (f instanceof Folder) return false;
        return /\.(mov|mp4|m4v|qt|exr|dpx|png|jpg|jpeg|tif|tiff|ari|r3d)$/i.test(f.name);
    }

    function isQuickTime(fsName) {
        return /\.(mov|mp4|m4v|qt)$/i.test(fsName);
    }

    // ── QuickTime moov/tmcd reader ─────────────────────────────────────
    // Ported verbatim from export-shot-xml/export_shot_xml.jsx. Reads 4 MB
    // of the file header, parses mvhd for fps/duration, then walks hdlr →
    // stco/co64 to find the tmcd track's single sample = start TC frame.

    function readU32(str, off) {
        return ((str.charCodeAt(off)     & 0xFF) * 16777216)
             + ((str.charCodeAt(off + 1) & 0xFF) * 65536)
             + ((str.charCodeAt(off + 2) & 0xFF) * 256)
             +  (str.charCodeAt(off + 3) & 0xFF);
    }

    function parseMvhd(raw) {
        var idx = raw.indexOf("mvhd");
        if (idx < 0) return null;
        var off     = idx + 4;
        var version = raw.charCodeAt(off) & 0xFF;
        var tsOff   = off + (version === 0 ? 12 : 20);
        var durOff  = tsOff + 4;

        var ts  = readU32(raw, tsOff);
        var dur = (version === 0)
                    ? readU32(raw, durOff)
                    : readU32(raw, durOff + 4);

        var validFps = { 24:1, 25:1, 30:1, 48:1, 50:1, 60:1 };
        if (!validFps[ts]) return null;

        return { fps: ts, totalFrames: dur };
    }

    function readFileTCFrame(file, raw) {
        try {
            var searchFrom = 0;
            var hdlrIdx = -1;
            while (true) {
                var hi = raw.indexOf("hdlr", searchFrom);
                if (hi < 0) break;
                if (raw.substr(hi + 12, 4) === "tmcd") { hdlrIdx = hi; break; }
                searchFrom = hi + 1;
            }
            if (hdlrIdx < 0) return 0;

            var chunkOff   = -1;
            var chunkOffHi = 0;

            var sfrom = hdlrIdx;
            while (chunkOff < 0) {
                var si = raw.indexOf("stco", sfrom);
                if (si < 0) break;
                if (readU32(raw, si + 8) === 1) {
                    chunkOff = readU32(raw, si + 12);
                    break;
                }
                sfrom = si + 1;
            }

            if (chunkOff < 0) {
                sfrom = hdlrIdx;
                while (chunkOff < 0) {
                    var ci = raw.indexOf("co64", sfrom);
                    if (ci < 0) break;
                    if (readU32(raw, ci + 8) === 1) {
                        chunkOffHi = readU32(raw, ci + 12);
                        chunkOff   = readU32(raw, ci + 16);
                        break;
                    }
                    sfrom = ci + 1;
                }
            }

            if (chunkOff < 0) return 0;

            var tcFrame;
            if (chunkOffHi === 0 && chunkOff + 4 <= raw.length) {
                tcFrame = readU32(raw, chunkOff);
            } else if (chunkOffHi === 0) {
                file.encoding = "BINARY";
                if (!file.open("r")) return 0;
                file.seek(chunkOff);
                var tcRaw = file.read(4);
                file.close();
                tcFrame = readU32(tcRaw, 0);
            } else {
                var fullOff = chunkOffHi * 4294967296 + chunkOff;
                var safeFs  = file.fsName.replace(/'/g, "'\\''");
                var hex = system.callSystem(
                    "dd if='" + safeFs + "' bs=1 skip=" + fullOff
                    + " count=4 2>/dev/null | od -An -tx1 | tr -d ' \\n'"
                );
                if (!hex || hex.length < 8) return 0;
                hex = hex.replace(/[^0-9a-fA-F]/g, "");
                if (hex.length < 8) return 0;
                tcFrame = parseInt(hex.substr(0, 8), 16);
            }
            return (tcFrame > 0 && tcFrame < 5184000) ? tcFrame : 0;
        } catch (e) {
            return 0;
        }
    }

    function getFileInfo(file) {
        try {
            file.encoding = "BINARY";
            if (!file.open("r")) return null;
            var raw = file.read(4194304);
            file.close();

            var mvhd = parseMvhd(raw);
            if (!mvhd) return null;

            var tcFrame = readFileTCFrame(file, raw);
            return { fps: mvhd.fps, totalFrames: mvhd.totalFrames, tcStartFrame: tcFrame };
        } catch (e) {
            return null;
        }
    }

    // ── run ────────────────────────────────────────────────────────────

    var proj = app.project;
    var comp = proj.activeItem;
    if (!(comp instanceof CompItem)) {
        greyAlert("Import Comp Grades", "Open a composition first.");
        return;
    }

    // Resolve the source folder for graded returns. Default is "_grade/"
    // next to the AEP (matches the XML exporter's default save location),
    // but the user can point at any folder — useful when Resolve renders
    // to a custom delivery dir, or when pulling denoise/stabilize returns
    // that live under a different name.
    var defaultPath = "";
    if (proj.file && proj.file.parent) {
        var preferred = new Folder(proj.file.parent.fsName + "/_grade");
        defaultPath = (preferred.exists ? preferred : proj.file.parent).fsName;
    }

    var gradeDir = (function pickGradeFolder(initial) {
        var dlg = new Window("dialog", "Import Comp Grades");
        dlg.orientation = "column"; dlg.alignChildren = ["fill", "top"];
        dlg.spacing = 10; dlg.margins = 14;

        var about = dlg.add("statictext", undefined,
              "Import half of the Comp Grade Roundtrip. For each footage "
            + "layer in the active comp, finds a matching graded file by "
            + "source-file-stem prefix (newest by modification time wins) "
            + "and drops it in as a new layer directly above the original. "
            + "Alignment uses embedded source timecode (QuickTime moov/tmcd); "
            + "falls back to inPoint alignment for non-QT files.",
            { multiline: true });
        about.preferredSize = [540, 80];

        var pnl = dlg.add("panel", undefined, "Source folder");
        pnl.orientation = "column"; pnl.alignChildren = ["fill", "top"];
        pnl.margins = [10, 15, 10, 10]; pnl.spacing = 6;

        var help = pnl.add("statictext", undefined,
            "Folder containing the graded (or denoised / stabilized) returns. "
            + "Filenames must start with the matching source-file stem.",
            { multiline: true });
        help.preferredSize = [460, 34];

        var row = pnl.add("group");
        row.orientation = "row"; row.alignChildren = ["fill", "center"]; row.spacing = 6;
        var pathField = row.add("edittext", undefined, initial);
        pathField.characters = 50;
        pathField.alignment = ["fill", "center"];
        var browseBtn = row.add("button", undefined, "Browse…");
        browseBtn.preferredSize = [80, 22];
        browseBtn.onClick = function () {
            var cur = pathField.text ? new Folder(pathField.text) : null;
            if (cur && cur.exists) Folder.current = cur;
            var pickedF = Folder.selectDialog("Pick the returns folder");
            if (pickedF) pathField.text = pickedF.fsName;
        };

        var btnGrp = dlg.add("group");
        btnGrp.orientation = "row"; btnGrp.alignment = ["fill", "bottom"];
        var spc = btnGrp.add("statictext", undefined, ""); spc.alignment = ["fill", "center"];
        var btnCancel = btnGrp.add("button", undefined, "Cancel", { name: "cancel" });
        btnCancel.preferredSize = [80, 28];
        var btnOK = btnGrp.add("button", undefined, "Import", { name: "ok" });
        btnOK.preferredSize = [110, 28];

        btnCancel.onClick = function () { dlg.close(2); };
        btnOK.onClick = function () {
            var f = new Folder(pathField.text);
            if (!f.exists) {
                greyAlert("Import Comp Grades", "That folder doesn't exist:\n" + pathField.text);
                return;
            }
            dlg.close(1);
        };

        if (dlg.show() !== 1) return null;
        return new Folder(pathField.text);
    })(defaultPath);

    if (!gradeDir) return;

    var all = gradeDir.getFiles(fileFilter) || [];
    if (all.length === 0) {
        greyAlert("Import Comp Grades", "No supported files in\n" + gradeDir.fsName);
        return;
    }

    // Build the import plan: one entry per footage layer that has a
    // matching graded file. Warnings for anything we couldn't match.
    var plan = [];
    var warnings = [];
    var usedFiles = {};

    for (var li = 1; li <= comp.numLayers; li++) {
        var L = comp.layer(li);
        if (!isFootageLayer(L)) continue;
        var srcStem = stemOf(baseName(L.source.file.fsName));
        var matches = [];
        for (var gi = 0; gi < all.length; gi++) {
            if (nameStartsWithStem(all[gi].name, srcStem)) matches.push(all[gi]);
        }
        if (matches.length === 0) {
            warnings.push("No grade for \"" + L.name + "\" (stem \"" + srcStem + "\").");
            continue;
        }
        // Newest wins by modification time — same convention as the Shots-mode
        // importer. Robust to Resolve's "Use Unique Filenames" suffix scrambling
        // alphabetical order (e.g. _V1-0064 clip-numbering).
        matches.sort(function (a, b) { return b.modified.getTime() - a.modified.getTime(); });
        var pick = matches[0];
        if (usedFiles[pick.fsName]) {
            warnings.push("Graded file \"" + pick.name + "\" is being applied to multiple layers with the same source.");
        }
        usedFiles[pick.fsName] = true;
        plan.push({ sourceLayer: L, gradedFile: pick });
    }

    if (plan.length === 0) {
        greyAlert("Import Comp Grades", "Nothing to import.\n\n" + warnings.join("\n"));
        return;
    }

    // ── version bump ─────────────────────────────────────────────────
    // Same VFX-versioning rule the other roundtrip tools use:
    // MyProject_v03.aep → MyProject_v04.aep before any mutation, so the
    // original file is the rollback point. Skip when the project hasn't
    // been saved yet — there's no anchor to version off.
    if (!proj.file) {
        greyAlert("Import Comp Grades", "Save the project first so it can be versioned before any changes.");
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
            greyAlert("Import Comp Grades", "Could not find an unused version number for the backup copy.\nAborting so nothing is modified.");
            return null;
        }
        try {
            proj.save();
            proj.save(newFile);
        } catch (eSave) {
            greyAlert("Import Comp Grades", "Failed to save versioned copy —\n" + eSave.message +
                  "\n\nAborting so the original file stays untouched.");
            return null;
        }
        return newFile;
    }
    if (!saveAsNextVersion()) return;

    var imported   = 0;
    var tcAligned  = 0;
    var fallback   = 0;

    app.beginUndoGroup("Import Comp Grades");
    try {
        for (var p = 0; p < plan.length; p++) {
            var entry = plan[p];
            var L = entry.sourceLayer;

            // Reuse an existing FootageItem if this grade was already imported;
            // otherwise import fresh and tag it orange (Resolve-return label).
            var footageItem = null;
            for (var fi = 1; fi <= proj.numItems; fi++) {
                var it = proj.item(fi);
                if (it instanceof FootageItem && it.file && it.file.fsName === entry.gradedFile.fsName) {
                    footageItem = it;
                    break;
                }
            }
            if (!footageItem) {
                try {
                    footageItem = proj.importFile(new ImportOptions(entry.gradedFile));
                    footageItem.label = 11;
                } catch (eImp) {
                    warnings.push("Failed to import \"" + entry.gradedFile.name + "\": " + eImp);
                    continue;
                }
            }

            // Add to comp (AE places at index 1 by default), reslot directly
            // above the source.
            var newLayer = comp.layers.add(footageItem);
            try { newLayer.moveBefore(L); } catch (eMove) {}

            // ── alignment ──────────────────────────────────────────────
            // Primary: embedded-TC alignment. Read start TC from both the
            // source file and the grade file, compute the source-TC shown
            // at the source layer's inPoint, then place the grade so its
            // own frame-0's TC lines up with that same source TC at the
            // same comp time.
            //
            // Fallback: any failure → newLayer.startTime = L.inPoint
            // (grade frame 0 at source's inPoint).
            var aligned = false;
            var srcFs   = L.source.file.fsName;
            var gradeFs = entry.gradedFile.fsName;
            var canTC = isQuickTime(srcFs) && isQuickTime(gradeFs) && !L.timeRemapEnabled;
            if (canTC) {
                var srcInfo   = getFileInfo(L.source.file);
                var gradeInfo = getFileInfo(entry.gradedFile);
                if (srcInfo && gradeInfo && srcInfo.fps > 0 && gradeInfo.fps > 0
                    && (srcInfo.tcStartFrame > 0 || gradeInfo.tcStartFrame > 0)) {
                    var stretchPct = (L.stretch !== 0) ? L.stretch : 100;
                    // Seconds since TC 00:00:00:00.
                    var srcTCStartSec   = srcInfo.tcStartFrame   / srcInfo.fps;
                    var gradeTCStartSec = gradeInfo.tcStartFrame / gradeInfo.fps;
                    // Source TC displayed at the source layer's inPoint.
                    var srcTCAtInPointSec = srcTCStartSec + (L.inPoint - L.startTime) * (stretchPct / 100);
                    // Grade frame that matches that TC (grade assumed at native speed).
                    var gradeSecForSrcTC   = srcTCAtInPointSec - gradeTCStartSec;
                    var gradeFrameForSrcTC = gradeSecForSrcTC * gradeInfo.fps;
                    // Sanity: grade file must cover this TC inside its own
                    // duration (plus a small slack for rounding).
                    if (gradeFrameForSrcTC >= -1 && gradeFrameForSrcTC <= gradeInfo.totalFrames + 1) {
                        newLayer.startTime = L.inPoint - gradeSecForSrcTC;
                        // Trim visible span to exactly match the plate — any
                        // handles Resolve rendered stay on the layer (available
                        // if the user drags the in/out) but aren't visible.
                        newLayer.inPoint  = L.inPoint;
                        newLayer.outPoint = L.outPoint;
                        aligned = true;
                        tcAligned++;
                    } else {
                        warnings.push(L.name + ": grade TC range [" + framesTC(gradeInfo.tcStartFrame, gradeInfo.fps)
                            + " → " + framesTC(gradeInfo.tcStartFrame + gradeInfo.totalFrames, gradeInfo.fps)
                            + "] doesn't cover source TC " + framesTC(Math.round(srcTCAtInPointSec * srcInfo.fps), srcInfo.fps)
                            + " at inPoint — fell back to inPoint alignment.");
                    }
                } else {
                    if (!srcInfo || !gradeInfo) {
                        warnings.push(L.name + ": couldn't read TC header — fell back to inPoint alignment.");
                    } else {
                        warnings.push(L.name + ": both files have TC 00:00:00:00 — fell back to inPoint alignment.");
                    }
                }
            } else {
                if (L.timeRemapEnabled) {
                    warnings.push(L.name + ": time-remap enabled — fell back to inPoint alignment (TC math skipped).");
                } else {
                    warnings.push(L.name + ": non-QuickTime source or grade — fell back to inPoint alignment.");
                }
            }

            if (!aligned) {
                newLayer.startTime = L.inPoint;
                if (newLayer.outPoint > L.outPoint) newLayer.outPoint = L.outPoint;
                fallback++;
            }

            imported++;
        }
    } finally {
        app.endUndoGroup();
    }

    // Small TC formatter for warning strings (assumes integer fps).
    function framesTC(frames, fps) {
        if (!fps || fps <= 0) return String(frames);
        var r = Math.round(fps);
        var ff = Math.abs(frames) % r;
        var ss = Math.floor(Math.abs(frames) / r) % 60;
        var mm = Math.floor(Math.abs(frames) / (r * 60)) % 60;
        var hh = Math.floor(Math.abs(frames) / (r * 3600));
        function p2(n) { return n < 10 ? "0" + n : String(n); }
        return (frames < 0 ? "-" : "") + p2(hh) + ":" + p2(mm) + ":" + p2(ss) + ":" + p2(ff);
    }

    // ── summary ────────────────────────────────────────────────────────
    (function showSummary() {
        var dlg = new Window("dialog", "Import Comp Grades — Done");
        dlg.orientation = "column"; dlg.alignChildren = ["fill", "top"];
        dlg.spacing = 10; dlg.margins = 14;

        var sp = dlg.add("panel", undefined, "Summary");
        sp.orientation = "column"; sp.alignChildren = ["fill", "top"];
        sp.margins = [12, 12, 12, 12]; sp.spacing = 4;
        sp.add("statictext", undefined, "Imported " + imported + " grade layer(s) into " + comp.name + ".");
        sp.add("statictext", undefined, "TC-aligned: " + tcAligned + "   |   inPoint fallback: " + fallback);
        sp.add("statictext", undefined, "From: " + gradeDir.fsName);

        if (warnings.length > 0) {
            var wp = dlg.add("panel", undefined, "Warnings");
            wp.orientation = "column"; wp.alignChildren = ["fill", "top"];
            wp.margins = [12, 12, 12, 12]; wp.spacing = 4;
            var body = "";
            for (var wi = 0; wi < warnings.length; wi++) body += "  " + warnings[wi] + "\n";
            var maxH = $.screens[0].bottom - $.screens[0].top - 280;
            var textH = Math.min(Math.max(warnings.length * 15 + 20, 60), maxH);
            var ta = wp.add("edittext", undefined, body,
                { multiline: true, readonly: true, scrollable: true });
            ta.preferredSize = [460, textH];
        }

        var bg = dlg.add("group");
        bg.orientation = "row"; bg.alignment = ["fill", "bottom"];
        var spc = bg.add("statictext", undefined, ""); spc.alignment = ["fill", "center"];
        var ok = bg.add("button", undefined, "OK", { name: "ok" });
        ok.preferredSize = [90, 28];
        ok.onClick = function () { dlg.close(1); };
        dlg.show();
    })();

})();
