// SVG → G-code panel. Drives /api/vpype/* and loads the result straight into
// the viewer, so generating and plotting are one window.
//
// Field state lives in the DOM: every control carries data-field, and readForm()
// walks them. One reader, so the command preview, the run payload and the saved
// preset cannot describe different settings.

var vpypeSvg = null;        // absolute path of the chosen SVG
var vpypeLayers = [];       // [{lid, name, label}]
var vpypeDisabled = {};     // lid -> true when unticked
var vpypeDefaults = {};
var vpypeRunning = false;
var vpypeLastOutputs = [];  // {name, path} from the most recent run

function vpypeEl(id) { return document.getElementById(id); }

// ── Form state ─────────────────────────────────────────────────────────────

function vpypeReadForm() {
  var cfg = Object.assign({}, vpypeDefaults);

  document.querySelectorAll('#cd-vpype-layout [data-field]').forEach(function (el) {
    var key = el.getAttribute('data-field');
    if (el.classList.contains('cd-vpype-seg')) {
      var on = el.querySelector('.cd-mode-btn.is-active');
      if (on) {
        var v = on.getAttribute('data-value');
        cfg[key] = (v === 'true') ? true : (v === 'false') ? false : v;
      }
    } else if (el.type === 'checkbox') {
      cfg[key] = el.checked;
    } else if (el.value !== '') {
      cfg[key] = el.value;
    }
  });

  cfg.svg_file = vpypeSvg;
  cfg.orientation = cfg.orientation || 'portrait';
  cfg.disabled_layers = vpypeLayers.map(function (l) { return l.lid; })
    .filter(function (lid) { return vpypeDisabled[lid]; });
  return cfg;
}

function vpypeWriteForm(values) {
  if (!values) return;
  document.querySelectorAll('#cd-vpype-layout [data-field]').forEach(function (el) {
    var key = el.getAttribute('data-field');
    if (!(key in values)) return;
    var v = values[key];
    if (el.classList.contains('cd-vpype-seg')) {
      el.querySelectorAll('.cd-mode-btn').forEach(function (b) {
        b.classList.toggle('is-active', b.getAttribute('data-value') === String(v));
      });
    } else if (el.type === 'checkbox') {
      el.checked = !!v;
    } else {
      el.value = v;
    }
  });
}

// Rows appear only when they apply. An element may carry several gates at once
// (the re-pump interval is both pump-only and checkbox-gated), so every gate is
// evaluated per element and ANDed — setting display once per gate would let the
// last one win and show a row its own gate had rejected.
function vpypeGatePasses(el, cfg) {
  var only = el.getAttribute('data-only');
  if (only !== null && only !== cfg.mode) return false;

  var pen = el.getAttribute('data-pen');
  if (pen !== null && pen.split(' ').indexOf(cfg.pen_type) < 0) return false;

  var zmode = el.getAttribute('data-zmode');
  if (zmode !== null && zmode.split(' ').indexOf(cfg.z_mode) < 0) return false;

  var needs = el.getAttribute('data-needs');
  if (needs !== null && !needs.split(' ').every(function (k) { return !!cfg[k]; })) return false;

  return true;
}

function vpypeApplyVisibility() {
  var cfg = vpypeReadForm();
  document.querySelectorAll('#cd-vpype-layout [data-only], #cd-vpype-layout [data-pen], #cd-vpype-layout [data-zmode], #cd-vpype-layout [data-needs]')
    .forEach(function (el) {
      el.style.display = vpypeGatePasses(el, cfg) ? '' : 'none';
    });
}

// ── Pen heights: one source with the jog panel ─────────────────────────────

function vpypeSyncPenHeights() {
  if (typeof cdReadPenHeights !== 'function') return;
  var p = cdReadPenHeights();
  vpypeWriteForm({ z_up: p.up, z_down: p.down, z_pump: p.pump });
}

// ── Status / log ───────────────────────────────────────────────────────────

function vpypeStatus(msg, kind) {
  var el = vpypeEl('cd-vpype-status');
  el.textContent = msg || '';
  el.className = 'cd-vpype-status' + (kind ? ' is-' + kind : '');
}

function vpypeLog(line, isErr) {
  var box = vpypeEl('cd-vpype-log');
  box.style.display = '';
  var span = document.createElement('span');
  if (isErr) span.className = 'is-err';
  span.textContent = line;
  box.appendChild(span);
  box.scrollTop = box.scrollHeight;
}

