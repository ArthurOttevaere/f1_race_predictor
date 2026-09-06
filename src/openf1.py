"""OpenF1 — the F1 timing feed, from a host that can actually reach it.

`livetiming.formula1.com` — the source behind every FastF1 "session" field
(grid, laps, race control, weather) — answers 403 to GitHub Actions runners.
api.openf1.org mirrors the same feed over a plain REST API and *is* reachable
from Actions (verified 2026-09-06, ALMANAC §8.9). Everything here is a read of
that mirror, shaped to what `predict.py` and the game jobs already consume.

Free tier: 3 req/s, 30 req/min, no key; a session's data becomes free about
30 minutes after it ends, which is exactly when the jobs want it. `_get`
paces itself under the limit and backs off on 429.

Two things this module is careful about:

* **Positions are Ergast-style.** OpenF1 gives a retired driver no position;
  Ergast ranks retirements after the finishers by laps completed. The scoring
  engine was built on Ergast, and the ten-day re-score window replays every
  race against Ergast once it publishes, so `classification()` reproduces that
  convention rather than inventing a third one.
* **Nothing here knows a `driver_id`.** OpenF1 speaks driver numbers and
  three-letter codes. Translating to the Ergast `driver_id` slug is the
  caller's job — the jobs use the season's `drivers` table, `predict.py` the
  Jolpica roster — because that is where the season's own mapping lives.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import requests

BASE_URL = "https://api.openf1.org/v1"
JOLPICA_URL = "https://api.jolpi.ca/ergast/f1"
TIMEOUT = 30
USER_AGENT = "f1-duel (+https://f1-duel.com)"

# Free tier is 3 req/s and 30 req/min; one call every 0.4 s stays under both
# for the handful of calls a job makes per race.
_MIN_INTERVAL = 0.4
_last_call = 0.0


class OpenF1Error(RuntimeError):
    """OpenF1 could not be read. Callers treat it as "no data yet" and retry
    on their next pass rather than failing a run."""


def _get(endpoint: str, **params) -> list[dict]:
    """One GET, rate-paced, with backoff on 429/5xx. An empty result is []
    (OpenF1 answers 404 for "no rows", which is not an error here)."""
    global _last_call
    url = f"{BASE_URL}/{endpoint}"
    for attempt in range(4):
        wait = _MIN_INTERVAL - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        try:
            r = requests.get(url, params=params, timeout=TIMEOUT,
                             headers={"User-Agent": USER_AGENT})
        except requests.RequestException as exc:
            if attempt == 3:
                raise OpenF1Error(f"{endpoint}: {exc}") from exc
            time.sleep(2 ** attempt)
            continue
        _last_call = time.monotonic()
        if r.status_code == 200:
            data = r.json()
            return data if isinstance(data, list) else []
        if r.status_code == 404:
            return []
        if r.status_code == 429 or r.status_code >= 500:
            retry_after = r.headers.get("Retry-After")
            time.sleep(float(retry_after) if retry_after and retry_after.isdigit()
                       else 2.0 * 2 ** attempt)
            continue
        raise OpenF1Error(f"{endpoint} -> {r.status_code}: {r.text[:200]}")
    raise OpenF1Error(f"{endpoint}: still failing after 4 attempts")


def _dt(v: str) -> datetime:
    d = datetime.fromisoformat(v.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


# ─── Finding the session ─────────────────────────────────────────────────────

def race_start(year: int, rnd: int) -> datetime | None:
    """Lights-out (UTC) for a round, from the Jolpica calendar. OpenF1 has no
    notion of a round number, so this is the bridge between the two."""
    try:
        r = requests.get(f"{JOLPICA_URL}/{year}/{rnd}.json", timeout=TIMEOUT,
                         headers={"User-Agent": USER_AGENT})
        races = r.json()["MRData"]["RaceTable"]["Races"]
    except Exception:
        return None
    if not races:
        return None
    race = races[0]
    return _dt(f"{race['date']}T{race.get('time') or '00:00:00Z'}")


def race_session(year: int, race_at: datetime) -> dict | None:
    """The race session that starts at `race_at` (UTC), or the closest one on
    the same weekend. None if OpenF1 does not list it (yet)."""
    if race_at.tzinfo is None:
        race_at = race_at.replace(tzinfo=timezone.utc)
    best, best_gap = None, timedelta(hours=12)
    for s in _get("sessions", year=year, session_name="Race"):
        gap = abs(_dt(s["date_start"]) - race_at)
        if gap < best_gap:
            best, best_gap = s, gap
    return best


def weekend_session(year: int, race_at: datetime, name: str) -> dict | None:
    """Another session of the same weekend by name — 'Qualifying',
    'Practice 3', 'Sprint' …"""
    race = race_session(year, race_at)
    if race is None:
        return None
    for s in _get("sessions", meeting_key=race["meeting_key"], session_name=name):
        return s
    return None


# ─── Roster ──────────────────────────────────────────────────────────────────

def drivers(session_key: int) -> dict[int, dict]:
    """{driver_number: {code, full_name, team, colour}} for a session."""
    out = {}
    for d in _get("drivers", session_key=session_key):
        colour = (d.get("team_colour") or "").lstrip("#")
        out[int(d["driver_number"])] = {
            "code": (d.get("name_acronym") or "")[:3],
            "full_name": d.get("full_name") or "",
            "team": d.get("team_name") or "",
            "colour": f"#{colour}" if colour else None,
        }
    return out


# ─── Race ────────────────────────────────────────────────────────────────────

def classification(session_key: int) -> dict[str, int]:
    """Final classification as {driver code: position}, {} until published.

    Ergast-style: finishers keep their position; everyone else follows, ranked
    by laps completed (retirements), then disqualifications, then non-starters
    — so every driver who took part has a position, as the scoring engine
    expects.
    """
    rows = _get("session_result", session_key=session_key)
    if not rows:
        return {}
    roster = drivers(session_key)

    placed = sorted((r for r in rows if r.get("position") is not None),
                    key=lambda r: int(r["position"]))
    rest = sorted((r for r in rows if r.get("position") is None),
                  key=lambda r: (bool(r.get("dns")), bool(r.get("dsq")),
                                 -int(r.get("number_of_laps") or 0)))

    out: dict[str, int] = {}
    next_pos = 1
    for r in placed:
        pos = int(r["position"])
        code = roster.get(int(r["driver_number"]), {}).get("code")
        if code:
            out[code] = pos
        next_pos = max(next_pos, pos + 1)
    for r in rest:
        code = roster.get(int(r["driver_number"]), {}).get("code")
        if code:
            out[code] = next_pos
        next_pos += 1
    return out


def safety_car(session_key: int) -> bool | None:
    """Was a safety car — full or virtual — deployed? None when race control
    has published nothing for the session, so the caller can wait.

    Only meaningful once the race is over: ask after `classification()` is
    non-empty, or a race still running would read as "no safety car yet".
    """
    msgs = _get("race_control", session_key=session_key)
    if not msgs:
        return None
    for m in msgs:
        text = (m.get("message") or "").upper()
        cat = (m.get("category") or "").replace(" ", "").upper()
        if "DEPLOYED" in text and (cat == "SAFETYCAR" or "SAFETY CAR" in text
                                   or "VSC" in text):
            return True
    return False


# ─── Qualifying and practice (what the model's features are built from) ─────

def qualifying(session_key: int) -> list[dict]:
    """[{number, position, q1, q2, q3}] — times in seconds, None when the
    driver did not run that segment. [] until the session is published."""
    out = []
    for r in _get("session_result", session_key=session_key):
        times = r.get("duration")
        if not isinstance(times, list):
            times = [times, None, None]
        times = (list(times) + [None, None, None])[:3]
        out.append({
            "number": int(r["driver_number"]),
            "position": int(r["position"]) if r.get("position") is not None else None,
            "q1": times[0], "q2": times[1], "q3": times[2],
        })
    return out


def lap_times(session_key: int) -> dict[int, list[float]]:
    """{driver_number: [lap seconds, …]} for every timed flying lap. Pit-out
    laps are dropped, as they never represent pace."""
    out: dict[int, list[float]] = {}
    for lap in _get("laps", session_key=session_key):
        t = lap.get("lap_duration")
        if t is None or lap.get("is_pit_out_lap"):
            continue
        out.setdefault(int(lap["driver_number"]), []).append(float(t))
    return out


def weather_summary(session_key: int) -> dict:
    """The same five keys `predict._weather_summary` derives from FastF1.
    {} when OpenF1 has no weather samples for the session."""
    rows = _get("weather", session_key=session_key)
    if not rows:
        return {}

    def mean(key: str) -> float | None:
        vals = [float(r[key]) for r in rows if r.get(key) is not None]
        return round(sum(vals) / len(vals), 1) if vals else None

    out = {
        "AirTemp_mean": mean("air_temperature"),
        "TrackTemp_mean": mean("track_temperature"),
        "Humidity_mean": mean("humidity"),
        "WindSpeed_mean": mean("wind_speed"),
        "Rainfall": any(bool(r.get("rainfall")) for r in rows),
    }
    return {k: v for k, v in out.items() if v is not None}


# ─── Ergast driver ids (for callers without a database) ─────────────────────

_roster_cache: dict[int, dict] = {}


def ergast_driver_ids(year: int) -> dict:
    """{'by_code': {code: driver_id}, 'by_number': {number: driver_id}} from
    the Jolpica season roster — the only public place the Ergast slug lives
    next to the timing code and number."""
    if year in _roster_cache:
        return _roster_cache[year]
    by_code, by_number = {}, {}
    try:
        r = requests.get(f"{JOLPICA_URL}/{year}/drivers.json", params={"limit": 100},
                         timeout=TIMEOUT, headers={"User-Agent": USER_AGENT})
        for d in r.json()["MRData"]["DriverTable"]["Drivers"]:
            if d.get("code"):
                by_code[d["code"]] = d["driverId"]
            if d.get("permanentNumber"):
                by_number[int(d["permanentNumber"])] = d["driverId"]
    except Exception:
        pass
    out = {"by_code": by_code, "by_number": by_number}
    if by_code:
        _roster_cache[year] = out
    return out
