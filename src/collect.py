"""
collect.py — Download historical F1 session data via FastF1.

Usage:
  python src/collect.py 2023                    → collect 2023 (race + quali + sprint)
  python src/collect.py 2023 --practice         → collect FP1/FP2/FP3 for 2023 only
  python src/collect.py 2025 --force            → re-collect 2025 after a new race
  python src/collect.py 2025 --force --practice → re-collect including FP data

Outputs in data/processed/seasons/{year}/:
  race_results.csv
  qualifying_results.csv
  sprint_results.csv
  practice_results.csv   ← FP1 + FP2 + FP3, one row per driver per session

Merged outputs in data/processed/:
  same files + driver_standings.csv + constructor_standings.csv
"""

import argparse
import os
import shutil
import sys
from datetime import date

import fastf1
import pandas as pd
from tqdm import tqdm

ROOT        = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR   = os.path.join(ROOT, 'fastf1_cache')
OUTPUT_DIR  = os.path.join(ROOT, 'data', 'processed')
SEASONS_DIR = os.path.join(OUTPUT_DIR, 'seasons')

ALL_SEASONS = range(2018, 2027)  # 2018 → 2026 included

# Idem predict.py : le cache est gitignoré, donc absent sur une machine fraîche.
os.makedirs(CACHE_DIR, exist_ok=True)
fastf1.Cache.enable_cache(CACHE_DIR)

_DROP_COLS = ['HeadShot', 'BroadcastName', 'TeamColor', 'CountryCode', 'FullName']


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _weather_summary(session):
    w = session.weather_data
    if w is None or w.empty:
        return {}
    return {
        'AirTemp_mean':   round(w['AirTemp'].mean(), 1),
        'TrackTemp_mean': round(w['TrackTemp'].mean(), 1),
        'Humidity_mean':  round(w['Humidity'].mean(), 1),
        'WindSpeed_mean': round(w['WindSpeed'].mean(), 1),
        'Rainfall':       bool(w['Rainfall'].any()),
    }


def _past_events(year):
    """Return only events that have already taken place."""
    schedule = fastf1.get_event_schedule(year, include_testing=False)
    today = pd.Timestamp(date.today())
    return schedule[schedule['EventDate'] <= today]


# ─── Race / Qualifying / Sprint loading ──────────────────────────────────────

def _load_session(year, round_number, session_type):
    session = fastf1.get_session(year, round_number, session_type)
    session.load(laps=False, telemetry=False, weather=True, messages=False)

    df = session.results.copy()
    if df.empty:
        return None
    # DriverId is the Ergast slug and every downstream merge keys on it. When
    # timing has the session but Ergast has not published it yet, FastF1 hands
    # back a full table with DriverId NaN throughout — 22 rows that would join
    # to everything. Treat that as "not published", exactly like an empty table.
    ids = df['DriverId'] if 'DriverId' in df.columns else pd.Series(dtype=object)
    if ids.isna().all() or ids.astype(str).str.strip().eq('').all():
        return None

    df = df.drop(columns=[c for c in _DROP_COLS if c in df.columns])
    df.insert(0, 'Season',      year)
    df.insert(1, 'Round',       round_number)
    df.insert(2, 'EventName',   session.event['EventName'])
    df.insert(3, 'Circuit',     session.event['Location'])
    df.insert(4, 'SessionType', session_type)
    df.insert(5, 'EventDate',   session.event['EventDate'].date())

    for k, v in _weather_summary(session).items():
        df[k] = v

    return df


def _try_load(year, rnd, session_type, label):
    try:
        return _load_session(year, rnd, session_type)
    except Exception as e:
        print(f"\n  [SKIP] {label} {year} R{rnd}: {e}", file=sys.stderr)
        return None


# ─── Practice loading (laps=True pour avoir les temps) ───────────────────────

