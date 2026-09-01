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
var strokeRangeA = -1;
var strokeRangeB = -1;
var strokeRangeNext = 'a';

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
// The work-area colour. Painting a segment this reads as "not there" against
// the sheet — the toolpath is one continuous THREE.Line, so vertices cannot be
// removed from it, only hidden.
function strokeBgColor() {
  var bg = 0xffffff;
  try { bg = Theme.getColor('SKY_BOTTOM_COLOR'); } catch (e) {}
  return [((bg >> 16) & 0xff) / 255, ((bg >> 8) & 0xff) / 255, (bg & 0xff) / 255];
}

// Everything that paints the toolpath goes through here, so the editor, an
// armed layer and the whole file cannot end up looking like three different
// drawings. They differ in one thing only — which strokes are highlighted.
//
//   travel            -> its original colour, or hidden when `hideTravel`
//   ink, not picked   -> faint grey, so there is context to work against
//   ink, picked       -> `color`, or its original colour when `color` is null
//
// `pick` is a set of stroke indices, or null meaning every stroke.
//
// Travel is only dropped while editing. There it is noise across the picture
// you are aiming at, and it cannot be selected anyway — but everywhere else the
// pen-up moves are worth seeing: they are where the plot spends time it is not
// drawing, and where a lift is in the wrong place shows up.
var STROKE_DIM = [0.86, 0.85, 0.82];

// `rest` is the colour for ink outside `pick`. The editor dims it, because you
// need something to aim at while painting. A chosen version hides it, because
// there the picture has to be what START will draw and nothing else.
function strokePaintBuffer(pick, color, hideTravel, rest) {
  if (!object || !object.geometry || !object.geometry.attributes.color) return;

  var colors = object.geometry.attributes.color;
  if (!originalToolpathColors) originalToolpathColors = new Float32Array(colors.array);

  var total = colors.array.length;
  var bg = strokeBgColor();
  for (var i = 0; i < total; i += 3) {
    if (hideTravel) {
      colors.array[i] = bg[0];
      colors.array[i + 1] = bg[1];
      colors.array[i + 2] = bg[2];
    } else {
      colors.array[i] = originalToolpathColors[i];
      colors.array[i + 1] = originalToolpathColors[i + 1];
      colors.array[i + 2] = originalToolpathColors[i + 2];
    }
  }

  for (var t = 0; t < strokes.length; t++) {
    var st = strokes[t];
    if (!st) continue;
    var on = !pick || pick[t];
    var c = on ? color : (rest || STROKE_DIM);
    var to = Math.min((st.b + 1) * 3, total);
    for (var j = st.a * 3; j < to; j += 3) {
      if (on && !c) {
        // Whole file: hand back the colour the parser gave this vertex, so the
        // default preview still reads the way it always has.
        colors.array[j] = originalToolpathColors[j];
        colors.array[j + 1] = originalToolpathColors[j + 1];
        colors.array[j + 2] = originalToolpathColors[j + 2];
      } else {
        colors.array[j] = c[0];
        colors.array[j + 1] = c[1];
        colors.array[j + 2] = c[2];
      }
    }
  }

  colors.needsUpdate = true;
}

// The colour a layer paints with, matching its swatch in the layer panel.
function strokeLayerPaint(layer) {
  if (!layer) return [1, 0, 0];
  var li = 0;
  for (var n = 0; n < strokeLayers.length; n++) if (strokeLayers[n].id === layer.id) li = n;
  return strokeLayerColorOf(layer, li);
}

function strokeApplyColors() {
  strokePaintBuffer(strokeSelection, strokeLayerPaint(strokeLayerById(strokeEditingLayerId)), true);
  // The chain is drawn from the selection, so every repaint that follows a
  // selection change has to rebuild it. Doing it here rather than at each of
  // the callers is the difference between one owner and seven.
  strokeVersionTravelBuild();
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

// Coalesce full repaints to one per animation frame. Brushing fires mousemove
// far faster than the scene renders, and strokeApplyColors rewrites the whole
// colour buffer (~90k floats on a 12k-line file) and re-uploads it to the GPU.
// Doing that per event burns CPU for frames nobody sees.
var _strokeRepaintQueued = false;

function strokeApplyColorsSoon() {
  if (_strokeRepaintQueued) return;
  _strokeRepaintQueued = true;
  requestAnimationFrame(function () {
    _strokeRepaintQueued = false;
    if (strokeEditActive) strokeApplyColors();
  });
}

// Recolour a single stroke without touching the rest of the buffer. Hover fires
// on every mousemove, and repainting all ~100k vertices each time would stutter.
// The colour a stroke returns to when hover leaves it.
function strokeBaseColor(idx) {
  if (!strokeSelection[idx]) return STROKE_DIM;
  return strokeLayerPaint(strokeLayerById(strokeEditingLayerId));
}

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
    var b = strokeBaseColor(strokeHover);
    strokePaintOne(strokeHover, b[0], b[1], b[2]);
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
  var el = strokeLayerById(strokeEditingLayerId);
  $('#cdStrokeEditingName').text(el ? 'EDITING ' + el.name.toUpperCase() : 'EDITING');
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

  if (strokeTool === 'range') {
    // First click sets FROM, second sets TO, then it cycles — so dragging out a
    // range is click, click, done.
    var tolR = Math.max(strokeWorldPerPixel() * 8, 0.3);
    var hitR = strokeNearest(w, tolR);
    if (hitR >= 0) {
      strokeRangeSet(strokeRangeNext, hitR);
      strokeRangeNext = (strokeRangeNext === 'a') ? 'b' : 'a';
      strokeRangeRefresh();
    }
  } else if (strokeTool === 'box') {
    strokeBoxStart = w;
    var r = renderer.domElement.getBoundingClientRect();
    strokeBoxScreen = { x: ev.clientX - r.left, y: ev.clientY - r.top };
  } else if (strokeTool === 'brush') {
    if (strokePickAt(w, strokeBrushMm, strokePaintOn(ev))) { strokeApplyColors(); strokeUpdateStats(); }
  } else {
    var tol = Math.max(strokeWorldPerPixel() * 8, 0.3);
    if (strokePickAt(w, tol, strokePaintOn(ev))) {
      strokeApplyColors();
      strokeUpdateStats();
      // The click changed whether this stroke is selected, so the cross has to
      // re-answer now — after unselecting it would otherwise stay lit until
      // the pointer moved.
      strokeRefreshCursorState(ev);
    }
  }
}

