// Command Deck — interaction layer for the CD layout.
// Bridges new CD elements to existing socket.io/jog/ui plumbing.

$(document).ready(function () {

  // Version badge — fetch from /api/version (Express serves app/ via HTTP, so
  // require('../../version.js') does not resolve reliably in the renderer).
  $.getJSON('/api/version').done(function (v) {
    if (!v) return;
    var ver = v.appVersion || (v.version ? String(v.version).replace(/-targz$/, '') : '');
    if (ver) $('#cdLogoVersion').text('v' + ver);
  });

  // Resize the 3D renderer once the Command Deck layout is in place.
  // Three.js sized itself before flex:1 chained through, leaving a tiny canvas.
  setTimeout(function () {
    if (typeof fixRenderSize === 'function') fixRenderSize();
  }, 200);
  setTimeout(function () {
    if (typeof fixRenderSize === 'function') fixRenderSize();
  }, 800);


  // ─── Step size buttons ───────────────────────────────────────────────────
  $('.cd-step-btn').on('click', function () {
    var step = parseFloat($(this).data('step'));
    if (unit === 'mm') {
      jogdistXYZ = step;
    } else {
      // convert stored mm values to their inch equivalents
      var map = { 0.01: 0.0254, 0.1: 0.0254, 1: 0.254, 10: 2.54, 100: 25.4 };
      jogdistXYZ = map[step] !== undefined ? map[step] : step;
    }
    // sync old dist buttons so existing jog.js logic stays consistent
    var idMap = { 0.01: '#dist01', 0.1: '#dist01', 1: '#dist1', 10: '#dist10', 100: '#dist100' };
    var target = idMap[step];
    if (target) $(target).trigger('click');

    $('.cd-step-btn').removeClass('cd-step-active');
    $(this).addClass('cd-step-active');
  });

  // Sync jogdistXYZ to whichever step button renders as active on load — fixes
  // the mismatch where jog.js defaulted to 10 but the UI highlighted 1.
  setTimeout(function () {
    var $active = $('.cd-step-btn.cd-step-active').first();
    if ($active.length) $active.trigger('click');
  }, 50);

  // Sync the JOG override slider to whatever localStorage persisted last run,
  // so the displayed % matches the real jogRateX/Y/Z multiplier on page load.
  // Without this the CD slider always reads 100 while jogOverride() at startup
  // applied whatever was stored (eg 1 → 40mm/min, feels like a dead jog).
  setTimeout(function () {
    var stored = parseInt(localStorage.getItem('jogOverride'), 10);
    if (!stored || isNaN(stored)) return;
    var $sl = $('#cdJro');
    if (!$sl.length) return;
    var min = parseInt($sl.attr('min') || '1', 10);
    var max = parseInt($sl.attr('max') || '300', 10);
    var clamped = Math.max(min, Math.min(max, stored));
    $sl.val(clamped);
    $('#cdJroVal').text(clamped);
  }, 100);

  // ─── Override nudge (±1) helper ───────────────────────────────────────────
  window.cdNudgeOverride = function (sliderId, valId, delta, fn, min, max) {
    var el = document.getElementById(sliderId);
    var v = Math.max(min, Math.min(max, +el.value + delta));
    el.value = v;
    document.getElementById(valId).textContent = v;
    fn(v);
  };

  // ─── Override value click-to-edit ─────────────────────────────────────────
  // Clicking the % display opens an inline number input; Enter or blur applies.
  $(document).on('click', '.cd-vslider-val', function () {
    var $div = $(this);
    if ($div.find('.cd-vslider-edit').length) return;
    var sliderId = $div.data('slider');
    var fn       = window[$div.data('fn')];
    var min      = +$div.data('min');
    var max      = +$div.data('max');
    var $num     = $div.find('.cd-vslider-num');
    var $unit    = $div.find('.cd-vslider-unit');
    var current  = parseInt($num.text(), 10);
    var $input   = $('<input type="number" class="cd-vslider-edit">').val(current);
    $num.hide(); $unit.hide();
    $div.append($input);
    $input[0].focus(); $input[0].select();
    function apply() {
      var v = parseInt($input.val(), 10);
      if (isNaN(v)) v = current;
      v = Math.max(min, Math.min(max, v));
      document.getElementById(sliderId).value = v;
      $num.text(v).show(); $unit.show();
      $input.off('blur').remove();
      if (typeof fn === 'function') fn(v);
    }
    $input.on('keydown', function (e) {
      if (e.key === 'Enter')  { e.preventDefault(); apply(); }
      if (e.key === 'Escape') { $num.show(); $unit.show(); $input.off('blur').remove(); }
    }).on('blur', apply);
  });

  // ─── Unit toggle (mirror existing mmMode/inMode buttons) ─────────────────
  // The CD unit buttons call mmMode()/inMode() inline — we just sync styling.
  function syncUnitBtns() {
    if (unit === 'mm') {
      $('#cdMmBtn').addClass('cd-unit-active');
      $('#cdInBtn').removeClass('cd-unit-active');
      $('.cdUnitsLabel').text('mm');
    } else {
      $('#cdInBtn').addClass('cd-unit-active');
      $('#cdMmBtn').removeClass('cd-unit-active');
      $('.cdUnitsLabel').text('inch');
    }
  }

  // Patch mmMode/inMode to also sync CD buttons after they run
  var _origMmMode = window.mmMode;
  window.mmMode = function () {
    _origMmMode.apply(this, arguments);
    syncUnitBtns();
  };
  var _origInMode = window.inMode;
  window.inMode = function () {
    _origInMode.apply(this, arguments);
    syncUnitBtns();
  };
  syncUnitBtns(); // initial sync on load

  // ─── Connect / Disconnect button ─────────────────────────────────────────
  $('#cdConnBtn').on('click', function () {
    if ($('#cdConnBtn').hasClass('cd-connected')) {
      cdMarkOperatorStop();
      closePort();
      return;
    }
    var chosen = $('#cdPortSelect').val();
    if (chosen) {
      $('#portUSB').val(chosen);
      selectPort();
    }
  });

  // Alarm banner debounce state — used by cdUpdateConnection below.
  var _lastAlarmShown = false;
  var _alarmShowTimer = null;

  // ─── Port selector: custom dropdown in CD topbar ────────────────────────
  // #cdPortSelect options are populated by populatePortsMenu() (websocket.js)
  // which injects the same HTML it feeds to Metro4. This function just
  // refreshes the visible label / menu after that injection.
  var _cdPortMenuOpen = false;

  function cdSyncPortOptions() {
    var $dst = $('#cdPortSelect');
    if (!$dst.length) return;
    if (_cdPortMenuOpen) return;

    $dst.prop('disabled', false);
    cdPortUpdateLabel();
  }

  function cdPortCurrentOptionText() {
    var $dst = $('#cdPortSelect');
    var v = $dst.val();
    if (!v) return '';
    var $opt = $dst.find('option').filter(function () { return this.value === v; }).first();
    return $opt.length ? $opt.text() : '';
  }

  function cdPortUpdateLabel() {
    var txt = cdPortCurrentOptionText();
    $('#cdPortButtonLabel').text(txt || 'Select a port…');
  }

  function cdPortBuildMenu() {
    var $menu = $('#cdPortMenu');
    var $dst = $('#cdPortSelect');
    var currentVal = $dst.val();
    $menu.empty();

    $dst.children().each(function () {
      var $node = $(this);
      if ($node.is('optgroup')) {
        $menu.append($('<div class="cd-port-menu-group"></div>').text($node.attr('label')));
        var $opts = $node.children('option');
        if (!$opts.length) {
          $menu.append($('<div class="cd-port-menu-item cd-port-menu-item-disabled"></div>').text('—'));
        }
        $opts.each(function () {
          var $o = $(this);
          var val = $o.val();
          var $item = $('<div class="cd-port-menu-item" role="option"></div>')
            .attr('data-value', val)
            .text($o.text());
          if (val === currentVal) $item.addClass('cd-port-menu-item-selected');
          $menu.append($item);
        });
      } else if ($node.is('option')) {
        var v = $node.val();
        var $it = $('<div class="cd-port-menu-item" role="option"></div>')
          .attr('data-value', v)
          .text($node.text());
        if (v === currentVal) $it.addClass('cd-port-menu-item-selected');
        $menu.append($it);
      }
    });
  }

  function cdPortPositionMenu() {
    var btn = document.getElementById('cdPortButton');
    var menu = document.getElementById('cdPortMenu');
    if (!btn || !menu) return;
    var r = btn.getBoundingClientRect();
    menu.style.minWidth = r.width + 'px';
    menu.style.left = r.left + 'px';
    // Prefer below; flip above if it would overflow the viewport.
    var belowSpace = window.innerHeight - r.bottom - 8;
    menu.style.maxHeight = Math.max(160, Math.min(360, belowSpace)) + 'px';
    menu.style.top = (r.bottom + 2) + 'px';
  }

  function cdPortOpenMenu() {
    if (_cdPortMenuOpen) return;
    cdPortBuildMenu();
    _cdPortMenuOpen = true;
    var menu = document.getElementById('cdPortMenu');
    menu.hidden = false;
    $('#cdPortButton').attr('aria-expanded', 'true');
    cdPortPositionMenu();
  }

  function cdPortCloseMenu() {
    if (!_cdPortMenuOpen) return;
    _cdPortMenuOpen = false;
    document.getElementById('cdPortMenu').hidden = true;
    $('#cdPortButton').attr('aria-expanded', 'false');
    // Catch up on any sync we skipped while open.
    cdSyncPortOptions();
  }

  // Delegate from document so timing / element-recreation can't drop the
  // binding, and accept a click anywhere in the wrap (not just the inner
  // <button>) — some Electron/macOS builds have pointer-event quirks on
  // nested buttons that web Chrome doesn't.
  $(document).on('click', '#cdPortCustom', function (e) {
    e.stopPropagation();
    e.preventDefault();
    if (_cdPortMenuOpen) cdPortCloseMenu(); else cdPortOpenMenu();
  });

  $(document).on('click', '#cdPortMenu .cd-port-menu-item', function (e) {
    e.stopPropagation();
    if ($(this).hasClass('cd-port-menu-item-disabled')) return;
    var v = $(this).attr('data-value');
    var $dst = $('#cdPortSelect');
    if ($dst.val() !== v) {
      $dst.val(v).trigger('change');
    }
    cdPortUpdateLabel();
    cdPortCloseMenu();
  });

  $(document).on('mousedown', function (e) {
    if (!_cdPortMenuOpen) return;
    if ($(e.target).closest('#cdPortMenu, #cdPortCustom').length) return;
    cdPortCloseMenu();
  });
  $(document).on('keydown', function (e) {
    if (_cdPortMenuOpen && e.key === 'Escape') cdPortCloseMenu();
  });
  $(window).on('resize scroll', function () {
    if (_cdPortMenuOpen) cdPortPositionMenu();
  });

  cdSyncPortOptions();
  setTimeout(cdSyncPortOptions, 500);
  setInterval(cdSyncPortOptions, 2000);
  window.cdSyncPortOptions = cdSyncPortOptions;

  $('#cdPortSelect').on('change', function () {
    var v = $(this).val();
    cdPortUpdateLabel();
    $('#portUSB').val(v).trigger('change');
  });

  // ─── File open ───────────────────────────────────────────────────────────
  // The original #openGcodeBtn* elements are dropdown toggles, not direct
  // file openers — triggering click on them just opens the Metro dropdown.
  // Call the actual file-open action for the current runtime instead.
  $('#cdFileOpen').on('click', function () {
    if (navigator.userAgent.indexOf('Electron') >= 0) {
      if (typeof socket !== 'undefined' && socket) {
        socket.emit('openFile');
      }
      return;
    }

    // Browser: the original <input type="file" id="file"> lives inside
    // a Metro ribbon-dropdown that's display:none by default, so triggering
    // click() on it from there silently no-ops. Use the native element and
    // temporarily make it reachable, or fall back to a freshly created one.
    var existing = document.getElementById('file');
    if (existing) {
      var prevParent = existing.parentNode;
      var prevParentDisplay = prevParent ? prevParent.style.display : null;
      // Move it out of any hidden ancestor onto <body> just for the click
      document.body.appendChild(existing);
      existing.style.position = 'fixed';
      existing.style.left = '-9999px';
      existing.click();
      // Don't move it back immediately — the 'change' handler may still
      // reference it. It remains functional either way.
      return;
    }

    // Fallback: create a one-shot input
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.gcode,.gc,.tap,.nc,.cnc';
    input.style.display = 'none';
    input.addEventListener('change', function () {
      if (!input.files || !input.files[0]) return;
      var reader = new FileReader();
      reader.onload = function (e) {
        if (typeof editor !== 'undefined' && editor) {
          editor.setValue(e.target.result);
          editor.clearSelection();
          if (typeof parseGcodeInWebWorker === 'function') {
            parseGcodeInWebWorker(editor.getValue());
          }
        }
        loadedFileName = input.files[0].name;
        if (typeof setWindowTitle === 'function') setWindowTitle();
        if (typeof cdUpdateFileState === 'function') cdUpdateFileState(true, loadedFileName);
      };
      reader.readAsText(input.files[0]);
    });
    document.body.appendChild(input);
    input.click();
  });

  $('#cdFileUnload').on('click', function () {
    // Clear editor and reset state
    if (typeof editor !== 'undefined') {
      editor.execCommand('selectall');
      editor.execCommand('del');
      if (typeof parseGcodeInWebWorker === 'function') {
        parseGcodeInWebWorker(editor.getValue());
      }
    }
    loadedFileName = '';
    setWindowTitle();
    cdUpdateFileState(false, '');
  });

  // ─── Alarm unlock ────────────────────────────────────────────────────────
  $('#cdUnlockAlarm').on('click', function () {
    socket.emit('clearAlarm', 2);
  });

  // ─── Pause / Resume toggle ───────────────────────────────────────────────
  $('#cdPauseResumeBtn').on('click', function () {
    if ($(this).hasClass('cd-resuming')) {
      socket.emit('resume', true);
    } else {
      socket.emit('pause', true);
    }
  });

  // ─── Stop ────────────────────────────────────────────────────────────────
  $('#cdStopBtn').on('click', function () {
    cdMarkOperatorStop();
    socket.emit('stop', { stop: true, jog: false, abort: false });
  });

  // ─── Abort (with confirm modal) ──────────────────────────────────────────
  $('#cdAbortBtn').on('click', function () {
    $('#cd-abort-modal').fadeIn(120);
  });

  $('#cdAbortCancel').on('click', function () {
    $('#cd-abort-modal').fadeOut(120);
  });

  $('#cd-abort-modal').on('click', function (e) {
    if (e.target === this) $('#cd-abort-modal').fadeOut(120);
  });

  $('#cdAbortConfirm').on('click', function () {
    cdMarkOperatorStop();
    socket.emit('stop', { stop: false, jog: false, abort: true });
    $('#cd-abort-modal').fadeOut(120);
  });

  // ─── Pen Up / Pen Down (Z-axis based) ────────────────────────────────────
  // Not the servo/M3 "tool" logic from OpenBuilds — on a pen plotter the "pen"
  // is lifted and lowered by commanding Z to a stored absolute height.
  window.cdReadPenHeights = function () {
    var up   = parseFloat(localStorage.getItem('penUpZ'));
    var down = parseFloat(localStorage.getItem('penDownZ'));
    var pump = parseFloat(localStorage.getItem('penPumpZ'));
    // Real machine values, not placeholders. The old 5 / 0 / -2 were nothing
    // like any pen actually used here, so a fresh profile — or a browser whose
    // storage had been cleared — silently plotted at heights that read as
    // plausible defaults while being completely wrong.
    if (isNaN(up))   up   = -15;
    if (isNaN(down)) down = -29;
    if (isNaN(pump)) pump = -35;
    return { up: up, down: down, pump: pump };
  };

  // Pump mode for the layer G-code generator. The depth is the PUMP height the
  // jog panel already owns — this only decides whether, and how often, a layer
  // plot dips to it. 'off' means pen up/down only, which is what a pen that
  // needs no priming wants and what the generator did before.
  window.cdReadPump = function () {
    var z = parseFloat(localStorage.getItem('penPumpZ'));
    var d = parseFloat(localStorage.getItem('pumpDistance'));
    var w = parseFloat(localStorage.getItem('pumpDwell'));
    var mode = localStorage.getItem('pumpMode');
    if (isNaN(z)) z = -35;
    if (isNaN(d) || d <= 0) d = 300;
    if (isNaN(w) || w < 0) w = 500;
    if (mode !== 'line' && mode !== 'dist') mode = 'off';
    return { mode: mode, z: z, distance: d, dwell: w };
  };
  window.cdRefreshPenHints = function () {
    var p = cdReadPenHeights();
    var fmt = function (v) { return v.toFixed(1); };
    // Skip refresh on any span that's currently open for editing.
    var pairs = [['#cdPenUpHint', fmt(p.up)], ['#cdPenDownHint', fmt(p.down)], ['#cdPumpHint', fmt(p.pump)]];
    pairs.forEach(function (pair) {
      var $s = $(pair[0]);
      if (!$s.find('input').length) $s.text(pair[1]);
    });
  };

  // ─── Parking (move to a fixed spot when a job finishes) ──────────────────
  // Lifts the pen to the stored pen-up height for a safe travel, rapids to the
  // park X/Y, then lowers to the park Z (defaults to the pen-down height).
  // The enable toggle is mirrored between the RUN panel and Settings › PARKING.
  window.cdReadParking = function () {
    var pens = cdReadPenHeights();
    var x = parseFloat(localStorage.getItem('parkX'));
    var y = parseFloat(localStorage.getItem('parkY'));
    var z = parseFloat(localStorage.getItem('parkZ'));
    var tz = parseFloat(localStorage.getItem('parkTravelZ'));
    if (isNaN(x)) x = 0;
    if (isNaN(y)) y = 0;
    if (isNaN(z)) z = pens.down;
    if (isNaN(tz)) tz = pens.up;
    return {
      enabled: localStorage.getItem('parkEnabled') === 'true',
      x: x, y: y, z: z, travelZ: tz
    };
  };

  // Called once from the jobComplete handler; no-op unless parking is enabled.
  window.cdRunParkMove = function () {
    var p = cdReadParking();
    if (!p.enabled || typeof sendGcode !== 'function') return;
    sendGcode('G90\nG0 Z' + p.travelZ + '\nG0 X' + p.x + ' Y' + p.y + '\nG0 Z' + p.z);
    if (typeof printLogModern === 'function') {
      printLogModern('', 'PARK', 'Parked at X' + p.x + ' Y' + p.y + ' Z' + p.z, 'fg-darkGreen');
    }
  };

  window.cdRefreshParkToggle = function () {
    $('#cdParkToggle').toggleClass('on', localStorage.getItem('parkEnabled') === 'true');
  };

  $('#cdParkToggleRow').on('click', function (e) {
    e.preventDefault();
    var cur = localStorage.getItem('parkEnabled') === 'true';
    localStorage.setItem('parkEnabled', (!cur).toString());
    cdRefreshParkToggle();
    if (typeof cdRefreshParkingSettings === 'function') cdRefreshParkingSettings();
  });
  cdRefreshParkToggle();

  // ─── Phone notification via ntfy ─────────────────────────────────────────
  // Simplest durable push: a plain HTTP POST to an ntfy topic. No account/keys.
  // Server defaults to the public ntfy.sh but is swappable for a self-hosted one.
  // Title stays ASCII (ntfy header constraint); the filename goes in the body.
  window.cdSendNtfy = function (title, message, cb, opts) {
    var server = (localStorage.getItem('ntfyServer') || 'https://ntfy.sh').replace(/\/+$/, '');
    var topic = localStorage.getItem('ntfyTopic');
    if (!topic) { if (cb) cb(false); return; }
    opts = opts || {};
    var headers = { 'Title': title, 'Tags': opts.tags || 'white_check_mark' };
    if (opts.priority) headers['Priority'] = String(opts.priority);
    fetch(server + '/' + encodeURIComponent(topic), {
      method: 'POST',
      headers: headers,
      body: message
    })
      .then(function (r) { if (cb) cb(r.ok); })
      .catch(function () { if (cb) cb(false); });
  };

  // Called from the jobComplete handler; no-op unless notifications are enabled.
  window.cdNotifyPlotDone = function (filename, ms) {
    if (localStorage.getItem('ntfyEnabled') !== 'true') return;
    var dur = (typeof msToTime === 'function' && ms) ? msToTime(ms) : null;
    var body = (filename || 'Plot') + ' finished' + (dur ? ' in ' + dur : '');
    cdSendNtfy('Plot finished', body);
  };

  // ─── Failure notification ────────────────────────────────────────────────
  // A dropped plot is the case where a push actually matters — you walk away
  // and come back to a half-drawn sheet. One failure produces several signals
  // (disconnect fires, then the stream fails, then jobComplete lands), so
  // collapse anything inside a short window into a single push.
  var _lastFailNotifyAt = 0;
  var _lastFailWasSpecific = false;

  // STOP, ABORT and DISCONNECT end a job exactly the way a dropped USB cable
  // does — the same jobComplete with failed:true, the same drop to
  // disconnected — so the only thing that can tell them apart is knowing a
  // button was pressed. Without this you get a high-priority "Plot stopped"
  // push on your phone for the thing you just did yourself.
  var _cdOperatorStopAt = 0;
  window.cdMarkOperatorStop = function () { _cdOperatorStopAt = Date.now(); };

  // `specific` marks a reason that says what actually happened (disconnect,
  // ALARM) as opposed to the generic "did not finish" the jobComplete handler
  // sends. The generic one usually lands first, so without the override below
  // it was the only push you ever got — and it is the one that tells you least.
  window.cdNotifyPlotFailed = function (reason, specific) {
    if (localStorage.getItem('ntfyEnabled') !== 'true') return;
    if (localStorage.getItem('ntfyFailEnabled') === 'false') return;
    if (Date.now() - _cdOperatorStopAt < 15000) return;

    var now = Date.now();
    if (now - _lastFailNotifyAt >= 20000) _lastFailWasSpecific = false;
    // Keep the first push of a burst, but let a specific reason replace a
    // generic one once inside the window.
    if (now - _lastFailNotifyAt < 20000 && (!specific || _lastFailWasSpecific)) return;
    _lastFailNotifyAt = now;
    if (specific) _lastFailWasSpecific = true;

    var name = (typeof loadedFileName !== 'undefined' && loadedFileName) ? loadedFileName : 'Plot';
    cdSendNtfy('Plot stopped', name + ' — ' + reason, null, {
      tags: 'rotating_light',
      priority: 'high'
    });
  };

  // ─── Z-height edit popover ────────────────────────────────────────────────
  var $zpenPop = $(
    '<div id="cdZpenPopover" class="cd-zpen-popover">' +
      '<div class="cd-zpen-pop-header">' +
        '<span class="cd-zpen-pop-title"></span>' +
        '<button class="cd-zpen-pop-close" type="button">✕</button>' +
      '</div>' +
      '<div class="cd-zpen-pop-body">' +
        '<div class="cd-zpen-pop-field">' +
          '<input type="number" class="cd-zpen-pop-input" step="0.1">' +
          '<span class="cd-zpen-pop-unit">mm</span>' +
        '</div>' +
        '<div class="cd-zpen-pop-nudges">' +
          '<button class="cd-zpen-pop-nudge" type="button" data-delta="-1">−1</button>' +
          '<button class="cd-zpen-pop-nudge" type="button" data-delta="-0.1">−0.1</button>' +
          '<button class="cd-zpen-pop-nudge" type="button" data-delta="0.1">+0.1</button>' +
          '<button class="cd-zpen-pop-nudge" type="button" data-delta="1">+1</button>' +
        '</div>' +
      '</div>' +
      '<div class="cd-zpen-pop-footer">' +
        '<button class="cd-zpen-pop-cancel" type="button">CANCEL</button>' +
        '<button class="cd-zpen-pop-apply" type="button">APPLY</button>' +
      '</div>' +
    '</div>'
  ).appendTo('body');

  var _zpenState = { key: null, min: -50, max: 20, $span: null, orig: 0 };

  function zpenOpen($editBtn) {
    var $span  = $('#' + $editBtn.data('target'));
    var key    = $editBtn.data('key');
    var color  = $editBtn.css('color');
    var val    = parseFloat($span.text());
    var label  = $editBtn.closest('.cd-pen-row').find('.cd-pen-label').text();
    _zpenState = { key: key, min: parseFloat($editBtn.data('min')), max: parseFloat($editBtn.data('max')), $span: $span, orig: val };

    $zpenPop.find('.cd-zpen-pop-title').text(label + ' — Z HEIGHT');
    $zpenPop.find('.cd-zpen-pop-input').val(val.toFixed(1)).css('color', color);
    $zpenPop.find('.cd-zpen-pop-apply').css({ background: color, color: '#fff', border: 'none' });
    $zpenPop.addClass('is-open');

    var rect = $editBtn[0].getBoundingClientRect();
    var pw = 210, ph = 182;
    var top  = rect.top - ph - 8;
    if (top < 8) top = rect.bottom + 8;
    var left = Math.max(8, Math.min(rect.right - pw, window.innerWidth - pw - 8));
    $zpenPop.css({ top: top + 'px', left: left + 'px' });
    $zpenPop.find('.cd-zpen-pop-input')[0].focus();
    $zpenPop.find('.cd-zpen-pop-input')[0].select();
  }

  function zpenApply() {
    var v = parseFloat($zpenPop.find('.cd-zpen-pop-input').val());
    if (isNaN(v)) v = _zpenState.orig;
    v = Math.max(_zpenState.min, Math.min(_zpenState.max, parseFloat(v.toFixed(1))));
    _zpenState.$span.text(v.toFixed(1));
    localStorage.setItem(_zpenState.key, v);
    if (typeof window.cdRefreshPenHints === 'function') window.cdRefreshPenHints();
    $zpenPop.removeClass('is-open');
  }

  function zpenClose() { $zpenPop.removeClass('is-open'); }

  $zpenPop.find('.cd-zpen-pop-apply').on('click', zpenApply);
  $zpenPop.find('.cd-zpen-pop-cancel, .cd-zpen-pop-close').on('click', zpenClose);
  $zpenPop.find('.cd-zpen-pop-nudge').on('click', function () {
    var $inp = $zpenPop.find('.cd-zpen-pop-input');
    var v = parseFloat($inp.val()) + parseFloat($(this).data('delta'));
    v = Math.max(_zpenState.min, Math.min(_zpenState.max, parseFloat(v.toFixed(1))));
    $inp.val(v.toFixed(1));
  });
  $zpenPop.find('.cd-zpen-pop-input').on('keydown', function (e) {
    if (e.key === 'Enter')  { e.preventDefault(); zpenApply(); }
    if (e.key === 'Escape') { zpenClose(); }
  });
  $(document).on('mousedown', function (e) {
    if ($zpenPop.hasClass('is-open') && !$(e.target).closest('#cdZpenPopover, .cd-zpen-edit-btn').length) {
      zpenClose();
    }
  });

  $('.cd-pen-edit-trigger').on('click', function () {
    zpenOpen($(this));
  });
  cdRefreshPenHints();
  // These three move to a height and STOP. Nothing else. No dwell, no return
  // move, no unit word beyond what was always here — the jog panel drives a
  // physical machine by hand and is not a place to add behaviour.
  $('#cdPenUpBtn').on('click', function () {
    var p = cdReadPenHeights();
    sendGcode('G90');
    sendGcode('G0 Z' + p.up);
  });
  $('#cdPenDownBtn').on('click', function () {
    var p = cdReadPenHeights();
    sendGcode('G90');
    sendGcode('G0 Z' + p.down);
  });
  $('#cdPumpBtn').on('click', function () {
    var p = cdReadPenHeights();
    sendGcode('G90');
    sendGcode('G0 Z' + p.pump);
  });

  // ─── Utility buttons ─────────────────────────────────────────────────────
  $('#cdChkSizeBtn').on('click', function () {
    $('#chkSize').trigger('click');
  });

  $('#cdGotoXY0Btn').on('click', function () {
    $('#gotozeroWPos').trigger('click');
  });

  // ─── Scrub panel (docked at bottom of right sidebar) ─────────────────────
  // Show the scrub panel whenever gcode is loaded (so user can pick a
  // restart point anytime). Initialize slider range on geometry load.
  $('.cd-scrub-step').on('click', function () {
    var step = parseInt($(this).data('step'), 10);
    var slider = document.getElementById('restartSlider');
    if (!slider) return;
    var next = Math.max(parseInt(slider.min, 10), Math.min(parseInt(slider.max, 10), parseInt(slider.value, 10) + step));
    slider.value = next;
    if (typeof onRestartSliderMove === 'function') onRestartSliderMove(next);
  });

  // START / END marker tabs — clicking one hands the slider over to it.
  $('.cd-scrub-mark').on('click', function () {
    if (typeof setActiveRestartMark === 'function') setActiveRestartMark($(this).data('mark'));
  });

  // Typed line numbers. Commit on Enter or blur so partial input isn't applied
  // on every keystroke; Escape restores the marker's current value.
  $('#cdScrubStartLine, #cdScrubEndLine').on('keydown', function (e) {
    if (e.which === 13) { $(this).blur(); }
    else if (e.which === 27) { if (typeof refreshRestartMarkFields === 'function') refreshRestartMarkFields(); $(this).blur(); }
  }).on('focus', function () {
    if (typeof setActiveRestartMark === 'function') setActiveRestartMark($(this).closest('.cd-scrub-mark').data('mark'));
  }).on('blur', function () {
    var mark = $(this).closest('.cd-scrub-mark').data('mark');
    if (typeof setRestartMarkFromLine === 'function') setRestartMarkFromLine(mark, $(this).val());
    if (typeof refreshRestartMarkFields === 'function') refreshRestartMarkFields();
  });

  // Edit Start trigger — opens the scrub panel
  $('#cdEditStartBtn').on('click', function () {
    if (typeof openScrubber === 'function') {
      openScrubber();
    }
    if (typeof cdShowScrubPanel === 'function') cdShowScrubPanel();
  });

  $('#cdScrubStopBtn').on('click', function () {
    if (typeof closeScrubber === 'function') {
      closeScrubber();
    } else if (typeof restoreToolpathColors === 'function') {
      restoreToolpathColors();
    }
    $('#cd-scrub-panel').hide();
    // Re-show the Edit Start trigger so the user can reopen the panel
    if (typeof editor !== 'undefined' && editor && editor.session && editor.session.getLength() > 1) {
      $('#cd-scrub-trigger').show();
    }
  });

  // Expose a helper so gcode-load code can show the panel + init slider range
  window.cdShowScrubPanel = function () {
    var slider = document.getElementById('restartSlider');
    if (slider && typeof object !== 'undefined' && object && object.userData && object.userData.linePoints) {
      slider.max = object.userData.linePoints.length - 1;
      slider.value = 0;
      if (typeof onRestartSliderMove === 'function') onRestartSliderMove(0);
    }
    $('#cd-scrub-trigger').hide();
    $('#cd-scrub-panel').show();
  };

  // ─── Top bar tabs: MACHINE CONTROL | SVG | SETTINGS ─────────────────────
  // One table, one switch. With each view hiding the others by hand a third
  // tab meant six statements to keep in step, which is how you end up with a
  // hidden view and a highlighted tab.
  var CD_VIEWS = {
    machine:  { el: '#cd-main',           tab: '#cdTabMachine',         strip: true,  display: 'flex' },
    vpype:    { el: '#cd-vpype-layout',   tab: '#cdTabVpype',           strip: false, display: 'flex' },
    settings: { el: '#cd-settings-layout',tab: '#cdTabTroubleshooting', strip: false, display: 'flex' }
  };

  window.cdShowView = function (name) {
    var view = CD_VIEWS[name];
    if (!view) return;
    if (name === 'settings' && typeof window.cdSettingsInit === 'function') window.cdSettingsInit();

    Object.keys(CD_VIEWS).forEach(function (k) {
      var v = CD_VIEWS[k];
      $(v.el).css('display', k === name ? v.display : 'none');
      $(v.tab).toggleClass('cd-tab-active', k === name);
    });
    $('#cd-position-strip').toggle(view.strip);

    if (name === 'vpype' && typeof window.vpypeOnShow === 'function') window.vpypeOnShow();
  };

  function cdShowMachine() { window.cdShowView('machine'); }
  function cdShowSettings() { window.cdShowView('settings'); }

  $('#cdTabMachine').on('click', cdShowMachine);
  $('#cdTabVpype').on('click', function () { window.cdShowView('vpype'); });
  $('#cdTabTroubleshooting').on('click', cdShowSettings);

  // ─── CD-aware reconnect helpers ──────────────────────────────────────────

  // Tracks whether the previous status tick had a job running or held, so a
  // drop to disconnected/ALARM can be told apart from an idle machine.
  var _cdJobWasLive = false;

  // Called by setConnectBar() mirror (see websocket.js additions).
  // Updates CD top bar connection state.
  window.cdUpdateConnection = function (connectionStatus, status) {
    var connected = connectionStatus >= 1;
    var running = connectionStatus === 3;
    var paused = connectionStatus === 4;
    var alarm = connectionStatus === 5;

    // Push a phone alert if a job that was live drops out from under us.
    // Only these two transitions — a normal finish lands on IDLE and is
    // handled by the jobComplete handler instead.
    if (_cdJobWasLive && typeof cdNotifyPlotFailed === 'function') {
      if (!connected) {
        cdNotifyPlotFailed('machine disconnected mid-plot', true);
      } else if (alarm) {
        cdNotifyPlotFailed('controller went into ALARM', true);
      }
    }

    // Sticky, and cleared only on a genuine idle WHILE STILL CONNECTED.
    // Recomputing it from the current tick meant any single status frame that
    // was not exactly running or paused — one arrives between the queue
    // draining and the disconnect registering — cleared the flag before the
    // drop could be attributed to a live job, which is the one alert that
    // matters. A disconnect never clears it; a finished job does.
    if (running || paused) {
      _cdJobWasLive = true;
    } else if (connected && !alarm) {
      _cdJobWasLive = false;
    }

    $('#cdConnDot').toggleClass('cd-connected', connected);
    $('#cdConnLabel').toggleClass('cd-connected', connected);

    var port = (status && status.comms && status.comms.interfaces && status.comms.interfaces.activePort)
      ? status.comms.interfaces.activePort : '';

    if (connected) {
      $('#cdConnLabel').text('LINK' + (port ? ' · ' + port : ''));
      $('#cdConnBtn').text('DISCONNECT').addClass('cd-connected');
      $('#cd-port-wrap').hide();
    } else {
      $('#cdConnLabel').text('OFFLINE');
      $('#cdConnBtn').text('CONNECT').removeClass('cd-connected');
    }

    // Status bar
    var stateStr = '';
    var dotClass = '';
    switch (connectionStatus) {
      case 0: stateStr = 'DISCONNECTED'; dotClass = ''; break;
      case 1: stateStr = 'CONNECTED'; dotClass = 'cd-idle'; break;
      case 2: stateStr = 'READY'; dotClass = 'cd-idle'; break;
      case 3: stateStr = 'RUNNING'; dotClass = 'cd-running'; break;
      case 4: stateStr = 'HOLD'; dotClass = 'cd-paused'; break;
      case 5: stateStr = 'ALARM'; dotClass = 'cd-alarm'; break;
      default: stateStr = 'UNKNOWN'; dotClass = '';
    }
    $('#cdStateDot').attr('class', 'cd-state-dot ' + dotClass);
    $('#cdStateLabel').text(stateStr);
    $('#cdPortStatus').text(connected ? 'PORT: ' + (port || 'Connected') : 'PORT: Not Connected');
    if (status && status.comms && status.comms.interfaces && status.comms.interfaces.serialBaud) {
      $('#cdBaud').text('BAUD ' + status.comms.interfaces.serialBaud);
    }
    if (typeof window.cdSettingsOnStatus === 'function') window.cdSettingsOnStatus();

    // Alarm banner — debounce ON so transient alarm ticks during the connect
    // handshake (GRBL often boots into alarm before settling) don't flash the
    // banner; hide OFF immediately so clearing an alarm feels instant.
    if (alarm !== _lastAlarmShown) {
      _lastAlarmShown = alarm;
      if (_alarmShowTimer) { clearTimeout(_alarmShowTimer); _alarmShowTimer = null; }
      if (alarm) {
        _alarmShowTimer = setTimeout(function () {
          _alarmShowTimer = null;
          if (_lastAlarmShown) document.getElementById('cd-alarm-banner').style.display = 'flex';
        }, 700);
      } else {
        $('#cd-alarm-banner').hide();
      }
    }

    // Jog section disabled state
    var canJog = connected && !running && !alarm;
    $('#cd-jog-section').toggleClass('cd-jog-disabled', !canJog);
    $('.cd-axis-set0').prop('disabled', !connected);
    $('#cdHome').prop('disabled', !canJog);

    // Overrides disabled state
    $('.cd-vslider').toggleClass('cd-disabled', !connected);

    // Run controls
    cdUpdateRunControls(connectionStatus);

    // CD position strip dimming
    $('.cd-axis-readout').toggleClass('cd-disabled', !connected);
  };

  // ─── Machine position updates ─────────────────────────────────────────────
  window.cdUpdatePosition = function (x, y, z) {
    // Don't overwrite the value while the user is editing that axis
    if (!$('#cdXPos').hasClass('cd-axis-editing')) $('#cdXPos').text(x);
    if (!$('#cdYPos').hasClass('cd-axis-editing')) $('#cdYPos').text(y);
    if (!$('#cdZPos').hasClass('cd-axis-editing')) $('#cdZPos').text(z);
  };

  // ─── Click-to-edit DROs — jog to absolute target on Enter ────────────────
  function cdGetJogRate(axis) {
    if (axis === 'X' && typeof jogRateX !== 'undefined') return jogRateX;
    if (axis === 'Y' && typeof jogRateY !== 'undefined') return jogRateY;
    if (axis === 'Z' && typeof jogRateZ !== 'undefined') return jogRateZ;
    return 2000;
  }

  function cdCurrentWorkPos(axis) {
    try {
      var p = laststatus.machine.position.work;
      if (axis === 'X') return p.x;
      if (axis === 'Y') return p.y;
      if (axis === 'Z') return p.z;
    } catch (e) {}
    return 0;
  }

  function cdMakeAxisEditable($valEl, axis) {
    if ($valEl.hasClass('cd-axis-editing')) return;
    var originalText = $valEl.text();
    var currentVal;
    if (typeof unit !== 'undefined' && unit === 'in') {
      currentVal = (cdCurrentWorkPos(axis) / 25.4).toFixed(3);
    } else {
      currentVal = cdCurrentWorkPos(axis).toString();
    }

    // Use contenteditable on the value div itself — no injected <input>, so
    // Metro auto-init can't wrap it with its clear-button/dropdown shell.
    $valEl.addClass('cd-axis-editing');
    $valEl.text(currentVal);
    $valEl.attr('contenteditable', 'true');
    $valEl.focus();

    // Select all the text
    var range = document.createRange();
    range.selectNodeContents($valEl[0]);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    var settled = false;

    function teardown() {
      $valEl.removeClass('cd-axis-editing');
      $valEl.removeAttr('contenteditable');
      $valEl.off('keydown.cdedit blur.cdedit');
    }

    function commit() {
      if (settled) return; settled = true;
      var v = $valEl.text().trim();
      teardown();
      if (v === '' || isNaN(parseFloat(v))) {
        $valEl.text(originalText);
        return;
      }
      // Revert display; cdUpdatePosition will push the real value as the
      // machine moves.
      $valEl.text(originalText);
      var isInch = (typeof unit !== 'undefined' && unit === 'in');
      var gUnit = isInch ? 'G20' : 'G21';
      // Enter: JOG to absolute target. The machine moves to the typed value.
      sendGcode('$J=G90 ' + gUnit + ' ' + axis + v + ' F' + cdGetJogRate(axis));
    }
    function cancel() {
      if (settled) return; settled = true;
      teardown();
      $valEl.text(originalText);
    }

    $valEl.on('keydown.cdedit', function (e) {
      // Block jog / macro shortcuts (bound on document) while editing
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    // keypress also needed — some jQuery shortcut plugins listen there
    $valEl.on('keypress.cdedit keyup.cdedit', function (e) {
      e.stopPropagation();
    });
    $valEl.on('blur.cdedit', cancel);
  }

  $('#cdXPos').on('click', function () { cdMakeAxisEditable($(this), 'X'); });
  $('#cdYPos').on('click', function () { cdMakeAxisEditable($(this), 'Y'); });
  $('#cdZPos').on('click', function () { cdMakeAxisEditable($(this), 'Z'); });

  // ─── Run control state ────────────────────────────────────────────────────
  window.cdUpdateRunControls = function (connectionStatus) {
    var connected = connectionStatus >= 1;
    var running = connectionStatus === 3;
    var paused = connectionStatus === 4;

    var hasFile = typeof editor !== 'undefined' && editor.session && editor.session.getLength() > 1;
    var canStart = connected && hasFile && !running && connectionStatus !== 5;

    // Toggle idle vs active blocks
    $('#cdRunIdle').toggle(!running && !paused);
    $('#cdRunActive').toggle(running || paused);

    // START button
    $('#cdStartBtn').prop('disabled', !canStart);

    // PAUSE/RESUME button state
    if (paused) {
      $('#cdPauseResumeBtn').text('▶ RESUME').addClass('cd-resuming');
    } else {
      $('#cdPauseResumeBtn').text('❚❚ PAUSE').removeClass('cd-resuming');
    }

    // Progress bar paused tint
    $('#cdProgressBar').toggleClass('cd-paused', paused);

    // Progress ticker: only tick while actively running (not paused / alarm / idle)
    if (running) {
      window.cdStartProgressTicker();
    } else {
      window.cdStopProgressTicker();
    }

    // Canvas state chip (top-right of 3D VIEW / CONSOLE / ... strip)
    var $chip = $('#cdCanvasState');
    if ($chip.length) {
      $chip.removeClass('cd-live cd-hold cd-scrub');
      if (running && !paused) {
        $chip.text('● LIVE').addClass('cd-live').show();
      } else if (paused) {
        $chip.text('❚❚ HOLD').addClass('cd-hold').show();
      } else if (hasFile) {
        $chip.text('● PREVIEW').show();
      } else {
        $chip.hide();
      }
    }

    // Utility buttons
    var canUtil = connected && !running && connectionStatus !== 5;
    $('#cdChkSizeBtn').prop('disabled', !canUtil || !hasFile);
    $('#cdGotoXY0Btn').prop('disabled', !connected || connectionStatus === 5);
    $('#cdProbeBtn').prop('disabled', !canUtil);
    $('#cdToolBtn').prop('disabled', !connected || connectionStatus === 5);
    $('#cdPenUpBtn, #cdPenDownBtn, #cdPumpBtn').prop('disabled', !connected || connectionStatus === 5);
  };

  // ─── File state ───────────────────────────────────────────────────────────
  window.cdUpdateFileState = function (loaded, filename) {
    if (loaded && filename) {
      $('#cdFileName').text(filename).show();
      $('#cdFileUnload').show();
      $('#cdFileOpen').hide();
      $('#cd-job-info').show();
      // Show the Edit Start trigger; panel stays closed until user clicks it
      $('#cd-scrub-trigger').show();
      $('#cd-scrub-panel').hide();
      var baseName = filename.replace(/\.[^/.]+$/, '');
      $('#cdJobName').text(baseName);
      // LINES describes the FILE that is loaded. It used to be written from the
      // streaming queue, so once a job ended and the queue collapsed the card
      // read "1 LINES / 100.0%" with nothing running.
      var fileLines = (typeof editor !== 'undefined' && editor.session) ? editor.session.getLength() : 0;
      $('#cdJobMeta').text(fileLines ? fileLines.toLocaleString() + ' LINES' : '—');
      $('#cdProgressPct').html('0.0<span class="cd-progress-pct-unit">%</span>');
      $('#cdProgressBar').css('width', '0%');
    } else {
      $('#cdFileName').hide();
      $('#cdFileUnload').hide();
      $('#cdFileOpen').show();
      $('#cd-job-info').hide();
      $('#cd-scrub-trigger').hide();
      $('#cd-scrub-panel').hide();
      $('#cdProgressPct').html('0.0<span class="cd-progress-pct-unit">%</span>');
      $('#cdProgressBar').css('width', '0%');
    }
  };

  // ─── Job progress ─────────────────────────────────────────────────────────
  window.cdUpdateJobProgress = function (pct, currentLine, totalLines, elapsed, remaining, travelMm) {
    // A collapsed queue reports total = 1, which rendered as a finished job.
    // Progress is only meaningful while there is a real queue behind it.
    if (!totalLines || totalLines < 2) return;
    $('#cdProgressPct').html(pct.toFixed(1) + '<span class="cd-progress-pct-unit">%</span>');
    $('#cdProgressBar').css('width', Math.min(100, pct) + '%');
    if (currentLine !== undefined) {
      $('#cdLine').text(currentLine.toLocaleString());
    }
    if (elapsed !== undefined) {
      $('#cdElapsed').text(cdFmtTime(elapsed));
    }
    if (remaining !== undefined) {
      $('#cdRemaining').text(cdFmtTime(remaining));
    }
    if (travelMm !== undefined) {
      $('#cdTravel').text(travelMm >= 1000 ? (travelMm / 1000).toFixed(1) + 'm' : Math.round(travelMm) + 'mm');
    }
  };

  window.cdFmtTime = function (minutes) {
    if (!isFinite(minutes) || minutes < 0) minutes = 0;
    var h = Math.floor(minutes / 60);
    var m = Math.floor(minutes % 60);
    return String(h).padStart(2, '0') + 'h:' + String(m).padStart(2, '0') + 'm';
  };

  // 1 Hz ticker: queueCount only fires on line dequeues, so elapsed/remaining
  // freeze during long moves. Recompute from the wall clock while running.
  var cdJobState = { done: 0, total: 0, totalTimeMin: NaN };
  window.cdProgressTickerState = cdJobState;
  var cdProgressTimer = null;

  window.cdStartProgressTicker = function () {
    if (cdProgressTimer) return;
    cdProgressTimer = setInterval(cdProgressTick, 1000);
    cdProgressTick();
  };
  window.cdStopProgressTicker = function () {
    if (cdProgressTimer) {
      clearInterval(cdProgressTimer);
      cdProgressTimer = null;
    }
  };
  function cdProgressTick() {
    if (typeof lastJobStartTime === 'undefined' || !lastJobStartTime) return;
    var elapsedMin = (Date.now() - lastJobStartTime) / 1000 / 60;
    // Prefer extrapolation from real line throughput; the parser's totalTime
    // estimate ignores acceleration and undershoots on segment-heavy jobs.
    var remainingMin = NaN;
    if (cdJobState.done > 100 && cdJobState.total > 0) {
      remainingMin = elapsedMin * (cdJobState.total - cdJobState.done) / cdJobState.done;
    } else if (typeof object !== 'undefined' && object && object.userData && !isNaN(object.userData.totalTime)) {
      remainingMin = Math.max(0, object.userData.totalTime - elapsedMin);
    } else if (!isNaN(cdJobState.totalTimeMin)) {
      remainingMin = Math.max(0, cdJobState.totalTimeMin - elapsedMin);
    }
    var pct = (cdJobState.total > 0) ? (cdJobState.done / cdJobState.total) * 100 : 0;
    $('#cdElapsed').text(cdFmtTime(elapsedMin));
    if (!isNaN(remainingMin)) $('#cdRemaining').text(cdFmtTime(remainingMin));
    if (!isNaN(pct)) {
      $('#cdProgressPct').html(pct.toFixed(1) + '<span class="cd-progress-pct-unit">%</span>');
      $('#cdProgressBar').css('width', Math.min(100, pct) + '%');
    }
  }

  // Patch cdUpdateJobProgress to stash state for the ticker.
  var _origUpdateJobProgress = window.cdUpdateJobProgress;
  window.cdUpdateJobProgress = function (pct, currentLine, totalLines, elapsed, remaining, travelMm) {
    cdJobState.done = currentLine || 0;
    cdJobState.total = totalLines || cdJobState.total;
    if (!isNaN(elapsed) && !isNaN(remaining)) cdJobState.totalTimeMin = elapsed + remaining;
    _origUpdateJobProgress.call(this, pct, currentLine, totalLines, elapsed, remaining, travelMm);
  };

  // ─── Feed display ─────────────────────────────────────────────────────────
  window.cdUpdateFeed = function (feedMmPerMin, jogPct, toolPct, toolOn) {
    $('#cdFeedValue').html(Math.round(feedMmPerMin) + ' <span class="cd-feed-unit">mm/min</span>');
    var toolStr = toolOn ? 'ON' : 'OFF';
    $('#cdFeedMeta').text('TOOL: ' + toolStr + ' · JOG: ' + Math.round(jogPct) + '%');
  };

  // ─── Tool state ───────────────────────────────────────────────────────────
  window.cdUpdateToolState = function (on) {
    toolIsOn = on;
    $('#cdToolLabel').text(on ? 'TOOL · ON' : 'TOOL · OFF');
    $('#cdToolBtn').toggleClass('cd-active', on);
  };

  // ─── Queue ────────────────────────────────────────────────────────────────
  window.cdUpdateQueue = function (count) {
    $('#cdQueue').text('QUEUE ' + count);
  };

  // ─── MPos ─────────────────────────────────────────────────────────────────
  window.cdUpdateMPos = function (x, y, z) {
    $('#cdMpos').text('MPos X' + x + ' Y' + y + ' Z' + z);
    var axes = [['cdXMpos', x, 'cdXPos'], ['cdYMpos', y, 'cdYPos'], ['cdZMpos', z, 'cdZPos']];
    axes.forEach(function (a) {
      var el = document.getElementById(a[0]);
      if (!el) return;
      el.textContent = 'MPos: ' + a[1];
      var wcs = parseFloat((document.getElementById(a[2]) || {}).textContent);
      var mp  = parseFloat(a[1]);
      var offset = !isNaN(wcs) && !isNaN(mp) && Math.abs(wcs - mp) > 0.0005;
      el.classList.toggle('cd-axis-mpos-offset', offset);
    });
  };

});
