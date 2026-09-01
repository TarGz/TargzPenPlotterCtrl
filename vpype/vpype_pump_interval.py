#!/usr/bin/env python3
# Copied from vpype_settings v1.18.0 (a67a0d4, 2026-07-26).
# Diverges intentionally — do not auto-sync.
"""
vpype_pump_interval.py — Inject in-place pump cycles into pump-marker gcode.

Problem: the megaplot_with_pump profile only pumps at segment_first (pen-down).
After linemerge, strokes can be metres long -> no pump for ages -> marker dries.

This post-processor tracks pen-down travel distance and injects an in-place
pump cycle (press to Z_PUMP, dwell, back to Z_DOWN, keep drawing) every
--interval mm. Long straight segments are split at the exact point where the
pump is due, so the interval is respected even on long lines.

The pump sequence (Z values, dwell, Z feed) is auto-detected from the first
pump block found in the file, so it works with any z_pump/z_down/dwell config.

Usage:
    python3 vpype_pump_interval.py file1.gcode [file2.gcode ...] --interval 500
    python3 vpype_pump_interval.py "*.gcode" --interval 400 --suffix _pumped

Output: <original-stem><suffix>.gcode next to the input (default suffix: _pump<interval>).
"""

from __future__ import annotations
import argparse
import glob
import math
import re
import sys
from pathlib import Path

MOVE_RE = re.compile(r'^G([01])\b')
WORD_RE = re.compile(r'([XYZF])(-?\d+\.?\d*)')


def detect_pump_sequence(lines):
    """Find the first pump block: G1 Z<pump> F<f> / G4 P<dwell> / G1 Z<down> F<f>.

    Returns (z_pump, z_down, dwell_line, z_feed) or None.
    """
    for i in range(len(lines) - 2):
        m1 = re.match(r'^G1 Z(-?\d+\.?\d*) F(\d+\.?\d*)\s*$', lines[i])
        m2 = re.match(r'^G4 P', lines[i + 1])
        m3 = re.match(r'^G1 Z(-?\d+\.?\d*) F(\d+\.?\d*)\s*$', lines[i + 2])
        if m1 and m2 and m3:
            return (float(m1.group(1)), float(m3.group(1)),
                    lines[i + 1].strip(), m3.group(2))
    return None


def process(path: Path, interval: float, suffix: str, dry_run: bool, in_place: bool = False) -> Path | None:
    lines = path.read_text().splitlines()
    pump = detect_pump_sequence(lines)
    if pump is None:
        print(f"  SKIP {path.name}: no pump block found (not a pump profile?)")
        return None
    z_pump, z_down, dwell_line, z_feed = pump
    pump_block = [f"G1 Z{z_pump:g} F{z_feed}", dwell_line, f"G1 Z{z_down:g} F{z_feed}"]

    out = []
    x = y = None          # current position
    z = None
    pen_down = False
    dist = 0.0            # pen-down distance since last pump (resets on injection)
    orig_dist = 0.0       # pen-down distance since last NATURAL pump (original file)
    injected = 0
    max_gap = 0.0         # longest pen-down run without a pump in the original file

    for line in lines:
        stripped = line.strip()
        m = MOVE_RE.match(stripped)
        if not m:
            out.append(line)
            continue
        words = dict(WORD_RE.findall(stripped))
        g = m.group(1)

        if 'Z' in words and 'X' not in words and 'Y' not in words:
            new_z = float(words['Z'])
            # a natural pump press or pen lift resets the distance counters
            if new_z <= z_pump or new_z > z_down:
                max_gap = max(max_gap, orig_dist)
                dist = 0.0
                orig_dist = 0.0
            z = new_z
            pen_down = (z is not None and abs(z - z_down) < 0.01)
            out.append(line)
            continue

        nx = float(words['X']) if 'X' in words else x
        ny = float(words['Y']) if 'Y' in words else y

        if g == '1' and pen_down and x is not None and nx is not None:
            seg = math.hypot(nx - x, ny - y)
            orig_dist += seg
            feed = words.get('F', '')
            fpart = f" F{feed}" if feed else ""
            # split the segment every time the interval elapses inside it
            while dist + seg >= interval:
                need = interval - dist
                t = need / seg if seg > 0 else 0
                px, py = x + (nx - x) * t, y + (ny - y) * t
                out.append(f"G1 X{px:.4f} Y{py:.4f}{fpart}")
                out.extend(pump_block)
                injected += 1
                x, y = px, py
                seg -= need
                dist = 0.0
            dist += seg
            out.append(line)
        else:
            out.append(line)

        x, y = nx, ny

    max_gap = max(max_gap, orig_dist)

    out_path = path if in_place else path.with_name(f"{path.stem}{suffix}.gcode")
    print(f"  {path.name}")
    print(f"    longest run without pump before: {max_gap:.0f} mm")
    print(f"    pumps injected: {injected}" + ("" if injected else "  (nothing to do)"))
    if injected and not dry_run:
        out_path.write_text("\n".join(out) + "\n")
        if not in_place:
            print(f"    -> {out_path.name}")
        return out_path
    return None


def main():
    ap = argparse.ArgumentParser(description="Inject in-place pump cycles every N mm of pen-down travel.")
    ap.add_argument('files', nargs='+', help="gcode file(s) or glob pattern(s)")
    ap.add_argument('--interval', type=float, default=500.0,
                    help="pen-down distance between pumps, mm (default: 500)")
    ap.add_argument('--suffix', default=None,
                    help="output filename suffix (default: _pump<interval>)")
    ap.add_argument('--dry-run', action='store_true',
                    help="only report distances, write nothing")
    ap.add_argument('--in-place', action='store_true',
                    help="overwrite input files instead of writing suffixed copies")
    args = ap.parse_args()

    paths = []
    for pattern in args.files:
        matched = glob.glob(pattern)
        paths.extend(Path(p) for p in sorted(matched)) if matched else paths.append(Path(pattern))

    suffix = args.suffix if args.suffix is not None else f"_pump{args.interval:g}"
    print(f"Pump interval: {args.interval:g} mm")
    for p in paths:
        if not p.exists():
            print(f"  MISSING {p}")
            continue
        process(p, args.interval, suffix, args.dry_run, args.in_place)


if __name__ == '__main__':
    main()
