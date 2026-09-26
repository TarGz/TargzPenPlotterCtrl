// Edit Gcode Range — Two methods:
// 1. 3D View scrubber: slider moves cone along toolpath, pick START / END visually
// 2. Editor cursor: click a line in GCODE editor, see coords in banner
//
// START and END are independent markers; the slider drives whichever one is
// active (restartActiveMark). Only the range between them is plotted.

var restartSelectionActive = false;
var restartSelectedLine = -1;
var restartSelectedPointIdx = -1;
var originalToolpathColors = null;
var _restartDebounceTimer = null;
var scrubberOpen = false;

// Range markers. Line numbers are 0-based editor rows; -1 means "not set",
// which for END means "run to the last line".
var restartActiveMark = 'start';
var restartEndLine = -1;
var restartEndPointIdx = -1;

// ============================================================
// 3D VIEW SCRUBBER — primary method
// ============================================================

function openScrubber() {
  if (!object || !object.userData || !object.userData.linePoints || object.userData.linePoints.length < 2) {
    Metro.toast.create('No G-code loaded in 3D view. Open a G-code file first.', null, 5000, 'bg-red');
    return;
  }
  if (simRunning) {
    Metro.toast.create('Stop the simulation first.', null, 3000, 'bg-orange');
    return;
  }

  scrubberOpen = true;
  restartSelectionActive = true;

  var lastIdx = object.userData.linePoints.length - 1;
  var slider = document.getElementById('restartSlider');
  slider.max = lastIdx;
  slider.value = 0;

  // Fresh open: START at the first point, END at the last.
  restartActiveMark = 'start';
  setRestartMark('end', lastIdx);
  setActiveRestartMark('start');

  // Set cone to orange
  if (typeof cone !== 'undefined' && cone) {
    cone.visible = true;
    cone.material = new THREE.MeshPhongMaterial({
      color: 0xff8c00,
      specular: 0xcc6600,
      shininess: 100,
      opacity: 0.8,
      transparent: true
    });
  }

  $('#restartScrubber').show();
  $('#openScrubberBtn').addClass('active');

  // Move to start
  onRestartSliderMove(0);
}

function closeScrubber() {
  scrubberOpen = false;
  restartSelectionActive = false;
  restartSelectedLine = -1;
  restartSelectedPointIdx = -1;
  restartEndLine = -1;
  restartEndPointIdx = -1;

  // Restore cone to blue
  if (typeof cone !== 'undefined' && cone) {
    cone.material = new THREE.MeshPhongMaterial({
      color: 0x0000ff,
      specular: 0x0000ff,
      shininess: 100,
      opacity: 0.6,
      transparent: true
    });
  }

  restoreToolpathColors();
  $('#restartScrubber').hide();
  $('#openScrubberBtn').removeClass('active');

  // Command Deck: close the docked scrub panel and restore the Edit Start
  // trigger if a gcode file is still loaded.
  $('#cd-scrub-panel').hide();
  if (typeof editor !== 'undefined' && editor && editor.session && editor.session.getLength() > 1) {
    $('#cd-scrub-trigger').show();
  }
}

function onRestartSliderMove(value) {
  setRestartMark(restartActiveMark, parseInt(value));
}

