// Stroke Select — pick the parts of a plot to redraw when the missing pieces
// are NOT contiguous (pen ran dry in patches, sheet shifted, a few shapes got
// skipped). The START / END range in the scrub panel can only express one
// interval; this expresses an arbitrary set.
//
// The unit is a STROKE — one pen-down run — not a G-code line range. That is
// how every comparable tool works (LightBurn selects shapes, vpype selects
// lines), and it turns a 12k-line file into a few hundred selectable things.
//
// Hit-testing is done in 2D on the Z plane against a uniform grid of stroke
// bounding boxes. Raycasting the toolpath Line directly is O(vertices) per
// mousemove and stutters badly while brushing over a big plot.

var strokeEditActive = false;
var strokeTool = 'pick';
var strokes = [];
var strokeSelection = {};
var strokeSelectionCount = 0;
var strokeUndoStack = [];
var strokeGrid = null;
var strokeGridCell = 1;
var strokeScale = 1;
var strokeBrushMm = 8;
var strokeDragging = false;
var strokeBoxStart = null;
var strokeBoxScreen = null;
var strokeLastMove = null;
var strokePaintMode = 'add';
var strokeHover = -1;

// Whether the current gesture selects or deselects. Alt inverts the mode for a
// single stroke of work, the way it does in every raster editor.
function strokePaintOn(ev) {
  var add = (strokePaintMode === 'add');
  return ev && ev.altKey ? !add : add;
}

// ── Segmentation ───────────────────────────────────────────────────────────

// Pen-down detection: g >= 1 is a feed/arc move, but a file that lifts the pen
// with G1 instead of G0 would merge every stroke into one. So also require the
// point to sit in the lower half of the file's Z travel. Files with no Z
// variation fall back to the g test alone.
function strokeBuild() {
  strokes = [];
  strokeSelection = {};
  strokeSelectionCount = 0;
  strokeUndoStack = [];

  if (typeof object === 'undefined' || !object || !object.userData || !object.userData.linePoints) return;

  var lp = object.userData.linePoints;
  strokeScale = object.userData.inch ? 25.4 : 1;

  // Work per SEGMENT (i-1 → i), not per point. A segment is drawn ink when the
  // move is a feed/arc AND it actually goes somewhere in XY.
  //
  // Deliberately no Z heuristic: pen-up/down conventions vary too much between
  // post-processors (Z-up positive, Z-up negative, servo M-codes, no Z at all)
  // and guessing wrong silently selects the wrong half of the file. The XY test
  // is what makes it robust — a pen lift is a Z-only move, so it has zero XY
  // length and drops out on its own.
  var EPS = 1e-4;
  var cur = null;
  var drawnSegs = 0;

  for (var i = 1; i < lp.length; i++) {
    var p = lp[i], p0 = lp[i - 1];
    var x = p.x * strokeScale, y = p.y * strokeScale;
    var x0 = p0.x * strokeScale, y0 = p0.y * strokeScale;
    var d = Math.hypot(x - x0, y - y0);
    var drawn = (p.g >= 1) && d > EPS;

    if (drawn) {
      drawnSegs++;
      if (!cur) {
        cur = {
          a: i - 1, b: i,
          lineA: (p.indx !== undefined) ? p.indx : -1,
          lineB: (p.indx !== undefined) ? p.indx : -1,
          minX: Math.min(x0, x), maxX: Math.max(x0, x),
          minY: Math.min(y0, y), maxY: Math.max(y0, y),
          len: d
        };
      } else {
        cur.b = i;
        if (p.indx !== undefined) cur.lineB = p.indx;
        if (x < cur.minX) cur.minX = x;
        if (x > cur.maxX) cur.maxX = x;
        if (y < cur.minY) cur.minY = y;
        if (y > cur.maxY) cur.maxY = y;
        cur.len += d;
      }
    } else if (cur) {
      strokes.push(cur);
      cur = null;
    }
  }
  if (cur) strokes.push(cur);

  console.log('[strokes] points:', lp.length, 'drawn segments:', drawnSegs,
    'strokes:', strokes.length,
    'total length mm:', strokes.reduce(function (a, s) { return a + s.len; }, 0).toFixed(1));

  strokeBuildGrid();
}

// Uniform grid over the drawing extents; each cell lists the strokes whose
// bounding box overlaps it.
function strokeBuildGrid() {
  strokeGrid = {};
  if (!strokes.length) return;

  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  strokes.forEach(function (s) {
    if (s.minX < minX) minX = s.minX;
    if (s.minY < minY) minY = s.minY;
    if (s.maxX > maxX) maxX = s.maxX;
    if (s.maxY > maxY) maxY = s.maxY;
  });

  strokeGridCell = Math.max(1, Math.max(maxX - minX, maxY - minY) / 64);
  strokeGrid = { minX: minX, minY: minY, cells: {} };

  strokes.forEach(function (s, idx) {
    var c0 = Math.floor((s.minX - minX) / strokeGridCell);
    var c1 = Math.floor((s.maxX - minX) / strokeGridCell);
    var r0 = Math.floor((s.minY - minY) / strokeGridCell);
    var r1 = Math.floor((s.maxY - minY) / strokeGridCell);
    for (var c = c0; c <= c1; c++) {
      for (var r = r0; r <= r1; r++) {
        var k = c + ':' + r;
        (strokeGrid.cells[k] || (strokeGrid.cells[k] = [])).push(idx);
      }
    }
  });
}

