// Copied from vpype_settings v1.18.0 (a67a0d4, 2026-07-26).
// Diverges intentionally — do not auto-sync.
//
// JS port of build_vpype_command_standard / build_vpype_command_brush
// from vpype_interactive.py. Produces the same argv that the Python script
// would spawn — so a user can move between CLI and GUI freely.

const path = require('path');
const fs = require('fs');
const os = require('os');
const DEFAULTS = require('./defaults');

const PEN_MAP = {
  pump: 'megaplot_with_pump',
  parallel: 'megaplot_with_parallel_pen',
  ecoline: 'megaplot_with_ecoline',
};

const CONFIG_TEMPLATES = {
  '__XY_FEEDRATE__': v => `F${v}`,
  '__PUMP_DWELL__':  v => `P${v}`,
  '__Z_PUMP__':      v => `Z${v}`,
  '__Z_DOWN__':      v => `Z${v}`,
  '__Z_UP__':        v => `Z${v}`,
};

const TEMPLATE_PLACEHOLDERS = [
  ['F10000',  '__XY_FEEDRATE__'],
  ['P0.500',  '__PUMP_DWELL__'],
  ['Z-32',    '__Z_PUMP__'],
  ['Z-30',    '__Z_DOWN__'],
  ['Z-15',    '__Z_UP__'],
];

function script_dir() {
  // The .config files sit flat beside this file. Upstream resolved '..' because
  // this module lived in webui/; that nesting does not exist here, so resolving
  // up would silently miss the configs.
  return __dirname;
}

function renderConfig(baseConfigPath, values) {
  let content = fs.readFileSync(baseConfigPath, 'utf8');
  for (const [orig, placeholder] of TEMPLATE_PLACEHOLDERS) {
    content = content.split(orig).join(placeholder);
  }
  content = content.split('__XY_FEEDRATE__').join(`F${values.xy_feedrate}`);
  content = content.split('__PUMP_DWELL__').join(`P${values.pump_dwell}`);
  content = content.split('__Z_PUMP__').join(`Z${values.z_pump}`);
  content = content.split('__Z_DOWN__').join(`Z${values.z_down}`);
  content = content.split('__Z_UP__').join(`Z${values.z_up}`);
  return content;
}

// Preview builds (one per keystroke) reuse a fixed path and only touch disk
// when the content actually changed, instead of creating and deleting a
// uniquely-named temp file every time. The file surviving is deliberate: it
// keeps the command shown in the UI copy-pasteable into a terminal.
// Real runs still get unique paths, cleaned up when the run ends.
const previewCache = new Map();

