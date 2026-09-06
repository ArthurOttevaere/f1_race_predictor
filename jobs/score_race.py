"""Hourly after a race: fetch the classification and score the duel.

Run:  python jobs/score_race.py

Idempotent: safe to re-run any number of times. Locked races are scored as
soon as FastF1 has the official classification; recently-scored races are
re-scored so a Driver-of-the-Day entered later (jobs/set_dotd.py) is picked
up on the next pass. The official classification at scoring time is final.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import db
import mailer
import model_bridge
import scoring


def score_race(race: dict) -> bool:
    now = datetime.now(timezone.utc)
    race_at = datetime.fromisoformat(race["race_at"])
    if now < race_at + timedelta(hours=2):
        return False  # race not plausibly finished yet

    classification = model_bridge.actual_classification(race["season"], race["round"])
    if not classification:
        print(f"round {race['round']}: no official classification yet")
        return False

    entries = db.select("model_entries", {"race_id": f"eq.{race['id']}"})
    if not entries:
        print(f"round {race['round']}: no model entry — run lock_race first")
        return False
    entry = entries[0]
    prob_matrix = entry["prob_matrix"] or None

    existing = db.select("results", {"race_id": f"eq.{race['id']}"})
    dotd = existing[0]["dotd"] if existing else None

    sc_actual = model_bridge.safety_car_occurred(race["season"], race["round"])

    # Model total includes its own safety-car side bet, so the duel is fair.
    model_table = scoring.score_table(entry["predicted_order"][:10],
                                      classification, prob_matrix)
    model_sc = scoring.sc_bonus(entry.get("sc_bet"), sc_actual)
    model_table["bonuses"]["safety_car"] = model_sc
    model_table["total"] += model_sc
    db.upsert("model_entries", {
        "race_id": race["id"],
        "predicted_order": entry["predicted_order"],
        "prob_matrix": entry["prob_matrix"],
        "pre_quali": entry["pre_quali"],
        "sc_prob": entry.get("sc_prob"),
        "sc_bet": entry.get("sc_bet"),
        "total": model_table["total"],
        "breakdown": model_table,
    }, on_conflict="race_id")

    race_filter = {"race_id": f"eq.{race['id']}"}
    predictions = db.select("predictions", race_filter)

    # Scoring a partial field is worse than not scoring at all: the standings
    # would look finished while some players silently got nothing. If the read
    # and the server disagree, stop and leave the race locked.
    expected = db.count("predictions", race_filter)
    if len(predictions) != expected:
        raise RuntimeError(
            f"round {race['round']}: read {len(predictions)} predictions but "
            f"the server counts {expected} — refusing to score a partial field"
        )

    score_rows = []
    for pred in predictions:
        table = scoring.score_table(pred["picks"], classification, prob_matrix)
        final = scoring.finalize(table, pred["dotd"], dotd, model_table["total"],
                                 pred.get("sc_bet"), sc_actual)
        score_rows.append({
            "race_id": race["id"],
            "user_id": pred["user_id"],
            "total": final["total"],
            "breakdown": final,
            "beat_model": final["beat_model"],
            "drew_model": final["drew_model"],
        })
    db.upsert("scores", score_rows, on_conflict="race_id,user_id")

    # Monday morning: how it went, to everyone who entered. After the write, so
    # nobody is told a score that failed to save; `email_log` (migration 0008)
    # keeps this to one mail per player however many times this job re-runs.
    mailer.send_result_emails(
        race,
        {row["user_id"]: row for row in score_rows},
        model_table["total"],
    )

    db.upsert("results", {
        "race_id": race["id"],
        "classification": classification,
        "dotd": dotd,
        "safety_car": sc_actual,
        "scored_at": now.isoformat(),
    }, on_conflict="race_id")
    db.update("races", {"id": f"eq.{race['id']}"}, {"status": "scored"})
    print(f"round {race['round']}: scored — model {model_table['total']:.1f} pts, "
          f"{len(score_rows)} player(s)")
    return True


def main() -> None:
    now = datetime.now(timezone.utc)
    locked = db.select("races", {"status": "eq.locked"})
    rescore_window = (now - timedelta(days=10)).isoformat()
    recent = db.select("races", {"status": "eq.scored",
                                 "race_at": f"gte.{rescore_window}"})
    for race in locked + recent:
        score_race(race)


if __name__ == "__main__":
    main()
