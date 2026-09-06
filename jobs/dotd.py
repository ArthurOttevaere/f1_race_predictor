"""Driver of the Day, read from formula1.com — with `set_dotd.py` as the hand.

There is no DotD API. What there is: after every race, formula1.com publishes
an article whose URL slug starts with `driver-of-the-day-<name>-…`, and the
race's own hub page (`/en/racing/<season>/<slug>`) links to it — for the
current weekend and, it turns out, for past ones too. That link is the whole
signal read here: the article slug names the driver, the season roster turns
the name into a `driver_id`.

Scraping, so it is built to fail closed:

* a hub that cannot be matched, a slug naming nobody on the roster — or two
  people — is `None`, never a guess. `score_race` keeps re-asking for ten
  days, and `set_dotd.py` still works whenever a human wants to end it;
* one request per hub, paced, with a real User-Agent; the season page is
  fetched once per run and cached;
* the article slug is read as text, never rendered. formula1.com's pages are
  client-rendered, and the anchor is the one thing in the raw HTML.

Verified 2026-09-06 against the Italian, Dutch, Belgian and Barcelona hubs.
"""

from __future__ import annotations

import re
import time
import unicodedata

import requests

SITE = "https://www.formula1.com"
TIMEOUT = 20
USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 "
              "f1-duel (+https://f1-duel.com)")

_season_hubs: dict[int, list[str]] = {}


def _fetch(path: str) -> str | None:
    try:
        r = requests.get(f"{SITE}{path}", timeout=TIMEOUT,
                         headers={"User-Agent": USER_AGENT, "Accept-Language": "en"})
    except requests.RequestException as exc:
        print(f"  dotd: {path} unreachable ({exc})")
        return None
    if r.status_code != 200:
        print(f"  dotd: {path} -> {r.status_code}")
        return None
    return r.text


def _fold(text: str) -> str:
    """Lower-case ASCII with accents stripped, so 'Hülkenberg' meets 'hulkenberg'."""
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()


def _tokens(text: str) -> set[str]:
    return {t for t in re.split(r"[^a-z0-9]+", _fold(text)) if t}


def season_hubs(season: int) -> list[str]:
    """Slugs of every race hub on formula1.com for the season, e.g.
    ['australia', 'barcelona-catalunya', …]. Cached per run."""
    if season not in _season_hubs:
        html = _fetch(f"/en/racing/{season}") or ""
        slugs = sorted(set(re.findall(rf"/en/racing/{season}/([a-z0-9\-]+)", html)))
        _season_hubs[season] = [s for s in slugs if "testing" not in s]
    return _season_hubs[season]


def hub_candidates(race: dict) -> list[str]:
    """Hub slugs for a race, best guess first.

    Ranked by how many of the slug's words appear in the race's name, circuit
    and country — so 'italy' wins the Italian Grand Prix outright, and the
    two Spanish rounds are told apart by circuit ('barcelona-catalunya' for
    Barcelona, plain 'spain' for Madrid). Only slugs with at least one word in
    common are candidates at all.
    """
    name_words = _tokens(str(race.get("name") or "")) - {"grand", "prix"}
    haystack = _tokens(" ".join(str(race.get(k) or "") for k in ("name", "circuit", "country")))
    # Formula1.com says 'great-britain' where the calendar says 'United Kingdom'
    # / 'British', and 'united-arab-emirates' for Abu Dhabi.
    if "british" in haystack or "kingdom" in haystack or "silverstone" in haystack:
        haystack |= {"great", "britain"}
    if "abu" in haystack and "dhabi" in haystack:
        haystack |= {"united", "arab", "emirates"}
    if "sao" in haystack or "paulo" in haystack or "interlagos" in haystack:
        haystack.add("brazil")
    if "mexico" in haystack:
        haystack.add("mexico")

    scored = []
    for slug in season_hubs(race["season"]):
        words = set(slug.split("-"))
        hit = len(words & haystack)
        if hit:
            # A word from the race's own name first ('miami' over the
            # country's 'united-states', 'barcelona-catalunya' over 'spain'),
            # then full-word coverage, then hit count.
            scored.append((len(words & name_words), hit / len(words), hit, slug))
    scored.sort(reverse=True)
    return [s for *_, s in scored]


def _hub_matches(html: str, race: dict) -> bool:
    """The hub's <title> names the Grand Prix — the check that keeps 'spain'
    from being read for Barcelona."""
    m = re.search(r"<title>(.*?)</title>", html, re.S)
    if not m:
        return False
    title = _tokens(m.group(1))
    name = _tokens(str(race.get("name") or "")) - {"grand", "prix"}
    return bool(name & title)


def article_slug(race: dict) -> str | None:
    """The `driver-of-the-day-…` article slug linked from the race hub, or
    None while formula1.com has not published one."""
    for slug in hub_candidates(race)[:3]:
        html = _fetch(f"/en/racing/{race['season']}/{slug}")
        time.sleep(0.5)
        if not html or not _hub_matches(html, race):
            continue
        found = re.findall(r"/en/latest/article/(driver-of-the-day-[a-z0-9\-]+)\.", html)
        if found:
            return found[0]
        return None  # right hub, nothing published yet
    return None


def driver_from_slug(slug: str, roster: list[dict]) -> str | None:
    """Match the article slug to exactly one driver of the roster.

    The slug's words after `driver-of-the-day-` are compared with each
    driver's surname (and given names): 'kimi-antonelli' → Antonelli,
    'hamilton' → Hamilton. Anything but exactly one hit is None — a headline
    naming two drivers ('norris-edges-alonso') is resolved by keeping only
    the drivers named *first*, before any other driver's name appears.
    """
    words = slug.removeprefix("driver-of-the-day-").split("-")
    hits: list[tuple[int, str]] = []  # (position in headline, driver_id)
    for d in roster:
        names = _tokens(d.get("full_name") or "")
        surname = _fold((d.get("full_name") or "").split()[-1]) if d.get("full_name") else ""
        for i, w in enumerate(words):
            if w and (w == surname or (w in names and len(w) > 3)):
                hits.append((i, d["driver_id"]))
                break
    if not hits:
        return None
    hits.sort()
    first_pos, first_id = hits[0]
    # Same driver may match on two words; different driver later in the
    # headline is the "edges Alonso" case — the first name wins.
    others = {d for p, d in hits if d != first_id and p == first_pos}
    return None if others else first_id


def official_dotd(race: dict, roster: list[dict]) -> str | None:
    """`driver_id` of the Driver of the Day, or None if not (yet) knowable."""
    slug = article_slug(race)
    if not slug:
        return None
    driver_id = driver_from_slug(slug, roster)
    print(f"  dotd: {slug} -> {driver_id or 'no unique roster match'}")
    return driver_id
