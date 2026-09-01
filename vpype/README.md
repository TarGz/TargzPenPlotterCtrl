# vpype engine

SVG → gcode, copied from **vpype_settings v1.18.0** (commit `a67a0d4`, 2026-07-26).

This is a **snapshot, not a dependency**. `~/Documents/GIT/_penPlotting/vpype_settings`
keeps its own life and its own updates; nothing here reads from it at runtime, pings
it, or needs its path to exist. The two are expected to diverge — if a later
vpype_settings feature is worth having, port it by hand.

| File | Origin |
|---|---|
| `command-builder.js` | `webui/command-builder.js` — `script_dir()` changed to `__dirname` (see below) |
| `defaults.js` | `webui/defaults.js` |
| `gwrite_motor.config` | repo root, byte-identical |
| `vpype_pump_interval.py` | repo root |
| `api.js` | ported from `webui/server.js`; SSE replaced by socket.io |

**`script_dir()` differs deliberately.** Upstream resolves `..` because the module lived
in `webui/`; the configs sit flat beside `command-builder.js` here, so it returns
`__dirname`. Keep the configs next to it or vpype loses its profiles.

## Deliberate divergences from the snapshot

**Servo is gone.** Upstream offered `motor_type: motor|servo`, but the servo profile has
no `Z-15`/`Z-30`/`Z-32` or `P0.500` for `renderConfig()` to substitute, so the Z and
dwell fields did nothing when it was selected — and `F10000` appears on its `G1 Z0`
lines, so the XY feedrate rewrote Z feedrates too. Rather than ship four controls that
lie, the option and `gwrite_servo.config` were dropped. Recover the file from
vpype_settings if a servo machine ever comes back. The filename still carries the
`motor` token so new output sorts beside existing gcode.

**Brush renders its config to a temp file.** Upstream passed the checked-in path straight
to vpype; that breaks in a packaged build, because a child process cannot read inside
`app.asar`. Both modes now go through `renderConfig()` + `writeTemp()`, sharing one
`templateValues()` owner.

**Brush Z fields are live.** `buildBrush()` read `cfg.z_up`/`cfg.z_down` and used
`brush_z_up`/`brush_z_down` only as the fallback, so upstream's separate brush Z fields
never reached the command. It now prefers the brush keys, falls back to the pen heights,
then the defaults.

**Brush ignores split-layers, and says so.** `buildBrush()` always collapses to one layer,
so upstream wrote a single file named `..._split` — the name claimed something the output
had not done. `build()` now normalises `split_layers` to false for brush, so the filename
matches the file.

## Routes

Mounted on the app's own port by `mountVpypeApi(app, express, io)` in `index.js`.

| Route | Purpose |
|---|---|
| `GET /api/vpype/health` | executes the binary; `?recheck=1` busts the cache |
| `GET /api/vpype/defaults` | default field values |
| `GET /api/vpype/layers?svg=` | layer list for the enable/disable UI |
| `GET /api/vpype/last-run?svg=` | `vpype_last_run.json` beside the SVG |
| `POST /api/vpype/build` | dry run — command + rendered config, spawns nothing |
| `POST /api/vpype/run` | spawns vpype; returns immediately, progress on the socket |
| `POST /api/vpype/cancel` | SIGTERM, SIGKILL after 1.5 s |

Run progress arrives as socket events `vpype:start`, `vpype:stdout`, `vpype:stderr`,
`vpype:error`, `vpype:end`. `vpype:end` carries `{code, outputs, paths, dir}`.

Health must **execute** the binary, not stat it: `resolveVpype()` falls back to the bare
string `'vpype'` when the venv is absent, so an `existsSync` check reports a plausible
path on a machine with nothing installed.
