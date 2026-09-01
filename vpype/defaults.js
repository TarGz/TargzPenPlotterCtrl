// Copied from vpype_settings v1.18.0 (a67a0d4, 2026-07-26).
// Diverges intentionally — do not auto-sync.
// Was a mirror of DEFAULTS in vpype_interactive.py upstream; now this app's own.
module.exports = {
  // Z heights - Standard mode
  z_up: '-15',
  z_down: '-29',
  z_pump: '-35',
  pump_dwell: '0.300',
  pump_interval: '300',
  // Z heights - Brush mode
  brush_z_up: '-15.0',
  brush_z_down: '-30.0',
  // Brush spatial mode
  z_travel: '-3.0',
  z_smooth_distance: '5.0',
  // Tolerances
  simplify_tolerance: '0.01',
  brush_merge_tolerance: '0.5',
  linemerge_tolerance: '0.1',
  // Brush press/lift
  press_distance: '10.0',
  lift_distance: '10.0',
  // Refill station
  refill_x: '0',
  refill_y: '0',
  refill_z: '-25',
  refill_interval: '50',
  refill_dwell: '2.0',
  // Wipe zone
  wipe_x1: '10',
  wipe_y1: '0',
  wipe_x2: '50',
  wipe_y2: '0',
  wipe_z: '-15',
  wipe_passes: '3',
  // Feed rates
  xy_feedrate: '4000',
};
