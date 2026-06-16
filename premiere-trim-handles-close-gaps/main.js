const { entrypoints } = require('uxp');

entrypoints.setup({
  panels: {
    panel1: {
      show(rootNode) {

        // ── Styles ─────────────────────────────────────────────────────────
        rootNode.style.cssText = [
          'padding:16px',
          'font-family:sans-serif',
          'font-size:12px',
          'color:#e0e0e0',
          'background:#1e1e1e',
          'box-sizing:border-box'
        ].join(';');

        // ── Header ─────────────────────────────────────────────────────────
        var header = document.createElement('div');
        header.style.cssText = 'margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid #333;';

        var title = document.createElement('div');
        title.textContent = 'Trim Handles & Close Gaps';
        title.style.cssText = 'font-size:15px; font-weight:700; color:#fff; letter-spacing:0.3px;';

        var subtitle = document.createElement('div');
        subtitle.textContent = 'Gegenschuss \u00b7 v1.1';
        subtitle.style.cssText = 'font-size:10px; color:#555; margin-top:2px;';

        header.appendChild(title);
        header.appendChild(subtitle);
        rootNode.appendChild(header);

        // ── Section ────────────────────────────────────────────────────────
        var section = document.createElement('div');
        section.style.cssText = 'margin-bottom:16px; padding:12px; background:#282828; border-radius:6px;';

        var label = document.createElement('div');
        label.textContent = 'Handles (frames)';
        label.style.cssText = 'font-size:11px; color:#999; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;';

        var input = document.createElement('input');
        input.type  = 'number';
        input.value = '50';
        input.min   = '1';
        input.style.cssText = [
          'width:100%',
          'margin-bottom:10px',
          'padding:6px 8px',
          'background:#1a1a1a',
          'border:1px solid #3a3a3a',
          'border-radius:4px',
          'color:#fff',
          'font-size:13px',
          'box-sizing:border-box'
        ].join(';');

        var btn = document.createElement('button');
        btn.textContent = 'Trim & Close Gaps';
        btn.style.cssText = [
          'width:100%',
          'padding:7px',
          'margin-bottom:6px',
          'background:#2d6cdf',
          'border:none',
          'border-radius:4px',
          'color:#fff',
          'font-size:12px',
          'font-weight:600',
          'cursor:pointer',
          'letter-spacing:0.3px'
        ].join(';');

        var btnUndo = document.createElement('button');
        btnUndo.textContent = 'Undo';
        btnUndo.style.cssText = [
          'width:100%',
          'padding:7px',
          'margin-bottom:6px',
          'background:#333',
          'border:1px solid #444',
          'border-radius:4px',
          'color:#bbb',
          'font-size:12px',
          'cursor:pointer'
        ].join(';');

        var hint = document.createElement('div');
        hint.textContent = 'Select clips first (Cmd+A)';
        hint.style.cssText = 'font-size:10px; color:#555; margin-top:4px; text-align:center;';

        section.appendChild(label);
        section.appendChild(input);
        section.appendChild(btn);
        section.appendChild(btnUndo);
        section.appendChild(hint);
        rootNode.appendChild(section);

        // ── Status message ─────────────────────────────────────────────────
        var msg = document.createElement('div');
        msg.textContent = 'Select clips on the timeline.';
        msg.style.cssText = [
          'font-size:11px',
          'color:#666',
          'text-align:center',
          'padding:4px 0',
          'min-height:16px'
        ].join(';');
        rootNode.appendChild(msg);

        function setMsg(text, isError) {
          msg.textContent = text;
          msg.style.color = isError ? '#e05555' : '#888';
        }

        var ppro     = require('premierepro');
        var lastUndo = null; // { trim: [{name, item, origStart, origEnd}], gaps: [{name, item, undoDelta}] }

        // ── Trim & Close Gaps ──────────────────────────────────────────────
        btn.addEventListener('click', async function () {
          var frames = parseInt(input.value, 10);
          setMsg('Working\u2026');

          if (isNaN(frames) || frames < 1) {
            setMsg('Enter a valid frame count.', true);
            return;
          }

          try {
            var project = await ppro.Project.getActiveProject();
            if (!project) { setMsg('No project open.', true); return; }

            var sequence = await project.getActiveSequence();
            if (!sequence) { setMsg('No active sequence.', true); return; }

            // ── Phase 1: Trim handles ──────────────────────────────────────
            var timebase      = await sequence.getTimebase();
            var ticksPerFrame = (typeof timebase === 'object') ? timebase.ticksNumber : Number(timebase);
            var fps           = 254016000000 / ticksPerFrame;
            var trimSecs      = frames / fps;

            var selObj     = await sequence.getSelection();
            var trackItems = await selObj.getTrackItems();

            if (!trackItems || trackItems.length === 0) {
              setMsg('No clips selected on the timeline.', true);
              return;
            }

            var clipData = [];
            for (var i = 0; i < trackItems.length; i++) {
              var item = trackItems[i];
              if (!(item instanceof ppro.VideoClipTrackItem)) continue;
              var startPt      = await item.getStartTime();
              var endPt        = await item.getEndTime();
              var newStartSecs = startPt.seconds + trimSecs;
              var newEndSecs   = endPt.seconds - trimSecs;
              if (newStartSecs >= newEndSecs) continue;
              clipData.push({
                item:       item,
                name:       await item.getName(),
                origStart:  startPt.seconds,
                origEnd:    endPt.seconds,
                newStartTT: await ppro.TickTime.createWithSeconds(newStartSecs),
                newEndTT:   await ppro.TickTime.createWithSeconds(newEndSecs)
              });
            }

            if (clipData.length === 0) {
              setMsg('Nothing to trim \u2014 clips may be too short.', true);
              return;
            }

            var trimmed = 0;

            // Pass 1: trim tails
            for (var k = 0; k < clipData.length; k++) {
              await (async function(d) {
                await project.lockedAccess(async () => {
                  try {
                    var a = d.item.createSetEndAction(d.newEndTT);
                    await project.executeTransaction(function(ca) { ca.addAction(a); });
                  } catch(e) { console.error('tail trim:', e.message); }
                });
              })(clipData[k]);
            }

            // Pass 2: trim heads — operate on the original clipData item
            // references directly. The previous version re-fetched the
            // selection and matched clips back by getName(), which mis-pairs
            // duplicate-named clips (the norm when a source recurs across
            // shots, or AE dynamicLink wrappers that share a name): two
            // same-named clips both resolve to the first match, so one gets
            // the wrong head trim and the other is never trimmed. TrackItem
            // references stay valid across transactions — the gap-close pass
            // and both undo passes below already rely on exactly that.
            for (var n = 0; n < clipData.length; n++) {
              await (async function(d) {
                await project.lockedAccess(async () => {
                  try {
                    var a = d.item.createSetStartAction(d.newStartTT);
                    await project.executeTransaction(function(ca) { ca.addAction(a); });
                    trimmed++;
                  } catch(e) { console.error('head trim:', e.message); }
                });
              })(clipData[n]);
            }

            var trimUndoData = clipData.map(function(d) {
              return { item: d.item, name: d.name, origStart: d.origStart, origEnd: d.origEnd };
            });

            // ── Phase 2: Close gaps ────────────────────────────────────────
            setMsg('Closing gaps\u2026');

            var project3    = await ppro.Project.getActiveProject();
            var sequence3   = await project3.getActiveSequence();
            var selObj3     = await sequence3.getSelection();
            var trackItems3 = await selObj3.getTrackItems();

            var byTrack = {};
            for (var i3 = 0; i3 < trackItems3.length; i3++) {
              var item3 = trackItems3[i3];
              if (!(item3 instanceof ppro.VideoClipTrackItem)) continue;
              var ti = await item3.getTrackIndex();
              var st = await item3.getStartTime();
              var en = await item3.getEndTime();
              if (!byTrack[ti]) byTrack[ti] = [];
              byTrack[ti].push({ item: item3, name: await item3.getName(), start: st.seconds, end: en.seconds });
            }

            var moved       = 0;
            var gapsUndoLog = [];
            var trackKeys   = Object.keys(byTrack);

            for (var t = 0; t < trackKeys.length; t++) {
              var clipsData = byTrack[trackKeys[t]];
              clipsData.sort(function(a, b) { return a.start - b.start; });

              var cursor = clipsData[0].start;

              for (var j = 0; j < clipsData.length; j++) {
                var d = clipsData[j];
                if (d.start > cursor + 0.001) {
                  var dur       = d.end - d.start;
                  var deltaSecs = cursor - d.start;
                  var deltaTT   = await ppro.TickTime.createWithSeconds(deltaSecs);
                  var trackIdx  = await d.item.getTrackIndex();
                  var aMove     = d.item.createMoveAction(deltaTT, trackIdx);
                  await project3.lockedAccess(async () => {
                    await project3.executeTransaction(function(ca) { ca.addAction(aMove); });
                  });
                  gapsUndoLog.push({ item: d.item, name: d.name, undoDelta: -deltaSecs });
                  d.start = cursor;
                  d.end   = cursor + dur;
                  moved++;
                }
                cursor = d.end;
              }
            }

            lastUndo = { trim: trimUndoData, gaps: gapsUndoLog };
            setMsg('Done: ' + trimmed + ' trimmed, ' + moved + ' gap(s) closed.');

          } catch (e) {
            setMsg('Error: ' + (e.message || String(e)), true);
            console.error('Trim & Close Gaps:', e);
          }
        });

        // ── Undo ──────────────────────────────────────────────────────────
        btnUndo.addEventListener('click', async function () {
          if (!lastUndo) { setMsg('Nothing to undo.', true); return; }
          setMsg('Undoing\u2026');
          try {
            var project  = await ppro.Project.getActiveProject();
            var restored = 0;

            // Step 1: undo close gaps (move clips back to post-trim positions)
            if (lastUndo.gaps && lastUndo.gaps.length > 0) {
              for (var i = 0; i < lastUndo.gaps.length; i++) {
                await (async function(entry) {
                  var deltaTT  = await ppro.TickTime.createWithSeconds(entry.undoDelta);
                  var trackIdx = await entry.item.getTrackIndex();
                  var aMove    = entry.item.createMoveAction(deltaTT, trackIdx);
                  await project.lockedAccess(async () => {
                    try {
                      await project.executeTransaction(function(ca) { ca.addAction(aMove); });
                      restored++;
                    } catch(e) { console.error('undo gaps move (' + entry.name + '):', e.message); }
                  });
                })(lastUndo.gaps[i]);
              }
            }

            // Step 2: undo trim (restore original in/out points)
            if (lastUndo.trim && lastUndo.trim.length > 0) {

              // Pass 1: restore end times
              for (var i = 0; i < lastUndo.trim.length; i++) {
                await (async function(entry) {
                  var origEndTT = await ppro.TickTime.createWithSeconds(entry.origEnd);
                  await project.lockedAccess(async () => {
                    try {
                      var a = entry.item.createSetEndAction(origEndTT);
                      await project.executeTransaction(function(ca) { ca.addAction(a); });
                    } catch(e) { console.error('undo tail (' + entry.name + '):', e.message); }
                  });
                })(lastUndo.trim[i]);
              }

              // Pass 2: restore start times on the original references
              // directly. The previous version re-fetched the selection and
              // matched back by getName(), which mis-pairs duplicate-named
              // clips — restoring the wrong origStart moves a clip to the
              // wrong place. Stored references are valid here: Step 1 and
              // Pass 1 above already mutated these same references.
              for (var j = 0; j < lastUndo.trim.length; j++) {
                await (async function(entry) {
                  var origStartTT = await ppro.TickTime.createWithSeconds(entry.origStart);
                  await project.lockedAccess(async () => {
                    try {
                      var a = entry.item.createSetStartAction(origStartTT);
                      await project.executeTransaction(function(ca) { ca.addAction(a); });
                      restored++;
                    } catch(e) { console.error('undo head:', e.message); }
                  });
                })(lastUndo.trim[j]);
              }
            }

            lastUndo = null;
            setMsg(restored > 0 ? 'Undo: ' + restored + ' clip(s) restored.' : 'Nothing restored.');
          } catch(e) {
            setMsg('Error: ' + (e.message || String(e)), true);
            console.error('Undo:', e);
          }
        });

      },

      hide() {}
    }
  }
});
