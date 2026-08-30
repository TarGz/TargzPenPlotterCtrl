module.exports = {
  version: require('./package.json').version,
  CHANGELOG: [
    {
      date: '2026-08-30',
      version: '1.22.2',
      changes: [
        'Fix — clearing the G-code or loading a new file left the LAYERS panel showing the previous file. The 3D mesh did leave the scene, but the parser assigns `object` from the worker result BEFORE the "did we get anything?" guard, so an emptied editor leaves a truthy husk carrying one linePoint. strokeHasFile() only tested that linePoints existed, and an empty array is truthy — so MAIN kept reporting the old stroke count, + NEW LAYER stayed enabled, and the strokes array still addressed geometry that was gone. It now requires more than one point.',
        'Add strokeOnGcodeChanged(), called by the parser on BOTH outcomes — only a successful parse reached the existing onGcodeReloaded() hook, and an unload is exactly the case that never gets there. It drops the strokes, the grid, the selection, the undo stack and the open layer, leaves edit mode, and reloads the layers for the new file fingerprint.'
      ]
    },
    {
      date: '2026-08-30',
      version: '1.22.1',
      changes: [
        'Fix — pressing STOP, ABORT or DISCONNECT pushed a high-priority "Plot stopped" alert to your phone for the thing you had just done yourself. The backend decides `failed` purely from queue length (index.js), so a job the operator ended lands on exactly the same jobComplete as a dropped USB cable, and the renderer had no way to tell them apart. Every route to stopping now marks the action first — the CD Stop and Abort buttons, Disconnect, the e-stop keyboard shortcut and the legacy ribbon buttons — and cdNotifyPlotFailed() drops any failure push within 15s of one. Jog cancels are untouched: they emit stop with jog:true and are not job stops.',
        'Pause already behaved: the alert only fires on disconnect or ALARM, and a paused job is neither.'
      ]
    },
    {
      date: '2026-08-30',
      version: '1.22.0',
      changes: [
        'The LAYERS panel now says what it is for. Nothing on screen named the stroke editor, so a month later the pencil on a layer row was just an icon you no longer recognised — and it was the only door in besides + NEW LAYER. The panel head carries a caption ("Tick what gets plotted. EDIT changes which strokes a layer holds."), and the pencil is a worded EDIT button on every layer row, filled orange and reading EDITING while that layer is open.',
        'Rename and delete moved behind a single ⋯ overflow (same anchored-popover pattern as the colour picker). Three unlabelled 26px buttons in a 10px mono row was icon soup, and consolidating them is what freed the width for the EDIT label. Colour keeps its own direct affordance on the swatch, now 12px rather than 8px.',
        'Layer rows are a two-line grid: the name spans the first line, the count and the buttons share the second. On one line at 260px the name got about 80px, which ellipsised anything longer than "Outline". MAIN reads "whole file · 2,887 strokes" and lost its swatch border — an outlined box next to the tick just read as a second, unticked checkbox.',
        'With no layers saved the list shows what a layer is for rather than only MAIN, and + NEW LAYER goes solid, since with nothing to edit it is the only way into the editor.',
        'Edit mode announces itself. The selection bar was a hairline strip stretched edge to edge with a metre of empty white in the middle — scenery on a wide screen, and genuinely missed. It shrink-wraps and centres at the bottom, the layer name is a filled orange chip, type went 10px to 11px and DONE reads ✓ DONE. A 2px orange frame now rings the 3D view for as long as edit mode is on, the way a recording indicator does: noticing you are in a mode that changes what the machine will draw should not depend on reading small type at the bottom of the window.'
      ]
    },
    {
      date: '2026-07-29',
      version: '1.21.1',
      changes: [
        'Fix — the LAYERS panel, and with it the whole stroke editor, was unreachable on a machine that had never saved a layer. The panel was shown only when strokeLayers.length > 0, but + NEW LAYER lives inside it and the layer pencil is the only other way into EDIT, so an empty localStorage meant no panel, no button, no way in. Layers are keyed by filename + line count in localStorage, so the same commit behaved differently on a second computer purely because that profile already had layers stored. Visibility now keys on whether a G-code file is loaded (new strokeHasFile()), which is what the panel actually depends on.'
      ]
    },
    {
      date: '2026-07-29',
      version: '1.21.0',
      changes: [
        'Closes #24 — REFERENCE PHOTO is placed by dragging rather than by typing coordinates. A DRAG TO PLACE toggle grabs the photo anywhere in the view and it follows the cursor; the CENTRE X / CENTRE Y fields and their nudge buttons are gone. The mode is deliberate — while it is on the left button moves the photo instead of orbiting, so the button fills solid, and OrbitControls is restored when it is turned off or the photo removed.',
        'Add a SCALE slider (10–400%) relative to whatever FIT TO DRAWING computed, so it stays useful whatever the photo\'s pixel size. The mm size field and derived height remain for when the paper width is known exactly.',
        'Draw the photo\'s outline. A photo of white paper on a white work area has essentially no visible edge, so there was nothing to align against. The border is a child of the plane, inheriting position, scale and rotation rather than needing its own update path.',
        'Move the panel to the bottom left, clear of the tool rail and options (top left), the layers panel (top right) and the selection bar (bottom, full width).'
      ]
    },
    {
      date: '2026-07-29',
      version: '1.20.1',
      changes: [
        'Fix #23 — the layer pencil now always opens the layer for editing. It used to toggle on strokeEditingLayerId, so when that still pointed at the layer the button called strokeLayerEditDone() instead — invisible when already out of edit mode, which left the layer unopenable and made creating a new layer the only way back in. DONE and Esc are the only ways out, and unlike the pencil they say so; a toggle behind an icon that never changed could not tell you which of the two a click would do. strokeLayerEdit() also builds the stroke list if it is missing and reports rather than silently returning.'
      ]
    },
    {
      date: '2026-07-29',
      version: '1.20.0',
      changes: [
        'RANGE gets two thumbs, one per end, instead of a single thumb that moved whichever end was active. FROM is orange and TO is blue so the two never read alike, the marker cards echo the same colours, the end taking the next click is filled solid while the other stays hollow, and the span between them is tinted on the track. Built as two native range inputs stacked over a shared track with pointer-events on the thumbs only — otherwise the upper input swallows every click and the lower thumb cannot be dragged where they overlap.',
        'RANGE now opens with FROM at the first stroke and TO at the last, so it starts meaning "all of it". The ends are shown but NOT applied: applying on open would replace whatever the layer already holds with the entire file the moment the tool was picked.',
        'The range scope is the whole file again, not the open layer\'s strokes. Scoping it to the layer made it useless in the case it is most wanted — a new layer is empty, so a layer-scoped range had nothing to walk and could never put anything in. You are picking strokes out of the drawing and into the layer, so the file is the right scope.'
      ]
    },
    {
      date: '2026-07-29',
      version: '1.19.0',
      changes: [
        'Closes #22 — EDIT GCODE is retired and the START / END range is now the RANGE selection tool. It used to call redoJob(), which overwrote the source file in the editor: two ways to choose what gets plotted sitting side by side, one of them destructive. A range is also just a contiguous run of strokes, so it was duplicating what selection already expresses. Click each end or scrub with the slider; the 3D cone is the cursor, as it was in the old scrubber, and the readout still shows stroke position, coordinates, source line and that line\'s G-code.',
        'The range is contextual: with a layer open it spans that layer\'s strokes, otherwise the whole file, and the panel says which. Nothing overwrites the editor any more — every route to choosing what to plot goes through selections and layers. resume.js is untouched on disk, and the old scrub markup stays hidden in the DOM because Metro4 initialises those controls at load and other scripts hold references to them.',
        'Editing belongs to a layer rather than to a global mode. The VIEW / EDIT switch is gone; each layer row carries a pencil that opens it with the selection tools scoped to it, and the Photo overlay is global because it belongs to the drawing. + NEW LAYER creates an empty layer and opens it, so you paint INTO a layer instead of selecting first and saving after — SAVE AS LAYER and UPDATE are both gone, every gesture writes straight through.',
        'Tools moved to a vertical rail on the left with a single contextual options panel beside it: mode for the painting tools, size for Brush, the full scrubber for Range. Previously a wide horizontal palette plus a second Range panel put three columns of chrome across the canvas, one of them nearly empty.',
        'Edit-mode painting: strokes outside the layer fade to a faint grey rather than solid black — at 2,887 strokes a black file is a wall you cannot read a layer against — and selected strokes take the layer\'s own colour so the canvas and the panel agree. Layer rename, recolour and delete now work in both modes, with 26px hit targets and real icons.',
        'Fix: opening a layer for editing came back empty. strokeLayerEdit() restored the layer\'s strokes and then called strokeRangeReset(), which cleared the markers AND the selection, undoing the restore one line later. Split into strokeRangeClearMarks() for opening a layer and strokeRangeReset() for the CLEAR RANGE button.',
        'Fix: layer rename called window.prompt(), which Electron does not implement — it throws rather than prompting, so rename failed the first time it was pressed. It is inline contenteditable now (an <input> gets mutated by Metro4 into a component with a dropdown chevron), and keystrokes stop at the field so typing a name containing b, x, v or r no longer switches tools.',
        'Performance: the range cursor built a new MeshPhongMaterial on every call, which runs on every slider tick while scrubbing — materials are created once and reused. Full colour-buffer repaints (~90k floats on a 12k-line file, re-uploaded to the GPU) fired on every mousemove while brushing and are now coalesced to one per animation frame.'
      ]
    },
    {
      date: '2026-07-29',
      version: '1.18.0',
      changes: [
        'Closes #21 — the 3D toolbar now leads with a VIEW / EDIT switch. VIEW keeps the controls for looking at and running a plot (speed, Simulate, Reset View); EDIT holds everything that changes what gets plotted (reference Photo, the selection tools, the layer panel, the selection bar). Nothing from one mode leaks into the other.',
        'Parts become LAYERS: named bunches of strokes, renamable and deletable, with MAIN meaning the whole file (it cannot be renamed or deleted). Layers may overlap — nothing stops a stroke being in several, and plotting two overlapping layers would draw the shared strokes twice, which is the user\'s call. Storage moved from strokePart:<file> to strokeLayers:<file>, so a part saved under 1.17.0 does not carry over and needs saving again as a layer.',
        'The layer panel IS the plot selector. Each row is play / swatch / name / count / rename / delete; the play button arms that layer for plotting and behaves as a radio, since only one thing can be plotted at a time. The RUN panel used to repeat the whole list as a second button grid — two places to change one thing — and now keeps only the readout plus the START label. The panel stays visible in both modes because changing what you plot should not require entering edit mode.',
        'Armed-for-plotting and open-in-the-editor are independent states and are shown differently: a soft orange row fill for the plot target, an orange left bar and name for the layer being edited. One highlight for both would have implied they are mutually exclusive.',
        'View-mode preview follows the layers: with a layer armed only that layer renders, in its own colour, matching exactly what START will draw. With nothing armed the file ghosts back and every layer tints in its own colour, which is the view that makes a two-pen split readable.',
        'Fix stale colours in edit mode: the part preview and the selection painter both wrote the geometry colour buffer behind guards, and the guards could lose to call ordering. There is now a single strokeRepaint() that dispatches on mode — edit paints the black/red selection, view paints the layers — so the buffer has exactly one owner.'
      ]
    },
    {
      date: '2026-07-29',
      version: '1.17.0',
      changes: [
        'Closes #20 — EDIT mode in the 3D view: select which strokes to plot when the parts you need are NOT contiguous (pen ran dry in patches, a few shapes skipped). The START/END range can only express one interval; this expresses an arbitrary set. The unit is a stroke — one pen-down run — which turns a 12k-line file into a few hundred selectable things, the same granularity LightBurn and vpype work at.',
        'Three tools over one selection: Pick (V, click a stroke), Brush (B, drag to paint, [ and ] resize — the wheel stays with the camera zoom), Box (X, rubber band). Select / Unselect modes (A / E) decide which way a gesture paints, with alt inverting for one gesture. Plus ALL / NONE / INVERT and 50-deep undo on Cmd+Z. Roll-over shows what a click would do: green it would come in, dark red it is already in, grey the click is a no-op.',
        'Stroke detection works per SEGMENT and asks only two things: is it a feed move, and does it move in XY. No Z heuristic — pen up/down conventions vary too much between post-processors, and guessing wrong silently selects the wrong half of the file. A pen lift is a Z-only move so it drops out on its own. Strokes seed at the previous point, because a drawn segment runs FROM the rapid endpoint (where the pen came down, g == 0) TO the feed point.',
        'Hit-testing is 2D against a uniform grid of stroke bounding boxes, with early-out in the point-to-segment loop. Raycasting the toolpath Line directly is O(vertices) per mousemove and stutters while brushing a large plot. Pick tolerance is derived from screen pixels so it feels the same at any zoom, and hover recolours only the two affected strokes rather than the whole buffer.',
        'SAVE PART stores the selection as stroke INDICES in localStorage (key strokePart:<file>:<line count>), never as generated G-code, and never modifies the source file — which is what makes a part re-editable: reopening restores the selection itself, not a derived artefact. The line count in the key means a re-exported file with different line numbering stops matching rather than plotting stale indices.',
        'RUN panel gains PLOT TARGET (Whole file / Part) and START relabels to START PART when a part is armed — without it there is no way to tell whether the next job is 75 strokes or all 2,887. Selecting Part also isolates it in the preview. The part G-code is generated fresh at plot time, so it always uses the current pen heights, and is streamed to /runjob directly so the editor keeps the full source file.',
        'Exported strokes keep the source file\'s work coordinates. Re-originating to the selection bounding box would break registration with the ink already on the paper — the same reason LightBurn tells you to leave "Use Selection Origin" off when re-running part of a job.'
      ]
    },
    {
      date: '2026-07-28',
      version: '1.16.0',
      changes: [
        'Closes #19 — REFERENCE PHOTO: load a photo of a half-finished sheet and align it under the toolpath preview, so a restart point can be read off the paper instead of guessed at from thousands of G-code lines. New Photo button in the 3D view toolbar opens a panel with centre X/Y (± 1 mm nudges), width (height derived from the image aspect), rotation and opacity. Loading an image auto-fits it to the toolpath bounding box — the photo is of that drawing, so the drawn extents are the best first guess. Drop opacity to ~50% and scrub START / END until the marker sits at the last inked line.',
        'The overlay is a unit PlaneGeometry scaled to size, so resizing never rebuilds geometry. It is placed below the LOWEST toolpath Z (bbbox2.min.z - 0.5) rather than a fixed depth, because pen-down Z is typically negative and a hardcoded shallow offset would bury the drawing under the photo. transparent:true puts it in three\'s transparent pass so it draws after the opaque white work-area plane (which would otherwise paint over it) while still sorting behind the toolpath lines. Loading new G-code sets clearSceneFlag and strips the scene, so plotPhotoReattach() re-adds the mesh and an alignment survives a re-parse.',
        'No perspective correction — shoot the sheet square-on, position/scale/rotation cannot undo camera tilt. The image itself is not persisted across restarts.'
      ]
    },
    {
      date: '2026-07-28',
      version: '1.15.1',
      changes: [
        'EDIT GCODE: the 3D camera no longer follows the START / END markers. Moving the slider panned the view to centre on each marker (cdScrubFollow), and closing the panel snapped back to overview framing (cdScrubResetCamera via resetView) — so you could not frame a detail and scrub through it. Camera position and zoom now stay exactly where you put them; the cone still tracks the active marker. Both helpers were removed from viewer.js along with their only call sites.'
      ]
    },
    {
      date: '2026-07-28',
      version: '1.15.0',
      changes: [
        'Closes #18 — ntfy now also pushes when a plot does NOT finish, which is the case where a phone alert actually matters. Three signals fire it: jobComplete with data.failed (abort or stream failure), the connection dropping while the job is running or held (machine disconnected mid-plot), and the controller entering ALARM while running. The last two hang off the periodic status tick that drives cdUpdateConnection, which keeps reporting after a port drops. Failure pushes use the rotating_light tag and Priority: high so they read differently from the success message; cdSendNtfy gained an optional opts argument for tags/priority and existing callers are unchanged. A single failure emits several signals in sequence, so pushes are collapsed to one per 20 s window.',
        'Add a "Notify on failure / disconnect" toggle in Settings › NOTIFICATIONS, stored as ntfyFailEnabled and defaulting to ON — so it is live as soon as notifications are enabled at all.',
        'Default ntfy topic is now the fixed "targz-plot-ended" instead of a per-install random string, so the topic to subscribe to is the same on every machine. Only affects fresh installs: an existing randomly-generated topic in localStorage is left alone. Note the public ntfy.sh treats the topic as the only access control, so this default is memorable rather than secret.'
      ]
    },
    {
      date: '2026-07-28',
      version: '1.14.0',
      changes: [
        'Closes #6 — EDIT START is now EDIT GCODE: the scrub panel gained an END marker alongside START, so a plot can be trimmed at both ends instead of only restarted from a point. START / END are tabs — clicking one hands the slider and the ± step buttons over to it — and each carries a typeable line-number field (Enter or blur commits, Escape reverts). Lines with no toolpath point (comments, M-codes) snap to the nearest motion line; the markers cannot cross. startFromHere(start, end) truncates the generated file at END and appends G90 + G0 Z<penUpZ>, because cutting the file short drops whatever footer it had and would otherwise leave the pen down on the paper.',
        'The 3D toolpath now ghosts everything outside the START→END range, keeping only the part that will actually be plotted saturated. Previously dimToolpathBefore ghosted the segment after the cursor despite its name — the colour buffer runs in linePoints order (convertParsedDataToObject), so the original direction was inverted.'
      ]
    },
    {
      date: '2026-07-05',
      version: '1.13.0',
      changes: [
        'Fix TRAVEL always empty: the gcode parser worker computed the cumulative distance (distSum) but never included it in the exported linePoints for straight moves (only arc points had it) — and a pen plot is 100% straight moves. distSum is now exported for straight segments too, so the JOB panel shows real plotted distance. Requires re-loading the gcode file (the value is baked in at parse time).',
        'Parking: add a configurable Travel Z (lift height used while moving to the park position) in Settings › PARKING, stored as parkTravelZ. Defaults to the pen-up height, which was previously hardcoded as the lift height.'
      ]
    },
    {
      date: '2026-07-04',
      version: '1.12.1',
      changes: [
        'Fix REMAINING stuck at 00h:00m mid-job: it was computed as (parser time estimate − elapsed), and the parser estimate ignores acceleration so it badly undershoots on segment-heavy hatch jobs. Now extrapolated from real line throughput (elapsed × lines-left / lines-done) once 100+ lines are in, in both the queueCount handler and the 1 Hz ticker; parser estimate kept only as an early-job fallback.',
        'Fix TRAVEL stuck at 0mm: it was never fed (hardcoded undefined). Now reads the cumulative plotted distance (distSum) of the current toolpath point via gcodeLineToPointIndex. Displays in metres above 1000 mm.'
      ]
    },
    {
      date: '2026-07-04',
      version: '1.12.0',
      changes: [
        'Add phone notifications when a plot finishes, via ntfy (no account, no API keys). New Settings › NOTIFICATIONS section: enable toggle, topic (auto-generated random secret on first open), server URL (defaults to public https://ntfy.sh, swappable for a self-hosted instance), and a SEND TEST button. On clean job completion the jobComplete handler POSTs a "Plot finished — <file> in <time>" message to the topic; the user just installs the free ntfy app and subscribes to the topic. Persisted in localStorage (ntfyEnabled / ntfyTopic / ntfyServer). Skipped on abort/fail.'
      ]
    },
    {
      date: '2026-07-04',
      version: '1.11.0',
      changes: [
        'Add PARK AT END: optionally move the head to a fixed position when a job finishes. Toggle on the RUN panel (mirrored in Settings › PARKING), park X/Y/Z configurable in Settings (defaults X:0 Y:0, Z:pen-down height). On completion it lifts to the pen-up height, rapids to the park X/Y, then lowers to the park Z — so the pen never drags across the work. Emitted from the jobComplete handler; skipped on abort/fail. Persisted in localStorage (parkEnabled / parkX / parkY / parkZ).'
      ]
    },
    {
      date: '2026-06-28',
      version: '1.10.0',
      changes: [
        'Add a work-zero (G54 origin) marker to the 3D viewer: a red map-pin standing at scene 0,0,0 with a "0" label. The toolpath is drawn in work coordinates, so this pin marks the point the job runs from — making a misplaced origin obvious before launching a plot (the cause of out-of-bounds ALARM:2 on the first rapid). Drawn in redrawGrid so it scales with the bed and is rebuilt on every grid redraw.'
      ]
    },
    {
      date: '2026-05-08',
      version: '1.9.0',
      changes: [
        'Closes TarGz/TargzPenPlotterCtrl#13 — Settings → GRBL Parameters: add ↑ IMPORT button next to ↓ EXPORT. Reads .txt/.nc/.gcode backup files (same format produced by EXPORT, $N=val with optional trailing ; comment), parses $-keys via importParamsFromText, and populates paramDirty so rows go yellow for review. User clicks APPLY TO CONTROLLER to push. $I= machine-name lines and non-$N keys are skipped. Counter messages distinguish: nothing parsed, all-already-match-controller, and lines-skipped cases.',
        'Fix TarGz/TargzPenPlotterCtrl#16 — Settings APPLY now joins all dirty $N=val rows into a single newline-joined sendGcode call instead of one socket.emit per key (the rapid back-to-back emits were dropping all but the first command). Added APPLY button feedback: APPLYING… while in flight, then ✓ APPLIED N flash for 1.5 s before restoring the original label.',
        'Closes TarGz/TargzPenPlotterCtrl#15 — macOS application menu: replace placeholder "Application" entry with the standard pattern. First menu uses electronApp.name as label and exposes About <App> (role: about), separator, Hide / Hide Others / Show All, separator, Quit. electronApp.setAboutPanelOptions populates the native About panel with applicationName, applicationVersion, version (with -targz suffix), copyright, and the app icon.',
        'Closes TarGz/TargzPenPlotterCtrl#14 — build-mac script now passes --config.productName="TargzPenPlotterCtrl-$npm_package_version" so each build produces a versioned .app bundle (e.g. TargzPenPlotterCtrl-1.9.0.app), allowing multiple versions to coexist in /Applications. Each versioned bundle is a distinct app to macOS with its own userData path; settings from previous unversioned installs do not auto-migrate.'
      ]
    },
    {
      date: '2026-05-03',
      version: '1.8.4',
      changes: [
        'Closes TarGz/TargzPenPlotterCtrl#12 — Remove PEN HEIGHTS settings sub-page; replace with click-to-edit Z value spans inline on PEN UP / PEN DOWN / PUMP buttons in the jog panel. Click a value, type a new number, blur or Enter to save to localStorage, Escape to cancel. cd-zpen-editable / cd-zpen-input CSS added; buildPenHeightsSection + bindPenHeights + helpers removed from settings.js.'
      ]
    },
    {
      date: '2026-05-03',
      version: '1.8.3',
      changes: [
        'Closes TarGz/TargzPenPlotterCtrl#10 — Override sliders (JOG/FEED/TOOL): add −/+ nudge buttons (±1%) flanking the value display, and click-to-edit on the % label (click → inline number input → Enter applies, Escape cancels). cdNudgeOverride helper added to commanddeck.js.'
      ]
    },
    {
      date: '2026-05-03',
      version: '1.8.2',
      changes: [
        'Closes #11 — Add PUMP Z-height preset: button in jog panel (syringe SVG icon, amber colour) + PUMP row in PEN HEIGHTS settings (slider, nudge, TEST, amber SVG marker on Z-axis diagram). localStorage key penPumpZ, default −2. Pen button icons replaced with inline SVGs (pen-up lifts, pen-down presses onto paper line). cdReadPenHeights / cdRefreshPenHints / cdUpdateConnection all extended for pump.'
      ]
    },
    {
      date: '2026-05-03',
      version: '1.8.1',
      changes: [
        'Fix #8 — Rename Z jog buttons UP/DOWN → Z+/Z− and move them into the XY jog grid as a 4th column. PEN UP / PEN DOWN remain as their own macro row above the pad. No JS changes: .zP / .zM class handlers in jog.js are untouched.'
      ]
    },
    {
      date: '2026-04-22',
      version: '1.8.0',
      changes: [
        'Port selector now includes a "Virtual Ports" section for PTY devices: index.js findVirtualPorts() scans /tmp for symlinks pointing at /dev/ttys* or /dev/pty* and adds them to status.comms.interfaces.virtualPorts; populatePortsMenu() renders them as a third optgroup alongside USB and Network ports. Selected virtual ports flow through the existing serial connect/read/write path with no special-casing, so connecting to a fake GRBL simulator (e.g. python3 fake_grbl.py --link /tmp/fakegrbl) works exactly like a real device.',
        'Removed the in-renderer "Dev Machine" simulator (DEV_PORT_VALUE / DEV_PORT_DEMO entries, buildFakeStatus tick loop, socket.emit / runJobFile / sendGcode intercepts) now that the real fake-GRBL PTY simulator is wired up. _lastAlarmShown / _alarmShowTimer, which happened to live inside the DEV block but belong to the alarm-banner debounce in cdUpdateConnection, are kept as standalone declarations.',
        'commanddeck.js cdSyncPortOptions no longer mirrors #portUSB via the DOM — Metro4 select.data() only updates its widget state, not the native select children, so that mirror always read the "Waiting for USB" placeholder. populatePortsMenu now writes the same response HTML directly to #cdPortSelect via element.innerHTML (jQuery .html() silently strips <optgroup> via its detached-div parser), and cdSyncPortOptions shrinks to a label/disabled-state refresh.'
      ]
    },
    {
      date: '2026-04-21',
      version: '1.7.0',
      changes: [
        'Axis readouts now show a small "MPos: <value>" line under each big WCS number, so the machine-coordinate position is visible at a glance. Highlights in accent colour when MPos differs from the displayed WCS value — i.e. whenever a G54 offset is active — to help avoid crashes caused by stale stored offsets.'
      ]
    },
    {
      date: '2026-04-21',
      version: '1.6.3',
      changes: [
        'FEED slider widened from 10-200% to 1-500% for visual parity with the JOG slider. Grbl itself still clamps feed override at 10-200% (bytes 0x91-0x94 cannot push it past that band) — beyond those limits the slider is effectively cosmetic for G1, but the coupled rapid override introduced in 1.6.0 keeps responding: below 38% the slider still drops G0 travel to 25%, and above 75% it releases to 100%. Net effect for the user: the slider range matches JOG visually and the extra low-end headroom just stays on rapid=25% all the way down.'
      ]
    },
    {
      date: '2026-04-21',
      version: '1.6.2',
      changes: [
        'Strip the srvLog debug bridge added in 1.6.1 now that rapidOverride is hardware-verified — grbl 1.1g reports back feedOverride=10 / rapidOverride=25 after dragging FEED low during a plot, confirming the bytes land. First-read races before the next 250ms status tick were a diagnostic artefact, not a bug.'
      ]
    },
    {
      date: '2026-04-21',
      version: '1.6.1',
      changes: [
        'Debug aid (temporary): rapidOverride backend handler now echoes each step back to the renderer via a new srvLog socket event, so debug output is visible in DevTools console instead of only the Node terminal. Will be stripped once the rapid-override hardware issue is diagnosed.'
      ]
    },
    {
      date: '2026-04-21',
      version: '1.6.0',
      changes: [
        'FEED slider now also drives grbl rapid override during a plotting job. On a pen plotter, pen-up XY travel is G0 rapid, which the feed-override bytes (0x91-0x94) do not touch — so the FEED slider previously did nothing for most of the visible motion. websocket.js feedOverride() now co-emits rapidOverride alongside feedOverride. New index.js handler maps the slider value to grbl\'s three discrete rapid levels: ≥75% → 0x95 (100%), ≥38% → 0x96 (50%), <38% → 0x97 (25%). Caches current rapidOverride to avoid redundant bytes. Dragging FEED down now slows G1 strokes and G0 travel together; dragging it up releases both.'
      ]
    },
    {
      date: '2026-04-21',
      version: '1.5.17',
      changes: [
        'Fix #2 — JOG override: fire jogOverride on oninput (not onchange-only), matching legacy Metro4 #jro behaviour. v1.5.10 had moved all three CD sliders to onchange to stop FEED/TOOL flooding grbl, but JOG is purely client-side (updates jogRateX/Y/Z/A, no socket emit) so the flood rationale never applied — and the onchange event on the vertical HTML5 range fired inconsistently, making the slider feel dead. Root cause of the "does nothing" perception, once oninput was in place, turned out to be the 1 mm default jog step: F=300 vs F=3000 over 1 mm both complete in a blink. Works clearly at 10 mm / 100 mm step. Hardware-verified at 1 % vs 100 %. FEED and TOOL intentionally left on onchange (their emit path still needs the debounce).',
        'Closes #3 — JOG slider widened from 1-300% to 1-500%. Below 100% the scaling is honoured exactly (fine slow-jog control). Above 100% grbl still clamps commanded F to $110/$111; the wider range removes the UI ceiling so there is headroom once $110 is raised in Settings.'
      ]
    },
    {
      date: '2026-04-21',
      version: '1.5.15',
      changes: [
        'App icon: jogWindow and gpuInfoWindow BrowserWindow icons pointed to /app/favicon.png which does not exist, so nativeImage returned an empty image and Electron fell back to its default logo in the taskbar/window frame. Repointed both to the existing /app/icon.png (same source the tray already uses). Also fixed the Linux electron-builder icon path from "build/" (bare directory containing .icns/.ico) to "build/icons/" (directory of sized PNGs electron-builder expects).'
      ]
    },
    {
      date: '2026-04-21',
      version: '1.5.14',
      changes: [
        'Fix #7 — Alarm banner relocated to the top of the right column (#cd-right) as an inline panel, so toggling it only shifts the scrollable JOB info below it; the jog panel, position strip, topbar and console are unaffected. cdUpdateConnection also debounces the ON transition by 700ms so transient alarm ticks during the GRBL handshake (status oscillating 5↔2 during initial connect) do not flash the banner; OFF transitions still hide immediately.'
      ]
    },
    {
      date: '2026-04-20',
      version: '1.5.12',
      changes: [
        'Port selector (follow-up to 1.5.11): delegated the open/close click off document so it stays wired regardless of element timing, and moved the hit target from the inner <button> to the whole #cdPortCustom wrap — Electron on macOS had pointer-event quirks on the nested button that plain Chrome did not, so clicks registered in the browser but no-op in the app.'
      ]
    },
    {
      date: '2026-04-20',
      version: '1.5.11',
      changes: [
        'Port selector: replaced the native <select> with a custom button + popover menu. Fixes two issues: (1) on macOS Electron the native dropdown rendered as an OS-level popup that floated outside the app window; (2) the 2s refresh was rebuilding the <select> unconditionally, making the open menu blink/close. The new menu is an in-DOM element so it stays clipped to the window, and the sync is now diff-based (skips rebuilds when the option list is unchanged) and completely suspended while the menu is open.'
      ]
    },
    {
      date: '2026-04-19',
      version: '1.5.10',
      changes: [
        'Fix #1 — jog step default mismatch: commanddeck.js now triggers the active cd-step-btn on load so jogdistXYZ (jog.js default 10) resyncs to the UI-highlighted step (markup default: 1). Inch map and legacy-dist ID map gained the missing 100mm entry.',
        'Fix #2 — override sliders were no-ops in common cases. Oninput fired the override on every pixel drag, flooding grbl with +1%/-1% real-time commands and out-racing curFRO, often netting zero effect. Split to oninput (value label only) + onchange (release-only emit). jogOverride no longer short-circuits when grblParams lacks $110 — it falls back to 4000/4000/2000/2000 so the slider works disconnected or pre-$$.',
        'Fix #3 (closes) — JOG override slider range widened from 1-200% to 1-300% so there is more visual headroom above nominal feed. Grbl still caps real motion at $110/$111/$112.',
        'Fix #4 — UI version plumbing. /api/version now also returns appVersion + changelog. commanddeck.js fetches the top-bar badge via /api/version (require(../../version.js) does not resolve in the renderer when the page is served over HTTP). settings.js PC_APP_VERSION and the About-panel changelog both come from the same endpoint. Stale hardcoded v1.5.2 and v1.5.6 fallbacks removed.'
      ]
    },
    {
      date: '2026-04-19',
      version: '1.5.9',
      changes: [
        '3D viewport surround unified to #FFFAF4 (matches --cd-bg). Three places had to agree: WebGLRenderer clear-color, the skydome top/bottom shader colors, and the Electron BrowserWindow native background.',
        'WebGLRenderer switched to alpha:false so the clear-color fills opaquely (was compositing inconsistently between Electron 23 and vanilla Chrome, producing different surround tints on different machines)',
        'Skydome SKY_TOP_COLOR / SKY_BOTTOM_COLOR changed from blue/white gradient to flat #FFFAF4 — the 9900-radius sphere was masking the clear-color from every camera angle, which is why top-down views always read as white regardless of clear-color',
        'Work-area contour darkened to #B8A888 and raised from z=-0.4 to z=+0.02 so it sits above the plane + grid and is readable against both cream and white',
        '3D work area now auto-sizes to the controller-reported machine envelope: grblSettings() calls redrawGrid(0, $130, 0, $131) whenever the controller reports its settings, replacing the hard-coded 307×207 default. Unit-aware (mm→in). Post-$$-refresh means CD-settings edits update the viewer without a reconnect.'
      ]
    },
    {
      date: '2026-04-19',
      version: '1.5.8',
      changes: [
        'Titlebar emptied — version, loaded-file name and "connected to /dev/tty…" suffix removed. The CD top bar already carries the version badge, file chip and port chip, so the titlebar was pure redundancy.',
        'Alarm banner moved above the CD top bar instead of below it, so a halt alert is the very first thing you see',
        'build-mac script now `rm -rf dist &&` before electron-builder runs, preventing stale older-version artifacts from lingering in dist/ and being mistakenly opened after a version bump'
      ]
    },
    {
      date: '2026-04-19',
      version: '1.5.7',
      changes: [
        'Settings → Parameters: single unified $-key list (BASIC + ADVANCED tabs merged, numerically sorted by $-number). Search still works across the whole set.',
        'Settings → Calibration: X/Y/Z step-calibration cards now dispatch to the legacy xstepscalibrate / ystepscalibrate / zstepscalibrate wizards via bindCalibration()',
        'Pen heights moved out of the Calibration card list into their own dedicated sub-page; Calibration header hint rewritten accordingly',
        'Pen heights page: header simplified (hero + back button removed in favour of always-visible section), SVG "WORK 0" marker relabeled to "HOME" to match how users think about the Z reference'
      ]
    },
    {
      date: '2026-04-18',
      version: '1.5.6',
      changes: [
        'Edit mode: 3D camera now follows the scrub cursor (cdScrubFollow) so the user can zoom via mouse wheel and nudge ±1/±10/±100 to pen-position precisely',
        'Camera resets to full view (resetView) when the scrubber closes',
        'Zoom slider + buttons removed — mouse-wheel OrbitControls zoom is enough'
      ]
    },
    {
      date: '2026-04-18',
      version: '1.5.5',
      changes: [
        'Titlebar slimmed: 42px → 26px, logo removed, window control buttons shrunk to 26×26, title text dropped to 11px/0.7 opacity',
        'CD layout height offset updated to calc(100vh - 26px) to match the new titlebar',
        'Version badge added to the Command Deck top bar next to PENPLOTTER · CONTROL, auto-synced from version.js via require() at page ready',
        'Scrub-to-restart-point card: each info row pinned to its own block with fixed line-height (pill / coords / gcode) so digit-count changes no longer shift the card vertically; coords use tabular-nums; empty gcode row still reserves its height'
      ]
    },
    {
      date: '2026-04-18',
      version: '1.5.4',
      changes: [
        'Command Deck canvas zone rework — V2 tab strip + framed work area',
        'Tabs renamed and restyled: 3D VIEW / CONSOLE / MACROS / G-CODE (uppercase mono, flat, orange underline on active). Legacy Metro4 ribbon icons hidden',
        'New canvas status overlay in top-right of the tab strip: GRID / VIEW / state chip (PREVIEW · LIVE · HOLD), wired to cdUpdateRunControls',
        'Three.js scene now draws the work area as a white plane + thin beige contour inside the cream-backgrounded viewport, so the white only shows where the plot lives',
        'Jog Control panel regroup: PEN UP / Z+ / Z− / PEN DOWN in a 2×2 strip above the XY jog grid; all buttons share a consistent portrait footprint',
        'Jog panel compaction pass: tighter paddings, step row now 0.1 / 1 / 10 / 100 (dropped 0.01), Z/pen buttons slimmed to 40px rows',
        'fixRenderSize() uses clientWidth/Height and Three.js setSize(..., true) so the canvas tracks the padded container without overflow'
      ]
    },
    {
      date: '2026-04-18',
      version: '1.5.3',
      changes: [
        'Command Deck fix batch after v1.5.2 shakedown',
        'Progress fields: add 1 Hz ticker so ELAPSED / REMAINING / %-bar update continuously while running (queueCount alone left them frozen on long moves)',
        'Overrides: JOG slider now emits jogOverride over socket; value labels (JOG/FEED/TOOL %) update live on drag; RESET buttons snap slider back to 100',
        'Serial console: strip the outer Metro4 .input wrapper border/background so only the input has a hairline',
        'Alarm UX: suppress the blocking Grbl Alarm / Grbl Error modal popins — the #cd-alarm-banner header warning remains the single source of truth',
        'Settings: drop the Job Log section (no backend); wire Firmware tool to openFlashingTool()',
        'Settings > Calibration: dedicated PEN UP / PEN DOWN page with Z-axis visual, sliders, ±0.1/±1 nudge buttons, TEST UP/DOWN, DEFAULTS, SAVE — opened from a "SET DEFAULT PEN HEIGHTS" card alongside the axis wizards',
        'Machine Control: replace the TOOL spindle button with dedicated PEN UP / PEN DOWN buttons that command Z to the saved heights (defaults Z5 / Z0)',
        'Keyboard: re-point jog shortcuts from legacy #xM/#xP/#yM/#yP/#zM/#zP IDs to the Command Deck #cdXM/#cdXP/... buttons so arrow-key jogging works again'
      ]
    },
    {
      date: '2026-04-18',
      version: '1.5.2',
      changes: [
        'Settings page: rework legacy troubleshootingPanel into a V2-design SETTINGS view rendered inside Command Deck',
        'New left sub-nav with 7 sections (GRBL Parameters, Calibration, Tools & Wizards, Keyboard, Diagnostics, Job Log, About) mirroring the V2 mockup',
        'Diagnostics: 3D viewer / serial / DRO toggles wired to existing localStorage flags; new showGpuInfo flag gates Computer card',
        'GRBL Parameters panel: Basic/Advanced tabs, search, dirty-row highlighting, APPLY sends $key=value lines via sendGcode and re-requests $$',
        'Tools panel wires Mobile Jog and USB Flashdrive to existing pages; Surfacing/Firmware fall back gracefully when handlers are absent',
        'About panel reads VERSION + CHANGELOG when version.js is reachable via require, with kv fallback otherwise',
        'Calibration / Keyboard rebind / Job Log entries scaffolded per the mockup with disabled actions until backends land',
        'New app/css/settings.css and app/js/settings.js; SETTINGS / MACHINE CONTROL tabs in Command Deck topbar now swap views in place'
      ]
    },
    {
      date: '2026-04-17',
      version: '1.5.1',
      changes: [
        'Tabs B.1: convert main tabs + sub-tabs from filled/outlined pills to minimal underline style (uppercase 11px letter-spaced label, 2px orange underline when active)',
        'Remove ribbon content-holder card (transparent, no border), tabs-holder gets bottom hairline instead',
        'Removed filled-tab artifacts (backgrounds, border overlaps, box-shadows) — approaching the mockup "control panel" look'
      ]
    },
    {
      date: '2026-04-17',
      version: '1.5.0',
      changes: [
        'UI polish pass: pro-grade hierarchy & consistency without changing the color DNA',
        'Extend pc-tokens.css with spacing scale (4/6/8/12/16/20/24/32), type scale (11/12/13/14/16/20), font-weight + tracking + leading tokens, control heights (24/32/40), z-index scale, focus-ring token',
        'Introduce three-tier border system (--pc-border-hairline / -default / -strong); legacy border tokens kept as aliases',
        'Add pc-utilities.css utility layer: .pc-glass, .pc-card, dividers, typography helpers (.pc-label, .pc-caption, .pc-body, .pc-display, .pc-mono), .pc-titlebar, .pc-sidebar-wide, .is-hidden',
        'Apply 4-tier typography rhythm (label 10px / caption 11px / body 13px / display 16px) across ribbon group labels, ribbon-button captions, badges, tallies, card headers',
        'Fix active-tab icon color bug — was overridden to white on orange background, now correctly uses --pc-primary',
        'Add body.pc-app scope + Phase 6 section in pc-theme.css: unified focus ring, control-height rhythm (buttons/inputs 32px), orange underline-style tabs, tighter letter-spacing on chrome',
        'Progress bar bumped to 3px with pill radius; status bar gets backdrop-blur for chrome-consistency with header/scrubber',
        'Swap hardcoded colors in buttons.css, main.css, restart-from-point.css for design tokens (--pc-border-default, --pc-primary, --pc-surface, etc.); scrubber primary button now uses orange instead of black',
        'Strip inline titlebar sizing/padding to .pc-titlebar utility class; add class="pc-app" on <body>'
      ]
    },
    {
      date: '2026-04-17',
      version: '1.4.9',
      changes: [
        'Revert tab-action experiment; restore 3D-view floating nav-bar at bottom of #tab-three'
      ]
    },
    {
      date: '2026-04-17',
      version: '1.4.8',
      changes: [
        'Fold 3D-view tools into the sub-tabs strip as <li class="tab-action"> entries (Simulate / Stop / Reset View / Restart from point)',
        'Action items push right via margin-left:auto on the first one; accent class highlights Restart from point in orange',
        'Removes the floating nav-bar entirely — zero bottom chrome, full canvas'
      ]
    },
    {
      date: '2026-04-17',
      version: '1.4.7',
      changes: [
        'Move 3D-view tools (Simulate / Stop / Reset View / Restart from point) inline with the sub-tabs row as a compact pill',
        'Sub-tabs become fully rounded pills (pill radius, active = white with shadow)'
      ]
    },
    {
      date: '2026-04-17',
      version: '1.4.6',
      changes: [
        'Relocate status pills (timer, Port, Controller, Job Queue) into the title bar — reclaims the entire 40px bottom strip for content',
        'Move progress bar to a 2px line just under the title bar (visible only during active jobs)',
        'Lower floating nav-bars to bottom:20px; grow 3D canvas by another ~40px'
      ]
    },
    {
      date: '2026-04-17',
      version: '1.4.5',
      changes: [
        'Tighten UI chrome: smaller DROs (34px, 15px/16px), 60×60 jog direction buttons, trimmed ribbon padding',
        'Cap vertical jog/feed/tool slider tracks to 120px, tighter slider cells',
        'Reduce initial height reservation for #renderArea, #editor, #console, #macros so 3D canvas gains ~95px',
        'Nudge scrubber bottom offset to 110px'
      ]
    },
    {
      date: '2026-04-17',
      version: '1.4.4',
      changes: [
        'Restyle console (#console) and command form: glass card, monospace paragraphs with pill hover',
        'Restyle Ace editors (#editor, #fluidnceditor): glass frame, soft gutter',
        'Convert editor and console fixed-bottom toolbars into centered glass nav-bar pills',
        'Restyle macros: glass cards (.command-button-macro) with orange hover border',
        'Restyle troubleshooting machine-profile picker (image-checkbox) as selectable glass cards with orange check',
        'Restyle probe wizard SVG to use PC primary color; step-list numbers orange',
        'Minor: remap .fg-openbuilds/.bd-openbuilds to neutral PC tokens'
      ]
    },
    {
      date: '2026-04-17',
      version: '1.4.3',
      changes: [
        'Restyle DRO displays: glass cards with tabular-nums value, axis-colored text, orange hover/focus',
        'Restyle DRO edit input (.droInput) with orange ring',
        'Restyle jog direction buttons (.button.light.square.xlarge.jogbtn): glass 72×72, orange hover border, axis-colored FA layers',
        'Restyle setzero/gotozero/WCS pill buttons and step-distance segmented buttons',
        'Restyle vertical jog/feed/tool sliders with orange accent, pill reset buttons, dark tally value badge'
      ]
    },
    {
      date: '2026-04-17',
      version: '1.4.2',
      changes: [
        'Restyle primitives: .button variants (dark/light/outline/primary/success/alert/secondary/mini/small) with PC tokens; jog & ribbon buttons preserved via :not() guards',
        'Restyle inputs, selects, textareas: glass surface, subtle border, orange focus ring',
        'Restyle badges (.badge, .badge.bg-*) and .tally pin-status indicators as pills',
        'Restyle .table/.table.striped with tiny uppercase headers and hairline rows',
        'Restyle .card, Metro.dialog.create output and Metro.toast.create output as glass cards with colored accent'
      ]
    },
    {
      date: '2026-04-17',
      version: '1.4.1',
      changes: [
        'Restyle ribbon menu: tabbed top strip (Machine Control / Grbl / FluidNC / Troubleshooting), glass content panel, hairline group separators, tiny uppercase group labels',
        'Restyle ribbon buttons (.ribbon-button, .ribbon-icon-button): transparent with hover, orange caret, Inter typography',
        'Restyle ribbon dropdowns and .d-menu context menus: glass panels with pill-hover rows',
        'Sub-tabs (3D View / Log / Macros / GCODE Editor) inherit the new tab styling'
      ]
    },
    {
      date: '2026-04-17',
      version: '1.4.0',
      changes: [
        'Introduce Portrait-Cubes design tokens at :root (pc-tokens.css) — orange accent, glass surfaces, Inter, radii, shadows',
        'Add pc-theme.css skin layer — restyle body background (warm gradient), window title bar (frosted glass) and bottom status bar (pill badges)',
        'Drop dark mode: remove theme toggle button, dynamic dark.css load; simplify theme.js to light-only lookup (3D viewer colors preserved)'
      ]
    },
    {
      date: '2026-04-17',
      version: '1.3.1',
      changes: [
        'Replace app icon with new Targz Pen Plotter Ctrl logo (mac .icns, win .ico, linux .png, favicon)'
      ]
    },
    {
      date: '2026-04-17',
      version: '1.3.0',
      changes: [
        'Restyle restart-from-point scrubber, editor banner and 3D-view floating toolbar with Portrait-Cubes design language',
        'Fix toolpath ghosting before scrub head so already-drawn lines blend toward the viewer background instead of darkening'
      ]
    },
    {
      date: '2026-04-15',
      version: '1.2.1',
      changes: [
        'Update app logo',
        'Simplify README with build & install instructions',
        'Build arm64 only'
      ]
    },
    {
      date: '2026-04-15',
      version: '1.2.0',
      changes: [
        'Rebrand to Targz Pen Plotter Ctrl',
        'Add local macOS build script (build-mac)',
        'Add version.js with changelog'
      ]
    },
    {
      date: '2025-01-01',
      version: '1.1.0',
      changes: [
        'Add visual restart-from-point feature with 3D scrubber'
      ]
    }
  ]
};
