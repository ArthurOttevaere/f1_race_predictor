"""Hourly on race weekends: refresh the model's duel entry, lock at race start.

Run:  python jobs/lock_race.py

For the upcoming race (once qualifying should be over), runs the model and
upserts its entry — order + probability matrix — so the entry on record is
always the freshest pre-race one. At race start the race flips to 'locked':
player predictions close (enforced by RLS) and the model entry is frozen.

Fallback per docs §2.2: if the model never produced an entry by lock time,
the qualifying order becomes the model entry with no probabilities (all
rarity multipliers ×1). The duel always happens.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import db
import mailer
import model_bridge
import safety_car
import scoring  # noqa: F401  (kept close: scoring reads the matrix written here)


def _dt(v: str | None):
    return datetime.fromisoformat(v) if v else None


def refresh_entry(race: dict) -> bool:
    try:
        entry = model_bridge.model_entry(race["season"], race["round"])
    except Exception as e:
        print(f"round {race['round']}: model unavailable ({e})")
        return False
    db.upsert("model_entries", {
        "race_id": race["id"],
        "predicted_order": entry["predicted_order"],
        "prob_matrix": entry["prob_matrix"],
        "pre_quali": entry["pre_quali"],
        "sc_prob": entry["sc_prob"],
        "sc_bet": entry["sc_bet"],
        "locked_at": datetime.now(timezone.utc).isoformat(),
    }, on_conflict="race_id")
    mode = "pre-quali" if entry["pre_quali"] else "post-quali"
    print(f"round {race['round']}: model entry refreshed ({mode})")
    return True


def quali_order(season: int, rnd: int) -> list[str]:
    """Qualifying classification as an ordered list of driver_ids, [] if absent.

    In a FastF1 'Q' session GridPosition is NaN for everyone (a grid only
    exists in the race), so the qualifying order is the best stand-in — it is
    the starting grid before penalties.
    """
    # load_qualifying returns (results, weather); results is None when the
    # session isn't published yet.
    results, _weather = model_bridge.model.load_qualifying(season, rnd)
    if results is None or results.empty or "DriverId" not in results.columns:
        return []
    ranked = results.dropna(subset=["DriverId"])
    if "Position" in ranked.columns:
        ranked = ranked.sort_values("Position", na_position="last")
    return [str(d) for d in ranked["DriverId"]]


def grid_fallback(race: dict) -> None:
    order = quali_order(race["season"], race["round"])
    if not order:
        print(f"round {race['round']}: no qualifying data — no model entry")
        return
    sc_prob, sc_bet = safety_car.model_bet(
        race.get("name"), race.get("circuit"), race.get("country"))
    db.upsert("model_entries", {
        "race_id": race["id"],
        "predicted_order": order,
        "prob_matrix": {},
        "pre_quali": False,
        "sc_prob": round(float(sc_prob), 4),
        "sc_bet": bool(sc_bet),
        "locked_at": datetime.now(timezone.utc).isoformat(),
    }, on_conflict="race_id")
    print(f"round {race['round']}: grid-order fallback entry stored")


def main() -> None:
    now = datetime.now(timezone.utc)
    races = db.select("races", {"status": "eq.scheduled",
                                "race_at": "not.is.null",
                                "order": "race_at.asc"})
    for race in races:
        race_at = _dt(race["race_at"])
        quali_at = _dt(race["quali_at"])
        if race_at > now + timedelta(days=3):
            break  # only the imminent weekend matters

        if now < race_at:
            # Entry becomes worth refreshing once qualifying should be done.
            if quali_at is None or now > quali_at + timedelta(hours=1, minutes=30):
                # The nudge goes out only if the entry actually landed. Sent
                # from here rather than on a clock of its own precisely so it
                # cannot claim "the model has played its hand" on a weekend
                # where the model was unavailable — gating on the return value
                # is what makes that true. `email_log` keeps the hourly
                # re-runs to one mail per player.
                if refresh_entry(race):
                    mailer.send_lock_emails(race)
        else:
            # Race has started: freeze whatever we have and lock.
            existing = db.select("model_entries", {"race_id": f"eq.{race['id']}"})
            if not existing and not refresh_entry(race):
                grid_fallback(race)
            db.update("races", {"id": f"eq.{race['id']}"}, {"status": "locked"})
            print(f"round {race['round']}: LOCKED")

    # A race locked with no entry at all used to be stuck for good: score_race
    # refuses it ("run lock_race first") and this job only scanned 'scheduled'
    # races, so nothing ever retried (ALMANAC §13.1 #1). Try again here, every
    # run, until an entry exists — the race is over, so the qualifying data
    # the model or the grid fallback need are as available as they will get.
    for race in db.select("races", {"status": "eq.locked", "race_at": "not.is.null"}):
        if db.select("model_entries", {"race_id": f"eq.{race['id']}"}):
            continue
        print(f"round {race['round']}: locked without a model entry — backfilling")
        if not refresh_entry(race):
            grid_fallback(race)


if __name__ == "__main__":
    main()
