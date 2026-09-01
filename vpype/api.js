// Ported from vpype_settings v1.18.0 webui/server.js (a67a0d4, 2026-07-26).
// Diverges intentionally — do not auto-sync.
//
// The run route streams over socket.io instead of SSE: the renderer is already
// on a socket, so a second streaming transport would be a second thing to keep
// alive and reconnect.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { build, formatCommand, resolveVpype, svgLayers } = require('./command-builder');
const DEFAULTS = require('./defaults');

const SETTINGS_FILENAME = 'vpype_last_run.json';
const PUMP_SCRIPT = path.join(__dirname, 'vpype_pump_interval.py');

// Where install.sh puts things, and where the repo conventionally lives. Only
// used to tell the user how to fix a broken install — nothing is read from it.
const VENV_DIR = path.join(os.homedir(), 'venv', 'vpype');
const REPO_DIR = path.join(os.homedir(), 'Documents', 'GIT', '_penPlotting', 'vpype_settings');

// ── Presets ─────────────────────────────────────────────────────────

function loadLastRun(svgFile) {
  try {
    const f = path.join(path.dirname(svgFile), SETTINGS_FILENAME);
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { return {}; }
}

function saveLastRun(svgFile, data) {
  try {
    fs.writeFileSync(path.join(path.dirname(svgFile), SETTINGS_FILENAME), JSON.stringify(data, null, 2));
    return true;
  } catch { return false; }
}

// ── Outputs ─────────────────────────────────────────────────────────
//
// The mtime check only guards against picking up an unrelated older run that
// happened to share the exact same name. It needs slack: cloud-synced and
// network volumes (kDrive, SMB…) round mtimes down to whole seconds, so a file
// written 200ms into the run can report a timestamp *before* startedAt.
const MTIME_SLACK_MS = 5000;

function collectOutputs(built, cwd, sinceMs) {
  const single = `${built.filename}.gcode`;
  const splitSuffix = `${built.filename}-.gcode`;
  const cutoff = sinceMs - MTIME_SLACK_MS;
  let entries;
  try { entries = fs.readdirSync(cwd); } catch { return []; }
  const found = [];
  for (const name of entries) {
    if (name !== single && !name.endsWith(splitSuffix)) continue;
    const p = path.join(cwd, name);
    try { if (fs.statSync(p).mtimeMs < cutoff) continue; } catch { continue; }
    found.push(p);
  }
  return found.sort();
}

function noOutputMessage(step, built, cwd) {
  return `${step}: no gcode output found in ${cwd}\n`
    + `  expected "${built.filename}.gcode" or "*_${built.filename}-.gcode"\n`;
}

// ── Pump interval post-processing ───────────────────────────────────

function injectPumpIntervals(cfg, built, cwd, sinceMs) {
  const files = collectOutputs(built, cwd, sinceMs);
  if (!files.length) return { ok: false, out: noOutputMessage('Pump interval', built, cwd) };
  if (!fs.existsSync(PUMP_SCRIPT)) {
    return { ok: false, out: `Pump interval: helper script missing at ${PUMP_SCRIPT}\n` };
  }
  const interval = String(parseFloat(cfg.pump_interval) || 0);
  const r = spawnSync('python3', [PUMP_SCRIPT, ...files, '--interval', interval, '--in-place'],
    { cwd, encoding: 'utf8' });
  if (r.error) return { ok: false, out: `Pump interval: ${r.error.message}\n` };
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0) return { ok: false, out: out || `Pump interval: python3 exited ${r.status}\n` };
  return { ok: true, out };
}

function wantsPumpInterval(cfg) {
  return cfg.mode !== 'brush' && cfg.pen_type === 'pump'
    && cfg.enable_pump_interval && parseFloat(cfg.pump_interval) > 0;
}

// ── Health ──────────────────────────────────────────────────────────
//
// This has to EXECUTE the binary. resolveVpype() falls back to the bare string
// 'vpype' when the venv is absent, so an existsSync check reports a plausible
// path on a machine with nothing installed.

let healthCache = null;

function probe(bin, args) {
  try {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 15000 });
    return { ok: !r.error && r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
  } catch (e) {
    return { ok: false, out: e.message };
  }
}