// Move one marker to a toolpath point index. Shared by the slider, the step
// buttons and the typed line-number fields.
function setRestartMark(mark, idx) {
  if (!object || !object.userData || !object.userData.linePoints) return;

  var lp = object.userData.linePoints[idx];
  if (!lp) return;

  // Skip fake points — find nearest real point
  if (lp.fake) {
    for (var i = idx + 1; i < object.userData.linePoints.length; i++) {
      if (!object.userData.linePoints[i].fake) {
        lp = object.userData.linePoints[i];
        idx = i;
        break;
      }
    }
  }

  if (mark === 'end') {
    restartEndPointIdx = idx;
    restartEndLine = (lp.indx !== undefined) ? lp.indx : -1;
  } else {
    restartSelectedPointIdx = idx;
    restartSelectedLine = (lp.indx !== undefined) ? lp.indx : -1;
  }

  // Keep the pair ordered — dragging one marker past the other pushes it.
  if (restartEndPointIdx >= 0 && restartSelectedPointIdx >= 0 && restartEndPointIdx < restartSelectedPointIdx) {
    if (mark === 'end') {
      restartSelectedPointIdx = restartEndPointIdx;
      restartSelectedLine = restartEndLine;
    } else {
      restartEndPointIdx = restartSelectedPointIdx;
      restartEndLine = restartSelectedLine;
    }
  }

  if (mark === restartActiveMark) moveRestartCone(lp);
  dimToolpathOutside(restartSelectedPointIdx, restartEndPointIdx);
  refreshRestartMarkFields();
  updateRestartScrubInfo(lp);
}

function moveRestartCone(lp) {
  var x = lp.x, y = lp.y, z = lp.z;
  if (object.userData.inch) {
    x *= 25.4; y *= 25.4; z *= 25.4;
  }

  if (typeof cone !== 'undefined' && cone) {
    cone.position.x = x;
    cone.position.y = y;
    cone.position.z = z;
  }
}

function updateRestartScrubInfo(lp) {
  var lineNum = (lp.indx !== undefined) ? (lp.indx + 1) : '?';
  var gcodeText = '';
  if (lp.indx !== undefined && typeof editor !== 'undefined') {
    gcodeText = editor.session.getLine(lp.indx);
    if (gcodeText && gcodeText.length > 60) gcodeText = gcodeText.substring(0, 60) + '...';
    gcodeText = escapeHtml(gcodeText);
  }

  $('#restartScrubInfo').html(
    '<div class="pc-info-row pc-info-row-pill"><span class="pc-pill">' +
      restartActiveMark.toUpperCase() + ' · Line ' + lineNum + '</span></div>' +
    '<div class="pc-info-row pc-info-row-coords">X:' + lp.x.toFixed(2) + ' Y:' + lp.y.toFixed(2) + ' Z:' + lp.z.toFixed(2) + '</div>' +
    '<div class="pc-info-row pc-info-gcode">' + (gcodeText || '&nbsp;') + '</div>'
  );
}

// Sync the two number inputs + the slider position to the current markers.
// Skips an input the user is currently typing into.
function refreshRestartMarkFields() {
  var $s = $('#cdScrubStartLine');
  var $e = $('#cdScrubEndLine');
  if (typeof editor !== 'undefined' && editor && editor.session) {
    $s.attr('max', editor.session.getLength());
    $e.attr('max', editor.session.getLength());
  }
  if (!$s.is(':focus') && restartSelectedLine >= 0) $s.val(restartSelectedLine + 1);
  if (!$e.is(':focus') && restartEndLine >= 0) $e.val(restartEndLine + 1);

  var slider = document.getElementById('restartSlider');
  if (slider) {
    var idx = (restartActiveMark === 'end') ? restartEndPointIdx : restartSelectedPointIdx;
    if (idx >= 0) slider.value = idx;
    // Paint the left-of-thumb fill (Chrome has no ::-moz-range-progress equivalent)
    var span = slider.max - slider.min;
    var pct = span > 0 ? ((slider.value - slider.min) / span) * 100 : 0;
    slider.style.setProperty('--pc-slider-fill', pct + '%');
  }
}

// Switch which marker the slider drives.
function setActiveRestartMark(mark) {
  restartActiveMark = (mark === 'end') ? 'end' : 'start';
  $('.cd-scrub-mark').removeClass('is-active')
    .filter('[data-mark="' + restartActiveMark + '"]').addClass('is-active');

  var idx = (restartActiveMark === 'end') ? restartEndPointIdx : restartSelectedPointIdx;
  if (idx >= 0 && object && object.userData && object.userData.linePoints[idx]) {
    var lp = object.userData.linePoints[idx];
    moveRestartCone(lp);
    updateRestartScrubInfo(lp);
  }
  refreshRestartMarkFields();
}

