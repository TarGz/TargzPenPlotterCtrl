// Selection -> SVG, so an edit can be sent back through vpype.
//
// This is a second writer beside strokeBuildGcode(), not a G-code parser: the
// editor already holds geometry (object.userData.linePoints indexed by
// strokes[]), so both walk the same points and differ only in what they emit.
// Keep the two loops in step — a stroke is lp[s.a..s.b] inclusive.
//
// ── Why the Y flip ──────────────────────────────────────────────────────────
// Every gwrite profile sets vertical_flip = true. vpype-gcode implements that
// as a mirror about the *declared page height* (invert_axis(whole_page=True)
// takes bounds (0,0,W,H) from the page, not from the geometry), so writing
//
//     y_svg = H - y_gcode      with the page declared H mm tall
//
// makes gwrite hand back y_out = H - y_svg = y_gcode. Coordinates survive the
// round trip unchanged, which is the whole point: a reprocessed selection has
// to land in register with what is already on the paper.
//
// vpype raises "Cannot flip a document with an undefined page size" without
// width/height, so the page attributes are load-bearing, not decoration.

var STROKE_SVG_MARGIN_MM = 10;

// Page height used for the flip. Derived from the content so the SVG is sane to
// look at; the exact value does not matter as long as the same H is used to
// write and to flip back, which it is — it cancels.
function strokeSvgPageSize(keep) {
  var lp = object.userData.linePoints;
  var maxX = 0, maxY = 0;
  keep.forEach(function (idx) {
    var s = strokes[idx];
    for (var i = s.a; i <= s.b; i++) {
      if (lp[i].x > maxX) maxX = lp[i].x;
      if (lp[i].y > maxY) maxY = lp[i].y;
    }
  });
  return {
    w: Math.ceil(maxX) + STROKE_SVG_MARGIN_MM,
    h: Math.ceil(maxY) + STROKE_SVG_MARGIN_MM
  };
}

// keep: stroke indices, same array strokeBuildGcode() takes.
function strokeBuildSvg(keep) {
  var lp = object.userData.linePoints;
  var page = strokeSvgPageSize(keep);
  var h = page.h;

  var out = '<?xml version="1.0" encoding="UTF-8"?>\n';
  out += '<svg xmlns="http://www.w3.org/2000/svg"';
  out += ' xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"';
  out += ' width="' + page.w + 'mm" height="' + h + 'mm"';
  // 1 user unit = 1 mm, so nothing is scaled on the way through vpype.
  out += ' viewBox="0 0 ' + page.w + ' ' + h + '">\n';
  out += '<!-- ' + keep.length + ' of ' + strokes.length + ' strokes from the editor.\n';
  out += '     y_svg = ' + h + ' - y_gcode, cancelling gwrite vertical_flip. -->\n';
  out += '<g inkscape:groupmode="layer" inkscape:label="1 - selection" id="layer-1">\n';

  keep.forEach(function (idx) {
    var s = strokes[idx];
    var pts = [];
    for (var i = s.a; i <= s.b; i++) {
      pts.push(lp[i].x.toFixed(4) + ',' + (h - lp[i].y).toFixed(4));
    }
    if (pts.length < 2) return;
    out += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#000000" stroke-width="0.3"/>\n';
  });

  out += '</g>\n</svg>\n';
  return out;
}

// The armed layer as SVG, mirroring strokePartGcodeIfArmed(). Returns null when
// nothing is armed — the caller then means "the whole file".
window.strokeSelectionSvgIfArmed = function () {
  var pl = strokeLayerById(strokePlotLayerId);
  if (!pl) return null;
  if (!strokeEnsureBuilt()) return null;
  var keep = Object.keys(pl.sel).map(Number).sort(function (a, b) { return a - b; });
  if (!keep.length) return null;
  return { svg: strokeBuildSvg(keep), strokes: keep.length, name: pl.name };
};

// Every stroke in the file, for reprocessing without an armed layer.
window.strokeWholeFileSvg = function () {
  if (!strokeEnsureBuilt()) return null;
  if (!strokes.length) return null;
  var keep = strokes.map(function (_, i) { return i; });
  return { svg: strokeBuildSvg(keep), strokes: keep.length, name: 'MAIN' };
};