def _load_practice_session(year, round_number, session_type):
    """
    Charge une session FP et retourne une ligne par pilote avec :
    - BestLapTime   : meilleur tour personnel
    - AvgLapTime    : moyenne des tours chronométrés
    - LapCount      : nombre de tours réalisés
    - GapToFastest  : écart au meilleur temps de la session (en secondes)
    """
    session = fastf1.get_session(year, round_number, session_type)
    session.load(laps=True, telemetry=False, weather=True, messages=False)

    laps = session.laps
    if laps is None or laps.empty:
        return None

    # Garder uniquement les tours avec un temps valide
    timed = laps[laps['LapTime'].notna()].copy()
    if timed.empty:
        return None

    # Stats par pilote
    stats = (
        timed.groupby('Driver')
        .agg(
            BestLapTime=('LapTime', 'min'),
            AvgLapTime=('LapTime', 'mean'),
            LapCount=('LapTime', 'count'),
        )
        .reset_index()
    )

    # Écart au plus rapide de la session (en secondes)
    fastest = stats['BestLapTime'].min()
    stats['GapToFastest'] = (stats['BestLapTime'] - fastest).dt.total_seconds()

    # Convertir les timedelta en secondes
    stats['BestLapTime'] = stats['BestLapTime'].dt.total_seconds()
    stats['AvgLapTime']  = stats['AvgLapTime'].dt.total_seconds()

    # Joindre les infos pilote depuis session.results
    info_cols = ['Abbreviation', 'DriverId', 'TeamName', 'FirstName', 'LastName']
    info_cols = [c for c in info_cols if c in session.results.columns]
    driver_info = session.results[info_cols].copy()
    driver_info = driver_info.rename(columns={'Abbreviation': 'Driver'})
    stats = stats.merge(driver_info, on='Driver', how='left')

    # Contexte
    stats.insert(0, 'Season',      year)
    stats.insert(1, 'Round',       round_number)
    stats.insert(2, 'EventName',   session.event['EventName'])
    stats.insert(3, 'Circuit',     session.event['Location'])
    stats.insert(4, 'SessionType', session_type)
    stats.insert(5, 'EventDate',   session.event['EventDate'].date())

    for k, v in _weather_summary(session).items():
        stats[k] = v

    return stats


def _try_load_practice(year, rnd, fp):
    try:
        return _load_practice_session(year, rnd, fp)
    except Exception as e:
        print(f"\n  [SKIP] {fp} {year} R{rnd}: {e}", file=sys.stderr)
        return None


# ─── Collect functions ────────────────────────────────────────────────────────

def collect_season(year):
    """Collect race, qualifying and sprint sessions for one season."""
    schedule = _past_events(year)
    races, quals, sprints = [], [], []

    for _, event in tqdm(schedule.iterrows(), total=len(schedule), desc=f'  {year}', ncols=80):
        rnd = event['RoundNumber']
        fmt = event.get('EventFormat', '')

        df = _try_load(year, rnd, 'R', 'Race')
        if df is not None:
            races.append(df)

        df = _try_load(year, rnd, 'Q', 'Quali')
        if df is not None:
            quals.append(df)

        if fmt in ('sprint', 'sprint_shootout', 'sprint_qualifying'):
            df = _try_load(year, rnd, 'S', 'Sprint')
            if df is not None:
                sprints.append(df)

    return races, quals, sprints


def collect_practice_season(year):
    """
    Collect FP1/FP2/FP3 for one season.
    Séparé car laps=True est plus lourd en requêtes API.
    FP2/FP3 n'existent pas sur les week-ends sprint 2023+ → [SKIP] normal.
    """
    schedule = _past_events(year)
    practices = []

    for _, event in tqdm(schedule.iterrows(), total=len(schedule), desc=f'  {year} FP', ncols=80):
        rnd = event['RoundNumber']
        for fp in ('FP1', 'FP2', 'FP3'):
            df = _try_load_practice(year, rnd, fp)
            if df is not None:
                practices.append(df)

    return practices


# ─── Standings computed locally ───────────────────────────────────────────────

def _compute_standings(race_df, group_col, id_col):
    rows = []
    for season, s_df in race_df.groupby('Season'):
        cumulative = {}
        for rnd in sorted(s_df['Round'].unique()):
            for entity, pts in cumulative.items():
                rows.append({'Season': season, 'BeforeRound': rnd,
                             id_col: entity, 'Points': pts})
            for _, r in s_df[s_df['Round'] == rnd].iterrows():
                key = r.get(group_col, '')
                cumulative[key] = cumulative.get(key, 0) + float(r.get('Points', 0) or 0)

    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df['Position'] = (
        df.groupby(['Season', 'BeforeRound'])['Points']
        .rank(method='min', ascending=False)
        .astype(int)
    )
    return df.sort_values(['Season', 'BeforeRound', 'Position'])


# ─── Save ─────────────────────────────────────────────────────────────────────

def _write_csv(rows, season_dir, filename):
    if rows:
        path = os.path.join(season_dir, filename)
        pd.concat(rows, ignore_index=True).to_csv(path, index=False)


def save_season(year, races, quals, sprints):
    season_dir = os.path.join(SEASONS_DIR, str(year))
    os.makedirs(season_dir, exist_ok=True)
    _write_csv(races,   season_dir, 'race_results.csv')
    _write_csv(quals,   season_dir, 'qualifying_results.csv')
    _write_csv(sprints, season_dir, 'sprint_results.csv')
    print(f"  → Saved to data/processed/seasons/{year}/")