function tempPath(kind, ext, preview) {
  if (preview) return path.join(os.tmpdir(), `vpype-studio-preview.${ext}`);
  return path.join(os.tmpdir(), `vpype-studio-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

function writeTemp(p, content, preview) {
  if (preview) {
    if (previewCache.get(p) === content) return p;
    previewCache.set(p, content);
  }
  fs.writeFileSync(p, content);
  return p;
}

function stem(p) {
  return path.basename(p, path.extname(p));
}

// ── SVG layer introspection ─────────────────────────────────────────
// vpype's layer-ID logic extracts the first run of digits from inkscape:label
// (then falls through to id, then file order). When several layers map to the
// same digit (e.g. "Layer 1 — Stroke" + "Layer 1 — Hatch"), vpype merges them.
// describeLayers() reports the layer IDs and names vpype will end up using —
// including the renumbering preprocessSvgIfNeeded() applies on collision — so
// the UI can list, preview filenames for, and deselect the exact same layers.
const layerTagRe = () => /<g\b[^>]*?inkscape:groupmode\s*=\s*"layer"[^>]*>/gi;

function firstDigits(s) {
  const m = String(s || '').match(/\d+/);
  return m ? m[0] : null;
}

// Illustrator (and plain SVG) exports have no inkscape:groupmode — there, vpype
// treats each top-level <g> as a layer, so fall back to those.
function topLevelGroupTags(content) {
  const body = content.replace(/<defs[\s\S]*?<\/defs>/gi, '');
  const re = /<(\/?)g\b([^>]*)>/gi;
  const tags = [];
  let depth = 0, m;
  while ((m = re.exec(body)) !== null) {
    if (m[1] === '/') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) tags.push(m[0]);
    if (!/\/\s*$/.test(m[2])) depth += 1;
  }
  return tags;
}

function describeLayers(content) {
  const inkTags = content.match(layerTagRe()) || [];
  const usingInkscape = inkTags.length > 0;
  const tags = usingInkscape ? inkTags : topLevelGroupTags(content);
  const raw = tags.map((tag, i) => ({
    label: (tag.match(/inkscape:label\s*=\s*"([^"]*)"/i) || [])[1] || '',
    id: (tag.match(/\bid\s*=\s*"([^"]*)"/i) || [])[1] || '',
    index: i + 1,
  }));
  for (const r of raw) r.digits = firstDigits(r.label) ?? firstDigits(r.id);

  // Only inkscape-labelled layers get renumbered — that's all
  // preprocessSvgIfNeeded() rewrites, and the two must agree.
  const seen = new Set();
  let renumbered = false;
  if (usingInkscape && raw.length >= 2) {
    for (const r of raw) {
      if (r.digits === null) continue;
      if (seen.has(r.digits)) { renumbered = true; break; }
      seen.add(r.digits);
    }
  }

  const layers = raw.map(r => ({
    lid: (renumbered || r.digits === null) ? String(r.index) : r.digits,
    // After renumbering, the rewritten label is what vpype puts in %_name%.
    name: renumbered ? (r.label ? `${r.index} - ${r.label}` : String(r.index)) : r.label,
    label: r.label || r.id || `Layer ${r.index}`,
  }));
  return { layers, renumbered };
}

function svgLayers(svgPath) {
  try { return describeLayers(fs.readFileSync(svgPath, 'utf8')); }
  catch { return { layers: [], renumbered: false }; }
}

function preprocessSvgIfNeeded(svgPath, preview) {
  let content;
  try { content = fs.readFileSync(svgPath, 'utf8'); }
  catch { return { path: svgPath, temp: null }; }

  if (!describeLayers(content).renumbered) return { path: svgPath, temp: null };

  // Rewrite each layer's inkscape:label by prefixing a unique sequence number.
  // Order-of-appearance becomes the new vpype layer ID (1, 2, 3, …).
  let i = 0;
  const rewritten = content.replace(layerTagRe(), tag => {
    i += 1;
    const seq = String(i);
    if (/inkscape:label\s*=\s*"[^"]*"/i.test(tag)) {
      return tag.replace(/inkscape:label\s*=\s*"([^"]*)"/i, (_, lbl) => `inkscape:label="${seq} - ${lbl}"`);
    }
    // No label → inject one so the digit logic uses our sequence
    return tag.replace(/<g\b/, `<g inkscape:label="${seq}"`);
  });

  const tmpPath = writeTemp(tempPath('svg', 'svg', preview), rewritten, preview);
  // Preview temps are reused, never deleted — don't report them as cleanup.
  return { path: tmpPath, temp: preview ? null : tmpPath };
}

// Which layers this run keeps / drops. Disabled IDs are intersected with the
// SVG's real layers so a stale selection (restored preset, edited file) can't
// make vpype fail on a layer that no longer exists.
function layerSelection(cfg) {
  const all = svgLayers(cfg.svg_file).layers;
  const disabled = new Set((cfg.disabled_layers || []).map(String));
  const drop = [...new Set(all.filter(l => disabled.has(l.lid)).map(l => l.lid))];
  const keep = all.filter(l => !disabled.has(l.lid));
  return { all, drop, keep };
}

function buildFilename(cfg, prefix = '') {
  const parts = [
    prefix,
    // Kept in the name even though servo is gone: existing gcode on disk is
    // named this way and the two should still sort together.
    'motor',
    cfg.pen_type,
    stem(cfg.svg_file),
    cfg.orientation || 'portrait',
    cfg.linesort ? 'sort' : 'no-sort',
    cfg.flip ? 'flip' : 'no-flip',
    cfg.reverse ? 'REVERSE' : '',
    cfg.merge ? 'merge' : 'no-merge',
    cfg.split_layers ? 'split' : 'single',
  ].filter(Boolean);
  return parts.join('_');
}

// Resolve vpype binary: prefer ~/venv/vpype/bin/vpype, fall back to PATH
function resolveVpype() {
  const venvBin = path.join(os.homedir(), 'venv', 'vpype', 'bin', 'vpype');
  if (fs.existsSync(venvBin)) return venvBin;
  return 'vpype';
}

// The values renderConfig() substitutes into the gwrite profile. One owner, so
// standard and brush cannot template the same config differently.
function templateValues(cfg) {
  return {
    z_up: cfg.z_up ?? DEFAULTS.z_up,
    z_down: cfg.z_down ?? DEFAULTS.z_down,
    z_pump: cfg.z_pump ?? DEFAULTS.z_pump,
    pump_dwell: cfg.pump_dwell ?? DEFAULTS.pump_dwell,
    xy_feedrate: cfg.xy_feedrate ?? DEFAULTS.xy_feedrate,
  };
}

function buildStandard(cfg, preview) {
  const baseConfig = path.join(script_dir(), 'gwrite_motor.config');
  const values = templateValues(cfg);
  const configText = renderConfig(baseConfig, values);
  const configPath = writeTemp(tempPath('config', 'config', preview), configText, preview);
  const filename = buildFilename(cfg);
  const { path: svgPath, temp: tempSvg } = preprocessSvgIfNeeded(cfg.svg_file, preview);

  const cmd = [resolveVpype(), '--config', configPath];
  cmd.push('read', '--no-crop', svgPath);

  const dropped = layerSelection(cfg).drop;
  if (dropped.length) cmd.push('ldelete', dropped.join(','));

  if (cfg.merge) cmd.push('linemerge', '--tolerance', `${DEFAULTS.linemerge_tolerance}mm`);

  const simplifyTol = cfg.simplify_tolerance ?? DEFAULTS.simplify_tolerance;
  cmd.push('linesimplify', '--tolerance', `${simplifyTol}mm`);

  if (cfg.linesort) {
    cmd.push('linesort', '--two-opt');
    if (!cfg.flip) cmd.push('--no-flip');
  }
  if (cfg.reverse) cmd.push('reverse', '--flip');

  if (!cfg.split_layers) cmd.push('lmove', 'all', '1');

  cmd.push('stat');

  const penProfile = PEN_MAP[cfg.pen_type] || PEN_MAP.parallel;

  if (cfg.split_layers) {
    cmd.push('forlayer', 'gwrite', '-p', penProfile, `%_lid%_%_name%_${filename}-.gcode`, 'end');
  } else {
    cmd.push('gwrite', '-p', penProfile, `${filename}.gcode`);
  }
  return {
    cmd, filename, tempSvg,
    tempConfig: preview ? null : configPath,
    configPath, configText, configSource: baseConfig, profile: penProfile,
  };
}

function buildBrush(cfg, preview) {
  const baseConfig = path.join(script_dir(), 'gwrite_motor.config');
  // Rendered to a temp file rather than passed in place: vpype is a child
  // process and cannot read inside app.asar in a packaged build.
  const configText = renderConfig(baseConfig, templateValues(cfg));
  const configFile = writeTemp(tempPath('config', 'config', preview), configText, preview);
  const filename = buildFilename(cfg, 'Brush');
  const { path: svgPath, temp: tempSvg } = preprocessSvgIfNeeded(cfg.svg_file, preview);

  const cmd = [resolveVpype(), '--config', configFile];
  cmd.push('read', '--no-crop', svgPath);

  const dropped = layerSelection(cfg).drop;
  if (dropped.length) cmd.push('ldelete', dropped.join(','));

  if (cfg.merge) cmd.push('linemerge', '--tolerance', `${DEFAULTS.linemerge_tolerance}mm`);

  const simplifyTol = cfg.simplify_tolerance ?? DEFAULTS.simplify_tolerance;
  cmd.push('linesimplify', '--tolerance', `${simplifyTol}mm`);

  if (cfg.linesort) {
    cmd.push('linesort', '--two-opt');
    if (!cfg.flip) cmd.push('--no-flip');
  }
  if (cfg.reverse) cmd.push('reverse', '--flip');

  // Split-layers brush mode requires iterating — not supported in webui MVP.
  // For split-layers, fall back to CLI.
  cmd.push('lmove', 'all', '1');
  cmd.push('stat');

  const mergeTol = cfg.brush_merge_tolerance ?? DEFAULTS.brush_merge_tolerance;
  const zMode = cfg.z_mode || 'position';

  cmd.push(
    'brush',
    // brush_z_* are the brush's own heights. Upstream read cfg.z_up/z_down here
    // and only used brush_z_* as the fallback, so its separate brush Z fields
    // never reached the command — dead controls. Prefer the brush keys, fall
    // back to the pen heights, then to the defaults.
    '--z-up', String(cfg.brush_z_up ?? cfg.z_up ?? DEFAULTS.brush_z_up),
    '--z-down', String(cfg.brush_z_down ?? cfg.z_down ?? DEFAULTS.brush_z_down),
    '--merge-tolerance', String(mergeTol),
  );

  if (zMode === 'svg_spatial') {
    cmd.push('--z-from-svg', cfg.svg_file);
    cmd.push('--z-travel', String(cfg.z_travel ?? DEFAULTS.z_travel));
    cmd.push('--z-smooth-distance', String(cfg.z_smooth_distance ?? DEFAULTS.z_smooth_distance));
  } else {
    cmd.push('--press-distance', String(cfg.press_distance ?? DEFAULTS.press_distance));
    cmd.push('--lift-distance', String(cfg.lift_distance ?? DEFAULTS.lift_distance));
    if (zMode === 'layer_color') cmd.push('--z-from-color');
  }

  if (cfg.enable_refill) {
    cmd.push(
      '--refill-x', String(cfg.refill_x ?? DEFAULTS.refill_x),
      '--refill-y', String(cfg.refill_y ?? DEFAULTS.refill_y),
      '--refill-z', String(cfg.refill_z ?? DEFAULTS.refill_z),
      '--refill-interval', String(cfg.refill_interval ?? DEFAULTS.refill_interval),
      '--refill-dwell', String(cfg.refill_dwell ?? DEFAULTS.refill_dwell),
    );
    if (cfg.enable_wipe) {
      cmd.push(
        '--wipe-x1', String(cfg.wipe_x1 ?? DEFAULTS.wipe_x1),
        '--wipe-y1', String(cfg.wipe_y1 ?? DEFAULTS.wipe_y1),
        '--wipe-x2', String(cfg.wipe_x2 ?? DEFAULTS.wipe_x2),
        '--wipe-y2', String(cfg.wipe_y2 ?? DEFAULTS.wipe_y2),
        '--wipe-z', String(cfg.wipe_z ?? DEFAULTS.wipe_z),
        '--wipe-passes', String(cfg.wipe_passes ?? DEFAULTS.wipe_passes),
      );
    }
  }

  cmd.push('--output', `${filename}.gcode`);
  return {
    cmd, filename, tempSvg,
    tempConfig: preview ? null : configFile,
    configPath: configFile, configText, configSource: baseConfig, profile: null,
  };
}

// preview = true for the live command display: reuse fixed temp paths and skip
// rewriting files whose content hasn't changed.
function build(cfg, { preview = false } = {}) {
  if (!cfg || !cfg.svg_file) throw new Error('Pick an SVG file first.');
  if (!fs.existsSync(cfg.svg_file)) {
    throw new Error(`SVG file no longer exists: ${path.basename(cfg.svg_file)}`);
  }
  const sel = layerSelection(cfg);
  if (sel.all.length && !sel.keep.length) {
    throw new Error('Every layer is turned off — enable at least one to export.');
  }
  if (cfg.mode === 'brush') {
    // buildBrush always collapses to one layer, so a split request produced a
    // single file named "split" — the filename claimed something the output
    // did not do. Normalise instead, so the name matches what is written.
    return buildBrush(Object.assign({}, cfg, { split_layers: false }), preview);
  }
  return buildStandard(cfg, preview);
}

// Format command for display (shell-escape each arg loosely)
function formatCommand(argv) {
  return argv.map(a => {
    if (a === '') return "''";
    if (/[\s"'\\$`]/.test(a)) return `'${a.replace(/'/g, `'\\''`)}'`;
    return a;
  }).join(' ');
}

module.exports = { build, formatCommand, resolveVpype, svgLayers, layerSelection };