// ── Health ─────────────────────────────────────────────────────────────────

function vpypeRenderHealth(h) {
  var card = vpypeEl('cd-vpype-setup');
  if (h && h.ok) {
    card.style.display = 'none';
    vpypeEl('cd-vpype-fields').style.display = '';
    return true;
  }
  card.style.display = '';
  vpypeEl('cd-vpype-fields').style.display = 'none';
  vpypeEl('cdVpypeRun').disabled = true;

  var title = vpypeEl('cdVpypeSetupTitle');
  var body = vpypeEl('cdVpypeSetupBody');
  var cmdWrap = vpypeEl('cdVpypeSetupCmdWrap');
  var cmd = vpypeEl('cdVpypeSetupCmd');

  if (!h) {
    title.textContent = 'Could not reach the app server';
    body.textContent = 'The vpype check did not answer. Restart the app and try again.';
    cmdWrap.style.display = 'none';
    return false;
  }

  if (h.reason === 'plugins-missing') {
    title.textContent = 'vpype is missing a plugin';
    body.textContent = 'vpype ' + h.vpype + ' is installed, but ' +
      h.missing.map(function (m) { return m === 'gcode' ? 'gwrite (vpype-gcode)' : 'brush (vpype-brush)'; }).join(' and ') +
      ' did not respond. Re-running the installer adds them.';
  } else {
    title.textContent = 'vpype is not installed';
    body.textContent = 'Nothing runnable at ' + h.bin + '. The installer creates the venv at ' +
      h.venvDir + ' and adds vpype, vpype-gcode and vpype-brush.';
  }

  // Copy, not run: install.sh prompts for the venv and edits ~/.zshrc, so it
  // needs a terminal.
  cmd.textContent = h.repoDir
    ? 'cd ' + h.repoDir + ' && ./install.sh'
    : 'python3 -m venv ' + h.venvDir + ' && ' + h.venvDir + '/bin/pip install vpype vpype-gcode git+https://github.com/TarGz/vpype-brush.git';
  cmdWrap.style.display = '';
  return false;
}

function vpypeCheckHealth(recheck) {
  return fetch('/api/vpype/health' + (recheck ? '?recheck=1' : ''))
    .then(function (r) { return r.json(); })
    .then(function (h) { return vpypeRenderHealth(h); })
    .catch(function () { return vpypeRenderHealth(null); });
}

// ── Layers ─────────────────────────────────────────────────────────────────

function vpypeRenderLayers() {
  var list = vpypeEl('cd-vpype-layers');
  var empty = vpypeEl('cd-vpype-layers-empty');
  list.innerHTML = '';
  empty.style.display = vpypeLayers.length ? 'none' : '';

  vpypeLayers.forEach(function (l) {
    var on = !vpypeDisabled[l.lid];
    var row = document.createElement('label');
    row.className = 'cd-vpype-layer' + (on ? '' : ' is-off');

    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = on;
    cb.addEventListener('change', function () {
      vpypeDisabled[l.lid] = !cb.checked;
      vpypeRenderLayers();
      vpypeRefreshCommand();
    });

    var lid = document.createElement('span');
    lid.className = 'cd-vpype-layer-lid';
    lid.textContent = l.lid;

    var name = document.createElement('span');
    name.className = 'cd-vpype-layer-name';
    name.textContent = l.label;

    row.appendChild(cb); row.appendChild(lid); row.appendChild(name);
    list.appendChild(row);
  });
}

function vpypeLoadSvg(p) {
  vpypeSvg = p;
  vpypeDisabled = {};
  vpypeLastOutputs = [];
  vpypeEl('cd-vpype-results').style.display = 'none';

  var name = vpypeEl('cdVpypeFileName');
  name.textContent = p || 'No SVG selected';
  name.classList.toggle('is-empty', !p);
  vpypeEl('cdVpypeRun').disabled = !p;
  if (!p) { vpypeLayers = []; vpypeRenderLayers(); return; }

  var q = encodeURIComponent(p);
  fetch('/api/vpype/layers?svg=' + q)
    .then(function (r) { return r.json(); })
    .then(function (d) { vpypeLayers = d.layers || []; vpypeRenderLayers(); })
    .catch(function () { vpypeLayers = []; vpypeRenderLayers(); });

  // Restore whatever this SVG was last exported with — the preset file the
  // Python CLI and Vpype Studio also read.
  fetch('/api/vpype/last-run?svg=' + q)
    .then(function (r) { return r.json(); })
    .then(function (last) {
      if (last && Object.keys(last).length) {
        vpypeWriteForm(last);
        if (Array.isArray(last.disabled_layers)) {
          last.disabled_layers.forEach(function (lid) { vpypeDisabled[lid] = true; });
          vpypeRenderLayers();
        }
        vpypeStatus('Restored last settings for this SVG');
      }
      vpypeApplyVisibility();
      vpypeRefreshCommand();
    })
    .catch(function () { vpypeApplyVisibility(); vpypeRefreshCommand(); });
}