function checkHealth() {
  const bin = resolveVpype();
  const version = probe(bin, ['--version']);
  if (!version.ok) {
    return {
      ok: false, reason: 'not-installed', bin, vpype: null, plugins: {},
      venvDir: VENV_DIR, repoDir: fs.existsSync(REPO_DIR) ? REPO_DIR : null,
      detail: version.out || `Could not run ${bin}`,
    };
  }
  const plugins = {
    gcode: probe(bin, ['gwrite', '--help']).ok,
    brush: probe(bin, ['brush', '--help']).ok,
  };
  const missing = Object.entries(plugins).filter(([, v]) => !v).map(([k]) => k);
  return {
    ok: missing.length === 0,
    reason: missing.length ? 'plugins-missing' : null,
    bin,
    vpype: (version.out.match(/vpype\s+([\d.]+)/i) || [])[1] || version.out,
    plugins, missing,
    venvDir: VENV_DIR, repoDir: fs.existsSync(REPO_DIR) ? REPO_DIR : null,
  };
}

function getHealth(force) {
  if (force || !healthCache) healthCache = checkHealth();
  return healthCache;
}

// ── Mount ───────────────────────────────────────────────────────────

let activeChild = null;

function mountVpypeApi(app, express, io) {
  const json = express.json({ limit: '2mb' });

  app.get('/api/vpype/health', (req, res) => {
    res.json(getHealth(req.query.recheck === '1'));
  });

  app.get('/api/vpype/defaults', (req, res) => {
    res.json({ defaults: DEFAULTS });
  });

  app.get('/api/vpype/layers', (req, res) => {
    const svg = req.query.svg;
    if (!svg || !fs.existsSync(svg)) return res.status(400).json({ error: 'SVG not found' });
    res.json(svgLayers(svg));
  });

  app.get('/api/vpype/last-run', (req, res) => {
    const svg = req.query.svg;
    if (!svg) return res.status(400).json({ error: 'svg required' });
    res.json(loadLastRun(svg));
  });

  app.post('/api/vpype/build', json, (req, res) => {
    try {
      const built = build(req.body, { preview: true });
      res.json({
        command: formatCommand(built.cmd),
        argv: built.cmd,
        filename: built.filename,
        profile: built.profile,
        configText: built.configText,
        configSource: built.configSource,
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/vpype/cancel', (req, res) => {
    if (!activeChild || activeChild.killed) return res.json({ ok: false, error: 'No run in progress' });
    activeChild.kill('SIGTERM');
    const child = activeChild;
    setTimeout(() => { if (child && !child.killed) child.kill('SIGKILL'); }, 1500);
    res.json({ ok: true });
  });

  // Responds immediately; progress arrives on the socket as 'vpype:*'. The
  // HTTP response deliberately does not wait for the run — an 8MB SVG takes
  // seconds and a hung request would look like a dead app.
  app.post('/api/vpype/run', json, (req, res) => {
    const cfg = req.body;

    let built;
    try { built = build(cfg); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    if (activeChild && !activeChild.killed) {
      return res.status(409).json({ error: 'A vpype run is already in progress' });
    }

    const health = getHealth();
    if (!health.ok) return res.status(412).json({ error: 'vpype is not ready', health });

    const [bin, ...args] = built.cmd;
    const cwd = path.dirname(cfg.svg_file);
    if (!fs.existsSync(cfg.svg_file)) {
      return res.status(400).json({ error: `SVG file not found: ${cfg.svg_file}` });
    }

    const emit = (event, data) => io.sockets.emit('vpype:' + event, data);
    const command = formatCommand(built.cmd);
    res.json({ ok: true, command, filename: built.filename });
    emit('start', { command, filename: built.filename });

    const startedAt = Date.now();
    const child = spawn(bin, args, { cwd, env: process.env });
    activeChild = child;

    child.stdout.on('data', d => emit('stdout', { line: d.toString() }));
    child.stderr.on('data', d => emit('stderr', { line: d.toString() }));
    child.on('error', err => emit('error', { message: err.message }));

    child.on('close', code => {
      activeChild = null;

      if (code === 0 && wantsPumpInterval(cfg)) {
        const r = injectPumpIntervals(cfg, built, cwd, startedAt);
        emit(r.ok ? 'stdout' : 'stderr', { line: r.out });
      }

      const outputs = code === 0 ? collectOutputs(built, cwd, startedAt) : [];
      emit('end', {
        code,
        outputs: outputs.map(p => path.basename(p)),
        paths: outputs,
        dir: cwd,
      });

      if (code === 0 && cfg.svg_file) saveLastRun(cfg.svg_file, cfg);
      for (const t of [built.tempConfig, built.tempSvg]) {
        if (t && fs.existsSync(t)) { try { fs.unlinkSync(t); } catch {} }
      }
    });
  });
}

module.exports = { mountVpypeApi, getHealth, loadLastRun, saveLastRun, collectOutputs };