function strokeOnMove(ev) {
  if (!strokeEditActive) return;
  strokeLastMove = { clientX: ev.clientX, clientY: ev.clientY, altKey: ev.altKey };

  if (strokeTool === 'brush') {
    var wpp = strokeWorldPerPixel();
    var px = strokeBrushMm / (wpp || 1);
    var rect = renderer.domElement.getBoundingClientRect();
    $('#cd-stroke-cursor').removeClass('is-pick is-over').css({
      display: 'block',
      width: px * 2 + 'px', height: px * 2 + 'px',
      left: (ev.clientX - rect.left - px) + 'px',
      top: (ev.clientY - rect.top - px) + 'px'
    });
    strokeRefreshCursorSign(ev);
  }

  // Roll-over preview: show which stroke a click would take. Pick only — the
  // brush already shows its reach with the ring, and the box with its band.
  if (!strokeDragging && strokeTool === 'pick') {
    var hw = strokeMouseWorld(ev);
    strokeSetHover(hw ? strokeNearest(hw, Math.max(strokeWorldPerPixel() * 8, 0.3)) : -1);

    var prect = renderer.domElement.getBoundingClientRect();
    $('#cd-stroke-cursor')
      .addClass('is-pick')
      .css({
        display: 'block',
        width: '', height: '',
        left: (ev.clientX - prect.left) + 'px',
        top: (ev.clientY - prect.top) + 'px'
      });
    strokeRefreshCursorState(ev);
  }

  if (!strokeDragging) return;
  var w = strokeMouseWorld(ev);
  if (!w) return;

  if (strokeTool === 'brush') {
    if (strokePickAt(w, strokeBrushMm, strokePaintOn(ev))) { strokeApplyColorsSoon(); strokeUpdateStats(); }
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
  var commit = true;
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

  // Write the gesture through to the layer being edited.
  if (commit) strokeCommitToLayer();
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
    // Pick hides the system arrow and draws its own. Leaving edit mode without
    // putting it back would leave the viewport with no pointer at all.
    if (typeof renderer !== 'undefined' && renderer) $(renderer.domElement).css('cursor', '');
    $('#cd-stroke-cursor').removeClass('is-pick is-over').hide();
    $('#cd-photo-panel').hide();
    strokeRangeCursorHide();
  }

  $('#cd-stroke-tools').toggle(toEdit);
  $('#cd-tool-options').toggle(toEdit);
  $('#cd-stroke-bar').toggle(toEdit);
  $('#cd-edit-frame').toggle(toEdit);
  // The layer panel stays up in both modes — it is the plot selector, and you
  // need to change what you are plotting without entering edit mode.
  strokeRefreshLayerUI();

  if (toEdit) {
    strokeSetTool(strokeTool);
    strokeSetPaintMode(strokePaintMode);
    strokeUpdateStats();
  } else {
  }
  strokeRepaint();
}

// Kept as the names the rest of the app already calls.
function strokeEditEnter() { strokeSetMode('edit'); }
function strokeEditExit() { strokeSetMode('view'); }

// The ring shows what a click would do right now — strokePaintOn() already
// answers that, Alt inversion included, so the sign is read from it rather
// than from strokePaintMode alone.
function strokeRefreshCursorSign(ev) {
  $('#cd-stroke-cursor').toggleClass('is-remove', !strokePaintOn(ev));
}

// Would a click on whatever is under the pointer actually change the
// selection? In Unselect that is only true over a stroke already in the
// selection — lighting up over an unselected one promised a removal that
// cannot happen. Reads the effective mode, so holding Alt re-answers it.
function strokeHoverActionable(ev) {
  if (strokeHover < 0 || !strokes[strokeHover]) return false;
  return strokePaintOn(ev) ? true : !!strokeSelection[strokeHover];
}

function strokeRefreshCursorState(ev) {
  strokeRefreshCursorSign(ev);
  $('#cd-stroke-cursor').toggleClass('is-over', strokeHoverActionable(ev));
}

function strokeSetPaintMode(mode) {
  strokePaintMode = (mode === 'remove') ? 'remove' : 'add';
  $('.cd-stroke-mode').removeClass('is-active')
    .filter('[data-mode="' + strokePaintMode + '"]').addClass('is-active');
  strokeRefreshCursorState(strokeLastMove);
  // The hover colour encodes the mode, so re-evaluate whatever is under the
  // cursor rather than waiting for the pointer to move.
  if (strokeHover >= 0) strokePaintHover(strokeHover);
}

var STROKE_TOOL_INFO = {
  pick:  { name: 'PICK' },
  brush: { name: 'BRUSH' },
  box:   { name: 'BOX' },
  range: { name: 'RANGE' }
};

function strokeSetTool(tool) {
  // Roll-over is a Pick affordance only. In range mode the 3D cone is the
  // cursor, and a green stroke under the pointer competes with it.
  if (tool !== 'pick') strokeSetHover(-1);
  strokeTool = tool;

  $('.cd-rail-btn').removeClass('is-active').filter('[data-tool="' + tool + '"]').addClass('is-active');

  var info = STROKE_TOOL_INFO[tool] || STROKE_TOOL_INFO.pick;
  $('#cdToolName').text(info.name);

  // One panel per tool: only the groups this tool owns are shown, so there is
  // never an empty panel sitting next to a full one.
  $('.cd-opt-group[data-opt="brush"]').toggle(tool === 'brush');
  $('.cd-opt-group[data-opt="range"]').toggle(tool === 'range');
  $('.cd-opt-group[data-opt="paint"]').toggle(tool !== 'range');
  $('#cd-tool-options').toggle(strokeMode === 'edit');

  // Hide the system arrow only where a drawn cursor replaces it.
  if (typeof renderer !== 'undefined' && renderer) $(renderer.domElement).css('cursor', (tool === 'pick') ? 'none' : '');
  if (tool !== 'brush' && tool !== 'pick') $('#cd-stroke-cursor').removeClass('is-pick is-over').hide();
  if (tool === 'range') { strokeRangeDefaults(); strokeRangeRefresh(); }
  else strokeRangeCursorHide();
}