// ── Command preview ────────────────────────────────────────────────────────

var vpypeCmdTimer = null;

function vpypeRefreshCommand() {
  clearTimeout(vpypeCmdTimer);
  vpypeCmdTimer = setTimeout(function () {
    var box = vpypeEl('cd-vpype-command');
    if (!vpypeSvg) { box.textContent = 'Choose an SVG.'; box.className = 'cd-vpype-command'; return; }
    fetch('/api/vpype/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vpypeReadForm())
    })
      .then(function (r) { return r.json().then(function (d) { return [r.ok, d]; }); })
      .then(function (pair) {
        box.className = 'cd-vpype-command' + (pair[0] ? '' : ' is-error');
        box.textContent = pair[0] ? pair[1].command : pair[1].error;
        vpypeEl('cdVpypeRun').disabled = !pair[0] || vpypeRunning;
      })
      .catch(function (e) {
        box.className = 'cd-vpype-command is-error';
        box.textContent = e.message;
      });
  }, 150);
}

// ── Run ────────────────────────────────────────────────────────────────────

function vpypeSetRunning(on) {
  vpypeRunning = on;
  vpypeEl('cdVpypeRun').disabled = on || !vpypeSvg;
  vpypeEl('cdVpypeRun').textContent = on ? 'RUNNING…' : 'GENERATE';
  vpypeEl('cdVpypeCancel').style.display = on ? '' : 'none';
}

function vpypeRun() {
  if (vpypeRunning || !vpypeSvg) return;
  vpypeEl('cd-vpype-log').innerHTML = '';
  vpypeEl('cd-vpype-log').style.display = 'none';
  vpypeEl('cd-vpype-results').style.display = 'none';
  vpypeSetRunning(true);
  vpypeStatus('Starting vpype…');

  fetch('/api/vpype/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(vpypeReadForm())
  })
    .then(function (r) { return r.json().then(function (d) { return [r.status, d]; }); })
    .then(function (pair) {
      if (pair[0] === 200) return;
      vpypeSetRunning(false);
      // 412 carries the health payload, so a broken install explains itself
      // instead of just failing.
      if (pair[0] === 412 && pair[1].health) { vpypeRenderHealth(pair[1].health); return; }
      vpypeStatus(pair[1].error || ('Run failed (' + pair[0] + ')'), 'bad');
    })
    .catch(function (e) { vpypeSetRunning(false); vpypeStatus(e.message, 'bad'); });
}

function vpypeRenderResults(outputs, paths, dir) {
  var box = vpypeEl('cd-vpype-results');
  box.innerHTML = '';
  vpypeLastOutputs = outputs.map(function (n, i) { return { name: n, path: paths[i] }; });
  if (!outputs.length) { box.style.display = 'none'; return; }
  box.style.display = '';

  vpypeLastOutputs.forEach(function (o) {
    var row = document.createElement('div');
    row.className = 'cd-vpype-result';

    var name = document.createElement('span');
    name.className = 'cd-vpype-result-name';
    name.textContent = o.name;

    var btn = document.createElement('button');
    btn.className = 'cd-vpype-mini cd-vpype-mini-accent';
    btn.type = 'button';
    btn.textContent = 'LOAD';
    btn.addEventListener('click', function () { vpypeLoadResult(o.path); });

    row.appendChild(name); row.appendChild(btn);
    box.appendChild(row);
  });
}

// Hand the file to the main process, which delivers it back over the same
// 'gcodeupload' path a File > Open uses — so the viewer, the stroke index and
// the plot target all refresh exactly as they normally do.
function vpypeLoadResult(p) {
  if (typeof socket === 'undefined' || !socket) { vpypeStatus('Not connected', 'bad'); return; }
  socket.emit('vpypeLoadGcode', p);
  if (typeof cdShowView === 'function') cdShowView('machine');
}

