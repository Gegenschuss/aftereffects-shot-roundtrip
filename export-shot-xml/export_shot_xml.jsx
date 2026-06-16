/*
 *       _____                          __
 *      / ___/__ ___ ____ ___  ___ ____/ /  __ _____ ___
 *     / (_ / -_) _ `/ -_) _ \(_-</ __/ _ \/ // (_-<(_-<
 *     \___/\__/\_, /\__/_//_/___/\__/_//_/\_,_/___/___/
 *             /___/
 */

/**
 * Export Shot XML for DaVinci Resolve  –  FCP7 / xmeml v4
 *
 * Scans the "Shots" folder for every "*_comp" composition, picks the
 * "active" footage layer for each shot, and writes an FCP7-compatible
 * XML matching Premiere Pro's export format, which DaVinci Resolve
 * imports reliably.
 *
 * Two layouts are supported (matching Import Returns):
 *
 *   1. FLAT — footage sits directly in {shot}_comp. We pick the topmost
 *      enabled footage layer whose name starts with the shot number
 *      (e.g. "KM_050_plate_v02.mov" in comp "KM_050_comp").
 *
 *   2. PRECOMP — {shot}_comp contains a {shot}_stack precomp created by
 *      Shot Roundtrip. Inside that precomp, the stack order is
 *      grade (top) → render → plate (bottom), and the importer disables
 *      older files within each category. We recurse into the precomp
 *      and pick the topmost enabled footage layer there — naturally the
 *      most-finished visible version (latest grade if present, else the
 *      latest VFX render, else the plate).
 *
 * Import in DaVinci Resolve via:
 *   File → Import Timeline → Import AAF, EDL, XML…
 *
 * When launched standalone a Settings dialog offers:
 *   Source mode:
 *     - "Shots folder" (default): scan for *_comp comps under "Shots"
 *       as described above. One clip per shot, appended head-to-tail on
 *       a single sequence track.
 *     - "Active composition": dump every footage layer in the currently
 *       open comp straight to XML at its own timeline position. One track
 *       per AE layer (AE layer 1 → top XML track). The export half of
 *       the Comp Grade Roundtrip — pairs with Import Comp Grades to
 *       round-trip a single comp through Resolve without using the full
 *       shot-by-shot workflow. Intended for comps assembled outside the
 *       roundtrip (e.g. a reference edit built by hand that you want to
 *       grade). "Visible layers only" checkbox (default on) skips guide
 *       + disabled layers; uncheck to export every footage layer
 *       regardless of state. Time-remap is exported as a straight span
 *       with a warning.
 *   "Trim to Editorial Cut (Experimental)" — Shots folder mode only:
 *     - Unchecked (default): full clips — source AND sequence span both
 *       cover `_comp.workArea` (clip + handles) at native speed. Stable,
 *       matches the original XML export behaviour.
 *     - Checked (experimental): trim each clip to its CURRENT mainComp
 *       cut by walking `_comp.usedIn` up to the top of the project.
 *       Retime / stretch / reverse along the chain is composed into the
 *       source-time range and into the sequence span, so Resolve infers
 *       speed from the clip:sequence duration ratio. Falls back to the
 *       default full-clips behaviour if the chain walk fails.
 */