// ── Range tool ─────────────────────────────────────────────────────────────
//
// A contiguous run of strokes — what the old START / END scrubber produced,
// but as a selection rather than a destructive rewrite of the source file.
//
// The range spans the WHOLE FILE, not the open layer's strokes. Scoping it to
// the layer made it useless in the case it is most wanted: a new layer is empty,
// so a layer-scoped range would have nothing to walk and could never put
// anything in. You are picking strokes out of the drawing and into the layer.
function strokeRangeScope() {
  var all = [];
  for (var i = 0; i < strokes.length; i++) all.push(i);
  return all;
}

// Park the ends at the first and last stroke so the tool opens meaning "all of
// it". Deliberately does NOT apply — applying on open would replace whatever
// the layer already holds with the entire file the moment you picked the tool.
function strokeRangeDefaults() {
  var scope = strokeRangeScope();
  if (!scope.length) return;
  if (strokeRangeA < 0) strokeRangeA = scope[0];
  if (strokeRangeB < 0) strokeRangeB = scope[scope.length - 1];
}

function strokeRangePos(scope, idx) {
  for (var i = 0; i < scope.length; i++) if (scope[i] === idx) return i;
  return -1;
}

// Set one end of the range to a stroke index, then apply.
function strokeRangeSet(which, idx) {
  if (which === 'b') strokeRangeB = idx; else strokeRangeA = idx;
  strokeRangeApply();
}

// Set one end from a typed 1-based position within the scope.
function strokeRangeSetPos(which, pos) {
  var scope = strokeRangeScope();
  var p = Math.max(1, Math.min(scope.length, parseInt(pos, 10) || 1)) - 1;
  strokeRangeSet(which, scope[p]);
}

function strokeRangeApply() {
  var scope = strokeRangeScope();
  if (!scope.length) return;
  var pa = strokeRangePos(scope, strokeRangeA);
  var pb = strokeRangePos(scope, strokeRangeB);
  if (pa < 0 && pb < 0) return;
  if (pa < 0) pa = pb;
  if (pb < 0) pb = scope.length - 1;

  var lo = Math.min(pa, pb), hi = Math.max(pa, pb);
  strokePushUndo();
  strokeSelectAllQuiet(false);
  for (var i = lo; i <= hi; i++) strokeSet(scope[i], true);

  // Dragging the slider fires far faster than the scene renders.
  strokeApplyColorsSoon();
  strokeUpdateStats();
  strokeRangeRefresh();
}

function strokeRangeRefresh() {
  var scope = strokeRangeScope();
  var pa = strokeRangePos(scope, strokeRangeA);
  var pb = strokeRangePos(scope, strokeRangeB);

  var $f = $('#cdStrokeRangeFrom'), $t = $('#cdStrokeRangeTo');
  if (!$f.is(':focus')) $f.val(pa >= 0 ? pa + 1 : '');
  if (!$t.is(':focus')) $t.val(pb >= 0 ? pb + 1 : '');
  $f.attr('max', scope.length);
  $t.attr('max', scope.length);

  $('#cdStrokeRangeScope').text('of ' + scope.length.toLocaleString() + ' strokes');

  $('.cd-range-mark').removeClass('is-next')
    .filter('[data-end="' + strokeRangeNext + '"]').addClass('is-next');

  // One thumb per end, each independently draggable.
  var max = Math.max(0, scope.length - 1);
  var sa = document.getElementById('cdStrokeRangeSliderA');
  var sb = document.getElementById('cdStrokeRangeSliderB');
  if (sa && sb) {
    sa.max = max; sb.max = max;
    if (pa >= 0) sa.value = pa;
    if (pb >= 0) sb.value = pb;
    var va = parseInt(sa.value, 10) || 0;
    var vb = parseInt(sb.value, 10) || 0;
    var lo = Math.min(va, vb), hi = Math.max(va, vb);
    var fill = document.getElementById('cdRangeFill');
    if (fill && max > 0) {
      fill.style.left = (lo / max * 100) + '%';
      fill.style.width = ((hi - lo) / max * 100) + '%';
    }
    $(sa).toggleClass('is-next', strokeRangeNext === 'a');
    $(sb).toggleClass('is-next', strokeRangeNext === 'b');
  }

  var pos = (strokeRangeNext === 'b') ? pb : pa;
  strokeRangeCursor(pos >= 0 ? scope[pos] : -1);
}

// The 3D cone is the cursor in range mode — the same affordance the old scrub
// panel used. Roll-over highlighting is off here so the two do not compete.
// Materials are built once and reused. Creating a MeshPhongMaterial per call
// churned GPU programs on every slider tick while scrubbing.
var _strokeConeMatOn = null;
var _strokeConeMatOff = null;

function strokeConeMaterial(on) {
  if (on) {
    if (!_strokeConeMatOn) _strokeConeMatOn = new THREE.MeshPhongMaterial({
      color: 0xff8c00, specular: 0xcc6600, shininess: 100, opacity: 0.8, transparent: true
    });
    return _strokeConeMatOn;
  }
  if (!_strokeConeMatOff) _strokeConeMatOff = new THREE.MeshPhongMaterial({
    color: 0x0000ff, specular: 0x0000ff, shininess: 100, opacity: 0.6, transparent: true
  });
  return _strokeConeMatOff;
}