// ── View ───────────────────────────────────────────────────────────────────

// Called by cdShowVpype() in commanddeck.js once the view is visible. Health is
// re-read on every entry rather than once at boot, so installing vpype in
// another terminal and coming back just works.
window.vpypeOnShow = function () {
  vpypeCheckHealth(false).then(function (ok) {
    if (!ok) return;
    vpypeSyncPenHeights();
    vpypeApplyVisibility();
    vpypeRefreshCommand();
  });
};

// ── Wiring ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
  if (!vpypeEl('cd-vpype-layout')) return;

  fetch('/api/vpype/defaults')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      vpypeDefaults = d.defaults || {};
      vpypeWriteForm(vpypeDefaults);
      vpypeSyncPenHeights();
      vpypeApplyVisibility();
    })
    .catch(function () {});

  vpypeEl('cdVpypeRun').addEventListener('click', vpypeRun);
  vpypeEl('cdVpypeRecheck').addEventListener('click', function () { vpypeCheckHealth(true); });

  vpypeEl('cdVpypeCancel').addEventListener('click', function () {
    fetch('/api/vpype/cancel', { method: 'POST' });
  });

  vpypeEl('cdVpypeSetupCopy').addEventListener('click', function () {
    var t = vpypeEl('cdVpypeSetupCmd').textContent;
    navigator.clipboard.writeText(t).then(function () {
      vpypeEl('cdVpypeSetupCopy').textContent = 'COPIED';
      setTimeout(function () { vpypeEl('cdVpypeSetupCopy').textContent = 'COPY'; }, 1200);
    });
  });

  // Same dialog as the topbar OPEN button — one way to choose a file, and
  // Electron owns it, so no osascript and it works off macOS.
  vpypeEl('cdVpypePick').addEventListener('click', function () {
    if (typeof socket === 'undefined' || !socket) return;
    socket.emit('openFile');
  });

  // Segmented controls
  vpypeEl('cd-vpype-layout').addEventListener('click', function (e) {
    var btn = e.target.closest('.cd-vpype-seg .cd-mode-btn');
    if (!btn) return;
    var seg = btn.parentElement;
    seg.querySelectorAll('.cd-mode-btn').forEach(function (b) { b.classList.remove('is-active'); });
    btn.classList.add('is-active');
    vpypeApplyVisibility();
    vpypeRefreshCommand();
  });

  vpypeEl('cd-vpype-layout').addEventListener('change', function (e) {
    if (!e.target.matches('[data-field]')) return;
    vpypeApplyVisibility();
    vpypeRefreshCommand();
  });
  vpypeEl('cd-vpype-layout').addEventListener('input', function (e) {
    if (e.target.matches('input[type=number][data-field]')) vpypeRefreshCommand();
  });

  vpypeBindSocket();
});

// websocket.js creates `socket` inside jQuery's document.ready, which is the
// same phase as DOMContentLoaded — the order between them is not guaranteed, so
// wait for it rather than binding into undefined and silently receiving nothing.
function vpypeBindSocket() {
  if (typeof socket === 'undefined' || !socket) { setTimeout(vpypeBindSocket, 200); return; }

  socket.on('vpypeSvgPicked', function (p) {
    if (!p) return;
    // Choosing an SVG from the topbar means "work on this", so bring the view
    // forward rather than loading it into a tab nobody is looking at.
    if (typeof cdShowView === 'function') cdShowView('vpype');
    vpypeLoadSvg(p);
  });

  socket.on('vpype:start', function (d) { vpypeStatus('Running — ' + d.filename); });
  socket.on('vpype:stdout', function (d) { vpypeLog(d.line, false); });
  socket.on('vpype:stderr', function (d) { vpypeLog(d.line, true); });
  socket.on('vpype:error', function (d) { vpypeLog(d.message + '\n', true); });

  socket.on('vpype:end', function (d) {
    vpypeSetRunning(false);
    if (d.code === 0) {
      vpypeStatus(d.outputs.length + ' file(s) written', 'good');
      vpypeRenderResults(d.outputs, d.paths, d.dir);
    } else {
      vpypeStatus('vpype exited ' + d.code, 'bad');
    }
  });
}
