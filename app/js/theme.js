// Light-only theme. Kept as a lookup table for the 3D viewer
// (SKY_BOTTOM_COLOR, LINE_COLOURS, GRID_STEP_*, etc.) consumed by
// 3dview.js, verylitegcodeviewer.js and restart-from-point.js.
// Dark-mode code paths were removed; UI is now Portrait-Cubes warm-light.

let ThemeData = {
  THEMES: {
    "light": {
      DESCRIPTION: 'Light Mode',
      ICON: 'sun',
      SPRITE_OPACITY: 0.6,
      SKY_TOP_COLOR: 0xFFFAF4,
      SKY_BOTTOM_COLOR: 0xFFFAF4,
      HEMI_LIGHT_COLOR: {
        'H': 0.6,
        'S': 1.0,
        'L': 0.6
      },
      GRID_STEP_10_COLOR: 0x888888,
      GRID_STEP_10_OPACITY: 0.15,
      GRID_STEP_100_COLOR: 0x666666,
      GRID_STEP_100_OPACITY: 0.15,
      RULER_COLOR: 0x888888,
      RULER_OPACITY: 0.15,
      X_RULER_NUMBER_COLOR: "#cc0000",
      X_RULER_LABEL_COLOR: "#ff0000",
      X_AXIS_LINE_COLOR: 0xcc0000,
      Y_RULER_NUMBER_COLOR: "#006600",
      Y_RULER_LABEL_COLOR: "#006600",
      Y_AXIS_LINE_COLOR: 0x00cc00,
      /* ── 0 TO 1, NOT 0 TO 255, AND THAT IS THE WHOLE POINT ─────────────
         These go straight into a THREE vertex-colour buffer, which is
         normalised. The old table was written in 0..200 and every entry
         clamped to full saturation on the way to the framebuffer — so the
         numbers rendered as pure red and pure green, and NO SHADE BETWEEN
         BLACK AND FULL COULD BE WRITTEN HERE AT ALL. The values below render
         identically to what shipped; they are simply now sayable, which is
         what DRAWN needs.

         INDEX IS THE G WORD (see 3dview.js): 0 travel, 1 feed, 2 arc, 3
         anything else. ARC AND THE FALLBACK ARE DEAD WEIGHT ON THIS MACHINE —
         nothing in the pipeline emits G2/G3 — and they stay only because the
         mapping that reads this array is upstream of us and indexes by G. */
      LINE_COLOURS: [
        { 'R': 0, 'G': 1, 'B': 0 },   // G0  travel, pen up
        { 'R': 1, 'G': 0, 'B': 0 },   // G1  feed, pen down — ink
        { 'R': 0, 'G': 0, 'B': 1 },   // G2  arc — never emitted here
        { 'R': 1, 'G': 0, 'B': 1 }    //     anything else
      ],

      /* ── DRAWN — THE THIRD STATE, AND IT IS NOT A G WORD ────────────────
         Travel and feed say what a move IS. This says what has HAPPENED to
         it: the pen has been over this and the ink is on the sheet. It is not
         in LINE_COLOURS because nothing in the gcode selects it — the plot
         does, as it runs.

         GREY AND NOT BLACK. Black is what the stroke editor paints over the
         strokes you EXCLUDED from a run, and the two are different statements
         about the same line — one is the machine reporting, the other is your
         decision. Same colour for both would make a plot in progress look
         like a selection. */
      DRAWN_COLOR: { 'R': 0.55, 'G': 0.55, 'B': 0.55 }
    }
  },

  currentThemeId: "light",

  init: function init() {
    $("body").addClass('theme_light');
  },

  getColor: function getColor(key) {
    return ThemeData.THEMES[ThemeData.currentThemeId][key];
  },

  get: function get() {
    return ThemeData.currentThemeId;
  },

  // Kept as no-ops so any legacy callers don't throw.
  toggle: function toggle() {},
  set: function set() {}
};

const Theme = new Proxy(ThemeData, {
  get: function(theme, key) {
    if (key == "getColor") return ThemeData.getColor;
    if (key == "lines")    return theme.getColor("LINE_COLOURS");
    if (key == "get")      return theme.get;
    if (key == "set")      return theme.set;
    if (key == "toggle")   return theme.toggle;
    return theme.getColor(key);
  }
});

ThemeData.init();