// Jump a marker to a typed 1-based editor line. Lines with no toolpath point
// (comments, M-codes) snap forward to the next line that has one.
function setRestartMarkFromLine(mark, lineNumber) {
  if (!object || !object.userData || !object.userData.gcodeLineToPointIndex) return;
  var map = object.userData.gcodeLineToPointIndex;
  var row = parseInt(lineNumber, 10) - 1;
  if (isNaN(row) || row < 0) return;

  var total = (typeof editor !== 'undefined' && editor.session) ? editor.session.getLength() : row + 1;
  for (var r = row; r < total; r++) {
    if (map[r] !== undefined) { setRestartMark(mark, map[r]); return; }
  }
  // Nothing forward of it — fall back to the last motion line before it.
  for (var b = row - 1; b >= 0; b--) {
    if (map[b] !== undefined) { setRestartMark(mark, map[b]); return; }
  }
}

function triggerRestartFromScrubber() {
  if (restartSelectedLine < 0) {
    Metro.toast.create('START is not on a G-code motion line. Move the slider.', null, 3000, 'bg-orange');
    return;
  }
  var startLine = restartSelectedLine + 1; // 0-based to 1-based
  var endLine = restartEndLine >= 0 ? restartEndLine + 1 : -1;
  closeScrubber();
  startFromHere(startLine, endLine);
}


// ============================================================
// EDITOR CURSOR — secondary method (banner in editor tab)
// ============================================================

function initRestartFromPoint() {
  if (typeof editor !== 'undefined' && editor) {
    editor.selection.on('changeCursor', function() {
      clearTimeout(_restartDebounceTimer);
      _restartDebounceTimer = setTimeout(onEditorCursorChange, 150);
    });
  }
}

function onEditorCursorChange() {
  if (!object || !object.userData || !object.userData.gcodeLineToPointIndex) return;
  if (simRunning) return;
  // Don't update editor banner while scrubber is open
  if (scrubberOpen) return;

  // A running job moves the cursor itself: websocket.js calls editor.gotoLine()
  // on every queue tick. Treating that as the operator picking a restart point
  // put the cone on the SOURCE file's point for that line — a position with no
  // relation to where the machine actually is — and set restartSelectionActive,
  // which then stops the real machine position from updating the cone at all.
  // So during a plot the pen marker showed an invented position and froze there.
  if (typeof laststatus !== 'undefined' && laststatus && laststatus.comms &&
      laststatus.comms.connectionStatus >= 3) return;

  // The status check above is not enough on its own: this handler is debounced
  // by 150ms, so the LAST gotoLine() of a job fires after the job has finished
  // and the controller is already idle. That is what painted a false progress
  // at the end of every plot — dimToolpathBefore() blacks out everything before
  // the point, which reads as "already drawn", from a line number that during a
  // layer plot does not even address this geometry.
  if (window.restartIgnoreCursorUntil && Date.now() < window.restartIgnoreCursorUntil) return;

  var row = editor.getCursorPosition().row;
  var pointIdx = object.userData.gcodeLineToPointIndex[row];

  if (pointIdx !== undefined) {
    showRestartSelection(row, pointIdx);
  } else {
    hideRestartBanner();
  }
}