function strokeRangeCursor(idx) {
  if (typeof cone === 'undefined' || !cone) return;
  var s = strokes[idx];
  if (!s) { $('#cdStrokeRangeInfo .pc-pill').text('—'); return; }

  var lp = object.userData.linePoints;
  var p = lp[s.a];
  cone.visible = true;
  cone.position.x = p.x * strokeScale;
  cone.position.y = p.y * strokeScale;
  cone.position.z = p.z * strokeScale;
  cone.material = strokeConeMaterial(true);

  var scope = strokeRangeScope();
  var gtext = '';
  if (s.lineA >= 0 && typeof editor !== 'undefined') {
    gtext = editor.session.getLine(s.lineA) || '';
    if (gtext.length > 46) gtext = gtext.substring(0, 46) + '…';
  }
  $('#cdStrokeRangeInfo').html(
    '<div class="pc-info-row pc-info-row-pill"><span class="pc-pill">' +
      (strokeRangeNext === 'b' ? 'TO' : 'FROM') + ' · stroke ' +
      (strokeRangePos(scope, idx) + 1) + '</span></div>' +
    '<div class="pc-info-row pc-info-row-coords">X:' + (p.x * strokeScale).toFixed(2) +
      ' Y:' + (p.y * strokeScale).toFixed(2) + ' · line ' + (s.lineA + 1) + '</div>' +
    '<div class="pc-info-row pc-info-gcode">' + $('<i>').text(gtext).html() + '</div>'
  );
}

function strokeRangeCursorHide() {
  if (typeof cone !== 'undefined' && cone) cone.material = strokeConeMaterial(false);
}

// Just the markers. Opening a layer needs this WITHOUT touching the selection —
// clearing both is what made an edited layer come back empty.
function strokeRangeClearMarks() {
  strokeRangeA = -1;
  strokeRangeB = -1;
  strokeRangeNext = 'a';
  if (strokeTool === 'range') strokeRangeDefaults();
  strokeRangeRefresh();
}