def save_practice(year, practices):
    season_dir = os.path.join(SEASONS_DIR, str(year))
    os.makedirs(season_dir, exist_ok=True)
    _write_csv(practices, season_dir, 'practice_results.csv')
    print(f"  → Practice saved to data/processed/seasons/{year}/practice_results.csv")


def season_already_done(year):
    return os.path.exists(os.path.join(SEASONS_DIR, str(year), 'race_results.csv'))


def practice_already_done(year):
    path = os.path.join(SEASONS_DIR, str(year), 'practice_results.csv')
    if not os.path.exists(path):
        return False
    # Vérifie que le fichier contient bien des temps (pas l'ancienne version vide)
    df = pd.read_csv(path)
    return 'BestLapTime' in df.columns and df['BestLapTime'].notna().any()


# ─── Merge ────────────────────────────────────────────────────────────────────

def merge_all_seasons(seasons):
    fnames = ['race_results.csv', 'qualifying_results.csv',
              'sprint_results.csv', 'practice_results.csv']
    merged = {}

    for fname in fnames:
        parts = [
            pd.read_csv(os.path.join(SEASONS_DIR, str(y), fname))
            for y in seasons
            if os.path.exists(os.path.join(SEASONS_DIR, str(y), fname))
        ]
        if parts:
            df = pd.concat(parts, ignore_index=True)
            df.to_csv(os.path.join(OUTPUT_DIR, fname), index=False)
            merged[fname] = df
            print(f"  {fname}  ({len(df)} rows)")

    if 'race_results.csv' in merged:
        race_df = merged['race_results.csv']

        d_std = _compute_standings(race_df, 'DriverId', 'DriverId')
        if not d_std.empty:
            d_std.to_csv(os.path.join(OUTPUT_DIR, 'driver_standings.csv'), index=False)
            print(f"  driver_standings.csv  ({len(d_std)} rows)")

        c_std = _compute_standings(race_df, 'TeamName', 'TeamName')
        if not c_std.empty:
            c_std.to_csv(os.path.join(OUTPUT_DIR, 'constructor_standings.csv'), index=False)
            print(f"  constructor_standings.csv  ({len(c_std)} rows)")


# ─── CLI ─────────────────────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(description='Collect F1 historical data.')
    parser.add_argument(
        'year', nargs='?', type=int, default=None,
        help='Season to collect. Omit to process all seasons (2018-2026).'
    )
    parser.add_argument(
        '--practice', action='store_true',
        help='Collect FP1/FP2/FP3 data (heavier — loads laps). Can be combined with --force.'
    )
    parser.add_argument(
        '--force', action='store_true',
        help='Re-collect even if data already exists.'
    )
    return parser.parse_args()


def main():
    args = parse_args()
    os.makedirs(SEASONS_DIR, exist_ok=True)

    seasons = [args.year] if args.year else list(ALL_SEASONS)

    for year in seasons:
        print(f"\n{'='*45}")
        print(f"  Season {year}")
        print('='*45)

        # --- Race / Qualifying / Sprint ---
        if not args.practice:
            if season_already_done(year) and not args.force:
                print(f"  [SKIP] Race/Quali already collected — use --force to re-collect.")
            else:
                if args.force and season_already_done(year):
                    for f in ('race_results.csv', 'qualifying_results.csv', 'sprint_results.csv'):
                        p = os.path.join(SEASONS_DIR, str(year), f)
                        if os.path.exists(p):
                            os.remove(p)
                try:
                    races, quals, sprints = collect_season(year)
                    save_season(year, races, quals, sprints)
                except Exception as e:
                    print(f"  [ERROR] {year}: {e}", file=sys.stderr)

        # --- Practice ---
        if args.practice:
            if practice_already_done(year) and not args.force:
                print(f"  [SKIP] Practice already collected — use --force to re-collect.")
            else:
                if args.force:
                    p = os.path.join(SEASONS_DIR, str(year), 'practice_results.csv')
                    if os.path.exists(p):
                        os.remove(p)
                try:
                    practices = collect_practice_season(year)
                    save_practice(year, practices)
                except Exception as e:
                    print(f"  [ERROR] Practice {year}: {e}", file=sys.stderr)

    print(f"\n{'='*45}")
    print("  Merging all collected seasons...")
    merge_all_seasons(ALL_SEASONS)
    print(f"\n  Done. Data in: {OUTPUT_DIR}")


if __name__ == '__main__':
    main()