function showRestartSelection(gcodeLineNum, pointIdx) {
  var lp = object.userData.linePoints[pointIdx];
  if (!lp) return;

  restartSelectionActive = true;
  restartSelectedLine = gcodeLineNum;
  restartSelectedPointIdx = pointIdx;

  // Move cone to the selected point
  var x = lp.x, y = lp.y, z = lp.z;
  if (object.userData.inch) {
    x *= 25.4; y *= 25.4; z *= 25.4;
  }

  if (typeof cone !== 'undefined' && cone) {
    cone.position.x = x;
    cone.position.y = y;
    cone.position.z = z;
    cone.visible = true;
    cone.material = new THREE.MeshPhongMaterial({
      color: 0xff8c00,
      specular: 0xcc6600,
      shininess: 100,
      opacity: 0.8,
      transparent: true
    });
  }

  dimToolpathBefore(pointIdx);

  // Show banner in editor tab
  var gcodeText = editor.session.getLine(gcodeLineNum);
  if (gcodeText && gcodeText.length > 50) gcodeText = gcodeText.substring(0, 50) + '...';

  var coordsText = 'X:' + lp.x.toFixed(2) + ' Y:' + lp.y.toFixed(2) + ' Z:' + lp.z.toFixed(2);

  $('#restartBanner').html(
    '<span class="pc-pill">Line ' + (gcodeLineNum + 1) + '</span>' +
    '<span class="pc-info-text">' + coordsText +
      ' <span class="pc-muted" title="' + escapeHtml(editor.session.getLine(gcodeLineNum)) + '">' + escapeHtml(gcodeText) + '</span>' +
    '</span>' +
    '<span class="pc-btn-group">' +
      '<button class="pc-btn pc-btn-primary" onclick="triggerRestartFromHere()" title="Generate recovery G-code from this line"><i class="fas fa-play"></i> Restart from here</button>' +
      '<button class="pc-btn pc-btn-ghost" onclick="showRestartIn3D()" title="Switch to 3D view to see position"><i class="mif-3d-rotation"></i> Show in 3D</button>' +
      '<button class="pc-btn pc-btn-ghost" onclick="clearRestartSelection()" title="Cancel selection"><i class="fas fa-times"></i></button>' +
    '</span>'
  ).show();
}


// ============================================================
// SHARED UTILITIES
// ============================================================