// The CLEAR RANGE button: markers and the strokes they selected.
function strokeRangeReset() {
  strokeRangeClearMarks();
  strokeSelectAllQuiet(false);
  strokeApplyColors();
  strokeUpdateStats();
  strokeCommitToLayer();
  strokeRangeRefresh();
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

// Cheap "is there a toolpath?" test, without paying for strokeBuild(). The
// panel itself is always on screen now; this gates + NEW LAYER, since there is
// nothing to put in a layer until a file is loaded.
//
// The length test is the point. Clearing the editor leaves `object` set to a
// truthy husk carrying a single linePoint — the parser assigns it before the
// "did we get anything?" guard — so an existence check reported a loaded file
// after an unload and left the panel showing the old file's stroke count.
function strokeHasFile() {
  return typeof object !== 'undefined' && !!object && !!object.userData &&
    !!object.userData.linePoints && object.userData.linePoints.length > 1;
}

// A new parse replaces the geometry the stroke indices address, so the old
// strokes, selection and open layer mean nothing against it. Called by the
// parser for BOTH outcomes — a fresh file and a cleared editor — since only
// one of those reaches the success branch.
var strokeLastFingerprint = null;

window.strokeOnGcodeChanged = function () {
  var fp = strokeFingerprint();

  // Same file, parsed again — "Update 3D View", a re-render, a reload of the
  // same G-code. The geometry is equivalent, so the layers and whatever is
  // armed still mean exactly what they meant a moment ago. Only the stroke
  // index needs rebuilding, because it addresses the NEW object.
  //
  // This guard is the point of the function. Without it every re-parse ran
  // strokeLayersLoad(), whose "if the armed id is missing, unarm" line then
  // silently cleared strokePlotLayerId — and an unarmed layer makes the view
  // paint the whole file and the plot stream the whole file. Before this hook
  // existed strokeLayersLoad() ran once at startup, so arming survived.
  if (fp === strokeLastFingerprint) {
    strokes = [];
    strokeGrid = null;
    strokeEnsureBuilt();
    strokeRefreshLayerUI();
    strokeRepaint();
    return;
  }
  strokeLastFingerprint = fp;

  if (strokeMode === 'edit') strokeSetMode('view');
  strokeEditingLayerId = null;
  strokes = [];
  strokeGrid = null;
  strokeSelection = {};
  strokeSelectionCount = 0;
  strokeUndoStack = [];
  strokeHover = -1;
  strokeRangeClearMarks();
  strokeVersionTravelClear();
  strokeLayersLoad();
};

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
  // Show the panel for any loaded file, not only one that already has layers:
  // + NEW LAYER lives inside it and is the only way into EDIT, so gating the
  // panel on strokeLayers.length made the whole editor unreachable on a machine
  // with no saved layers in localStorage.
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

// New layers start empty and open for editing — you paint into a layer rather
// than selecting first and saving afterwards.
// The list is a chooser: it earns its space only when there is something to
// choose between, and it hides during edit mode so the edit bar owns the one
// DONE on screen.
function strokeRefreshPanelVisibility() {
  $('#cd-plot-target').toggle(strokeHasFile() && strokeMode !== 'edit');
}

function strokeLayerNew() {
  if (!strokeEnsureBuilt()) {
    Metro.toast.create('Load a G-code file first.', null, 3000, 'bg-orange');
    return;
  }
  var id = 'L' + strokeLayerSeq++;
  strokeLayers.push({ id: id, name: 'Version ' + (strokeLayers.length + 1), sel: {}, count: 0, len: 0 });
  strokeLayersSave();
  strokeLayerEdit(id);
}

// While a layer is open, every change writes straight through to it. There is
// no separate save step — the layer IS what you are editing.
function strokeCommitToLayer() {
  var l = strokeLayerById(strokeEditingLayerId);
  if (!l) return;
  var next = strokeLayerFromSelection(l.id, l.name);
  next.ci = l.ci;
  strokeLayers[strokeLayers.indexOf(l)] = next;
  strokeLayersSave();
  strokeRefreshLayerUI();
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

// Inline rename — Electron does not implement window.prompt(), so a prompt
// here would throw rather than rename.
function strokeLayerRename(id) {
  var l = strokeLayerById(id);
  if (!l) return;
  var $row = $('#cd-layer-list .cd-layer-row[data-id="' + id + '"]');
  var $name = $row.find('.cd-layer-name');
  if ($name.attr('contenteditable') === 'true') return;

  // contenteditable rather than an <input>: Metro4 mutates inputs it finds in
  // the DOM and turns this one into a styled component with a dropdown chevron.
  $name.attr('contenteditable', 'true').addClass('is-renaming').focus();

  var range = document.createRange();
  range.selectNodeContents($name[0]);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  var done = false;
  function commit(save) {
    if (done) return;
    done = true;
    var v = $.trim($name.text());
    if (save && v) { l.name = v; strokeLayersSave(); }
    $name.removeAttr('contenteditable').removeClass('is-renaming');
    strokeRefreshLayerUI();
  }

  // Keystrokes must not reach the document handler, or typing "b" in a name
  // would switch to the brush tool.
  $name.on('keydown', function (e) {
    e.stopPropagation();
    if (e.which === 13) { e.preventDefault(); commit(true); }
    else if (e.which === 27) { e.preventDefault(); commit(false); }
  }).on('blur', function () { commit(true); })
    .on('click', function (e) { e.stopPropagation(); });
}

function strokeLayerSetColor(id, ci) {
  var l = strokeLayerById(id);
  if (!l) return;
  l.ci = ci;
  strokeLayersSave();
  strokeRefreshLayerUI();
  strokeRepaint();
}

// Swatch popover, anchored to the row that opened it.
function strokeLayerColorPicker(id, anchor) {
  $('#cd-layer-colors').remove();
  var $pop = $('<div id="cd-layer-colors" class="cd-layer-colors"></div>');
  STROKE_LAYER_COLORS.forEach(function (c, i) {
    $pop.append('<button type="button" class="cd-layer-color" data-ci="' + i + '" ' +
      'aria-label="Colour ' + (i + 1) + '" style="background:' + strokeLayerRgb(i) + '"></button>');
  });
  $('#cd-plot-target').append($pop);

  var pr = anchor.getBoundingClientRect();
  var wr = document.getElementById('cd-plot-target').getBoundingClientRect();
  $pop.css({ top: (pr.bottom - wr.top + 4) + 'px', left: (pr.left - wr.left) + 'px' });

  $pop.on('click', '.cd-layer-color', function (e) {
    e.stopPropagation();
    strokeLayerSetColor(id, parseInt($(this).data('ci'), 10));
    $pop.remove();
  });
  setTimeout(function () {
    $(document).one('click', function () { $('#cd-layer-colors').remove(); });
  }, 0);
}

// Open a layer for editing: switch to edit mode and restore its strokes as the
// working selection.
function strokeLayerEdit(id) {
  var l = strokeLayerById(id);
  if (!l) return;
  // Never depend on prior state: build the strokes if they are not there yet,
  // and bail with a message rather than silently doing nothing.
  if (!strokeEnsureBuilt()) {
    Metro.toast.create('No strokes found in this file.', null, 3000, 'bg-orange');
    return;
  }
  strokeEditingLayerId = id;
  strokeSetMode('edit');
  strokeSelectAllQuiet(false);
  for (var k in l.sel) if (strokes[k]) strokeSet(Number(k), true);
  strokeUndoStack = [];
  strokeRangeClearMarks();
  strokeRepaint();
  strokeUpdateStats();
  strokeRefreshLayerUI();
}

function strokeLayerEditDone() {
  strokeCommitToLayer();
  // Finishing a version arms it. You just decided what it holds, so it is what
  // you meant to plot — dropping back to MAIN made every new version take a
  // second press to become the thing you had only just built.
  if (strokeEditingLayerId && strokeLayerById(strokeEditingLayerId)) {
    strokePlotLayerId = strokeEditingLayerId;
  }
  strokeEditingLayerId = null;
  strokeSetMode('view');   // refreshes the list and repaints
  strokeRefreshPanelVisibility();
}

function strokeSelectAllQuiet(on) {
  strokeSelection = {};
  strokeSelectionCount = 0;
  if (on) for (var i = 0; i < strokes.length; i++) strokeSet(i, true);
}

// Selecting decides what START draws, and nothing else. Editing is a separate
// press on the row that is already selected — selecting used to open the editor
// too, which meant you could not simply choose what to plot.
function strokeSetPlotLayer(id) {
  if (strokeMode === 'edit') strokeLayerEditDone();
  strokePlotLayerId = strokeLayerById(id) ? id : null;
  strokeRefreshLayerUI();
  strokeRepaint();
}

function strokeLayerColor(i) {
  return STROKE_LAYER_COLORS[i % STROKE_LAYER_COLORS.length];
}

// A layer's own colour if one was chosen, else its position in the palette.
function strokeLayerColorOf(l, idx) {
  return strokeLayerColor((l && l.ci !== undefined) ? l.ci : idx);
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

  // Unchosen rows are a list to scan, so they carry one number.
  function metaLine(count, len, isMain) {
    if (isMain) return total ? total.toLocaleString() + ' strokes' : 'no file loaded';
    if (!count) return 'empty';
    return (len / 1000).toFixed(2) + ' m';
  }

  // The chosen row is the answer to "what is about to be drawn", so it spells it
  // out instead of leaving you to infer it from one figure.
  function detailLine(count, len, isMain) {
    if (isMain) return total ? 'whole file · ' + total.toLocaleString() + ' strokes' : 'no file loaded';
    if (!count) return 'no strokes yet — nothing would be drawn';
    return (len / 1000).toFixed(2) + ' m · ' + count.toLocaleString() +
      ' of ' + (total || '?').toLocaleString() + ' strokes';
  }

  // Unchosen rows are one compact line. The chosen one grows into a two-line
  // card: it is the only row that decides what the machine does, so it should
  // not look like the rest of the list. Every action lives in ⋯ — a button on
  // the row competed with the row's own job, which is being the choice.
  function row(id, name, count, len, rgb, isMain) {
    var plotting = (strokePlotLayerId === id) || (isMain && strokePlotLayerId === null);
    return '<div class="cd-layer-row' + (plotting ? ' is-plotting' : '') +
        '" data-id="' + (id || '') + '" tabindex="0" role="radio" ' +
        'aria-checked="' + (plotting ? 'true' : 'false') + '" ' +
        'title="' + (isMain ? 'Plot the whole file' : 'Plot this version') + '">' +
        '<div class="cd-layer-main">' +
          '<span class="cd-layer-swatch' + (isMain ? ' is-main' : '') + '"' +
            (isMain ? '' : ' data-act="color" role="button" tabindex="0" title="Change this version\'s colour"') +
            (rgb ? ' style="background:' + rgb + '"' : '') + '></span>' +
          '<span class="cd-layer-name">' + $('<i>').text(name).html() + '</span>' +
          (plotting ? '' : '<span class="cd-layer-meta">' + metaLine(count, len, isMain) + '</span>') +
          (isMain ? '' :
            '<button class="cd-layer-btn" data-act="menu" type="button" ' +
              'aria-label="Edit, rename or delete ' + name + '" title="Edit, rename or delete">' +
              '<i class="fas fa-ellipsis-h" data-act="menu"></i></button>') +
        '</div>' +
        (plotting ? '<div class="cd-layer-detail">' + detailLine(count, len, isMain) + '</div>' : '') +
      '</div>';
  }

  var $list = $('#cd-layer-list').attr('role', 'radiogroup').empty();
  $list.append(row(null, 'MAIN', total, 0, null, true));
  strokeLayers.forEach(function (l, i) {
    $list.append(row(l.id, l.name, l.count, l.len, strokeLayerRgb((l.ci !== undefined) ? l.ci : i), false));
  });

  strokeRefreshPanelVisibility();
  $('#cdLayerAdd').prop('disabled', !strokeHasFile())
    .toggleClass('is-primary', strokeLayers.length === 0 && strokeHasFile());

  // No filename here — the top bar already carries it, and repeating it cost
  // this panel a line while telling you nothing new.
  var pl = strokeLayerById(strokePlotLayerId);
  $('#cdStartBtn').text(pl ? '▶ START ' + pl.name.toUpperCase() : '▶ START');
}

// Rename and delete sit behind one overflow button so the row has the width for
// a worded EDIT. Colour keeps its own direct affordance — the swatch.
function strokeLayerMenu(id, anchor) {
  $('#cd-layer-menu').remove();
  var $pop = $('<div id="cd-layer-menu" class="cd-layer-menu">' +
    '<button type="button" data-menu="edit"><i class="fas fa-fw fa-pen"></i> Edit strokes</button>' +
    '<button type="button" data-menu="rename"><i class="fas fa-fw fa-font"></i> Rename</button>' +
    '<button type="button" data-menu="delete" class="is-danger"><i class="fas fa-fw fa-trash"></i> Delete version</button>' +
    '</div>');
  $('#cd-plot-target').append($pop);

  var pr = anchor.getBoundingClientRect();
  var wr = document.getElementById('cd-plot-target').getBoundingClientRect();
  $pop.css({ top: (pr.bottom - wr.top + 4) + 'px', right: (wr.right - pr.right) + 'px' });

  $pop.on('click', 'button', function (e) {
    e.stopPropagation();
    var what = $(this).data('menu');
    $pop.remove();
    if (what === 'edit') strokeLayerEdit(id);
    else if (what === 'rename') strokeLayerRename(id);
    else if (what === 'delete') strokeLayerDelete(id);
  });
  setTimeout(function () {
    $(document).one('click', function () { $('#cd-layer-menu').remove(); });
  }, 0);
}

// ── Painting (single owner) ────────────────────────────────────────────────
//
// Exactly one thing owns the colour buffer at a time, decided by mode. Two
// features writing it with guards is what made edit mode show stale colours.

function strokeRepaint() {
  if (!object || !object.geometry || !object.geometry.attributes.color) return;
  if (strokeMode === 'edit') {
    strokeApplyColors();      // rebuilds the chain itself
  } else {
    strokePaintViewMode();
    strokeVersionTravelBuild();
  }
}


// View mode. Same painter as the editor, so the drawing does not change
// character when you leave edit mode — only which strokes are picked out, and
// the travel moves stay on screen here. A version armed: that version in its
// own colour, the rest dimmed. Nothing armed: the whole file in its original
// colours, because that is what START draws.
function strokePaintViewMode() {
  if (!strokeEnsureBuilt()) {
    if (typeof restoreToolpathColors === 'function') restoreToolpathColors();
    return;
  }
  var pl = strokeLayerById(strokePlotLayerId);
  if (pl) {
    // Only the version, and only its own travel. The file's own pen-up moves
    // join strokes this run will not draw, so showing them drew a plot that
    // does not exist — and the rest of the file dimmed behind it read as
    // "this is also going to be drawn".
    strokePaintBuffer(pl.sel, strokeLayerPaint(pl), true, strokeBgColor());
  } else {
    strokePaintBuffer(null, null, false);
  }
}

// Called by runJobFile: the G-code to stream, or null to plot the whole file.
// Built fresh at plot time so it always uses the current pen heights.
window.strokePartGcodeIfArmed = function () {
  var pl = strokeLayerById(strokePlotLayerId);
  if (!pl) return null;
  if (!strokeEnsureBuilt()) return null;
  return strokeBuildGcode(Object.keys(pl.sel).map(Number).sort(function (a, b) { return a - b; }));
};

// A version is a CUT of the source file, not a re-write of it.
//
// The file already separates every stroke and already carries its own approach:
// the lift, the move across, the priming dip, the pen-down, the feedrates. So a
// version copies those lines out verbatim and drops the strokes it does not
// want. Nothing is re-derived, which is the point — what a version plots is
// byte-for-byte what MAIN would have plotted for the same strokes, at the same
// heights, with the same priming.
//
// The generator this replaces rebuilt each stroke from geometry, so the pen
// heights and the priming came from the app's own settings instead of the file.
// It let you re-tune them without going back through vpype, and that is exactly
// how a version came to plunge on a G0 where the file used G1 F20000, lower the
// pen five times slower, and skip priming entirely when the PUMP button was off.
//
// Every stroke knows the source lines it came from (lineA/lineB), and every
// vertex carries its own line number (indx), so the approach block in front of
// a stroke is the run of lines between the previous stroke's end and this one.
function strokeBuildGcode(keep) {
  if (!keep || !keep.length) return '';
  var lp = object.userData.linePoints;

  var text = (typeof editor !== 'undefined' && editor.session) ? editor.session.getValue() : '';
  if (!text) return '';
  var lines = text.split('\n');

  // The line a vertex sits on, or -1 when the parser could not map it.
  function lineOf(v) {
    var p = lp[v];
    return (p && p.indx !== undefined) ? p.indx : -1;
  }

  var out = [];
  out.push('; === VERSION - ' + keep.length + ' of ' + strokes.length + ' strokes ===');
  out.push('; Lines copied unchanged from ' +
    ((typeof loadedFileName !== 'undefined' && loadedFileName) ? loadedFileName : 'the source file') + '.');
  out.push('; Same coordinates, same pen heights, same priming — so this');
  out.push('; registers with what is already on the sheet. Do NOT re-zero.');
  out.push('');

  // Everything before the first move: units, plane, absolute mode. Copied so the
  // modal state is the file's own rather than a guess about it.
  var firstMove = lineOf(0);
  if (firstMove > 0) out.push.apply(out, lines.slice(0, firstMove));

  keep.forEach(function (idx) {
    var s = strokes[idx];
    if (!s || s.lineB < 0) return;
    // The approach: from just after the previous stroke in the FILE (kept or
    // not) up to the end of this one. That run is this stroke's lift, move,
    // dip and pen-down, exactly as the file wrote them.
    var prev = strokes[idx - 1];
    var from = prev ? lineOf(prev.b + 1) : firstMove;
    if (from < 0) from = s.lineA;
    out.push.apply(out, lines.slice(from, s.lineB + 1));
  });

  // The lift off the final stroke, so the pen does not stay down at the end.
  var last = strokes[keep[keep.length - 1]];
  if (last) {
    var lift = lineOf(last.b + 1);
    if (lift > last.lineB) out.push.apply(out, lines.slice(last.lineB + 1, lift + 1));
  }

  return out.join('\n') + '\n';
}

// The dips do not exist in the file — they are synthesised at plot time — so
// the preview has to draw its own geometry for them. A child of `object` rather
// than a scene member, so it inherits the toolpath's scale and dies with it on
// a re-parse, and so the colour-buffer painters never touch it.

// ── Version travel preview ─────────────────────────────────────────────────
//
// The pen-up moves a chosen version will actually make. They are not in the
// toolpath: the file's travel joins the strokes the FILE draws, in the file's
// order, while a version skips most of them — so plotting one hops between the
// strokes it kept, and those hops exist nowhere until they are built here.
//
// Same order strokeBuildGcode() streams in (index ascending), so the picture
// and the G-code cannot disagree about where the pen goes.

var strokeTravelObj = null;

function strokeVersionTravelClear() {
  if (strokeTravelObj) {
    if (strokeTravelObj.parent) strokeTravelObj.parent.remove(strokeTravelObj);
    if (strokeTravelObj.geometry) strokeTravelObj.geometry.dispose();
    strokeTravelObj = null;
  }
}

// Both ends of a travel segment, read straight off the file's own colour
// buffer.
//
// They have to be the theme's values, not the version's colour, and not those
// values rescaled. The theme writes lines on a 0-200 scale that the shader
// clamps to 1, so MAIN's rapid is a pure (0,200,0) and its ink a pure
// (200,0,0) — and the yellow you see on every pen-down is what those two
// interpolate to: (100,100,0), where red and green both clamp full.
//
// That only works for PURE colours. A version's colour is [0.85,0.10,0.10];
// scaled to the buffer it becomes (170,20,20), whose three components all clamp
// to 1 — white. So the travel chain borrows the file's colours rather than the
// version's, which is also what makes it read as travel.
function strokeToolpathColors() {
  if (!originalToolpathColors || !strokes.length) return null;
  var isInk = {};
  for (var t = 0; t < strokes.length; t++) {
    for (var i = strokes[t].a; i <= strokes[t].b; i++) isInk[i] = true;
  }
  var count = originalToolpathColors.length / 3;
  var at = function (v) {
    return new THREE.Color(
      originalToolpathColors[v * 3],
      originalToolpathColors[v * 3 + 1],
      originalToolpathColors[v * 3 + 2]
    );
  };
  var rapid = null, ink = null;
  for (var v = 0; v < count && (!rapid || !ink); v++) {
    if (isInk[v]) { if (!ink) ink = at(v); }
    else if (!rapid) rapid = at(v);
  }
  return (rapid && ink) ? { rapid: rapid, ink: ink } : null;
}

function strokeVersionTravelBuild() {
  strokeVersionTravelClear();
  if (typeof THREE === 'undefined' || !object || !object.userData || !strokes.length) return;

  // Same chain in both modes — what is being edited and what is armed are the
  // same kind of thing, so they get the same picture. The file's own travel
  // stays hidden either way: that was the clutter, thousands of crossings for
  // strokes this run will not draw. These are the selection's own, and there
  // are as many of them as there are strokes you picked.
  var editing = (strokeMode === 'edit');
  var sel = editing ? strokeSelection : null;
  var layer = editing
    ? strokeLayerById(strokeEditingLayerId)
    : strokeLayerById(strokePlotLayerId);
  if (!editing) {
    if (!layer) return;
    sel = layer.sel;
  }
  if (!sel) return;

  var keep = Object.keys(sel).map(Number).sort(function (a, b) { return a - b; });
  if (!keep.length) return;

  var pal = strokeToolpathColors();
  if (!pal) return;
  var rapid = pal.rapid, inkCol = pal.ink;

  var lp = object.userData.linePoints;
  var zs = object.userData.inch ? (1 / 25.4) : 1;
  var pens = (typeof cdReadPenHeights === 'function') ? cdReadPenHeights() : { up: -15 };
  var zUp = pens.up * zs;

  var pos = [], col = [];
  function seg(ax, ay, az, ac, bx, by, bz, bc) {
    pos.push(ax, ay, az, bx, by, bz);
    col.push(ac.r, ac.g, ac.b, bc.r, bc.g, bc.b);
  }

  // Exactly what strokeBuildGcode() streams between strokes: lift straight up,
  // cross at pen-up height, drop onto the next start. Drawn as three segments
  // with per-vertex colours rather than one flat line, because the yellow you
  // read on this view is not a colour — it is the gradient along the verticals
  // where a rapid meets ink, and a solid green hop has no such gradient.
  keep.forEach(function (idx, n) {
    var st = strokes[idx];
    if (!st) return;
    var a = lp[st.a], b = lp[st.b];
    if (!a || !b) return;

    // Drop onto this stroke.
    seg(a.x, a.y, zUp, rapid, a.x, a.y, a.z, inkCol);

    // Lift off it, and cross to the next one.
    var nextIdx = keep[n + 1];
    var next = (nextIdx !== undefined) ? strokes[nextIdx] : null;
    var nextA = next ? lp[next.a] : null;
    seg(b.x, b.y, b.z, inkCol, b.x, b.y, zUp, rapid);
    if (nextA) seg(b.x, b.y, zUp, rapid, nextA.x, nextA.y, zUp, rapid);
  });
  if (!pos.length) return;

  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // THREE.VertexColors, not true: this build of three.js takes an enum here
  // (NoColors 0 / FaceColors 1 / VertexColors 2), and a boolean leaves the
  // per-vertex colours switched off — the whole chain then draws in the
  // material's default white. 3dview.js builds the toolpath the same way.
  strokeTravelObj = new THREE.LineSegments(geo,
    new THREE.LineBasicMaterial({ vertexColors: THREE.VertexColors }));
  strokeTravelObj.name = 'versiontravel';
  object.add(strokeTravelObj);
}

// ── Wiring ─────────────────────────────────────────────────────────────────

$(document).ready(function () {
  $('#cd-stroke-tools').on('click', '.cd-rail-btn', function () {
    strokeSetTool($(this).data('tool'));
  });

  $('#cd-tool-options').on('click', '.cd-stroke-mode', function () {
    strokeSetPaintMode($(this).data('mode'));
  });

  $('#cdStrokeBrushDown').on('click', function () { strokeBrushResize(0.8); });
  $('#cdStrokeBrushUp').on('click', function () { strokeBrushResize(1.25); });

  $('#cdStrokeRangeFrom, #cdStrokeRangeTo').on('keydown', function (e) {
    if (e.which === 13) $(this).blur();
    else if (e.which === 27) { strokeRangeRefresh(); $(this).blur(); }
  }).on('focus', function () {
    strokeRangeNext = $(this).closest('.cd-range-mark').data('end');
    strokeRangeRefresh();
  }).on('blur', function () {
    strokeRangeSetPos($(this).closest('.cd-range-mark').data('end'), $(this).val());
  });

  // Clicking a marker hands the slider and the next click over to it.
  $('#cd-tool-options').on('click', '.cd-range-mark', function (e) {
    if ($(e.target).is('input')) return;
    strokeRangeNext = $(this).data('end');
    strokeRangeRefresh();
  });

  // Dragging a thumb moves its own end and makes it the active one, so the
  // cone and the step buttons follow whichever you last touched.
  $('#cdStrokeRangeSliderA, #cdStrokeRangeSliderB').on('input', function () {
    var end = $(this).hasClass('is-b') ? 'b' : 'a';
    strokeRangeNext = end;
    var scope = strokeRangeScope();
    if (!scope.length) return;
    var p = Math.max(0, Math.min(scope.length - 1, parseInt(this.value, 10) || 0));
    strokeRangeSet(end, scope[p]);
  });

  $('#cd-tool-options').on('click', '.cd-range-step', function () {
    var slider = document.getElementById(
      strokeRangeNext === 'b' ? 'cdStrokeRangeSliderB' : 'cdStrokeRangeSliderA');
    if (!slider) return;
    var next = Math.max(0, Math.min(parseInt(slider.max, 10),
      (parseInt(slider.value, 10) || 0) + parseInt($(this).data('step'), 10)));
    slider.value = next;
    $(slider).trigger('input');
  });

  $('#cdStrokeRangeReset').on('click', strokeRangeReset);

  $('#cdStrokeAll').on('click', function () { strokeSelectAll(true); strokeCommitToLayer(); });
  $('#cdStrokeNone').on('click', function () { strokeSelectAll(false); strokeCommitToLayer(); });
  $('#cdStrokeInvert').on('click', function () { strokeInvert(); strokeCommitToLayer(); });
  $('#cdLayerAdd').on('click', strokeLayerNew);

  $('#cdStrokeDone').on('click', strokeLayerEditDone);

  // The row arms a version; ⋯ edits, renames or deletes it.
  $('#cd-layer-list').on('click', '.cd-layer-row', function (e) {
    var id = $(this).data('id') || null;
    var act = $(e.target).data('act');
    if (act === 'menu') { e.stopPropagation(); strokeLayerMenu(id, $(e.target).closest('.cd-layer-btn')[0]); return; }
    if (act === 'color') { e.stopPropagation(); strokeLayerColorPicker(id, e.target); return; }
    if ($(e.target).is('input') || $(e.target).attr('contenteditable') === 'true') return;
    strokeSetPlotLayer(id);
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
    if (e.altKey) strokeAltChanged(true);
    if ((e.metaKey || e.ctrlKey) && e.which === 90) { e.preventDefault(); strokeUndo(); }
    else if (e.which === 27) strokeLayerEditDone();
    else if (e.which === 66) strokeSetTool('brush');
    else if (e.which === 88) strokeSetTool('box');
    else if (e.which === 86) strokeSetTool('pick');
    else if (e.which === 82) strokeSetTool('range');
    else if (e.which === 219) strokeBrushResize(0.8);
    else if (e.which === 221) strokeBrushResize(1.25);
    else if (e.which === 65) strokeSetPaintMode('add');
    else if (e.which === 69) strokeSetPaintMode('remove');
  });

  // Alt inverts the mode, so the ring has to flip the moment it is held —
  // waiting for the next pointer move would show the wrong sign for as long as
  // you hold still and think about where to click.
  $(document).on('keyup', function (e) {
    if (strokeEditActive && !e.altKey) strokeAltChanged(false);
  });
});

function strokeAltChanged(alt) {
  if (!strokeLastMove || strokeLastMove.altKey === alt) return;
  strokeLastMove.altKey = alt;
  strokeRefreshCursorState(strokeLastMove);
}