// Candidate strokes whose bounding box is within `pad` of the query box.
function strokeCandidates(minX, minY, maxX, maxY, pad) {
  if (!strokeGrid) return [];
  var out = {}, list = [];
  var c0 = Math.floor((minX - pad - strokeGrid.minX) / strokeGridCell);
  var c1 = Math.floor((maxX + pad - strokeGrid.minX) / strokeGridCell);
  var r0 = Math.floor((minY - pad - strokeGrid.minY) / strokeGridCell);
  var r1 = Math.floor((maxY + pad - strokeGrid.minY) / strokeGridCell);
  for (var c = c0; c <= c1; c++) {
    for (var r = r0; r <= r1; r++) {
      var cell = strokeGrid.cells[c + ':' + r];
      if (!cell) continue;
      for (var i = 0; i < cell.length; i++) {
        if (!out[cell[i]]) { out[cell[i]] = 1; list.push(cell[i]); }
      }
    }
  }
  return list;
}

function strokePointSegDist(px, py, ax, ay, bx, by) {
  var dx = bx - ax, dy = by - ay;
  var l2 = dx * dx + dy * dy;
  var t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Distance from a point to a stroke's polyline, bailing out as soon as it is
// inside `limit` — brushing calls this thousands of times.
function strokeDistTo(idx, px, py, limit) {
  var s = strokes[idx];
  var lp = object.userData.linePoints;
  var best = Infinity;
  for (var i = s.a; i < s.b; i++) {
    var d = strokePointSegDist(px, py,
      lp[i].x * strokeScale, lp[i].y * strokeScale,
      lp[i + 1].x * strokeScale, lp[i + 1].y * strokeScale);
    if (d < best) best = d;
    if (best <= limit) return best;
  }
  return best;
}

// ── Selection ──────────────────────────────────────────────────────────────

function strokePushUndo() {
  var snap = {};
  for (var k in strokeSelection) snap[k] = 1;
  strokeUndoStack.push({ sel: snap, n: strokeSelectionCount });
  if (strokeUndoStack.length > 50) strokeUndoStack.shift();
}

function strokeUndo() {
  var prev = strokeUndoStack.pop();
  if (!prev) return;
  strokeSelection = prev.sel;
  strokeSelectionCount = prev.n;
  strokeApplyColors();
  strokeUpdateStats();
}

function strokeSet(idx, on) {
  if (on && !strokeSelection[idx]) { strokeSelection[idx] = 1; strokeSelectionCount++; }
  else if (!on && strokeSelection[idx]) { delete strokeSelection[idx]; strokeSelectionCount--; }
}

function strokeSelectAll(on) {
  strokePushUndo();
  strokeSelection = {};
  strokeSelectionCount = 0;
  if (on) for (var i = 0; i < strokes.length; i++) strokeSet(i, true);
  strokeApplyColors();
  strokeUpdateStats();
}

function strokeInvert() {
  strokePushUndo();
  for (var i = 0; i < strokes.length; i++) {
    if (strokeSelection[i]) { delete strokeSelection[i]; strokeSelectionCount--; }
    else { strokeSelection[i] = 1; strokeSelectionCount++; }
  }
  strokeApplyColors();
  strokeUpdateStats();
}

// ── Rendering ──────────────────────────────────────────────────────────────

// Hard two-tone while selecting: everything black, kept strokes pure red. The
// ghost-toward-background treatment used by the START / END range is too subtle
// to read when the selection is scattered across the sheet.
// Shares originalToolpathColors with restart-from-point.js — the two modes are
// mutually exclusive, and leaving either one calls restoreToolpathColors().
function strokeApplyColors() {
  if (!object || !object.geometry || !object.geometry.attributes.color) return;

  var colors = object.geometry.attributes.color;
  if (!originalToolpathColors) originalToolpathColors = new Float32Array(colors.array);

  var total = colors.array.length;
  for (var i = 0; i < total; i += 3) {
    colors.array[i] = 0;
    colors.array[i + 1] = 0;
    colors.array[i + 2] = 0;
  }

  for (var k in strokeSelection) {
    var s = strokes[k];
    if (!s) continue;
    var from = s.a * 3, to = Math.min((s.b + 1) * 3, total);
    for (var j = from; j < to; j += 3) {
      colors.array[j] = 1;
      colors.array[j + 1] = 0;
      colors.array[j + 2] = 0;
    }
  }

  colors.needsUpdate = true;
  if (strokeHover >= 0) strokePaintHover(strokeHover);
}

// Roll-over shows what the click would actually DO, which depends on the paint
// mode as well as the stroke's state. Green = it would come in, dark red = it is
// in (or would go out), grey = the click is a no-op. Without the grey case,
// hovering in Unselect mode over an unselected stroke lit up green and promised
// a selection that could never happen.
function strokePaintHover(idx) {
  if (strokeSelection[idx]) strokePaintOne(idx, 0.42, 0, 0);
  else if (strokePaintMode === 'add') strokePaintOne(idx, 0, 0.7, 0.15);
  else strokePaintOne(idx, 0.6, 0.6, 0.6);
}

// Recolour a single stroke without touching the rest of the buffer. Hover fires
// on every mousemove, and repainting all ~100k vertices each time would stutter.
function strokePaintOne(idx, r, g, b) {
  var s = strokes[idx];
  if (!s || !object || !object.geometry || !object.geometry.attributes.color) return;
  var colors = object.geometry.attributes.color;
  var to = Math.min((s.b + 1) * 3, colors.array.length);
  for (var j = s.a * 3; j < to; j += 3) {
    colors.array[j] = r;
    colors.array[j + 1] = g;
    colors.array[j + 2] = b;
  }
  colors.needsUpdate = true;
}

function strokeSetHover(idx) {
  if (idx === strokeHover) return;
  if (strokeHover >= 0 && strokes[strokeHover]) {
    var wasSel = !!strokeSelection[strokeHover];
    strokePaintOne(strokeHover, wasSel ? 1 : 0, 0, 0);
  }
  strokeHover = idx;
  if (strokeHover >= 0) strokePaintHover(strokeHover);
}

// Nearest stroke to a world point within tolerance, or -1.
function strokeNearest(world, tol) {
  var hits = strokeCandidates(world.x, world.y, world.x, world.y, tol);
  var best = -1, bestD = tol;
  for (var i = 0; i < hits.length; i++) {
    var d = strokeDistTo(hits[i], world.x, world.y, 0);
    if (d <= bestD) { bestD = d; best = hits[i]; }
  }
  return best;
}

function strokeUpdateStats() {
  var len = 0;
  for (var k in strokeSelection) if (strokes[k]) len += strokes[k].len;
  $('#cdStrokeCount').text(strokeSelectionCount.toLocaleString() + ' of ' + strokes.length.toLocaleString() + ' strokes');
  $('#cdStrokeLen').text((len / 1000).toFixed(2) + ' m');
  $('#cdStrokeNewLayer').prop('disabled', strokeSelectionCount === 0);
  $('#cdStrokeUpdateLayer').prop('disabled', strokeSelectionCount === 0);
}

// ── Pointer handling ───────────────────────────────────────────────────────

function strokeMouseWorld(ev) {
  if (typeof renderer === 'undefined' || !renderer) return null;
  var rect = renderer.domElement.getBoundingClientRect();
  var ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  var pt = new THREE.Vector3();
  return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), pt) ? pt : null;
}

