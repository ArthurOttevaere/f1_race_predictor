"""Record the official Driver of the Day for a race by hand.

Run:  python jobs/set_dotd.py <season> <round> <driver_id>
e.g.  python jobs/set_dotd.py 2026 13 max_verstappen

Since 2026-09 `score_race.py` reads the Driver of the Day itself, from the
article formula1.com links on the race's hub page (`jobs/dotd.py`), on every
pass until it finds one. This is the hand for when it doesn't — the site
changed, the headline named two drivers, a name the roster can't match. The
race is re-scored immediately so the +5 bonus lands right away.
"""

from __future__ import annotations

import sys

import db
import score_race


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    season, rnd, driver_id = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]

    races = db.select("races", {"season": f"eq.{season}", "round": f"eq.{rnd}"})
    if not races:
        raise SystemExit(f"No race {season} round {rnd} in the database")
    race = races[0]

    known = {d["driver_id"] for d in db.select("drivers", {"season": f"eq.{season}"})}
    if known and driver_id not in known:
        raise SystemExit(f"Unknown driver_id '{driver_id}' for {season}. "
                         f"Known: {', '.join(sorted(known))}")

    if db.select("results", {"race_id": f"eq.{race['id']}"}):
        db.update("results", {"race_id": f"eq.{race['id']}"}, {"dotd": driver_id})
    else:
        db.upsert("results",
                  {"race_id": race["id"], "classification": {}, "dotd": driver_id},
                  on_conflict="race_id")

    print(f"DotD for {race['name']}: {driver_id}")
    if race["status"] in ("locked", "scored"):
        score_race.score_race(race)


if __name__ == "__main__":
    main()
