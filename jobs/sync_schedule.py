"""Weekly sync: season calendar, driver roster, championship-pick metadata.

Run:  python jobs/sync_schedule.py [season]

- Upserts the season calendar into `races` (never touches `status`).
- Refreshes the `drivers` roster from the latest completed race (names, teams,
  team colors for profile theming).
- Fills rank-at-lock + prorate on fresh `season_picks` rows (docs §2.3), using
  the Jolpica/Ergast standings API.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone

import pandas as pd
import requests

import db
import model_bridge  # noqa: F401  (configures the FastF1 cache via src/predict)
import fastf1
import openf1  # src/openf1.py, on sys.path thanks to model_bridge


def _utc(v):
    if v is None or pd.isna(v):
        return None
    ts = pd.Timestamp(v)
    ts = ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")
    return ts.isoformat()


def sync_calendar(season: int) -> None:
    schedule = fastf1.get_event_schedule(season, include_testing=False)
    rows = []
    for _, ev in schedule.iterrows():
        quali_at = race_at = None
        for i in range(1, 6):
            name = str(ev.get(f"Session{i}") or "")
            when = ev.get(f"Session{i}DateUtc")
            if name == "Qualifying":
                quali_at = _utc(when)
            elif name == "Race":
                race_at = _utc(when)
        rows.append({
            "season": season,
            "round": int(ev["RoundNumber"]),
            "name": str(ev["EventName"]),
            "circuit": str(ev.get("Location") or ""),
            "country": str(ev.get("Country") or ""),
            "quali_at": quali_at,
            "race_at": race_at,
            # no "status" key: upserts must never revert locked/scored races
        })
    db.upsert("races", rows, on_conflict="season,round")
    print(f"calendar: {len(rows)} races upserted for {season}")


def sync_roster(season: int) -> None:
    now = datetime.now(timezone.utc)
    past = [r for r in db.select("races", {"season": f"eq.{season}",
                                           "order": "round.desc"})
            if r["race_at"] and datetime.fromisoformat(r["race_at"]) < now]
    for race in past:  # newest first; fall back if results are missing
        try:
            session = fastf1.get_session(season, race["round"], "R")
            session.load(laps=False, telemetry=False, weather=False, messages=False)
            res = session.results
            if res is None or res.empty:
                continue
        except Exception:
            continue
        rows = []
        for _, r in res.iterrows():
            if not r.get("DriverId"):
                continue
            color = str(r.get("TeamColor") or "").lstrip("#")
            rows.append({
                "season": season,
                "driver_id": str(r["DriverId"]),
                "code": str(r.get("Abbreviation") or "")[:3],
                "full_name": str(r.get("FullName") or r.get("DriverId")),
                "team": str(r.get("TeamName") or "Unknown"),
                "team_color": f"#{color}" if color else None,
                "active": True,
            })
        _fill_team_colours(season, race, rows)
        db.upsert("drivers", rows, on_conflict="season,driver_id")
        print(f"roster: {len(rows)} drivers from round {race['round']}")
        return
    print("roster: no completed race with results yet")


def _fill_team_colours(season: int, race: dict, rows: list[dict]) -> None:
    """Team colours are timing-only, so on Actions FastF1 leaves every one of
    them null (all 23 of 2026 were, until 2026-09). OpenF1 carries the same
    colours and is reachable there; read them by driver code."""
    if all(r["team_color"] for r in rows) or not race.get("race_at"):
        return
    try:
        session = openf1.race_session(season, datetime.fromisoformat(race["race_at"]))
        if session is None:
            return
        by_code = {d["code"]: d["colour"] for d in openf1.drivers(session["session_key"]).values()}
    except openf1.OpenF1Error as e:
        print(f"roster: OpenF1 colours unavailable ({e})")
        return
    filled = 0
    for r in rows:
        if not r["team_color"] and by_code.get(r["code"]):
            r["team_color"] = by_code[r["code"]]
            filled += 1
    if filled:
        print(f"roster: {filled} team colour(s) from OpenF1")


def _standings(season: int, kind: str) -> list[dict]:
    url = f"https://api.jolpi.ca/ergast/f1/{season}/{kind}standings.json"
    data = requests.get(url, timeout=30).json()
    lists = data["MRData"]["StandingsTable"]["StandingsLists"]
    return lists[0][f"{kind.capitalize()}Standings"] if lists else []


def fill_season_picks(season: int) -> None:
    picks = db.select("season_picks", {"season": f"eq.{season}",
                                       "prorate": "is.null"})
    if not picks:
        return
    races = db.select("races", {"season": f"eq.{season}"})
    total = len(races) or 1
    try:
        d_stand = _standings(season, "driver")
        c_stand = _standings(season, "constructor")
    except Exception as e:
        print(f"season_picks: standings unavailable ({e}), retry next run")
        return

    def driver_rank(driver_id: str) -> int | None:
        for s in d_stand:
            if s["Driver"]["driverId"] == driver_id:
                return int(s["position"])
        return None

    def team_rank(team: str) -> int | None:
        t = team.casefold()
        for s in c_stand:
            name = s["Constructor"]["name"].casefold()
            if name in t or t in name:
                return int(s["position"])
        return None

    for p in picks:
        locked = datetime.fromisoformat(p["locked_at"])
        remaining = sum(1 for r in races
                        if r["race_at"] and datetime.fromisoformat(r["race_at"]) > locked)
        db.update(
            "season_picks",
            {"user_id": f"eq.{p['user_id']}", "season": f"eq.{season}"},
            {"driver_rank_at_lock": driver_rank(p["champion_driver"]),
             "team_rank_at_lock": team_rank(p["champion_team"]),
             "prorate": round(max(0.2, remaining / total), 3)},
        )
    print(f"season_picks: filled {len(picks)} new pick(s)")


if __name__ == "__main__":
    season = int(sys.argv[1]) if len(sys.argv) > 1 else datetime.now(timezone.utc).year
    sync_calendar(season)
    sync_roster(season)
    fill_season_picks(season)