// Screen-space tolerance in world units, so picking feels the same at any zoom.
function strokeWorldPerPixel() {
  var rect = renderer.domElement.getBoundingClientRect();
  var a = strokeMouseWorld({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
  var b = strokeMouseWorld({ clientX: rect.left + rect.width / 2 + 20, clientY: rect.top + rect.height / 2 });
  if (!a || !b) return 0.2;
  return a.distanceTo(b) / 20;
}

function strokePickAt(world, radius, on) {
  var hits = strokeCandidates(world.x, world.y, world.x, world.y, radius);
  var changed = false;
  for (var i = 0; i < hits.length; i++) {
    if (strokeDistTo(hits[i], world.x, world.y, radius) <= radius) {
      var want = (on === undefined) ? !strokeSelection[hits[i]] : on;
      if (!!strokeSelection[hits[i]] !== want) { strokeSet(hits[i], want); changed = true; }
    }
  }
  return changed;
}

function strokeBoxApply(a, b, on) {
  var minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  var minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  var hits = strokeCandidates(minX, minY, maxX, maxY, 0);
  for (var i = 0; i < hits.length; i++) {
    var s = strokes[hits[i]];
    // Blender's box select takes anything the box touches, not just fully inside.
    if (s.maxX >= minX && s.minX <= maxX && s.maxY >= minY && s.minY <= maxY) {
      strokeSet(hits[i], on);
    }
  }
}

function strokeOnDown(ev) {
  if (!strokeEditActive || ev.button !== 0) return;
  var w = strokeMouseWorld(ev);
  if (!w) return;

  ev.preventDefault();
  ev.stopPropagation();
  if (typeof controls !== 'undefined' && controls) controls.enabled = false;
  strokeDragging = true;
  strokePushUndo();

  if (strokeTool === 'box') {
    strokeBoxStart = w;
    var r = renderer.domElement.getBoundingClientRect();
    strokeBoxScreen = { x: ev.clientX - r.left, y: ev.clientY - r.top };
  } else if (strokeTool === 'brush') {
    if (strokePickAt(w, strokeBrushMm, strokePaintOn(ev))) { strokeApplyColors(); strokeUpdateStats(); }
  } else {
    var tol = Math.max(strokeWorldPerPixel() * 8, 0.3);
    if (strokePickAt(w, tol, strokePaintOn(ev))) { strokeApplyColors(); strokeUpdateStats(); }
  }
}

function strokeOnMove(ev) {
  if (!strokeEditActive) return;
  strokeLastMove = { clientX: ev.clientX, clientY: ev.clientY, altKey: ev.altKey };

  if (strokeTool === 'brush') {
    var wpp = strokeWorldPerPixel();
    var px = strokeBrushMm / (wpp || 1);
    var rect = renderer.domElement.getBoundingClientRect();
    $('#cd-stroke-cursor').css({
      display: 'block',
      width: px * 2 + 'px', height: px * 2 + 'px',
      left: (ev.clientX - rect.left - px) + 'px',
      top: (ev.clientY - rect.top - px) + 'px'
    });
  }

  // Roll-over preview: show which stroke a click would take. Pick only — the
  // brush already shows its reach with the ring, and the box with its band.
  if (!strokeDragging && strokeTool === 'pick') {
    var hw = strokeMouseWorld(ev);
    strokeSetHover(hw ? strokeNearest(hw, Math.max(strokeWorldPerPixel() * 8, 0.3)) : -1);
  }

  if (!strokeDragging) return;
  var w = strokeMouseWorld(ev);
  if (!w) return;

  if (strokeTool === 'brush') {
    if (strokePickAt(w, strokeBrushMm, strokePaintOn(ev))) { strokeApplyColors(); strokeUpdateStats(); }
  } else if (strokeTool === 'box' && strokeBoxScreen) {
    // Rubber band only — the selection commits on mouseup, so dragging never
    // recolours the whole buffer per frame.
    var r = renderer.domElement.getBoundingClientRect();
    var cx = ev.clientX - r.left, cy = ev.clientY - r.top;
    $('#cd-stroke-band').css({
      display: 'block',
      left: Math.min(cx, strokeBoxScreen.x) + 'px',
      top: Math.min(cy, strokeBoxScreen.y) + 'px',
      width: Math.abs(cx - strokeBoxScreen.x) + 'px',
      height: Math.abs(cy - strokeBoxScreen.y) + 'px'
    });
  }
}

function strokeOnUp(ev) {
  if (!strokeEditActive || !strokeDragging) return;
  strokeDragging = false;
  if (typeof controls !== 'undefined' && controls) controls.enabled = true;

  if (strokeTool === 'box' && strokeBoxStart) {
    var w = strokeMouseWorld(ev);
    if (w) {
      strokeBoxApply(strokeBoxStart, w, strokePaintOn(ev));
      strokeApplyColors();
      strokeUpdateStats();
    }
    strokeBoxStart = null;
    strokeBoxScreen = null;
    $('#cd-stroke-band').hide();
  }
}

// The wheel stays with the camera zoom, so brush size gets [ and ] (the
// Photoshop / Krita convention) plus the − / + buttons in the palette.
function strokeBrushResize(factor) {
  strokeBrushMm = Math.max(0.5, Math.min(200, strokeBrushMm * factor));
  $('#cdStrokeBrushVal').text(strokeBrushMm.toFixed(1) + ' mm');
  if (strokeLastMove) strokeOnMove(strokeLastMove);
}

// ── Mode ───────────────────────────────────────────────────────────────────
//
// VIEW is for looking at and running the plot: speed, simulate, reset view.
// EDIT is for changing what gets plotted: reference photo, selection tools,
// layers. Splitting them keeps the toolbar honest about what each control does,
// and gives the colour buffer a single owner (see strokeRepaint).

var strokeMode = 'view';

function strokeSetMode(mode) {
  var toEdit = (mode === 'edit');

  if (toEdit) {
    if (typeof object === 'undefined' || !object || !object.userData || !object.userData.linePoints) {
      Metro.toast.create('Load a G-code file first.', null, 3000, 'bg-orange');
      return;
    }
    // The range scrubber writes the same colour buffer; only one may own it.
    if (typeof closeScrubber === 'function' && typeof scrubberOpen !== 'undefined' && scrubberOpen) closeScrubber();
  }

  strokeMode = toEdit ? 'edit' : 'view';
  strokeEditActive = toEdit;

  if (toEdit) {
    if (!strokes.length) strokeBuild();
    strokeRefreshLayerUI();
  } else {
    strokeDragging = false;
    strokeHover = -1;
    if (typeof controls !== 'undefined' && controls) controls.enabled = true;
    $('#cd-stroke-cursor').hide();
    $('#cd-photo-panel').hide();
  }

  $('.cd-mode-btn').removeClass('is-active').filter('[data-mode="' + strokeMode + '"]').addClass('is-active');
  $('#cd-view-tools').toggle(!toEdit);
  $('#cd-edit-tools').toggle(toEdit);
  $('#cd-stroke-tools').toggle(toEdit);
  $('#cd-stroke-bar').toggle(toEdit);
  // The layer panel stays up in both modes — it is the plot selector, and you
  // need to change what you are plotting without entering edit mode.
  $('#cd-layer-panel').toggle(strokes.length > 0 || toEdit);
  strokeRefreshLayerUI();

  if (toEdit) {
    strokeSetTool(strokeTool);
    strokeSetPaintMode(strokePaintMode);
    strokeUpdateStats();
  }
  strokeRepaint();
}

// Kept as the names the rest of the app already calls.
function strokeEditEnter() { strokeSetMode('edit'); }
function strokeEditExit() { strokeSetMode('view'); }

function strokeSetPaintMode(mode) {
  strokePaintMode = (mode === 'remove') ? 'remove' : 'add';
  $('.cd-stroke-mode').removeClass('is-active')
    .filter('[data-mode="' + strokePaintMode + '"]').addClass('is-active');
  $('#cd-stroke-cursor').toggleClass('is-remove', strokePaintMode === 'remove');
  // The hover colour encodes the mode, so re-evaluate whatever is under the
  // cursor rather than waiting for the pointer to move.
  if (strokeHover >= 0) strokePaintHover(strokeHover);
}

function strokeSetTool(tool) {
  if (tool !== 'pick') strokeSetHover(-1);
  strokeTool = tool;
  $('.cd-stroke-tool').removeClass('is-active').filter('[data-tool="' + tool + '"]').addClass('is-active');
  $('#cdStrokeBrushSize').toggle(tool === 'brush');
  if (tool !== 'brush') $('#cd-stroke-cursor').hide();
}

// ── Layers ─────────────────────────────────────────────────────────────────
//
// A layer is a named bunch of strokes. MAIN is implicit — it means the whole
// file — and cannot be edited or deleted. Layers are stored as stroke INDICES,
// never as generated G-code, and the source file is never modified. That is
// what makes them re-editable: opening one restores the selection itself rather
// than some derived artefact.
//
// Layers may overlap freely; nothing stops a stroke being in several. Plotting
// two overlapping layers would draw the shared strokes twice, which is the
// user's call to make.

var strokeLayers = [];
var strokeEditingLayerId = null;
var strokePlotLayerId = null;
var strokeLayerSeq = 1;

var STROKE_LAYER_COLORS = [
  [0.85, 0.10, 0.10], [0.10, 0.45, 0.85], [0.10, 0.60, 0.25],
  [0.75, 0.45, 0.00], [0.55, 0.20, 0.70], [0.00, 0.55, 0.55]
];

// Stroke indices are only meaningful for the file they were built from.
function strokeFingerprint() {
  var name = (typeof loadedFileName !== 'undefined' && loadedFileName) ? loadedFileName : 'untitled';
  var lines = (typeof editor !== 'undefined' && editor.session) ? editor.session.getLength() : 0;
  return name + ':' + lines;
}

function strokeEnsureBuilt() {
  if (!strokes.length) strokeBuild();
  return strokes.length > 0;
}

function strokeLayersSave() {
  try {
    localStorage.setItem('strokeLayers:' + strokeFingerprint(), JSON.stringify(strokeLayers));
  } catch (e) {}
}

function strokeLayersLoad() {
  strokeLayers = [];
  try {
    var raw = localStorage.getItem('strokeLayers:' + strokeFingerprint());
    if (raw) strokeLayers = JSON.parse(raw) || [];
  } catch (e) { strokeLayers = []; }

  strokeLayerSeq = 1;
  strokeLayers.forEach(function (l) {
    var n = parseInt(String(l.id).replace(/\D/g, ''), 10);
    if (!isNaN(n) && n >= strokeLayerSeq) strokeLayerSeq = n + 1;
  });

  if (!strokeLayerById(strokePlotLayerId)) strokePlotLayerId = null;
  if (strokeLayers.length && strokes.length === 0) strokeEnsureBuilt();
  $('#cd-layer-panel').toggle(strokeLayers.length > 0 || strokeMode === 'edit');
  strokeRefreshLayerUI();
  strokeRepaint();
}

function strokeLayerById(id) {
  if (id === null || id === undefined) return null;
  for (var i = 0; i < strokeLayers.length; i++) if (strokeLayers[i].id === id) return strokeLayers[i];
  return null;
}

function strokeSelectionStats() {
  var len = 0;
  for (var k in strokeSelection) if (strokes[k]) len += strokes[k].len;
  return { count: strokeSelectionCount, len: len };
}

function strokeLayerFromSelection(id, name) {
  var sel = {};
  for (var k in strokeSelection) sel[k] = 1;
  var st = strokeSelectionStats();
  return { id: id, name: name, sel: sel, count: st.count, len: st.len };
}

function strokeLayerNew() {
  if (!strokeSelectionCount) return;
  var id = 'L' + strokeLayerSeq++;
  var layer = strokeLayerFromSelection(id, 'Layer ' + (strokeLayers.length + 1));
  strokeLayers.push(layer);
  strokeEditingLayerId = id;
  strokeLayersSave();
  strokeRefreshLayerUI();
  Metro.toast.create('Saved "' + layer.name + '" — ' + layer.count + ' strokes.', null, 3000, 'bg-green');
}

function strokeLayerUpdate() {
  var l = strokeLayerById(strokeEditingLayerId);
  if (!l || !strokeSelectionCount) return;
  var next = strokeLayerFromSelection(l.id, l.name);
  strokeLayers[strokeLayers.indexOf(l)] = next;
  strokeLayersSave();
  strokeRefreshLayerUI();
  Metro.toast.create('Updated "' + next.name + '" — ' + next.count + ' strokes.', null, 3000, 'bg-green');
}

function strokeLayerDelete(id) {
  var l = strokeLayerById(id);
  if (!l) return;
  strokeLayers.splice(strokeLayers.indexOf(l), 1);
  if (strokeEditingLayerId === id) strokeEditingLayerId = null;
  if (strokePlotLayerId === id) strokePlotLayerId = null;
  strokeLayersSave();
  strokeRefreshLayerUI();
  strokeRepaint();
}

function strokeLayerRename(id) {
  var l = strokeLayerById(id);
  if (!l) return;
  var name = window.prompt('Layer name', l.name);
  if (name === null) return;
  name = name.trim();
  if (!name) return;
  l.name = name;
  strokeLayersSave();
  strokeRefreshLayerUI();
}

// Open a layer for editing: switch to edit mode and restore its strokes as the
// working selection.
function strokeLayerEdit(id) {
  var l = strokeLayerById(id);
  if (!l) return;
  strokeEditingLayerId = id;
  if (strokeMode !== 'edit') strokeSetMode('edit');
  strokeSelectAllQuiet(false);
  for (var k in l.sel) if (strokes[k]) strokeSet(Number(k), true);
  strokeRepaint();
  strokeUpdateStats();
  strokeRefreshLayerUI();
}

function strokeSelectAllQuiet(on) {
  strokeSelection = {};
  strokeSelectionCount = 0;
  if (on) for (var i = 0; i < strokes.length; i++) strokeSet(i, true);
}

function strokeSetPlotLayer(id) {
  strokePlotLayerId = strokeLayerById(id) ? id : null;
  strokeRefreshLayerUI();
  strokeRepaint();
}

function strokeLayerColor(i) {
  return STROKE_LAYER_COLORS[i % STROKE_LAYER_COLORS.length];
}

// ── Layer UI ───────────────────────────────────────────────────────────────

function strokeLayerRgb(i) {
  var c = strokeLayerColor(i);
  return 'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')';
}

// The layer list IS the plot selector — the RUN panel used to repeat it as a
// second button grid, which meant two places to change one thing. RUN keeps
// only the readout, because START still has to say what it will draw.
function strokeRefreshLayerUI() {
  var total = strokes.length || 0;
  var editable = (strokeMode === 'edit');

  function row(id, name, count, rgb, isMain) {
    var plotting = (strokePlotLayerId === id) || (isMain && strokePlotLayerId === null);
    var editing = editable && strokeEditingLayerId === id;
    return '<div class="cd-layer-row' + (editing ? ' is-editing' : '') + (plotting ? ' is-plotting' : '') +
        '" data-id="' + (id || '') + '" tabindex="0">' +
        '<button class="cd-layer-plot' + (plotting ? ' is-on' : '') + '" data-act="plot" type="button" ' +
          'aria-label="Plot ' + name + '" title="Plot this">▶</button>' +
        '<span class="cd-layer-swatch' + (isMain ? ' is-main' : '') + '"' +
          (rgb ? ' style="background:' + rgb + '"' : '') + '></span>' +
        '<span class="cd-layer-name">' + $('<i>').text(name).html() + '</span>' +
        '<span class="cd-layer-count">' + count.toLocaleString() + '</span>' +
        (isMain ? '' :
          '<button class="cd-layer-btn" data-act="rename" type="button" aria-label="Rename" title="Rename">✎</button>' +
          '<button class="cd-layer-btn" data-act="delete" type="button" aria-label="Delete" title="Delete layer">✕</button>') +
      '</div>';
  }

  var $list = $('#cd-layer-list').empty();
  $list.append(row(null, 'MAIN', total, null, true));
  strokeLayers.forEach(function (l, i) {
    $list.append(row(l.id, l.name, l.count, strokeLayerRgb(i), false));
  });

  $('#cd-layer-panel').toggleClass('is-editable', editable);
  $('#cd-layer-empty').toggle(strokeLayers.length === 0 && editable);

  var el = strokeLayerById(strokeEditingLayerId);
  $('#cdStrokeUpdateLayer').toggle(!!el).text(el ? 'UPDATE ' + el.name.toUpperCase() : 'UPDATE');

  $('#cdStrokeEditLabel').text(strokeLayers.length ? 'EDIT · ' + strokeLayers.length : 'EDIT');

  // RUN panel: readout only.
  var pl = strokeLayerById(strokePlotLayerId);
  $('#cd-plot-target').toggle(strokeLayers.length > 0);
  $('#cdPlotTargetName').text(pl ? pl.name : 'Whole file');
  $('#cdPlotTargetMeta').text(pl
    ? pl.count.toLocaleString() + ' of ' + (total || '?').toLocaleString() + ' strokes · ' + (pl.len / 1000).toFixed(2) + ' m'
    : (total ? total.toLocaleString() + ' strokes' : ''));
  $('#cdStartBtn').text(pl ? '▶ START ' + pl.name.toUpperCase() : '▶ START');
}

// ── Painting (single owner) ────────────────────────────────────────────────
//
// Exactly one thing owns the colour buffer at a time, decided by mode. Two
// features writing it with guards is what made edit mode show stale colours.

function strokeRepaint() {
  if (!object || !object.geometry || !object.geometry.attributes.color) return;
  if (strokeMode === 'edit') strokeApplyColors();
  else strokePaintViewMode();
}

// View mode: isolate the plot layer if one is armed (everything else painted
// the background colour, which reads as hidden against the white work area —
// the toolpath is one continuous THREE.Line, so strokes cannot be removed from
// it). Otherwise hand the buffer back to the original toolpath colours.
function strokePaintViewMode() {
  var pl = strokeLayerById(strokePlotLayerId);

  // Nothing to say: no layers and no target — hand the buffer back untouched.
  if ((!strokeLayers.length && !pl) || !strokeEnsureBuilt()) {
    if (typeof restoreToolpathColors === 'function') restoreToolpathColors();
    return;
  }

  var colors = object.geometry.attributes.color;
  if (!originalToolpathColors) originalToolpathColors = new Float32Array(colors.array);

  var bg = 0xffffff;
  try { bg = Theme.getColor('SKY_BOTTOM_COLOR'); } catch (e) {}
  var br = ((bg >> 16) & 0xff) / 255;
  var bgG = ((bg >> 8) & 0xff) / 255;
  var bb = (bg & 0xff) / 255;
  var total = colors.array.length;

  function fill(sel, r, g, b) {
    for (var k in sel) {
      var s = strokes[k];
      if (!s) continue;
      var to = Math.min((s.b + 1) * 3, total);
      for (var j = s.a * 3; j < to; j += 3) {
        colors.array[j] = r; colors.array[j + 1] = g; colors.array[j + 2] = b;
      }
    }
  }

  if (pl) {
    // A layer is armed for plotting: show only it, so the preview matches what
    // START will actually draw. Everything else takes the background colour,
    // which reads as hidden against the white work area (the toolpath is one
    // continuous THREE.Line, so strokes cannot be removed from it).
    for (var i = 0; i < total; i += 3) {
      colors.array[i] = br; colors.array[i + 1] = bgG; colors.array[i + 2] = bb;
    }
    var ci = 0;
    for (var n = 0; n < strokeLayers.length; n++) if (strokeLayers[n].id === pl.id) ci = n;
    var c = strokeLayerColor(ci);
    fill(pl.sel, c[0], c[1], c[2]);
  } else {
    // No target: ghost the file and tint each layer so the split is readable.
    var t = 0.82, inv = 1 - t;
    for (var i2 = 0; i2 < total; i2 += 3) {
      colors.array[i2]     = originalToolpathColors[i2]     * inv + br  * t;
      colors.array[i2 + 1] = originalToolpathColors[i2 + 1] * inv + bgG * t;
      colors.array[i2 + 2] = originalToolpathColors[i2 + 2] * inv + bb  * t;
    }
    strokeLayers.forEach(function (l, idx) {
      var lc = strokeLayerColor(idx);
      fill(l.sel, lc[0], lc[1], lc[2]);
    });
  }

  colors.needsUpdate = true;
}

// Called by runJobFile: the G-code to stream, or null to plot the whole file.
// Built fresh at plot time so it always uses the current pen heights.
window.strokePartGcodeIfArmed = function () {
  var pl = strokeLayerById(strokePlotLayerId);
  if (!pl) return null;
  if (!strokeEnsureBuilt()) return null;
  return strokeBuildGcode(Object.keys(pl.sel).map(Number).sort(function (a, b) { return a - b; }));
};

function strokeBuildGcode(keep) {
  var lp = object.userData.linePoints;

  var pens = { up: parseFloat(localStorage.getItem('penUpZ')), down: parseFloat(localStorage.getItem('penDownZ')) };
  if (isNaN(pens.up)) pens.up = 5;
  if (isNaN(pens.down)) pens.down = 0;

  var firstLine = strokes[keep[0]].lineA + 1;
  var state = (typeof scanModalState === 'function') ? scanModalState(firstLine) : null;

  var g = '';
  g += '; === SELECTION - ' + keep.length + ' of ' + strokes.length + ' strokes ===\n';
  g += '; Generated: ' + new Date().toISOString() + '\n';
  g += '; Coordinates are unchanged from the source file so this registers\n';
  g += '; with what is already drawn. Do NOT re-zero before running.\n\n';

  if (state) {
    g += state.units + '\n';
    g += 'G90\n';
    g += state.wcs + '\n';
    g += state.plane + '\n';
    if (state.feedRateMode) g += state.feedRateMode + '\n';
  } else {
    g += 'G21\nG90\n';
  }

  var feed = (state && state.lastCuttingFeed) ? state.lastCuttingFeed : null;

  keep.forEach(function (idx) {
    var s = strokes[idx];
    var p0 = lp[s.a];
    g += '\n; --- stroke ' + idx + ' (lines ' + (s.lineA + 1) + '-' + (s.lineB + 1) + ') ---\n';
    g += 'G0 Z' + pens.up + '\n';
    g += 'G0 X' + (p0.x).toFixed(3) + ' Y' + (p0.y).toFixed(3) + '\n';
    g += 'G1 Z' + pens.down + (feed ? ' F' + feed : '') + '\n';
    for (var i = s.a + 1; i <= s.b; i++) {
      var p = lp[i];
      g += 'G1 X' + p.x.toFixed(3) + ' Y' + p.y.toFixed(3) + (feed ? ' F' + feed : '') + '\n';
    }
  });

  g += '\n; --- done ---\nG0 Z' + pens.up + '\n';
  return g;
}

// ── Wiring ─────────────────────────────────────────────────────────────────

$(document).ready(function () {
  $('#cdStrokeEditBtn').on('click', function () {
    if (strokeEditActive) strokeEditExit(); else strokeEditEnter();
  });

  $('#cd-stroke-tools').on('click', '.cd-stroke-tool', function () {
    strokeSetTool($(this).data('tool'));
  });

  $('#cd-stroke-tools').on('click', '.cd-stroke-mode', function () {
    strokeSetPaintMode($(this).data('mode'));
  });

  $('#cdStrokeBrushDown').on('click', function () { strokeBrushResize(0.8); });
  $('#cdStrokeBrushUp').on('click', function () { strokeBrushResize(1.25); });

  $('.cd-mode-btn').on('click', function () { strokeSetMode($(this).data('mode')); });

  $('#cdStrokeAll').on('click', function () { strokeSelectAll(true); });
  $('#cdStrokeNone').on('click', function () { strokeSelectAll(false); });
  $('#cdStrokeInvert').on('click', strokeInvert);
  $('#cdStrokeNewLayer').on('click', strokeLayerNew);
  $('#cdStrokeUpdateLayer').on('click', strokeLayerUpdate);
  $('#cdStrokeDone').on('click', strokeEditExit);

  // Layer list: the row opens it for editing, the buttons rename / delete.
  $('#cd-layer-list').on('click', '.cd-layer-row', function (e) {
    var id = $(this).data('id') || null;
    var act = $(e.target).data('act');
    if (act === 'plot') { e.stopPropagation(); strokeSetPlotLayer(id); return; }
    if (act === 'delete') { e.stopPropagation(); strokeLayerDelete(id); return; }
    if (act === 'rename') { e.stopPropagation(); strokeLayerRename(id); return; }
    if (strokeMode !== 'edit') { strokeSetPlotLayer(id); return; }
    if (!id) {
      // MAIN — clear the working selection and stop editing any layer.
      strokeEditingLayerId = null;
      strokeSelectAllQuiet(false);
      strokeRepaint();
      strokeUpdateStats();
      strokeRefreshLayerUI();
      return;
    }
    strokeLayerEdit(id);
  });

  // Keyboard equivalent of clicking a layer row.
  $('#cd-layer-list').on('keydown', '.cd-layer-row', function (e) {
    if (e.which === 13 || e.which === 32) { e.preventDefault(); $(this).trigger('click'); }
  });

  var el = document.getElementById('renderArea');
  if (el) {
    el.addEventListener('mousedown', strokeOnDown, true);
    el.addEventListener('mousemove', strokeOnMove, true);
    el.addEventListener('mouseup', strokeOnUp, true);
    el.addEventListener('mouseleave', function () {
      $('#cd-stroke-cursor').hide();
      if (strokeEditActive) strokeSetHover(-1);
    });
  }

  // A newly parsed file may have layers saved against it from a previous
  // session; the fingerprint in the storage key keeps them file-specific.
  setTimeout(strokeLayersLoad, 1200);

  $(document).on('keydown', function (e) {
    if (!strokeEditActive) return;
    if ((e.metaKey || e.ctrlKey) && e.which === 90) { e.preventDefault(); strokeUndo(); }
    else if (e.which === 27) strokeEditExit();
    else if (e.which === 66) strokeSetTool('brush');
    else if (e.which === 88) strokeSetTool('box');
    else if (e.which === 86) strokeSetTool('pick');
    else if (e.which === 219) strokeBrushResize(0.8);
    else if (e.which === 221) strokeBrushResize(1.25);
    else if (e.which === 65) strokeSetPaintMode('add');
    else if (e.which === 69) strokeSetPaintMode('remove');
  });
});