function escapeHtml(text) {
  if (!text) return '';
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

function showRestartIn3D() {
  $('#gcodeviewertab').click();
  if (typeof fixRenderSize === 'function') fixRenderSize();
}

function dimToolpathBefore(pointIdx) {
  dimToolpathOutside(pointIdx, -1);
}

/* ── TWO DIMS, TWO COLOURS, AND THEY ARE NOT THE SAME STATEMENT ────────────
   BLACK is EDIT: you took these strokes out of the run. GREY is LIVE: the pen
   has physically been here. One is your decision and the other is the machine
   reporting, and painting both the same makes a plot in progress look like a
   selection you made. The chip in the view strip names which mode is on. */
var TOOLPATH_DIM_EDIT = [0, 0, 0];
// DRAWN lives in the theme beside travel and feed — it is a state of the line,
// not a local shade this file happened to pick.
function toolpathDrawnColour() {
  var c = Theme.DRAWN_COLOR;
  return [c.R, c.G, c.B];
}

// Paint everything outside [startIdx, endIdx] in `rgb` — that part is already
// drawn on the sheet. Only the range that will actually be plotted keeps its
// original colours. endIdx < 0 means "to the end".
function dimToolpathOutside(startIdx, endIdx, rgb) {
  if (!object || !object.geometry || !object.geometry.attributes.color) return;

  var colors = object.geometry.attributes.color;
  var c = rgb || TOOLPATH_DIM_EDIT;

  if (!originalToolpathColors) {
    originalToolpathColors = new Float32Array(colors.array);
  }

  colors.array.set(originalToolpathColors);

  var total = colors.array.length;

  // The colour buffer runs in linePoints order (see convertParsedDataToObject),
  // so the plotted range is [startIdx*3, endIdx*3] and everything either side
  // of it gets dimmed.
  function ghost(from, to) {
    for (var i = Math.max(0, from); i < Math.min(total, to); i += 3) {
      colors.array[i]     = c[0];
      colors.array[i + 1] = c[1];
      colors.array[i + 2] = c[2];
    }
  }

  if (startIdx >= 0) ghost(0, startIdx * 3);
  if (endIdx >= 0) ghost((endIdx + 1) * 3, total);

  colors.needsUpdate = true;
}

/* ── LIVE PLOT PROGRESS ────────────────────────────────────────────────────
   DRIVEN BY THE STREAMER'S OWN LINE COUNT and not by the editor cursor. The
   cursor is moved BY the stream and its watcher is debounced, so the last move
   of a job lands after the job has ended — that is what painted false progress
   at the end of every plot (v1.28.3), and why the cursor path still refuses to
   run while the controller is busy. This reads the number the queue reports,
   once per tick, with no round trip through the editor.

   ONLY FOR A WHOLE-FILE RUN. A layer plot streams gcode this app generated
   from the stroke selection; its line numbers do not address the geometry on
   screen at all, so mapping them onto it would draw a confident picture of
   somewhere the pen has never been. Nothing is painted in that case.

   AND IT NEVER TAKES A BUFFER SOMEBODY ELSE OWNS. `originalToolpathColors` is
   shared with the stroke editor; if that already holds a snapshot, its painting
   is on screen for a reason and this stays out of the way. */
var liveProgressActive = false;

function livePlotPaintable() {
  if (!object || !object.userData || !object.userData.gcodeLineToPointIndex) return false;
  // MAIN is armed when no layer is — anything else is generated gcode.
  if (typeof strokePlotLayerId !== 'undefined' && strokePlotLayerId !== null) return false;
  return liveProgressActive || !originalToolpathColors;
}

function paintLivePlotProgress(gcodeRow) {
  if (!livePlotPaintable()) return;
  var pointIdx = object.userData.gcodeLineToPointIndex[gcodeRow];
  if (pointIdx === undefined) return;
  liveProgressActive = true;
  dimToolpathOutside(pointIdx, -1, toolpathDrawnColour());
}

function clearLivePlotProgress() {
  if (!liveProgressActive) return;
  liveProgressActive = false;
  restoreToolpathColors();
}

window.paintLivePlotProgress = paintLivePlotProgress;
window.clearLivePlotProgress = clearLivePlotProgress;

function restoreToolpathColors() {
  if (!originalToolpathColors || !object || !object.geometry || !object.geometry.attributes.color) return;

  var colors = object.geometry.attributes.color;
  colors.array.set(originalToolpathColors);
  colors.needsUpdate = true;
  originalToolpathColors = null;
}

function clearRestartSelection() {
  restartSelectionActive = false;
  restartSelectedLine = -1;
  restartSelectedPointIdx = -1;
  restartEndLine = -1;
  restartEndPointIdx = -1;

  if (typeof cone !== 'undefined' && cone) {
    cone.material = new THREE.MeshPhongMaterial({
      color: 0x0000ff,
      specular: 0x0000ff,
      shininess: 100,
      opacity: 0.6,
      transparent: true
    });
  }

  restoreToolpathColors();
  hideRestartBanner();
}

function hideRestartBanner() {
  $('#restartBanner').hide();
}

function triggerRestartFromHere() {
  if (restartSelectedLine < 0) return;
  var lineNumber = restartSelectedLine + 1;
  clearRestartSelection();
  startFromHere(lineNumber);
}

// Reset state when a new gcode file is loaded
function onGcodeReloaded() {
  originalToolpathColors = null;
  restartSelectionActive = false;
  restartSelectedLine = -1;
  restartSelectedPointIdx = -1;
  restartEndLine = -1;
  restartEndPointIdx = -1;
  restartActiveMark = 'start';
  scrubberOpen = false;
  hideRestartBanner();
  $('#restartScrubber').hide();
  $('#openScrubberBtn').removeClass('active');
}

// Initialize when DOM is ready
$(document).ready(function() {
  setTimeout(initRestartFromPoint, 1000);
});
