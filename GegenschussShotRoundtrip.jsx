/*
 *       _____                          __
 *      / ___/__ ___ ____ ___  ___ ____/ /  __ _____ ___
 *     / (_ / -_) _ `/ -_) _ \(_-</ __/ _ \/ // (_-<(_-<
 *     \___/\__/\_, /\__/_//_/___/\__/_//_/\_,_/___/___/
 *             /___/
 */

/**
 * AE Shot Roundtrip Panel
 *
 * A dockable ScriptUI launcher for the AE Shot Roundtrip toolset.
 *
 * INSTALLATION (dockable panel):
 *   Copy this file to:
 *   /Applications/Adobe After Effects <version>/Scripts/ScriptUI Panels/
 *   Then find it under the Window menu in AE.
 *
 * QUICK RUN (floating window):
 *   File > Scripts > Run Script File… → pick this file.
 *   The panel and scripts must stay in the same "AE Shot Roundtrip" folder.
 */

(function (thisObj) {

    // Resolve the folder this panel lives in, then build paths to sibling scripts.
    var BASE = (new File($.fileName)).parent;

    var SCRIPTS = [
        {
            group:  "Roundtrip",
            icon:   "⟲",
            label:  "Shot Roundtrip",
            tip:    "Extract selected shots for VFX work and re-import the renders back into the edit.",
            file:   "shot-roundtrip/shot_roundtrip.jsx"
        },
        {
            group:  "Roundtrip",
            icon:   "⟳",
            label:  "Re-render Plates",
            tip:    "Re-render every shot's original plate to {shot}_{suffix}.mov ready for external denoising or stabilization, and import the results back into each _stack precomp as plate variants.",
            file:   "re-render-plates/re_render_plates.jsx"
        },
        {
            group:  "Roundtrip",
            icon:   "⤓",
            label:  "Import Returns",
            tip:    "Scan all *_comp compositions for VFX renders (in each shot's render/ folder) and Resolve grades (in the flat _grade/ folder), and import them back into the project stacked grade > render > plate.",
            file:   "import-renders/import_renders.jsx"
        },
        {
            group:  "Roundtrip",
            icon:   "⇕",
            label:  "Select Version",
            tip:    "Central picker for every shot's active variant. Lists all *_comp shots with a dropdown of the variants stacked in their _footage/_stack precomp (top = newest). Bulk buttons to select all rows, set everything to latest, or disable all. Like Nuke Studio's select-version, but project-wide.",
            file:   "select-version/select_version.jsx"
        },
        {
            group:  "Time",
            icon:   "⇄",
            label:  "Switch Variant",
            tip:    "Preflight dialog listing every shot _container in the project with a checkbox showing which variant is currently active (☐ plate / ☑ bake). Click a row's checkbox to swap that shot's active variant atomically — toggles enabled flags on plate.mov + reversed.mov in the stack AND mirrors the container's time-remap values around the plate-range midpoint so the cut keeps playing the same content at the same master times, just from the opposite source. Bulk buttons: All → Bake, All → Plate, Refresh.",
            file:   "switch-variant/switch_variant.jsx"
        },
        {
            group:  "Project",
            icon:   "↪",
            label:  "Export Shot XML",
            tip:    "Export an FCP7 XML for DaVinci Resolve. Two modes: \"Shots folder\" scans every *_comp under the Shots folder (one clip per shot, appended head-to-tail) — used by the full Shot Roundtrip. \"Active composition\" dumps every footage layer in the current comp at its own timeline position (one track per AE layer) — the export half of the Comp Grade Roundtrip, paired with Import Comp Grades.",
            file:   "export-shot-xml/export_shot_xml.jsx"
        },
        {
            group:  "Project",
            icon:   "↩",
            label:  "Import Comp Grades",
            tip:    "Import half of the Comp Grade Roundtrip. For each footage layer in the active comp, finds a matching graded file in the _grade/ folder (next to the AEP) and drops it in as a new layer directly above the original. Matches by source-file stem prefix — Resolve's \"Use Unique Filenames\" suffix (e.g. _V1-0064) is fine. Newest-by-modification-time wins if multiple versions are present. Aligns by embedded source timecode (QuickTime tmcd atom) so Resolve-rendered handles stack correctly; falls back to inPoint alignment when TC can't be read.",
            file:   "import-comp-grades/import_comp_grades.jsx"
        },
        {
            group:  "Project",
            icon:   "⟡",
            label:  "Create dynamicLink Comps",
            tip:    "Standalone dynamicLink builder. Prompts for handle frames, then for each selected precomp or footage layer creates a wrapper comp with full cut + 2× handles duration (black padded) in /Shots/dynamicLink.",
            file:   "create-dynamiclink-comps/create_dynamiclink_comps.jsx"
        },
        {
            group:  "Diagnostics",
            icon:   "⊕",
            label:  "Deep Inspect",
            tip:    "Read-only single dump covering everything: full layer state (effects, expressions, transforms, time-remap with ease info, markers) for the active comp + every nested precomp; per-frame source-frame trace through every chain; *_stack inspection with mismatch flagging vs Pass 2's expected plate range. Use BEFORE / AFTER each roundtrip phase, tag each snapshot, then diff or read the *** MISMATCH *** lines in Pass 3. Dump lands next to the .aep as deep_inspect_<comp>_<tag>.txt.",
            file:   "diagnostics/dump_deep_inspect.jsx"
        }
    ];

    // Per-group foreground colors. Applied via button.graphics.foregroundColor —
    // ScriptUI may ignore this on macOS Aqua-styled buttons; if icons come out
    // grey everywhere, switch to iconbutton + PNG assets.
    var GROUP_COLORS = {
        "Roundtrip":   [0.45, 0.75, 1.00, 1.0], // cyan-ish
        "Time":        [0.85, 0.55, 0.95, 1.0], // violet — time-domain helpers
        "Project":     [0.95, 0.85, 0.45, 1.0], // gold
        "Diagnostics": [0.70, 0.70, 0.70, 1.0]  // neutral grey — read-only debug tools
    };

    function buttonLabel(script) {
        return script.icon + "  " + script.label;
    }

    function paintButton(btn, groupName) {
        var c = GROUP_COLORS[groupName];
        if (!c) return;
        try {
            var pen = btn.graphics.newPen(btn.graphics.PenType.SOLID_COLOR, c, 1);
            btn.graphics.foregroundColor = pen;
        } catch (ePc) {}
    }

    // ── helpers ────────────────────────────────────────────────────────────────

    function runScript(relativePath) {
        var f = new File(BASE.fsName + "/" + relativePath);
        if (!f.exists) {
            alert("Script not found:\n" + f.fsName);
            return;
        }
        $.evalFile(f);
    }

    // Collect unique group names in the order they first appear.
    function uniqueGroups() {
        var seen = {}, order = [];
        for (var i = 0; i < SCRIPTS.length; i++) {
            var g = SCRIPTS[i].group;
            if (!seen[g]) { seen[g] = true; order.push(g); }
        }
        return order;
    }

    // ── UI ─────────────────────────────────────────────────────────────────────

    function buildUI(thisObj) {
        var win = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", "Shot Roundtrip", undefined, { resizeable: true });

        win.orientation  = "column";
        win.alignChildren = ["fill", "top"];
        win.spacing      = 12;
        win.margins      = 16;

        // ── logo ───────────────────────────────────────────────────────────────
        var logoRow = win.add("group");
        logoRow.orientation = "row";
        logoRow.alignment = ["center", "top"];
        logoRow.spacing = 10;
        logoRow.margins = [0, 4, 0, 4];

        var logoFile = new File(BASE.fsName + "/Gegenschuss.png");
        if (logoFile.exists) {
            var logoImg = logoRow.add("image", undefined, logoFile);
            logoImg.alignment = ["left", "center"];
        }
        var brandCol = logoRow.add("group");
        brandCol.orientation = "column";
        brandCol.alignment = ["left", "center"];
        brandCol.spacing = 2;
        var buildDate = brandCol.add("statictext", undefined, "20260501");
        // NOTE to editor: keep this date in sync with ship day (YYYYMMDD).
        buildDate.graphics.font = ScriptUI.newFont("Helvetica", "REGULAR", 11);
        buildDate.graphics.foregroundColor = buildDate.graphics.newPen(buildDate.graphics.PenType.SOLID_COLOR, [0.55, 0.55, 0.55, 1], 1);
        var ghLabel = brandCol.add("statictext", undefined, "github.com/");
        ghLabel.graphics.font = ScriptUI.newFont("Helvetica", "REGULAR", 10);
        ghLabel.graphics.foregroundColor = ghLabel.graphics.newPen(ghLabel.graphics.PenType.SOLID_COLOR, [0.4, 0.4, 0.4, 1], 1);
        var ghName = brandCol.add("statictext", undefined, "Gegenschuss");
        ghName.graphics.font = ScriptUI.newFont("Helvetica", "REGULAR", 10);
        ghName.graphics.foregroundColor = ghName.graphics.newPen(ghName.graphics.PenType.SOLID_COLOR, [0.4, 0.4, 0.4, 1], 1);

        var groups = uniqueGroups();

        for (var g = 0; g < groups.length; g++) {
            var groupName = groups[g];

            var panel = win.add("panel", undefined, groupName);
            panel.orientation  = "column";
            panel.alignChildren = ["fill", "top"];
            panel.spacing      = 6;
            panel.margins      = [10, 16, 10, 10];

            for (var s = 0; s < SCRIPTS.length; s++) {
                if (SCRIPTS[s].group !== groupName) continue;
                (function (script) {
                    var btn = panel.add("button", undefined, buttonLabel(script));
                    btn.helpTip = script.tip;
                    paintButton(btn, script.group);
                    btn.onClick = function () { runScript(script.file); };
                })(SCRIPTS[s]);
            }
        }

        if (win instanceof Window) {
            win.center();
            win.show();
        } else {
            win.layout.layout(true);
        }
    }

    buildUI(thisObj);

})(this);