(function () {

    // ─── helpers ────────────────────────────────────────────────────────────

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

    function isFootageLayer(layer) {
        if (!(layer instanceof AVLayer)) return false;
        if (!layer.source) return false;
        if (!(layer.source instanceof FootageItem)) return false;
        if (!layer.source.file) return false;
        return true;
    }

    function xmlEscape(str) {
        return String(str)
            .replace(/&/g,  "&amp;")
            .replace(/</g,  "&lt;")
            .replace(/>/g,  "&gt;")
            .replace(/"/g,  "&quot;")
            .replace(/'/g,  "&apos;");
    }

    /**
     * Convert an OS path to a file://localhost/ URL.
     * Premiere / Resolve requires this exact form (not just file://).
     */
    function toFileURL(fsName) {
        var p = fsName.replace(/\\/g, "/");
        if (p.charAt(0) !== "/") p = "/" + p;   // Windows: /C:/path
        p = p.replace(/ /g,  "%20")
              .replace(/\[/g, "%5B")
              .replace(/\]/g, "%5D")
              .replace(/\(/g, "%28")
              .replace(/\)/g, "%29")
              .replace(/\+/g, "%2B")
              .replace(/,/g,  "%2C");
        return "file://localhost" + p;
    }

    function pad2(n) { return n < 10 ? "0" + n : String(n); }

    /** Format frames as HH:MM:SS:FF timecode. */
    function framesToTC(totalFrames, fps) {
        var r = Math.round(fps);
        var ff = totalFrames % r;
        var ss = Math.floor(totalFrames / r) % 60;
        var mm = Math.floor(totalFrames / (r * 60)) % 60;
        var hh = Math.floor(totalFrames / (r * 3600));
        return pad2(hh) + ":" + pad2(mm) + ":" + pad2(ss) + ":" + pad2(ff);
    }

    /**
     * Premiere ticks: 254016000000 ticks per second.
     * Returns a string to avoid JS integer precision issues.
     */
    function pproTicks(frames, fps) {
        // frames / fps * 254016000000 — keep integer by doing frames * (254016000000 / fps)
        var ticksPerFrame = 254016000000 / Math.round(fps);
        return String(Math.round(frames * ticksPerFrame));
    }

    /**
     * Read a 4-byte big-endian unsigned integer from a binary string.
     * Uses multiplication instead of << to avoid JS signed-int overflow.
     */
    function readU32(str, off) {
        return ((str.charCodeAt(off)     & 0xFF) * 16777216)
             + ((str.charCodeAt(off + 1) & 0xFF) * 65536)
             + ((str.charCodeAt(off + 2) & 0xFF) * 256)
             +  (str.charCodeAt(off + 3) & 0xFF);
    }

    /**
     * Parse the QuickTime mvhd atom from a raw binary string.
     * Returns { fps, totalFrames } if the timescale maps to a known video
     * rate, otherwise returns null.
     *
     * mvhd v0: [type(4)] version(1) flags(3) creation(4) modification(4) timescale(4) duration(4)
     * mvhd v1: [type(4)] version(1) flags(3) creation(8) modification(8) timescale(4) duration(8)
     *
     * Integer-rate files store timescale == fps and count duration in
     * frames directly. NTSC fractional rates (23.976 / 29.97 / 59.94)
     * store timescale in thousandths (24000 / 30000 / 60000) and count
     * duration in those units, so the real frame count is
     * (duration / timescale) * fps. Both forms are handled here; without
     * the NTSC mapping every fractional-rate ProRes/MOV — the dominant
     * delivery format — fell through to AE's interpreted fps/duration and
     * lost its embedded start timecode. (Exotic rates like 47.952 are
     * intentionally NOT mapped — rateBlock's NTSC test doesn't cover them,
     * so they fall back to AE rather than emit an inconsistent rate block.)
     */
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
                    : readU32(raw, durOff + 4); // lower 32 bits of 64-bit duration

        var fps = 0;
        if      (ts === 24)    fps = 24;
        else if (ts === 25)    fps = 25;
        else if (ts === 30)    fps = 30;
        else if (ts === 48)    fps = 48;
        else if (ts === 50)    fps = 50;
        else if (ts === 60)    fps = 60;
        else if (ts === 24000) fps = 24000 / 1001;  // 23.976
        else if (ts === 30000) fps = 30000 / 1001;  // 29.97
        else if (ts === 60000) fps = 60000 / 1001;  // 59.94
        else return null;                            // unknown / non-video timescale (incl. 48000/47.952)

        // frames = (dur / timescale) * fps. For integer rates this is dur;
        // for NTSC it divides out the 1001 units-per-frame.
        var totalFrames = Math.round(dur * fps / ts);
        return { fps: fps, totalFrames: totalFrames };
    }

    /**
     * Read the embedded start timecode (in frames) from a QuickTime/MOV file.
     *
     * The TC is stored as a 4-byte big-endian frame count in the tmcd track's
     * sample data.  Strategy:
     *   1. Find the 'hdlr' atom whose handler_type == 'tmcd'
     *   2. Find the next 'stco' atom (chunk-offset table for that track)
     *   3. Read the first chunk offset → seek to it → read 4 bytes = TC frame
     *
     * Returns 0 if the TC cannot be determined.
     */
    function readFileTCFrame(file, raw) {
        try {
            // Find hdlr with handler_type 'tmcd'
            // hdlr atom layout (from the 'hdlr' type tag):
            //   +0  "hdlr"         type (4)
            //   +4  version+flags  (4)
            //   +8  pre_defined    (4)
            //   +12 handler_type   (4) ← "tmcd", "vide", "soun" …
            var searchFrom = 0;
            var hdlrIdx = -1;
            while (true) {
                var hi = raw.indexOf("hdlr", searchFrom);
                if (hi < 0) break;
                if (raw.substr(hi + 12, 4) === "tmcd") { hdlrIdx = hi; break; }
                searchFrom = hi + 1;
            }
            if (hdlrIdx < 0) return 0;

            // Find the chunk-offset atom that belongs to the tmcd track.
            // The tmcd track has exactly 1 sample, so its stco/co64 has entry_count == 1.
            // We scan forward from the tmcd hdlr and accept the first stco or co64 whose
            // entry_count equals 1.  This skips false-positive matches (random bytes that
            // spell "stco"/"co64" in mdat data, or other tracks' offset tables which have
            // many entries).
            var chunkOff   = -1;
            var chunkOffHi = 0;   // high 32 bits of co64 offset (0 for stco / small files)

            // ── stco (32-bit offsets) ──────────────────────────────────────
            var sfrom = hdlrIdx;
            while (chunkOff < 0) {
                var si = raw.indexOf("stco", sfrom);
                if (si < 0) break;
                if (readU32(raw, si + 8) === 1) {          // entry_count == 1
                    chunkOff = readU32(raw, si + 12);
                    break;
                }
                sfrom = si + 1;
            }

            // ── co64 (64-bit offsets, fallback) ───────────────────────────
            if (chunkOff < 0) {
                sfrom = hdlrIdx;
                while (chunkOff < 0) {
                    var ci = raw.indexOf("co64", sfrom);
                    if (ci < 0) break;
                    if (readU32(raw, ci + 8) === 1) {      // entry_count == 1
                        chunkOffHi = readU32(raw, ci + 12); // high 32 bits
                        chunkOff   = readU32(raw, ci + 16); // low  32 bits
                        break;
                    }
                    sfrom = ci + 1;
                }
            }

            if (chunkOff < 0) return 0;

            // Read the 4-byte TC frame value at chunkOff.
            // chunkOffHi holds the high 32 bits of a co64 entry (0 for stco).
            var tcFrame;
            if (chunkOffHi === 0 && chunkOff + 4 <= raw.length) {
                // Within the already-loaded 4 MB buffer
                tcFrame = readU32(raw, chunkOff);
            } else if (chunkOffHi === 0) {
                // 32-bit offset beyond the buffer — seek in the file
                file.encoding = "BINARY";
                if (!file.open("r")) return 0;
                file.seek(chunkOff);
                var tcRaw = file.read(4);
                file.close();
                tcFrame = readU32(tcRaw, 0);
            } else {
                // 64-bit offset (file > 4 GB) — ExtendScript's File.seek() tops out at
                // ~4 GB, so use a shell dd command to reach the correct byte position.
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
            // Sanity: reject values > 24 h at 60 fps (= 5 184 000 frames).
            return (tcFrame > 0 && tcFrame < 5184000) ? tcFrame : 0;
        } catch (e) {
            return 0;
        }
    }

    /**
     * Read native fps, total frame count, and embedded start TC frame from a
     * QuickTime/MOV file.  Returns { fps, totalFrames, tcStartFrame } or null.
     *
     * Reading 4 MB covers the moov atom for virtually all ProRes files.
     */
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

    /** FCP7 <rate> block. */
    function rateBlock(fps, indent) {
        var sp = indent || "";
        var ntsc = (Math.abs(fps - 23.976) < 0.01 ||
                    Math.abs(fps - 29.97)  < 0.01 ||
                    Math.abs(fps - 59.94)  < 0.01) ? "TRUE" : "FALSE";
        return sp + "<rate>\n"
             + sp + "\t<timebase>" + Math.round(fps) + "</timebase>\n"
             + sp + "\t<ntsc>"     + ntsc            + "</ntsc>\n"
             + sp + "</rate>";
    }

    function collectCompItems(folder, result) {
        for (var i = 1; i <= folder.numItems; i++) {
            var item = folder.item(i);
            if (item instanceof FolderItem) {
                collectCompItems(item, result);
            } else if (item instanceof CompItem) {
                if (/[_\s]comp(_OS)?$/i.test(item.name)) result.push(item);
            }
        }
    }

    // Finds the "Shots" folder at project ROOT only. Projects sometimes
    // contain additional folders named "Shots" nested elsewhere (per-shot
    // subfolders, leftovers from other workflows, etc.) — those are ignored
    // here so the XML export only looks at the authoritative root-level bin
    // that the roundtrip creates via proj.items.addFolder().
    function findShotsFolder(root) {
        for (var i = 1; i <= root.numItems; i++) {
            var item = root.item(i);
            if (item instanceof FolderItem && item.name.toLowerCase() === "shots") {
                return item;
            }
        }
        return null;
    }

    /**
     * Walk UP via CompItem.usedIn to find the chain of layers from `comp` to
     * its top-most parent (typically mainComp). Each chain entry is the
     * layer in the parent that references the child.
     *
     *   chain[0]       = layer in comp's immediate parent (references comp)
     *   chain[last]    = layer in the top-most comp (mainComp)
     *
     * Returns null if `comp` has no parents (top-level already).
     */
    function walkUpChain(comp) {
        var chain = [];
        var current = comp;
        for (var safety = 0; safety < 20; safety++) {
            var parents = null;
            try { parents = current.usedIn; } catch (e) { break; }
            if (!parents || parents.length === 0) break;
            // Shared-source edge case: pick first parent. One XML clipitem
            // per shot means we can't represent the shot being dropped into
            // multiple mainComp positions; first-use is the safest default.
            var parent = parents[0];
            var foundLayer = null;
            for (var li = 1; li <= parent.numLayers; li++) {
                var L = parent.layer(li);
                try { if (L.source === current) { foundLayer = L; break; } } catch (eF) {}
            }
            if (!foundLayer) break;
            chain.push(foundLayer);
            current = parent;
        }
        return chain.length > 0 ? { chain: chain, topComp: current } : null;
    }

    /**
     * Map a time in the top-most comp down through the chain to the
     * innermost comp's time. chain is produced by walkUpChain().
     *
     * For each layer: honors time-remap when enabled; otherwise uses the
     * linear formula (compTime - startTime) * (100 / stretch). Handles
     * non-100% stretch and reverse (negative stretch, producing
     * decreasing time → caller must detect).
     */
    function mapTimeDownChain(topTime, chain) {
        var t = topTime;
        for (var i = chain.length - 1; i >= 0; i--) {
            var L = chain[i];
            var start = 0, stretch = 100;
            try { start   = L.startTime || 0;  } catch (eS)  {}
            try { stretch = L.stretch   || 100; } catch (eSt) {}
            try {
                if (L.timeRemapEnabled) {
                    var remap = L.property("ADBE Time Remapping");
                    if (remap) { t = remap.valueAtTime(t, false); continue; }
                }
            } catch (eR) {}
            t = (t - start) * (100 / stretch);
        }
        return t;
    }

    function shotNameFromComp(compName) {
        // Must mirror the leniency of collectCompItems() so "KM_010_comp"
        // and "KM_010_comp_OS" both resolve to "KM_010" — otherwise the
        // shot-prefix regex in pickFootageLayer silently fails to match
        // any layer inside overscan variants.
        return compName.replace(/[_\s]comp(_OS)?$/i, "");
    }

    /**
     * Return the topmost enabled footage layer inside a precomp. No
     * shot-name filter — by construction the {shot}_stack precomp only
     * holds plate/render/grade variants of this shot. Import Returns
     * keeps the stack ordered grade → render → plate top-to-bottom
     * and disables older files within each category, so "topmost enabled
     * footage" resolves to the most-finished visible version.
     */
    function pickTopmostFootageLayerInPrecomp(comp) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            if (!layer.enabled) continue;
            if (!isFootageLayer(layer)) continue;
            return layer;
        }
        return null;
    }

    /**
     * Return the active footage layer for a shot comp. Supports both
     * layouts written by Import Returns:
     *
     *   - PRECOMP: a {shot}_stack precomp layer lives directly in _comp
     *     as the hero. We recurse into it and pick the topmost enabled
     *     footage layer inside — naturally the newest grade, else the
     *     newest VFX render, else the plate itself.
     *   - FLAT: footage sits directly in _comp. We pick the topmost
     *     enabled footage layer whose name starts with the shot number
     *     (e.g. "KM_050_plate_v02.mov" or "KM_050_render.[####].exr" in
     *     comp "KM_050_comp").
     *
     * Accepts any footage item — movie files (mov, mp4, …) and image
     * sequences (dpx, exr, tif, …) alike.
     */
    function pickFootageLayer(comp) {
        var shot = shotNameFromComp(comp.name);
        var escaped = shot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        var shotRe = new RegExp("^" + escaped, "i");
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            if (!layer.enabled) continue;
            if (!layer.source) continue;
            if (layer.source instanceof CompItem &&
                /_stack(_OS)?$/i.test(layer.source.name) &&
                shotRe.test(layer.source.name)) {
                var inner = pickTopmostFootageLayerInPrecomp(layer.source);
                if (inner) return inner;
                continue;
            }
            if (!isFootageLayer(layer)) continue;
            if (shotRe.test(layer.name)) return layer;
        }
        return null;
    }

    // ─── main ────────────────────────────────────────────────────────────────

    var proj = app.project;
    if (!proj) { greyAlert("Export Shot XML", "No project open."); return; }

    // Project base name used for the sequence name inside the XML and the
    // generated output filename. Strip the .aep extension. Fall back to
    // "Shot Export" only if the project is still untitled.
    var projectBaseName = (proj.file && proj.file.displayName)
                        ? proj.file.displayName.replace(/\.aep$/i, "")
                        : "Shot Export";
    // Sanitise for use in a filename: strip characters that filesystems hate.
    var projectFileStem = projectBaseName.replace(/[\/\\:*?"<>|]/g, "_");

    // ─── settings dialog ────────────────────────────────────────────────────
    // Default = full clips (clip + handles) with native-speed sequence spans —
    // the stable path that's been shipping. Opt-in to the experimental
    // mainComp-chain trim via the checkbox.
    //
    // Source mode:
    //   "shots"      — scan the project's Shots folder for *_comp comps (default).
    //   "activeComp" — dump every footage layer in the active comp straight
    //                  to XML, at its current timeline position. Intended
    //                  for comps assembled outside the roundtrip (e.g. a
    //                  reference edit you built by hand and want to grade).
    var trimToCut    = false;
    var visibleOnly  = true;
    var sourceMode   = "shots";
    if (!$.global.__shotRoundtripXMLDir) {
        var dlg = new Window("dialog", "Export Shot XML");
        dlg.orientation = "column"; dlg.alignChildren = ["fill", "top"];
        dlg.spacing = 10; dlg.margins = 14;

        var about = dlg.add("statictext", undefined,
              "Writes an FCP7 / xmeml v4 XML timeline for DaVinci Resolve. "
            + "Either scans the Shots folder and lays every *_comp's footage "
            + "head-to-tail on one track (Shot Roundtrip pipeline), or dumps "
            + "every footage layer in the active comp at its own timeline "
            + "position as separate tracks (Comp Grade Roundtrip — pairs "
            + "with Import Comp Grades).",
            { multiline: true });
        about.preferredSize = [540, 72];

        var srcPnl = dlg.add("panel", undefined, "Source");
        srcPnl.orientation = "column"; srcPnl.alignChildren = ["left", "top"];
        srcPnl.margins = [10, 15, 10, 10]; srcPnl.spacing = 4;
        var rbShots  = srcPnl.add("radiobutton", undefined, "Shots folder  (every *_comp under the \"Shots\" folder)");
        var rbActive = srcPnl.add("radiobutton", undefined, "Active composition  (every footage layer in the current comp)");
        rbShots.value  = true;

        var optPnl = dlg.add("panel", undefined, "Options");
        optPnl.orientation = "column"; optPnl.alignChildren = ["fill", "top"];
        optPnl.margins = [10, 15, 10, 10]; optPnl.spacing = 6;
        var chkTrim = optPnl.add("checkbox", undefined,
            "Trim to Editorial Cut (Experimental) — Shots folder mode only");
        chkTrim.value = false;
        var chkVisible = optPnl.add("checkbox", undefined,
            "Visible layers only (skip disabled + guide) — Active composition mode only");
        chkVisible.value = true;
        function refreshOptEnabled() {
            chkTrim.enabled    = rbShots.value;
            chkVisible.enabled = rbActive.value;
        }
        rbShots.onClick  = refreshOptEnabled;
        rbActive.onClick = refreshOptEnabled;
        refreshOptEnabled();

        var btnGrp = dlg.add("group");
        btnGrp.orientation = "row"; btnGrp.alignment = ["fill", "bottom"];
        var spacerD = btnGrp.add("statictext", undefined, ""); spacerD.alignment = ["fill", "center"];
        var btnCancel = btnGrp.add("button", undefined, "Cancel"); btnCancel.preferredSize = [80, 28];
        var btnExport = btnGrp.add("button", undefined, "Export"); btnExport.preferredSize = [110, 28];
        btnCancel.onClick = function () { dlg.close(2); };
        btnExport.onClick = function () { dlg.close(1); };
        if (dlg.show() !== 1) return;
        trimToCut   = chkTrim.value;
        visibleOnly = chkVisible.value;
        sourceMode  = rbActive.value ? "activeComp" : "shots";
    }

    var comps = [];
    if (sourceMode === "shots") {
        var shotsFolder = findShotsFolder(proj.rootFolder);
        if (!shotsFolder) {
            greyAlert("Export Shot XML", "Could not find a folder named \"Shots\" in the project.");
            return;
        }
        collectCompItems(shotsFolder, comps);
        if (comps.length === 0) {
            greyAlert("Export Shot XML", "No \"*_comp\" compositions found inside the Shots folder.");
            return;
        }
        comps.sort(function (a, b) {
            return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
        });
    } else {
        // activeComp mode: the current composition IS the sequence source.
        var activeC = proj.activeItem;
        if (!(activeC instanceof CompItem)) {
            greyAlert("Export Shot XML", "\"Active composition\" mode requires a composition to be open.");
            return;
        }
        comps = [activeC];
        projectBaseName = activeC.name; // sequence name reads the comp name, not the .aep stem
        projectFileStem = projectBaseName.replace(/[\/\\:*?"<>|]/g, "_");
    }

    // ─── gather clip data ────────────────────────────────────────────────────

    var clips    = [];
    var warnings = [];
    var seqFps   = 0;

    // In activeComp mode each footage layer becomes its own clip,
    // keyed by AE layer index → XML track index (higher AE index = further
    // down the stack, maps to lower XML track). In shots mode there's one
    // layer per comp so we append to a single track as before.
    function buildClipsForCompShotsMode(comp) {
        var layer = pickFootageLayer(comp);
        if (!layer) {
            warnings.push(comp.name + ": no active footage layer — skipped.");
            return;
        }
        buildClipFromLayer(comp, layer, null);
    }

    function buildClipsForActiveComp(comp) {
        if (comp.frameRate > seqFps) seqFps = comp.frameRate;
        for (var li = 1; li <= comp.numLayers; li++) {
            var L = comp.layer(li);
            if (!isFootageLayer(L)) continue;
            // "Visible layers only" (checkbox, default on) skips guide layers
            // (never render) and disabled layers (not in the cut). When off,
            // every footage layer makes it into the XML regardless of state.
            if (visibleOnly && (L.guideLayer || !L.enabled)) continue;
            buildClipFromLayer(comp, L, li);
        }
        if (clips.length === 0) {
            warnings.push(comp.name + ": no footage layers found.");
        }
    }

    function buildClipFromLayer(comp, layer, layerIndex) {

        if (!layer) {
            warnings.push(comp.name + ": no active footage layer — skipped.");
            return;
        }

        var compFps = comp.frameRate;
        if (compFps > seqFps) seqFps = compFps;

        // Read native fps, total frame count, and embedded TC start frame directly
        // from the file's moov/mvhd atom — immune to AE's "Interpret Footage"
        // settings and source.duration inaccuracies on files with non-zero TC.
        // Only QuickTime-family files have a moov atom; image sequences and
        // other formats go straight to the AE fallback.
        var isQuickTime = /\.(mov|mp4|m4v|qt)$/i.test(layer.source.file.fsName);
        var fileInfo = isQuickTime ? getFileInfo(layer.source.file) : null;
        var srcFps = (fileInfo && fileInfo.fps > 0) ? fileInfo.fps
                   : (layer.source.frameRate > 0)   ? layer.source.frameRate
                   : compFps;

        // Total file duration from the mvhd atom (AE's source.duration can be
        // wrong when the file has a non-zero embedded start timecode).
        var totalDurF = (fileInfo && fileInfo.totalFrames > 0)
                          ? fileInfo.totalFrames
                          : Math.round(layer.source.duration * srcFps);

        if (isQuickTime && !fileInfo) {
            warnings.push(comp.name + ": could not read file header for \""
                + layer.source.file.displayName
                + "\" — fps=" + srcFps + " totalDurF=" + totalDurF + " (fallback)");
        }

        // Embedded start TC frame (needed for <file><timecode> so Resolve can
        // locate the clip by its actual TC range, not physical frame 0).
        var fileTCFrame = fileInfo ? fileInfo.tcStartFrame : 0;

        // _comp time → source-file frame mapping:
        //   - FLAT:    active layer is raw plate in _comp @ startTime=0 →
        //              offset = 0; src-frame = compTime * srcFps.
        //   - PRECOMP: active layer is inside stack, outer stack layer in
        //              _comp is at startTime=fullStart →
        //              offset = outer layer's startTime; src-frame = (compTime - offset) * srcFps.
        // NOTE: fullStart != _comp.workAreaStart. The _comp work area is the
        // editorial CUT (workAreaStart = cutStart = fullStart + handleSec),
        // verified on real shots via deep-inspect (e.g. workArea start 9.24
        // vs outer layer startTime 8.24, a 1.0s head handle). Using the outer
        // layer's startTime makes the source-frame mapping land on the true
        // cut frames (matching the FLAT layout); using workAreaStart shifted
        // the export window earlier by handleSec and dropped cut frames.
        var containingC = null;
        try { containingC = layer.containingComp; } catch (eCC) {}
        var isNested = !!(containingC && containingC !== comp);
        var offsetSec = 0;
        if (isNested) {
            // Find the outer layer in _comp whose source is the precomp we
            // recursed into, and use ITS startTime (= fullStart). Fall back
            // to workAreaStart only if it can't be located.
            var foundOuter = false;
            for (var oL = 1; oL <= comp.numLayers; oL++) {
                try {
                    if (comp.layer(oL).source === containingC) {
                        offsetSec = comp.layer(oL).startTime;
                        foundOuter = true;
                        break;
                    }
                } catch (eOL) {}
            }
            if (!foundOuter) {
                try { offsetSec = comp.workAreaStart || 0; } catch (eWA) {}
            }
        }

        // ── activeComp mode: short-circuit timing from the layer itself ──
        // Layer sits directly in the active comp. Its inPoint/outPoint give
        // the sequence span in comp time, and startTime gives the source-
        // time offset. Stretch is honoured; time-remap falls back to the
        // layer's own in/out which already reflect any remap.
        if (layerIndex !== null) {
            var stretch = (layer.stretch !== 0) ? layer.stretch : 100;
            var lIn  = layer.inPoint;
            var lOut = layer.outPoint;
            var seqDurSec   = Math.max(0, lOut - lIn);
            // Source time range the layer actually plays through:
            //   src = (compTime - layer.startTime) * (stretch/100)
            var srcInSec, srcOutSec;
            if (layer.timeRemapEnabled) {
                // Time-remap: the layer's in/out already define the
                // displayed source times via the remap keyframes. For a
                // pragmatic export we treat it as a linear span covering
                // source frames [in .. out] at comp time — speed math
                // isn't round-tripped, but the clip lands on the timeline.
                srcInSec  = lIn  - layer.startTime;
                srcOutSec = lOut - layer.startTime;
                warnings.push(comp.name + " / " + layer.name + ": time-remap present, exported without retime keys.");
            } else {
                srcInSec  = (lIn  - layer.startTime) * (stretch / 100);
                srcOutSec = (lOut - layer.startTime) * (stretch / 100);
            }
            if (srcOutSec < srcInSec) {
                var swp = srcInSec; srcInSec = srcOutSec; srcOutSec = swp;
                warnings.push(comp.name + " / " + layer.name + ": reversed stretch, exported forward.");
            }
            var aInF  = Math.max(0, Math.round(srcInSec  * srcFps));
            var aOutF = Math.min(totalDurF, Math.round(srcOutSec * srcFps));
            if (aOutF <= aInF) aOutF = Math.min(totalDurF, aInF + 1);

            clips.push({
                n:            clips.length + 1,
                name:         layer.source.file.displayName,
                comp:         comp.name,
                path:         layer.source.file.fsName,
                compFps:      compFps,
                srcFps:       srcFps,
                width:        comp.width,
                height:       comp.height,
                srcInF:       aInF,
                srcOutF:      aOutF,
                durF:         aOutF - aInF,
                totalDurF:    totalDurF,
                fileTCFrame:  fileTCFrame,
                mainSpanSec:  null,
                // activeComp-only: timeline placement + track assignment
                seqStartSec:  lIn,
                seqDurSec:    seqDurSec,
                trackIdx:     layerIndex   // AE layer index (1 = topmost)
            });
            return;
        }

        // Primary: walk UP via usedIn to find the outermost mainComp layer.
        // Its inPoint/outPoint give the CURRENT mainComp cut (picks up later
        // edits in AE automatically). Map those times through the chain down
        // to _comp time, then through the offset to source-file time.
        //
        // Falls back to _comp cut markers + workArea if the walk fails
        // (shot never wired into an edit, shared-source corner cases, etc.).
        var chainResult = walkUpChain(comp);
        var mainSpanSec     = null;  // mainComp-time duration of the shot
        var chainInSec      = null;  // _comp time mapped from mainComp in
        var chainOutSec     = null;  // _comp time mapped from mainComp out
        if (chainResult && chainResult.chain.length > 0) {
            var topLayer = chainResult.chain[chainResult.chain.length - 1];
            var mIn = 0, mOut = 0;
            try { mIn  = topLayer.inPoint;  } catch (eMi) {}
            try { mOut = topLayer.outPoint; } catch (eMo) {}
            if (mOut > mIn) {
                mainSpanSec = mOut - mIn;
                try { chainInSec  = mapTimeDownChain(mIn,  chainResult.chain); } catch (eMI2) {}
                try { chainOutSec = mapTimeDownChain(mOut, chainResult.chain); } catch (eMO2) {}
            }
        }

        var cutInCT = null, cutOutCT = null;
        if (comp.markerProperty && comp.markerProperty.numKeys > 0) {
            for (var mkI = 1; mkI <= comp.markerProperty.numKeys; mkI++) {
                var mkV = comp.markerProperty.keyValue(mkI);
                var mkCmt = (mkV && mkV.comment) ? String(mkV.comment).toLowerCase() : "";
                if (mkCmt === "cut in")  cutInCT  = comp.markerProperty.keyTime(mkI);
                if (mkCmt === "cut out") cutOutCT = comp.markerProperty.keyTime(mkI);
            }
        }

        var inSec = null, outSec = null;
        if (!trimToCut) {
            // Default "full clips" path: source range = _comp.workArea
            // (clip + handles). Unchanged from the original XML export.
            var waS = 0, waD = 0;
            try { waS = comp.workAreaStart || 0; } catch (eWaA) {}
            try { waD = comp.workAreaDuration || 0; } catch (eWaB) {}
            if (waD > 0) {
                inSec  = waS - offsetSec;
                outSec = (waS + waD) - offsetSec;
            }
        } else if (chainInSec !== null && chainOutSec !== null) {
            // Chain-walk succeeded → use mainComp cut (current edit state).
            // Normalise: negative stretch can make mapped out < in.
            if (chainOutSec > chainInSec) {
                inSec  = chainInSec  - offsetSec;
                outSec = chainOutSec - offsetSec;
            } else if (chainInSec > chainOutSec) {
                inSec  = chainOutSec - offsetSec;
                outSec = chainInSec  - offsetSec;
                warnings.push(comp.name + ": reversed chain detected — using absolute range; speed direction not encoded.");
            }
        } else if (cutInCT !== null && cutOutCT !== null && cutOutCT > cutInCT) {
            // Fallback: _comp cut markers (baked at Shot Roundtrip time).
            inSec  = cutInCT  - offsetSec;
            outSec = cutOutCT - offsetSec;
        } else {
            warnings.push(comp.name + ": no mainComp chain and no cut markers — exported full source as fallback.");
        }

        var srcInF  = 0;
        var srcOutF = totalDurF;
        var durF    = totalDurF;
        if (inSec !== null && outSec !== null && outSec > inSec) {
            var inF  = Math.round(inSec  * srcFps);
            var outF = Math.round(outSec * srcFps);
            if (inF  < 0)         inF  = 0;
            if (outF > totalDurF) outF = totalDurF;
            if (outF > inF) {
                srcInF  = inF;
                srcOutF = outF;
                durF    = outF - inF;
            }
        }

        clips.push({
            n:             clips.length + 1,
            name:          layer.source.file.displayName,
            comp:          comp.name,
            path:          layer.source.file.fsName,
            compFps:       compFps,     // used only for seq start/end conversion
            srcFps:        srcFps,      // native fps of the source file
            width:         comp.width,
            height:        comp.height,
            srcInF:        srcInF,      // TC-based in frame
            srcOutF:       srcOutF,     // TC-based out frame
            durF:          durF,
            totalDurF:     totalDurF,   // from file header
            fileTCFrame:   fileTCFrame, // embedded TC start frame
            mainSpanSec:   mainSpanSec,  // null if chain-walk failed; else mainComp visible duration
            // activeComp-only fields left null in shots mode
            seqStartSec:   null,
            seqDurSec:     null,
            trackIdx:      null
        });
    }

    // ── Drive the clip gathering ────────────────────────────────────────────
    for (var c = 0; c < comps.length; c++) {
        if (sourceMode === "activeComp") buildClipsForActiveComp(comps[c]);
        else                             buildClipsForCompShotsMode(comps[c]);
    }

    if (clips.length === 0) {
        greyAlert("Export Shot XML", "No clips could be exported.\n\n" + warnings.join("\n"));
        return;
    }

    // ─── sequence-relative start/end (all in seqFps) ─────────────────────────

    var totalSeqF;
    if (sourceMode === "activeComp") {
        // Each clip keeps its own timeline position from the active comp.
        var maxEnd = 0;
        for (var i = 0; i < clips.length; i++) {
            var cl = clips[i];
            cl.durSeqF   = Math.max(1, Math.round(cl.seqDurSec * seqFps));
            cl.seqStartF = Math.round(cl.seqStartSec * seqFps);
            cl.seqEndF   = cl.seqStartF + cl.durSeqF;
            if (cl.seqEndF > maxEnd) maxEnd = cl.seqEndF;
        }
        totalSeqF = maxEnd;
    } else {
        // Shots mode — clips are appended head-to-tail on one track (existing
        // behaviour). durSeqF comes from mainSpanSec in trim-to-cut mode,
        // else durF/srcFps (full clip at native speed).
        var seqHead = 0;
        for (var i = 0; i < clips.length; i++) {
            var cl = clips[i];
            var seqDurSec;
            if (!trimToCut || cl.mainSpanSec === null) {
                seqDurSec = cl.durF / cl.srcFps;
            } else {
                seqDurSec = cl.mainSpanSec;
            }
            cl.durSeqF   = Math.round(seqDurSec * seqFps);
            cl.seqStartF = seqHead;
            cl.seqEndF   = seqHead + cl.durSeqF;
            seqHead += cl.durSeqF;
        }
        totalSeqF = seqHead;
    }

    // ─── build XML ───────────────────────────────────────────────────────────

    var L = [];

    L.push('<?xml version="1.0" encoding="UTF-8"?>');
    L.push('<!DOCTYPE xmeml>');
    L.push('<xmeml version="4">');

    // ── sequence wrapper ──────────────────────────────────────────────────
    L.push('\t<sequence id="sequence-1">');
    L.push('\t\t<duration>' + totalSeqF + '</duration>');
    L.push(rateBlock(seqFps, "\t\t"));
    L.push('\t\t<name>' + xmlEscape(projectBaseName) + '</name>');

    // ── sequence timecode ──────────────────────────────────────────────
    L.push('\t\t<timecode>');
    L.push(rateBlock(seqFps, "\t\t\t"));
    L.push('\t\t\t<string>00:00:00:00</string>');
    L.push('\t\t\t<frame>0</frame>');
    L.push('\t\t\t<displayformat>NDF</displayformat>');
    L.push('\t\t</timecode>');

    // ── media ─────────────────────────────────────────────────────────
    L.push('\t\t<media>');
    L.push('\t\t\t<video>');

    // format block (describes the sequence)
    L.push('\t\t\t\t<format>');
    L.push('\t\t\t\t\t<samplecharacteristics>');
    L.push(rateBlock(seqFps, "\t\t\t\t\t\t"));
    L.push('\t\t\t\t\t\t<width>'  + clips[0].width  + '</width>');
    L.push('\t\t\t\t\t\t<height>' + clips[0].height + '</height>');
    L.push('\t\t\t\t\t\t<anamorphic>FALSE</anamorphic>');
    L.push('\t\t\t\t\t\t<pixelaspectratio>square</pixelaspectratio>');
    L.push('\t\t\t\t\t\t<fielddominance>none</fielddominance>');
    L.push('\t\t\t\t\t</samplecharacteristics>');
    L.push('\t\t\t\t</format>');

    // Group clips into tracks. Shots mode = one track with every clip;
    // activeComp mode = one track per AE layer (AE layer N = XML track 1
    // at the bottom, AE layer 1 = highest XML track on top).
    var videoTracks = [];
    if (sourceMode === "activeComp") {
        var byIdx = {};
        for (var gI = 0; gI < clips.length; gI++) {
            var tI = clips[gI].trackIdx;
            if (!byIdx[tI]) byIdx[tI] = [];
            byIdx[tI].push(clips[gI]);
        }
        var idxKeys = [];
        for (var kk in byIdx) idxKeys.push(parseInt(kk, 10));
        // Emit bottom-of-stack first so the highest AE layer (smallest idx)
        // ends up as the top XML track.
        idxKeys.sort(function (a, b) { return b - a; });
        for (var kkk = 0; kkk < idxKeys.length; kkk++) videoTracks.push(byIdx[idxKeys[kkk]]);
    } else {
        videoTracks.push(clips);
    }

    function emitVideoClipitem(cl, trackIdx) {
        var url = xmlEscape(toFileURL(cl.path));
        L.push('\t\t\t\t\t<clipitem id="clipitem-' + cl.n + '">');
        L.push('\t\t\t\t\t\t<masterclipid>masterclip-' + cl.n + '</masterclipid>');
        L.push('\t\t\t\t\t\t<name>'    + xmlEscape(cl.name) + '</name>');
        L.push('\t\t\t\t\t\t<enabled>TRUE</enabled>');
        L.push('\t\t\t\t\t\t<duration>' + cl.durF + '</duration>');
        L.push(rateBlock(cl.srcFps, "\t\t\t\t\t\t"));
        L.push('\t\t\t\t\t\t<start>' + cl.seqStartF + '</start>');
        L.push('\t\t\t\t\t\t<end>'   + cl.seqEndF   + '</end>');
        L.push('\t\t\t\t\t\t<in>'    + cl.srcInF    + '</in>');
        L.push('\t\t\t\t\t\t<out>'   + cl.srcOutF   + '</out>');
        L.push('\t\t\t\t\t\t<pproTicksIn>'  + pproTicks(cl.srcInF,  cl.srcFps) + '</pproTicksIn>');
        L.push('\t\t\t\t\t\t<pproTicksOut>' + pproTicks(cl.srcOutF, cl.srcFps) + '</pproTicksOut>');
        L.push('\t\t\t\t\t\t<alphatype>none</alphatype>');
        L.push('\t\t\t\t\t\t<pixelaspectratio>square</pixelaspectratio>');
        L.push('\t\t\t\t\t\t<anamorphic>FALSE</anamorphic>');

        L.push('\t\t\t\t\t\t<file id="file-' + cl.n + '">');
        L.push('\t\t\t\t\t\t\t<name>'    + xmlEscape(cl.name) + '</name>');
        L.push('\t\t\t\t\t\t\t<pathurl>' + url               + '</pathurl>');
        L.push(rateBlock(cl.srcFps, "\t\t\t\t\t\t\t"));
        L.push('\t\t\t\t\t\t\t<duration>' + cl.totalDurF + '</duration>');
        L.push('\t\t\t\t\t\t\t<timecode>');
        L.push(rateBlock(cl.srcFps, "\t\t\t\t\t\t\t\t"));
        L.push('\t\t\t\t\t\t\t\t<string>' + framesToTC(cl.fileTCFrame, cl.srcFps) + '</string>');
        L.push('\t\t\t\t\t\t\t\t<frame>'  + cl.fileTCFrame + '</frame>');
        L.push('\t\t\t\t\t\t\t\t<displayformat>NDF</displayformat>');
        L.push('\t\t\t\t\t\t\t</timecode>');
        L.push('\t\t\t\t\t\t\t<media>');
        L.push('\t\t\t\t\t\t\t\t<video>');
        L.push('\t\t\t\t\t\t\t\t\t<samplecharacteristics>');
        L.push(rateBlock(cl.srcFps, "\t\t\t\t\t\t\t\t\t\t"));
        L.push('\t\t\t\t\t\t\t\t\t\t<width>'  + cl.width  + '</width>');
        L.push('\t\t\t\t\t\t\t\t\t\t<height>' + cl.height + '</height>');
        L.push('\t\t\t\t\t\t\t\t\t\t<anamorphic>FALSE</anamorphic>');
        L.push('\t\t\t\t\t\t\t\t\t\t<pixelaspectratio>square</pixelaspectratio>');
        L.push('\t\t\t\t\t\t\t\t\t\t<fielddominance>none</fielddominance>');
        L.push('\t\t\t\t\t\t\t\t\t</samplecharacteristics>');
        L.push('\t\t\t\t\t\t\t\t</video>');
        L.push('\t\t\t\t\t\t\t\t<audio>');
        L.push('\t\t\t\t\t\t\t\t\t<samplecharacteristics>');
        L.push('\t\t\t\t\t\t\t\t\t\t<depth>16</depth>');
        L.push('\t\t\t\t\t\t\t\t\t\t<samplerate>48000</samplerate>');
        L.push('\t\t\t\t\t\t\t\t\t</samplecharacteristics>');
        L.push('\t\t\t\t\t\t\t\t\t<channelcount>2</channelcount>');
        L.push('\t\t\t\t\t\t\t\t</audio>');
        L.push('\t\t\t\t\t\t\t</media>');
        L.push('\t\t\t\t\t\t</file>');

        L.push('\t\t\t\t\t\t<link>');
        L.push('\t\t\t\t\t\t\t<linkclipref>clipitem-' + cl.n + '</linkclipref>');
        L.push('\t\t\t\t\t\t\t<mediatype>video</mediatype>');
        L.push('\t\t\t\t\t\t\t<trackindex>' + trackIdx + '</trackindex>');
        L.push('\t\t\t\t\t\t\t<clipindex>' + cl.n + '</clipindex>');
        L.push('\t\t\t\t\t\t</link>');

        L.push('\t\t\t\t\t\t<logginginfo>');
        L.push('\t\t\t\t\t\t\t<description></description>');
        L.push('\t\t\t\t\t\t\t<scene></scene>');
        L.push('\t\t\t\t\t\t\t<shottake></shottake>');
        L.push('\t\t\t\t\t\t\t<lognote></lognote>');
        L.push('\t\t\t\t\t\t\t<good></good>');
        L.push('\t\t\t\t\t\t\t<originalvideofilename></originalvideofilename>');
        L.push('\t\t\t\t\t\t\t<originalaudiofilename></originalaudiofilename>');
        L.push('\t\t\t\t\t\t</logginginfo>');
        L.push('\t\t\t\t\t\t<colorinfo>');
        L.push('\t\t\t\t\t\t\t<lut></lut>');
        L.push('\t\t\t\t\t\t\t<lut1></lut1>');
        L.push('\t\t\t\t\t\t\t<asc_sop></asc_sop>');
        L.push('\t\t\t\t\t\t\t<asc_sat></asc_sat>');
        L.push('\t\t\t\t\t\t\t<lut2></lut2>');
        L.push('\t\t\t\t\t\t</colorinfo>');
        L.push('\t\t\t\t\t\t<labels>');
        L.push('\t\t\t\t\t\t\t<label2>Iris</label2>');
        L.push('\t\t\t\t\t\t</labels>');
        L.push('\t\t\t\t\t</clipitem>');
    }

    for (var vT = 0; vT < videoTracks.length; vT++) {
        var trackClips = videoTracks[vT];
        var trackIdx   = vT + 1;
        L.push('\t\t\t\t<track>');
        for (var vC = 0; vC < trackClips.length; vC++) emitVideoClipitem(trackClips[vC], trackIdx);
        L.push('\t\t\t\t</track>');
    }
    L.push('\t\t\t</video>');

    // ── audio: one track per video track, clips link back to video ────────
    L.push('\t\t\t<audio>');
    function emitAudioClipitem(cl, trackIdx) {
        L.push('\t\t\t\t\t<clipitem id="clipitem-' + cl.n + '-audio">');
        L.push('\t\t\t\t\t\t<name>'     + xmlEscape(cl.name) + '</name>');
        L.push('\t\t\t\t\t\t<duration>' + cl.durF            + '</duration>');
        L.push(rateBlock(cl.srcFps, "\t\t\t\t\t\t"));
        L.push('\t\t\t\t\t\t<start>'    + cl.seqStartF       + '</start>');
        L.push('\t\t\t\t\t\t<end>'      + cl.seqEndF         + '</end>');
        L.push('\t\t\t\t\t\t<enabled>TRUE</enabled>');
        L.push('\t\t\t\t\t\t<in>'       + cl.srcInF          + '</in>');
        L.push('\t\t\t\t\t\t<out>'      + cl.srcOutF         + '</out>');
        L.push('\t\t\t\t\t\t<file id="file-' + cl.n + '"/>');
        L.push('\t\t\t\t\t\t<sourcetrack>');
        L.push('\t\t\t\t\t\t\t<mediatype>audio</mediatype>');
        L.push('\t\t\t\t\t\t\t<trackindex>1</trackindex>');
        L.push('\t\t\t\t\t\t</sourcetrack>');
        L.push('\t\t\t\t\t\t<link>');
        L.push('\t\t\t\t\t\t\t<linkclipref>clipitem-' + cl.n + '</linkclipref>');
        L.push('\t\t\t\t\t\t\t<mediatype>video</mediatype>');
        L.push('\t\t\t\t\t\t</link>');
        L.push('\t\t\t\t\t</clipitem>');
    }
    for (var aT = 0; aT < videoTracks.length; aT++) {
        var aClips = videoTracks[aT];
        L.push('\t\t\t\t<track>');
        for (var aC = 0; aC < aClips.length; aC++) emitAudioClipitem(aClips[aC], aT + 1);
        L.push('\t\t\t\t</track>');
    }
    L.push('\t\t\t</audio>');

    L.push('\t\t</media>');
    L.push('\t</sequence>');
    L.push('</xmeml>');

    // ─── save ────────────────────────────────────────────────────────────────

    var _d = new Date();
    var dateStr = String(_d.getFullYear()) + pad2(_d.getMonth() + 1) + pad2(_d.getDate());

    var fileSuffix = (sourceMode === "activeComp") ? "_comp_" : "_shots_";
    var saveFile;
    if ($.global.__shotRoundtripXMLDir) {
        // Called from roundtrip — save automatically into the shots folder
        var xmlDir = new Folder($.global.__shotRoundtripXMLDir);
        if (!xmlDir.exists) xmlDir.create();
        saveFile = new File(xmlDir.fsName + "/" + projectFileStem + fileSuffix + dateStr + ".xml");
    } else {
        // Standalone — show Save dialog
        var saveDir = proj.file ? proj.file.parent : Folder.desktop;
        saveFile = new File(saveDir.fsName + "/" + projectFileStem + fileSuffix + dateStr + ".xml");
        saveFile = saveFile.saveDlg("Save XML for DaVinci Resolve", "XML files:*.xml,All files:*.*");
        if (!saveFile) return;
    }

    saveFile.encoding = "UTF-8";
    if (!saveFile.open("w")) {
        greyAlert("Export Shot XML", "Failed to write XML file:\n" + saveFile.fsName + "\n\nCheck folder permissions and free disk space.");
        return;
    }
    saveFile.write(L.join("\n"));
    saveFile.close();

    // ─── completion dialog (grey ScriptUI, not alert) ───────────────────────
    // Skipped when invoked from Shot Roundtrip — that flow has its own
    // end-of-run report and doesn't want a second confirmation.
    if ($.global.__shotRoundtripXMLDir) return;

    (function showExportSummary() {
        var dlg = new Window("dialog", "Export Shot XML — Done");
        dlg.orientation = "column"; dlg.alignChildren = ["fill", "top"];
        dlg.spacing = 10; dlg.margins = 14;

        var LABEL_W = 150;
        var addRow = function (parent, label, value) {
            var g = parent.add("group");
            g.orientation = "row"; g.alignChildren = ["left", "center"]; g.spacing = 8;
            var l = g.add("statictext", undefined, label); l.preferredSize = [LABEL_W, 18];
            g.add("statictext", undefined, String(value));
        };

        var statsPnl = dlg.add("panel", undefined, "Summary");
        statsPnl.orientation = "column"; statsPnl.alignChildren = ["fill", "top"];
        statsPnl.margins = [12, 12, 12, 12]; statsPnl.spacing = 4;
        addRow(statsPnl, "Clips exported:",    clips.length);
        addRow(statsPnl, "Sequence duration:", framesToTC(totalSeqF, seqFps) + "  (" + totalSeqF + "f @ " + seqFps + ")");
        var modeLabel = (sourceMode === "activeComp")
                      ? "Active composition (" + projectBaseName + ")"
                        + (visibleOnly ? " — visible layers only" : " — all footage layers")
                      : (trimToCut ? "Shots folder — Trim to Editorial Cut (Experimental)"
                                   : "Shots folder — full clips (clip + handles)");
        addRow(statsPnl, "Mode:",              modeLabel);

        var filePnl = dlg.add("panel", undefined, "File");
        filePnl.orientation = "column"; filePnl.alignChildren = ["fill", "top"];
        filePnl.margins = [12, 12, 12, 12]; filePnl.spacing = 4;
        addRow(filePnl, "Saved to:", saveFile.displayName);
        filePnl.add("statictext", undefined, saveFile.parent.fsName);

        if (warnings.length > 0) {
            var warnPnl = dlg.add("panel", undefined, "Warnings");
            warnPnl.orientation = "column"; warnPnl.alignChildren = ["fill", "top"];
            warnPnl.margins = [12, 12, 12, 12]; warnPnl.spacing = 4;
            var body = "";
            for (var wi = 0; wi < warnings.length; wi++) body += "  " + warnings[wi] + "\n";
            var lines = body.split("\n").length;
            var maxH  = $.screens[0].bottom - $.screens[0].top - 360;
            var textH = Math.min(Math.max(lines * 15 + 10, 60), maxH);
            var txt = warnPnl.add("edittext", undefined, body,
                { multiline: true, readonly: true, scrollable: true });
            txt.preferredSize = [460, textH];
        }

        var btnRow = dlg.add("group");
        btnRow.alignment = ["right", "bottom"];
        var ok = btnRow.add("button", undefined, "OK"); ok.preferredSize = [80, 28];
        ok.onClick = function () { dlg.close(); };
        dlg.show();
    })();

})();
