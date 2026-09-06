"""Freeze every circuit on the calendar into an SVG path.

Run:  python jobs/build_circuit_traces.py [season]   →  web/lib/circuits.ts

The site draws the next Grand Prix's circuit in the hero (DESIGN.md §6.3). The
geometry comes from FastF1's position telemetry — the fastest lap of the most
recent race held there — which means the ornament is the same data the model
runs on rather than a decorative asset somebody drew.

It is a **build-time** job, not a runtime one: the output is a checked-in
TypeScript module, so the web app never imports FastF1, never hits the network
for a shape, and a circuit that has never been raced simply is not in the file
(the hero renders without a trace, which is the honest thing).

Re-run it when the calendar gains a venue. It is offline against the local
`fastf1_cache` first and only reaches the network for a session it has never
seen.
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import fastf1
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "lib" / "circuits.ts"

# Geometry traced from a published circuit diagram, for a venue where no lap
# exists yet — a circuit that has never been driven has no telemetry anywhere,
# and until first practice the hero would otherwise carry nothing at all.
#
# It is a stand-in and it says so: every entry emits `source: "schematic"` plus
# the credit its licence requires, and telemetry always wins, so the first run
# after that venue's FP1 replaces it with the real thing and never comes back.
SCHEMATIC = ROOT / "jobs" / "schematic_traces.json"

# FastF1 relabels a venue from time to time without the tarmac changing, so an
# exact-location fallback to last season silently loses a circuit. One entry
# per rename; the key is this season's label.
PREV_ALIAS = {
    # Not a rename: FastF1's 2026 schedule files the Bahrain Grand Prix — round
    # 16, country "Bahrain", run at Sakhir — under location "Kuala Lumpur".
    # Without this line the round has no trace at all, and the hero goes blank
    # for a circuit that has been on the calendar for twenty years.
    "Kuala Lumpur": "Sakhir",
    "Yas Marina": "Yas Island",
    "Monte Carlo": "Monaco",
    "Montreal": "Montréal",
    "Sao Paulo": "São Paulo",
}

# The drawing box. Height follows from each circuit's own aspect ratio, so a
# wide track (Monza) and a square one (Hungaroring) both fill their frame.
BOX = 1000.0
PAD = 26.0            # room for the 3px stroke and the start-line tick
TRACE_POINTS = 200    # after resampling; a lap arrives with ~540


# ─── Geometry ────────────────────────────────────────────────────────────────

def _resample(pts: list[tuple[float, float]], n: int) -> list[tuple[float, float]]:
    """Walk the closed lap and emit `n` points at equal arc length.

    This was Ramer–Douglas–Peucker first, and RDP is wrong here: it anchors on
    the first and last point of the polyline, and on a *closed* lap those are
    the same point. The line between them is degenerate, every perpendicular
    distance comes out meaningless, and the Hungaroring came back as a handful
    of disconnected straights. Even spacing has no such failure mode, gives a
    predictable file size, and feeds the spline below points it likes.
    """
    closed = pts + [pts[0]]
    seg = [math.dist(closed[i], closed[i + 1]) for i in range(len(closed) - 1)]
    total = sum(seg)
    step = total / n

    out = [closed[0]]
    i, carried = 0, 0.0
    for k in range(1, n):
        target = k * step
        while i < len(seg) - 1 and carried + seg[i] < target:
            carried += seg[i]
            i += 1
        t = (target - carried) / (seg[i] or 1.0)
        (x1, y1), (x2, y2) = closed[i], closed[i + 1]
        out.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
    return out


def _catmull_rom(pts: list[tuple[float, float]]) -> str:
    """Closed Catmull-Rom through every point, emitted as cubic Béziers.

    A polyline through 150 samples reads as a polygon at hero size — every
    straight has a visible kink where the car drifted a metre. This passes a
    spline through the same points, so the trace curves the way the track does
    and the file stays small."""
    n = len(pts)
    d = [f"M{pts[0][0]:.0f} {pts[0][1]:.0f}"]
    for i in range(n):
        p0 = pts[(i - 1) % n]
        p1 = pts[i]
        p2 = pts[(i + 1) % n]
        p3 = pts[(i + 2) % n]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d.append(
            f"C{c1[0]:.0f} {c1[1]:.0f} {c2[0]:.0f} {c2[1]:.0f} {p2[0]:.0f} {p2[1]:.0f}"
        )
    return "".join(d) + "Z"


def _slug(location: str) -> str:
    s = location.lower()
    for a, b in (("é", "e"), ("è", "e"), ("ã", "a"), ("ó", "o"), ("ç", "c")):
        s = s.replace(a, b)
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


# ─── One circuit ─────────────────────────────────────────────────────────────

# A single dropout in the position feed is invisible in the numbers and
# catastrophic in the drawing: the gap is closed with a straight chord, and the
# 2026 Hungarian GP's fastest lap came out as a polygon with a 347-metre side
# through the middle of the infield. So the fastest lap is a *candidate*, not
# the answer — take the quickest one whose samples are actually continuous.
MAX_GAP = 0.02   # of the lap, between two consecutive samples


def _clean_lap(session):
    laps = session.laps.dropna(subset=["LapTime"]).sort_values("LapTime")
    for _, lap in laps.head(15).iterrows():
        try:
            tel = lap.get_telemetry()
        except Exception:
            continue
        if tel is None or len(tel) < 200:
            continue
        xy = list(zip(tel["X"].to_numpy(), tel["Y"].to_numpy()))
        segs = [math.dist(xy[i], xy[i + 1]) for i in range(len(xy) - 1)]
        total = sum(segs)
        if total > 0 and max(segs) / total <= MAX_GAP:
            return tel
    return None


def trace(season: int, rnd: int):
    """`rnd`, never a location string. FastF1's event lookup fuzzy-matches
    names, and it will happily answer "Madrid" with the Miami Grand Prix —
    which would put the wrong circuit in the hero and look entirely
    plausible."""
    # Best lap first: the race and qualifying are driven on the full circuit at
    # speed. Practice is the last resort and exists for one case — a venue
    # nobody has ever raced, where Friday is the only telemetry in existence.
    for kind in ("R", "Q", "FP3", "FP2", "FP1"):
        try:
            s = fastf1.get_session(season, rnd, kind)
            s.load(telemetry=True, laps=True, weather=False, messages=False)
            tel = _clean_lap(s)
            if tel is None:
                continue
            info = s.get_circuit_info()
            break
        except Exception:
            continue
    else:
        return None

    # FastF1 stores the map in its own orientation; `rotation` is what turns it
    # the way the circuit is always drawn on a race programme.
    th = math.radians(float(info.rotation or 0.0))
    cos, sin = math.cos(th), math.sin(th)
    raw = [
        (x * cos - y * sin, x * sin + y * cos)
        for x, y in zip(tel["X"].to_numpy(), tel["Y"].to_numpy())
    ]

    xs = [p[0] for p in raw]
    ys = [p[1] for p in raw]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    scale = (BOX - 2 * PAD) / max(w, h)
    ox, oy = min(xs), min(ys)
    box_w = w * scale + 2 * PAD
    box_h = h * scale + 2 * PAD

    # SVG's y axis points down, telemetry's points up — flip, or every circuit
    # comes out mirrored, which is the kind of bug nobody spots for a season.
    pts = [(PAD + (x - ox) * scale, box_h - PAD - (y - oy) * scale) for x, y in raw]
    pts = _resample(pts, TRACE_POINTS)

    # The lap starts at the start/finish line, so point zero *is* the line and
    # the first segment gives its direction.
    (sx, sy), (nx, ny) = pts[0], pts[1]
    angle = math.degrees(math.atan2(ny - sy, nx - sx))

    return {
        "path": _catmull_rom(pts),
        "width": round(box_w, 1),
        "height": round(box_h, 1),
        "start": {"x": round(sx, 1), "y": round(sy, 1), "angle": round(angle, 1)},
        "corners": int(len(info.corners)),
        "season": season,
    }


# ─── Emit ────────────────────────────────────────────────────────────────────

HEADER = '''// GENERATED — do not edit by hand. See jobs/build_circuit_traces.py.
//
// One entry per circuit on the calendar, keyed by the `Location` string the
// schedule sync writes into `races.circuit`. The path is a closed cubic spline
// through the fastest race lap's position telemetry, normalised into its own
// viewBox; `start` is the start/finish line and the direction of travel
// through it.
//
// A circuit nobody has driven yet is absent unless jobs/schematic_traces.json
// carries a traced diagram for it, in which case the entry is marked
// `source: "schematic"` and carries the credit its licence requires. Telemetry
// always wins and replaces it after that venue's first session.
// Re-run the job when the calendar gains a venue.

export interface CircuitTrace {
  /** Matches `races.circuit`, lowercased and hyphenated. */
  slug: string;
  location: string;
  /** Closed SVG path, in the viewBox below. */
  path: string;
  width: number;
  height: number;
  /** The start/finish line: a point on the path and the heading through it. */
  start: { x: number; y: number; angle: number };
  corners: number;
  /** The season the geometry was taken from. */
  season: number;
  /** Where the shape came from. `schematic` is a stand-in for a venue that has
   *  never been driven, and is replaced by telemetry after its first session. */
  source: "telemetry" | "schematic";
  /** Attribution required by a schematic's licence. Absent for telemetry. */
  credit?: string;
  creditUrl?: string;
}

'''


def main() -> None:
    season = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
    fastf1.Cache.enable_cache(str(ROOT / "fastf1_cache"))

    schedule = fastf1.get_event_schedule(season, include_testing=False)
    prev = fastf1.get_event_schedule(season - 1, include_testing=False)
    prev_round = {
        str(ev["Location"]): int(ev["RoundNumber"]) for _, ev in prev.iterrows()
    }

    schematic = json.loads(SCHEMATIC.read_text()) if SCHEMATIC.exists() else {}

    now = pd.Timestamp.utcnow().tz_localize(None)
    out, missing = [], []
    for _, ev in schedule.iterrows():
        loc = str(ev["Location"])
        rnd = int(ev["RoundNumber"])
        # An event nobody has driven yet has no telemetry, and asking for it
        # means a network round-trip that times out. Twenty of those is the
        # difference between a job that takes a minute and one that takes ten.
        #
        # The gate is the *first session*, not the race. A brand-new venue —
        # Madrid in 2026 — has no past race to fall back on, so waiting for
        # Sunday leaves the hero blank across the very weekend the circuit is
        # new. First practice is enough to draw a lap, and it runs on Friday.
        started = pd.Timestamp(ev.get("Session1DateUtc") or ev["EventDate"]) < now
        # This season first — a circuit is re-profiled when it is resurfaced —
        # then last season, matched by exact location, for anything not yet
        # raced this year.
        t = trace(season, rnd) if started else None
        prev_loc = loc if loc in prev_round else PREV_ALIAS.get(loc)
        if t is None and prev_loc in prev_round:
            t = trace(season - 1, prev_round[prev_loc])
        if t:
            t["source"] = "telemetry"
        else:
            # No lap anywhere: fall back to a traced diagram if we have one.
            t = schematic.get(_slug(loc))
            if t:
                t = dict(t, source="schematic", season=season)
        if t:
            t["slug"] = _slug(loc)
            t["location"] = loc
            out.append(t)
            origin = t["season"] if t["source"] == "telemetry" else "diagram"
            print(f"  {loc:<22} {t['corners']:>2} corners  "
                  f"{len(t['path']):>5} chars  ({origin})")
        else:
            missing.append(loc)

    body = ["export const CIRCUIT_TRACES: Record<string, CircuitTrace> = {"]
    for t in sorted(out, key=lambda x: x["slug"]):
        body.append(f'  "{t["slug"]}": {{')
        body.append(f'    slug: "{t["slug"]}",')
        body.append(f'    location: {t["location"]!r}'.replace("'", '"') + ",")
        body.append(f'    path:\n      "{t["path"]}",')
        body.append(f'    width: {t["width"]},')
        body.append(f'    height: {t["height"]},')
        body.append(
            f'    start: {{ x: {t["start"]["x"]}, y: {t["start"]["y"]}, '
            f'angle: {t["start"]["angle"]} }},'
        )
        body.append(f'    corners: {t["corners"]},')
        body.append(f'    season: {t["season"]},')
        body.append(f'    source: "{t["source"]}",')
        if t.get("credit"):
            body.append(f'    credit: {t["credit"]!r}'.replace("'", '"') + ",")
            body.append(f'    creditUrl: "{t["credit_url"]}",')
        body.append("  },")
    body.append("};\n")
    body.append("""/** The trace for a `races.circuit` value, or null if that venue has no lap yet. */
export function circuitTrace(location: string | null | undefined): CircuitTrace | null {
  if (!location) return null;
  const slug = location
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return CIRCUIT_TRACES[slug] ?? null;
}
""")

    OUT.write_text(HEADER + "\n".join(body))
    print(f"\n{len(out)} circuits → {OUT.relative_to(ROOT)}")
    if missing:
        print("no telemetry yet: " + ", ".join(missing))


if __name__ == "__main__":
    main()
