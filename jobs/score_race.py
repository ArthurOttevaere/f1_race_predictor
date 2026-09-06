"""After a race: fetch the classification and score the duel.

Run:  python jobs/score_race.py                    # the scheduled pass
      python jobs/score_race.py --rounds 13        # one race, whatever its age
      python jobs/score_race.py --rounds 1-13 --dry-run   # show, write nothing

Idempotent: safe to re-run any number of times. Locked races are scored as
soon as a classification exists — OpenF1 carries the timing feed's final
classification within the hour, Ergast follows and supersedes it (ALMANAC
§8.4.1) — and recently-scored races are re-scored on every pass, so a
Driver-of-the-Day read later, a safety car published later, or an Ergast
correction to the order are all picked up without anyone doing anything.

`--rounds` is the operator's hand: re-score any race of the season, outside
the ten-day window — how the safety-car bet was settled retroactively on
2026-09-06 for every race it had silently skipped. `--dry-run` computes and
prints every total and writes nothing, mails nobody.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone

import db
import dotd
import mailer
import model_bridge
import scoring

RESCORE_DAYS = 10


def _official_dotd(race: dict, known: str | None) -> str | None:
    """The Driver of the Day on record, else formula1.com's — None until it
    publishes. `set_dotd.py` remains the hand for when it never does."""
    if known:
        return known
    roster = db.select("drivers", {"season": f"eq.{race['season']}"})
    return dotd.official_dotd(race, roster)


def score_race(race: dict, dry_run: bool = False) -> bool:
    now = datetime.now(timezone.utc)
    race_at = datetime.fromisoformat(race["race_at"])
    if now < race_at + timedelta(hours=2):
        return False  # race not plausibly finished yet

    classification, source = model_bridge.actual_classification(
        race["season"], race["round"], race["race_at"])
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
    dotd_id = _official_dotd(race, existing[0]["dotd"] if existing else None)

    # Asked only once the race has a classification, so a race still running
    # cannot read as "no safety car".
    sc_actual = model_bridge.safety_car_occurred(race["season"], race["round"],
                                                 race["race_at"])

    # Model total includes its own safety-car side bet, so the duel is fair.
    model_table = scoring.score_table(entry["predicted_order"][:10],
                                      classification, prob_matrix)
    model_sc = scoring.sc_bonus(entry.get("sc_bet"), sc_actual)
    model_table["bonuses"]["safety_car"] = model_sc
    model_table["total"] += model_sc

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
        final = scoring.finalize(table, pred["dotd"], dotd_id, model_table["total"],
                                 pred.get("sc_bet"), sc_actual)
        score_rows.append({
            "race_id": race["id"],
            "user_id": pred["user_id"],
            "total": final["total"],
            "breakdown": final,
            "beat_model": final["beat_model"],
            "drew_model": final["drew_model"],
        })

    summary = (f"model {model_table['total']:.1f} pts, {len(score_rows)} player(s), "
               f"safety car {sc_actual}, DotD {dotd_id or '—'}, "
               f"classification from {source}")
    if dry_run:
        print(f"round {race['round']}: [dry run] {summary}")
        for row in score_rows:
            b = row["breakdown"]
            print(f"    {row['user_id'][:8]}  {row['total']:6.1f}  "
                  f"{'W' if row['beat_model'] else 'D' if row['drew_model'] else 'L'}  "
                  f"sc={b['bonuses']['safety_car']:g} dotd={b['bonuses']['dotd']:g}")
        return True

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
    db.upsert("scores", score_rows, on_conflict="race_id,user_id")

    # How it went, to everyone who entered. After the write, so nobody is told
    # a score that failed to save; `email_log` (migration 0008) keeps this to
    # one mail per player however many times this job re-runs.
    mailer.send_result_emails(
        race,
        {row["user_id"]: row for row in score_rows},
        model_table["total"],
    )

    db.upsert("results", {
        "race_id": race["id"],
        "classification": classification,
        "dotd": dotd_id,
        "safety_car": sc_actual,
        "scored_at": now.isoformat(),
    }, on_conflict="race_id")
    db.update("races", {"id": f"eq.{race['id']}"}, {"status": "scored"})
    print(f"round {race['round']}: scored — {summary}")
    return True


def _parse_rounds(spec: str) -> list[int]:
    """'13' → [13]; '1-4,7' → [1, 2, 3, 4, 7]."""
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return sorted(set(out))


def main() -> None:
    p = argparse.ArgumentParser(description="Score locked races; re-score recent ones.")
    p.add_argument("--rounds", metavar="SPEC",
                   help="re-score these rounds whatever their age, e.g. 13 or 1-13")
    p.add_argument("--season", type=int, default=datetime.now(timezone.utc).year)
    p.add_argument("--dry-run", action="store_true",
                   help="compute and print; write nothing, mail nobody")
    args = p.parse_args()

    if args.rounds:
        wanted = _parse_rounds(args.rounds)
        races = [r for r in db.select("races", {"season": f"eq.{args.season}",
                                                "order": "round.asc"})
                 if r["round"] in wanted]
        for race in races:
            if race["status"] == "scheduled":
                print(f"round {race['round']}: still scheduled — nothing to score")
                continue
            score_race(race, dry_run=args.dry_run)
        return

    now = datetime.now(timezone.utc)
    locked = db.select("races", {"status": "eq.locked"})
    rescore_window = (now - timedelta(days=RESCORE_DAYS)).isoformat()
    recent = db.select("races", {"status": "eq.scored",
                                 "race_at": f"gte.{rescore_window}"})
    for race in locked + recent:
        score_race(race, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
