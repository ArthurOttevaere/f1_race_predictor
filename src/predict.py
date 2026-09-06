"""
predict.py — Prédit le classement d'une prochaine course F1.

Usage:
  python src/predict.py                              → prochain GP automatique
  python src/predict.py --year 2026 --round 12      → GP spécifique (après qualifs)
  python src/predict.py --year 2026 --round 12 --pre-quali  → avant qualifs (FP seulement)

Pré-requis :
  • Les données historiques doivent être à jour (collect.py) pour les stats de forme.
  • Pour le mode post-qualifs, les qualifications doivent être terminées (sinon utiliser --pre-quali).

Output: classement prédit dans le terminal.
"""

import argparse
import json
import logging
import os
import sys
import warnings
warnings.filterwarnings('ignore')
from datetime import date

import fastf1
import numpy as np
import pandas as pd
from sklearn.preprocessing import LabelEncoder
import xgboost as xgb
import lightgbm as lgb

# Silence les logs FastF1 (INFO/WARNING parasites quand une session n'existe pas encore)
for _lg in ('fastf1', 'fastf1.core', 'fastf1.req', 'fastf1._api',
            'fastf1.ergast', 'urllib3', 'requests'):
    logging.getLogger(_lg).setLevel(logging.CRITICAL)

ROOT       = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA       = os.path.join(ROOT, 'data', 'processed')
MODELS_DIR = os.path.join(ROOT, 'models')
CACHE_DIR  = os.path.join(ROOT, 'fastf1_cache')

# Le cache est gitignoré : sur une machine fraîche (CI notamment) le dossier
# n'existe pas encore et enable_cache() lève NotADirectoryError.
os.makedirs(CACHE_DIR, exist_ok=True)
fastf1.Cache.enable_cache(CACHE_DIR)

STREET_CIRCUITS = {
    'Monaco', 'Monte Carlo', 'Baku', 'Marina Bay', 'Singapore',
    'Jeddah', 'Miami', 'Miami Gardens', 'Las Vegas', 'Melbourne', 'Montréal',
}


# ─── Chargement modèles ───────────────────────────────────────────────────────

def load_models():
    with open(os.path.join(MODELS_DIR, 'meta.json')) as f:
        meta = json.load(f)

    xgb_model = xgb.XGBRegressor()
    xgb_model.load_model(os.path.join(MODELS_DIR, 'xgb_model.json'))
    lgb_model = lgb.Booster(model_file=os.path.join(MODELS_DIR, 'lgb_model.txt'))

    encoders = {}
    for col, enc_col in [('DriverId', 'driver_encoded'),
                         ('TeamName', 'team_encoded'),
                         ('Circuit',  'circuit_encoded')]:
        le = LabelEncoder()
        le.classes_ = np.array(meta['encoders'][col])
        encoders[col] = le

    return xgb_model, lgb_model, meta, encoders


DEFAULT_WEATHER = {
    'AirTemp_mean': 22.0, 'TrackTemp_mean': 35.0,
    'Humidity_mean': 50.0, 'WindSpeed_mean': 10.0, 'Rainfall': False,
}


# ─── FastF1 helpers ───────────────────────────────────────────────────────────

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


def find_next_race(year):
    """Retourne (round_number, event_name) du prochain GP non encore disputé."""
    schedule = fastf1.get_event_schedule(year, include_testing=False)
    today = pd.Timestamp(date.today())
    future = schedule[schedule['EventDate'] > today]
    if future.empty:
        return None, None
    nxt = future.iloc[0]
    return int(nxt['RoundNumber']), nxt['EventName']


def load_qualifying(year, round_number):
    """Charge les résultats de qualification. Retourne None si indisponible."""
    try:
        session = fastf1.get_session(year, round_number, 'Q')
        session.load(laps=False, telemetry=False, weather=True, messages=False)
        df = session.results.copy()
        if df.empty:
            return None, {}
        weather = _weather_summary(session)
        return df, weather
    except Exception as e:
        print(f"  [INFO] Qualifs non disponibles: {e}")
        return None, {}


def load_practice(year, round_number):
    """Charge FP3 (ou FP1 si FP3 indisponible). Retourne stats par pilote."""
    for fp in ('FP3', 'FP2', 'FP1'):
        try:
            session = fastf1.get_session(year, round_number, fp)
            session.load(laps=True, telemetry=False, weather=True, messages=False)
            laps = session.laps
            if laps is None or laps.empty:
                continue
            timed = laps[laps['LapTime'].notna()].copy()
            if timed.empty:
                continue

            stats = (
                timed.groupby('Driver')
                .agg(
                    BestLapTime=('LapTime', 'min'),
                    AvgLapTime=('LapTime', 'mean'),
                    LapCount=('LapTime', 'count'),
                )
                .reset_index()
            )
            fastest = stats['BestLapTime'].min()
            stats['GapToFastest'] = (stats['BestLapTime'] - fastest).dt.total_seconds()
            stats['BestLapTime']  = stats['BestLapTime'].dt.total_seconds()
            stats['AvgLapTime']   = stats['AvgLapTime'].dt.total_seconds()

            info_cols = [c for c in ['Abbreviation', 'DriverId', 'TeamName']
                         if c in session.results.columns]
            driver_info = session.results[info_cols].rename(columns={'Abbreviation': 'Driver'})
            # Left join from laps (all who set times) + add session.results info where available.
            # DriverId may be NaN for some 2026 drivers — build_predict_df handles this via history.
            stats = stats.merge(driver_info, on='Driver', how='left')

            weather = _weather_summary(session)
            print(f"  → Données practice chargées depuis {fp} ({len(stats)} pilotes avec tours)")
            return stats, weather, fp
        except Exception as e:
            print(f"  [INFO] {fp} indisponible: {e}")
            continue
    return None, {}, None


# ─── Features historiques par pilote ─────────────────────────────────────────

def get_driver_history(df_hist, year, round_number):
    """
    Extrait l'état courant de chaque pilote depuis features.csv.
    Utilise uniquement les données antérieures à (year, round_number).
    """
    prior = df_hist[
        (df_hist['Season'] < year) |
        ((df_hist['Season'] == year) & (df_hist['Round'] < round_number))
    ].copy()

    if prior.empty:
        return pd.DataFrame()

    # Dernières 5 courses par pilote
    last5 = (
        prior.sort_values(['Season', 'Round'])
        .groupby('DriverId')
        .tail(5)
    )

    # Dernière course
    last1 = (
        prior.sort_values(['Season', 'Round'])
        .groupby('DriverId')
        .last()
        .reset_index()
    )

    form = (
        last5.groupby('DriverId')
        .agg(
            driver_form_pos_5=('Position', 'mean'),
            driver_form_pts_5=('Points', 'mean'),
            driver_reliability_10=('Status', lambda x:
                x.str.contains('Finished|Lap', regex=True).mean()),
        )
        .reset_index()
    )

    team_form = (
        last5.groupby('TeamName')
        .agg(team_form_pos_5=('Position', 'mean'))
        .reset_index()
    )

    result = last1[['DriverId', 'TeamName', 'driver_last_pos', 'driver_last_pts',
                     'driver_wet_advantage', 'driver_vs_teammate_rate',
                     'driver_momentum']].copy()

    # Renommer si les colonnes existent
    for col in ['driver_last_pos', 'driver_last_pts']:
        if col not in last1.columns:
            result[col] = np.nan

    result = result.merge(form, on='DriverId', how='left')
    result = result.merge(team_form, on='TeamName', how='left')

    # Momentum recalculé sur les données fraîches
    last10 = prior.sort_values(['Season', 'Round']).groupby('DriverId').tail(10)
    last3 = last10.groupby('DriverId').tail(3)['Position'].groupby(
        last10.groupby('DriverId').tail(3)['DriverId']).mean()
    prev3 = last10.groupby('DriverId').head(7).groupby('DriverId').tail(3)['Position'].groupby(
        last10.groupby('DriverId').head(7).groupby('DriverId').tail(3)['DriverId']).mean()
    momentum = (last3 - prev3).rename('driver_momentum_fresh')
    result = result.merge(momentum.reset_index(), on='DriverId', how='left')
    result['driver_momentum'] = result['driver_momentum_fresh'].fillna(
        result.get('driver_momentum', 0)
    )
    result = result.drop(columns=['driver_momentum_fresh'], errors='ignore')

    return result


def get_circuit_history(df_hist, circuit, year, round_number, drivers, teams):
    """Historique moyen sur ce circuit pour chaque pilote/équipe."""
    prior = df_hist[
        (df_hist['Circuit'] == circuit) &
        (
            (df_hist['Season'] < year) |
            ((df_hist['Season'] == year) & (df_hist['Round'] < round_number))
        )
    ]

    driver_avg = (prior.groupby('DriverId')['Position'].mean()
                  .reindex(drivers).reset_index()
                  .rename(columns={'Position': 'driver_circuit_avg'}))
    team_avg = (prior.groupby('TeamName')['Position'].mean()
                .reindex(teams).reset_index()
                .rename(columns={'Position': 'team_circuit_avg'}))

    # wet rate et dnf rate du circuit
    circuit_wet_rate = prior['Rainfall'].astype(bool).mean() if len(prior) > 0 else 0.1
    circuit_dnf_rate = (~prior['Status'].fillna('').str.contains(
        'Finished|Lap', regex=True)).mean() if len(prior) > 0 else 0.15

    return driver_avg, team_avg, circuit_wet_rate, circuit_dnf_rate


def get_standings(year, round_number):
    """Classement championnat à la veille de cette course."""
    d_std = pd.read_csv(os.path.join(DATA, 'driver_standings.csv'))
    c_std = pd.read_csv(os.path.join(DATA, 'constructor_standings.csv'))

    d = d_std[(d_std['Season'] == year) & (d_std['BeforeRound'] == round_number)]
    if d.empty:
        d = d_std[d_std['Season'] == year].sort_values('BeforeRound').groupby('DriverId').last().reset_index()

    c = c_std[(c_std['Season'] == year) & (c_std['BeforeRound'] == round_number)]
    if c.empty:
        c = c_std[c_std['Season'] == year].sort_values('BeforeRound').groupby('TeamName').last().reset_index()

    d = d.rename(columns={'Points': 'driver_champ_pts', 'Position': 'driver_champ_pos'})
    c = c.rename(columns={'Points': 'constructor_champ_pts', 'Position': 'constructor_champ_pos'})
    return d, c


# ─── Construction du dataset de prédiction ───────────────────────────────────

def build_predict_df(year, round_number, pre_quali=False, weather_override=None):
    """Assemble les features pour tous les pilotes d'une course à venir.

    weather_override ∈ {None, 'wet', 'dry'} force un scénario météo (mode what-if).
    """
    print(f"\n{'='*55}")
    print(f"  Chargement FastF1 ({year} R{round_number})...")

    # Practice (toujours chargé)
    fp_stats, fp_weather, fp_name = load_practice(year, round_number)

    # Qualifications (sauf mode pre-quali)
    if pre_quali:
        quali_df, quali_weather = None, {}
        print("  → Mode pré-qualifs : GridPosition estimé depuis les FP")
    else:
        quali_df, quali_weather = load_qualifying(year, round_number)
        if quali_df is None:
            print("  → Qualifs non disponibles, passage en mode pré-qualifs")
            pre_quali = True

    # Météo : qualifs > FP > défaut
    # DEFAULT_WEATHER garantit que Rainfall et les autres clés sont toujours présents
    # même quand aucune session FP/quali n'est encore disponible.
    weather = {**DEFAULT_WEATHER, **fp_weather, **quali_weather}

    # What-if météo : on force un scénario sec ou pluvieux.
    if weather_override == 'wet':
        weather['Rainfall']      = True
        weather['Humidity_mean'] = max(float(weather.get('Humidity_mean', 50) or 50), 88.0)
        weather['TrackTemp_mean'] = min(float(weather.get('TrackTemp_mean', 35) or 35), 24.0)
        weather['AirTemp_mean']  = min(float(weather.get('AirTemp_mean', 22) or 22), 18.0)
    elif weather_override == 'dry':
        weather['Rainfall']      = False
        weather['Humidity_mean'] = min(float(weather.get('Humidity_mean', 50) or 50), 45.0)

    # Circuit depuis FastF1
    try:
        event = fastf1.get_event(year, round_number)
        circuit = event['Location']
        event_name = event['EventName']
        total_rounds = len(fastf1.get_event_schedule(year, include_testing=False))
    except Exception:
        circuit = 'Unknown'
        event_name = f'R{round_number}'
        total_rounds = 24

    print(f"  Circuit : {circuit} ({event_name})")
    print(f"  Mode    : {'Pré-qualifs (FP seulement)' if pre_quali else 'Post-qualifs'}")

    # ── Données historiques
    df_hist = pd.read_csv(os.path.join(DATA, 'features.csv'))
    # Colonnes optionnelles (peuvent manquer dans l'ancienne version)
    for col in ['driver_wet_advantage', 'driver_vs_teammate_rate', 'driver_momentum',
                'driver_last_pos', 'driver_last_pts']:
        if col not in df_hist.columns:
            df_hist[col] = np.nan

    # ── Liste des pilotes : depuis qualifs, sinon FP, sinon dernière course
    if quali_df is not None and not quali_df.empty:
        drivers_info = quali_df[['DriverId', 'TeamName', 'Abbreviation']].dropna(subset=['DriverId'])
    elif fp_stats is not None:
        # load_practice renomme 'Abbreviation' → 'Driver' : on rétablit le nom attendu.
        fp_info = fp_stats.copy()
        if 'Abbreviation' not in fp_info.columns and 'Driver' in fp_info.columns:
            fp_info = fp_info.rename(columns={'Driver': 'Abbreviation'})
        fp_abbrevs = fp_info['Abbreviation'].dropna().unique()

        # session.results de FastF1 peut avoir des DriverId manquants pour les
        # nouvelles équipes/pilotes. On utilise features.csv comme source fiable.
        season_src = df_hist[df_hist['Season'] == year]
        if season_src.empty:
            season_src = df_hist[df_hist['Season'] == df_hist['Season'].max()]

        if not season_src.empty and len(fp_abbrevs) > 0:
            lineup = (
                season_src.sort_values('Round')
                .groupby('Abbreviation').last()[['DriverId', 'TeamName']]
                .reset_index()
            )
            drivers_info = (
                pd.DataFrame({'Abbreviation': fp_abbrevs})
                .merge(lineup, on='Abbreviation', how='left')
            )
            # Pilotes non trouvés dans l'historique → on essaie le DriverId de fp_stats
            if 'DriverId' in fp_info.columns:
                fp_ids = (
                    fp_info[['Abbreviation', 'DriverId', 'TeamName']]
                    .dropna(subset=['DriverId'])
                    .set_index('Abbreviation')
                )
                for idx in drivers_info.index[drivers_info['DriverId'].isna()]:
                    abbr = drivers_info.loc[idx, 'Abbreviation']
                    if abbr in fp_ids.index:
                        drivers_info.loc[idx, 'DriverId'] = fp_ids.loc[abbr, 'DriverId']
                        drivers_info.loc[idx, 'TeamName'] = fp_ids.loc[abbr, 'TeamName']
            drivers_info = drivers_info.dropna(subset=['DriverId'])
        elif 'DriverId' in fp_info.columns:
            drivers_info = fp_info[['DriverId', 'TeamName', 'Abbreviation']].dropna(subset=['DriverId'])
        else:
            drivers_info = pd.DataFrame(columns=['DriverId', 'TeamName', 'Abbreviation'])
    else:
        # Fallback : aucune session (FP/quali) disponible — typiquement une course
        # future. On reconstruit la grille de départ depuis les données existantes.
        season_rows = df_hist[df_hist['Season'] == year]
        if not season_rows.empty:
            # La saison cible est déjà présente : on reprend SON line-up (stable sur
            # la saison) au lieu de fusionner plusieurs saisons. Évite ainsi de
            # ressusciter des pilotes partis (ex: Doohan/Tsunoda en 2026).
            drivers_info = (
                season_rows.sort_values('Round')
                .groupby('DriverId').last().reset_index()
                [['DriverId', 'TeamName', 'Abbreviation']]
            )
            print(f"  [INFO] FP et qualifs non disponibles — line-up {year} repris des données de la saison")
        else:
            # Saison inconnue : on retombe sur le line-up de la dernière saison
            # connue UNIQUEMENT (pas N-1 en plus), pour ne pas mélanger les grilles.
            prior_races = df_hist[df_hist['Season'] < year].sort_values(['Season', 'Round'])
            last_season = prior_races['Season'].max()
            drivers_info = (
                prior_races[prior_races['Season'] == last_season]
                .groupby('DriverId').last().reset_index()
                [['DriverId', 'TeamName', 'Abbreviation']]
            )
            print(f"  [INFO] FP et qualifs non disponibles — line-up estimé depuis la saison {int(last_season)}")

    # Déduplique (le nombre de pilotes varie : 20 historiquement, 22 en 2026+)
    drivers_info = (
        drivers_info
        .drop_duplicates('DriverId')
        .dropna(subset=['DriverId', 'TeamName'])
        .reset_index(drop=True)
    )
    drivers = list(drivers_info['DriverId'])
    teams   = list(drivers_info['TeamName'])

    print(f"  Pilotes : {len(drivers_info)}")

    # ── Standings
    d_std, c_std = get_standings(year, round_number)

    # ── Historique circuit
    d_circ, t_circ, circuit_wet_rate, circuit_dnf_rate = get_circuit_history(
        df_hist, circuit, year, round_number, drivers, teams
    )

    # ── Forme récente par pilote
    driver_hist = get_driver_history(df_hist, year, round_number)

    # ── Assemblage ligne par ligne
    rows = []
    for _, drv in drivers_info.iterrows():
        driver_id = drv['DriverId']
        team_name = drv['TeamName']
        abbrev    = drv.get('Abbreviation', driver_id)
        row = {
            'DriverId': driver_id, 'TeamName': team_name,
            'Abbreviation': abbrev, 'Circuit': circuit,
            'Season': year, 'Round': round_number,
        }

        # Qualifs
        if not pre_quali and quali_df is not None:
            q = quali_df[quali_df['DriverId'] == driver_id]
            if not q.empty:
                q = q.iloc[0]
                row['GridPosition']     = q.get('GridPosition', np.nan)
                row['quali_position']   = q.get('Position', np.nan)
                # Meilleur temps Q3 > Q2 > Q1
                for qt in ('Q3', 'Q2', 'Q1'):
                    t = q.get(qt)
                    if pd.notna(t) and t != pd.NaT:
                        try:
                            row['best_quali_time'] = (
                                t.total_seconds() if hasattr(t, 'total_seconds')
                                else float(str(t).split(':')[-1]) if isinstance(t, str) else float(t)
                            )
                        except Exception:
                            pass
                        break
                # Gap to pole
                if 'best_quali_time' in row and quali_df is not None:
                    all_times = []
                    for qt in ('Q3', 'Q2', 'Q1'):
                        for _, qr in quali_df.iterrows():
                            t = qr.get(qt)
                            if pd.notna(t) and t != pd.NaT:
                                try:
                                    ts = (t.total_seconds() if hasattr(t, 'total_seconds')
                                          else float(t))
                                    all_times.append(ts)
                                    break
                                except Exception:
                                    pass
                    if all_times:
                        pole_time = min(all_times)
                        row['quali_gap_to_pole'] = row.get('best_quali_time', pole_time) - pole_time
            else:
                for c_ in ('GridPosition', 'quali_position', 'best_quali_time', 'quali_gap_to_pole'):
                    row[c_] = np.nan
        else:
            for c_ in ('GridPosition', 'quali_position', 'best_quali_time', 'quali_gap_to_pole'):
                row[c_] = np.nan

        # Practice
        fp3_gap = np.nan
        fp3_laps = np.nan
        fp_avg_gap = np.nan
        if fp_stats is not None:
            fp = fp_stats[fp_stats.get('Abbreviation', fp_stats.get('Driver', pd.Series())) == abbrev]
            if fp.empty and 'DriverId' in fp_stats.columns:
                fp = fp_stats[fp_stats['DriverId'] == driver_id]
            if not fp.empty:
                fp = fp.iloc[0]
                fp3_gap  = fp.get('GapToFastest', np.nan)
                fp3_laps = fp.get('LapCount', np.nan)
                fp_avg_gap = fp.get('GapToFastest', np.nan)  # même proxy

        # Pré-qualifs : GridPosition estimé depuis le gap FP (si dispo)
        if pre_quali and fp_stats is not None and not np.isnan(fp3_gap):
            all_gaps = fp_stats['GapToFastest'].dropna().sort_values()
            rank = list(all_gaps.values).index(
                min(all_gaps.values, key=lambda x: abs(x - fp3_gap))
            ) + 1
            row['GridPosition']      = rank
            row['quali_position']    = rank
            row['best_quali_time']   = fp.get('BestLapTime', np.nan) if isinstance(fp, pd.Series) else np.nan
            row['quali_gap_to_pole'] = fp3_gap

        row['fp3_gap']   = fp3_gap
        row['fp3_laps']  = fp3_laps
        row['fp_avg_gap'] = fp_avg_gap
        row['fp3_vs_quali_delta'] = (
            (fp3_gap - row.get('quali_gap_to_pole', fp3_gap))
            if not np.isnan(fp3_gap) else np.nan
        )

        # Standings
        ds = d_std[d_std['DriverId'] == driver_id]
        row['driver_champ_pos'] = float(ds['driver_champ_pos'].iloc[0]) if not ds.empty else 11.0
        row['driver_champ_pts'] = float(ds['driver_champ_pts'].iloc[0]) if not ds.empty else 0.0

        cs = c_std[c_std['TeamName'] == team_name]
        row['constructor_champ_pos'] = float(cs['constructor_champ_pos'].iloc[0]) if not cs.empty else 6.0
        row['constructor_champ_pts'] = float(cs['constructor_champ_pts'].iloc[0]) if not cs.empty else 0.0

        # Forme récente
        dh = driver_hist[driver_hist['DriverId'] == driver_id]
        if not dh.empty:
            dh = dh.iloc[0]
            row['driver_form_pos_5']       = dh.get('driver_form_pos_5', 10.0)
            row['driver_form_pts_5']       = dh.get('driver_form_pts_5', 5.0)
            row['driver_last_pos']         = dh.get('driver_last_pos', 10.0)
            row['driver_last_pts']         = dh.get('driver_last_pts', 5.0)
            row['driver_reliability_10']   = dh.get('driver_reliability_10', 0.85)
            row['team_form_pos_5']         = dh.get('team_form_pos_5', 10.0)
            row['driver_wet_advantage']    = dh.get('driver_wet_advantage', 0.0)
            row['driver_vs_teammate_rate'] = dh.get('driver_vs_teammate_rate', 0.5)
            row['driver_momentum']         = dh.get('driver_momentum', 0.0)
        else:
            row['driver_form_pos_5']       = 10.0
            row['driver_form_pts_5']       = 5.0
            row['driver_last_pos']         = 10.0
            row['driver_last_pts']         = 5.0
            row['driver_reliability_10']   = 0.85
            row['team_form_pos_5']         = 10.0
            row['driver_wet_advantage']    = 0.0
            row['driver_vs_teammate_rate'] = 0.5
            row['driver_momentum']         = 0.0

        # Historique circuit
        dc = d_circ[d_circ['DriverId'] == driver_id]
        tc = t_circ[t_circ['TeamName'] == team_name]
        row['driver_circuit_avg'] = (float(dc['driver_circuit_avg'].iloc[0])
                                     if not dc.empty and not pd.isna(dc['driver_circuit_avg'].iloc[0])
                                     else row['driver_form_pos_5'])
        row['team_circuit_avg']   = (float(tc['team_circuit_avg'].iloc[0])
                                     if not tc.empty and not pd.isna(tc['team_circuit_avg'].iloc[0])
                                     else row['team_form_pos_5'])

        # Coéquipier
        teammates = drivers_info[
            (drivers_info['TeamName'] == team_name) &
            (drivers_info['DriverId'] != driver_id)
        ]
        if not pre_quali and quali_df is not None and not teammates.empty:
            mate_id = teammates.iloc[0]['DriverId']
            mate_q = quali_df[quali_df['DriverId'] == mate_id]
            if not mate_q.empty:
                # En session Q, GridPosition est NaN → on prend la position de qualif
                mate_grid = mate_q['GridPosition'].iloc[0]
                if pd.isna(mate_grid):
                    mate_grid = mate_q['Position'].iloc[0]
                row['teammate_grid'] = float(mate_grid)
            else:
                row['teammate_grid'] = row.get('GridPosition', np.nan)
        else:
            row['teammate_grid'] = row.get('GridPosition', 10.0)

        # Features dérivées
        row['grid_champ_delta'] = (row.get('GridPosition', 10) or 10) - row['driver_champ_pos']
        row['season_progress']  = round_number / total_rounds

        # Météo
        row.update(weather)

        # Nouvelles features
        row['circuit_wet_rate']    = circuit_wet_rate
        row['circuit_dnf_rate']    = circuit_dnf_rate
        row['is_street_circuit']   = int(circuit in STREET_CIRCUITS)

        rows.append(row)

    df = pd.DataFrame(rows)

    # ── Imputation
    df['fp3_gap']    = df['fp3_gap'].fillna(df['fp_avg_gap']).fillna(0.0)
    df['fp_avg_gap'] = df['fp_avg_gap'].fillna(df['fp3_gap']).fillna(0.0)

    # Ordre championnat : dernier recours quand aucune donnée piste (FP/quali)
    # n'est disponible. Évite l'ordre alphabétique absurde.
    champ_order = (
        df['driver_champ_pos']
        .fillna(df['driver_form_pos_5'].fillna(10))
        .clip(1, len(df))
        .astype(float)
    )

    # quali_position = résultat des qualifs. À défaut → championnat.
    if df['quali_position'].isna().all():
        df['quali_position'] = champ_order
    else:
        df['quali_position'] = df['quali_position'].fillna(champ_order)

    # GridPosition = grille de DÉPART. Dans une session 'Q', FastF1 ne renseigne
    # pas GridPosition (NaN partout) car la grille n'existe qu'en course → on
    # retombe sur la position de qualification (= grille avant pénalités), et
    # seulement en tout dernier recours sur le classement championnat.
    df['GridPosition'] = (
        df['GridPosition']
        .fillna(df['quali_position'])
        .fillna(champ_order)
    )

    # quali_gap_to_pole : ~0.3 s par position de recul (proxy raisonnable)
    df['quali_gap_to_pole'] = df['quali_gap_to_pole'].fillna(
        (df['quali_position'] - 1) * 0.3
    )
    df['best_quali_time']    = df['best_quali_time'].fillna(df['best_quali_time'].median())
    df['fp3_vs_quali_delta'] = df['fp3_vs_quali_delta'].fillna(0.0)
    df['teammate_grid']      = df['teammate_grid'].fillna(df['GridPosition'])
    df['grid_champ_delta']   = df['grid_champ_delta'].fillna(0.0)
    df['Rainfall']           = df['Rainfall'].astype(int)

    return df, event_name, circuit, pre_quali


# ─── Noms lisibles pour les features ─────────────────────────────────────────

FEATURE_LABELS = {
    'quali_position':         'Position de qualification',
    'GridPosition':           'Position de départ',
    'quali_gap_to_pole':      'Écart à la pole (s)',
    'driver_form_pos_5':      'Forme récente (moy. 5 dernières)',
    'driver_champ_pos':       'Position au championnat',
    'driver_champ_pts':       'Points au championnat',
    'constructor_champ_pos':  'Équipe au championnat',
    'team_form_pos_5':        'Forme équipe (5 courses)',
    'driver_circuit_avg':     'Historique sur ce circuit',
    'team_circuit_avg':       'Historique équipe sur ce circuit',
    'driver_last_pos':        'Dernier résultat',
    'driver_last_pts':        'Points dernière course',
    'driver_reliability_10':  'Fiabilité (10 dernières)',
    'driver_momentum':        'Momentum (tendance récente)',
    'driver_vs_teammate_rate':'Domination coéquipier',
    'driver_wet_advantage':   'Avantage sous la pluie',
    'circuit_dnf_rate':       'Taux DNF du circuit',
    'fp3_gap':                'Écart FP3 au plus rapide',
    'fp_avg_gap':             'Écart moyen FP',
    'grid_champ_delta':       'Grille vs rang championnat',
    'Rainfall':               'Pluie',
    'season_progress':        'Avancement saison',
}


# ─── Prédiction ───────────────────────────────────────────────────────────────

def load_actual_results(year, round_number):
    """Résultats réels de la course (DriverId → position d'arrivée).

    Source Ergast, qui publie plusieurs jours après la course. Pour classer une
    course le dimanche soir, voir `load_live_classification` ci-dessous.

    Retourne {} si la course n'a pas encore eu lieu ou est indisponible.
    """
    try:
        session = fastf1.get_session(year, round_number, 'R')
        session.load(laps=False, telemetry=False, weather=False, messages=False)
        res = session.results
        if res is None or res.empty:
            return {}
        out = {}
        for _, r in res.iterrows():
            did = r.get('DriverId')
            pos = r.get('Position')
            if did and pos == pos:  # not NaN
                try:
                    out[str(did)] = int(pos)
                except (TypeError, ValueError):
                    continue
        return out
    except Exception:
        return {}


def load_live_classification(year, round_number):
    """Classement final depuis le chronométrage officiel F1 (code pilote → position).

    `load_actual_results` ne connaît qu'Ergast, qui publie une course avec
    plusieurs jours de retard — le jeu ne peut pas attendre autant pour classer
    un Grand Prix. Le flux de chronométrage F1, lui, porte le classement dans
    l'heure qui suit l'arrivée.

    Ce n'est pas pour autant du provisoire : on ne lit le classement que si le
    statut de session est passé à **Finalised**, l'accusé de réception de la FIA
    disant que les commissaires ont fini et que le classement est officiel. Tant
    qu'il n'y est pas (course en cours, enquête ouverte), on retourne {} et
    l'appelant réessaiera.

    Les positions sont clés par code pilote ('VER') et non par DriverId : le
    slug DriverId vient d'Ergast et arrive donc vide ici. La traduction en
    DriverId appartient à l'appelant, qui a le tableau des pilotes de la saison
    (voir jobs/model_bridge.actual_classification).

    Retourne {} si la course n'est pas courue, pas finalisée, ou indisponible.
    """
    try:
        session = fastf1.get_session(year, round_number, 'R')
        # laps=True : sans les tours, FastF1 n'a aucune autre source que Ergast
        # pour remplir Position, et rend une grille de NaN.
        session.load(laps=True, telemetry=False, weather=False, messages=False)

        status = session.session_status
        if status is None or status.empty:
            return {}
        if 'Finalised' not in set(str(s) for s in status.get('Status', [])):
            return {}

        res = session.results
        if res is None or res.empty:
            return {}
        out = {}
        for _, r in res.iterrows():
            code = r.get('Abbreviation')
            pos = r.get('Position')
            if code and pos == pos:  # not NaN
                try:
                    out[str(code)] = int(pos)
                except (TypeError, ValueError):
                    continue
        return out
    except Exception:
        return {}


def safety_car_occurred(year, round_number):
    """Was a safety car (full or virtual) deployed during the race?

    Returns True/False from the official race-control messages, or None when the
    race data isn't available yet (so the caller can wait and retry).
    """
    try:
        session = fastf1.get_session(year, round_number, 'R')
        session.load(laps=False, telemetry=False, weather=False, messages=True)
        if session.results is None or session.results.empty:
            return None  # race not run / not published yet
        rcm = session.race_control_messages
        if rcm is None or rcm.empty:
            return False
        text = ' '.join(str(m) for m in rcm.get('Message', [])).upper()
        cats = ' '.join(str(c) for c in rcm.get('Category', [])).upper()
        deployed = 'DEPLOYED' in text or 'SAFETYCAR' in cats.replace(' ', '')
        return bool(('SAFETY CAR' in text or 'VIRTUAL SAFETY CAR' in text) and deployed)
    except Exception:
        return None


def predict(year, round_number, pre_quali=False, weather_override=None):
    # Charger modèles
    xgb_model, lgb_model, meta, encoders = load_models()
    FEATURE_COLS = meta['feature_cols']

    # Construire features
    df, event_name, circuit, pre_quali = build_predict_df(
        year, round_number, pre_quali, weather_override
    )

    # Encodage
    for col, enc_col in [('DriverId', 'driver_encoded'),
                         ('TeamName', 'team_encoded'),
                         ('Circuit',  'circuit_encoded')]:
        le = encoders[col]
        df[enc_col] = df[col].map(
            lambda x: le.transform([x])[0] if x in le.classes_ else -1
        )

    # Colonnes manquantes → valeur neutre
    for col in FEATURE_COLS:
        if col not in df.columns:
            df[col] = 0.0

    X = df[FEATURE_COLS]
    import xgboost as _xgb
    dmat = _xgb.DMatrix(X)

    # Prédiction ensemble
    w_xgb = meta['ensemble_weights']['xgb']
    w_lgb = meta['ensemble_weights']['lgb']
    pred_xgb = xgb_model.predict(X)
    pred_lgb = lgb_model.predict(X)
    df['score'] = w_xgb * pred_xgb + w_lgb * pred_lgb

    # Contributions SHAP via XGBoost (pred_contribs = valeur par feature pour chaque pilote)
    contribs = xgb_model.get_booster().predict(dmat, pred_contribs=True)
    # contribs shape : (n_drivers, n_features + 1) — dernier col = biais
    contrib_df = pd.DataFrame(contribs[:, :-1], columns=FEATURE_COLS)
    contrib_df.index = df.index
    df['_shap_contribs'] = [contrib_df.iloc[i] for i in range(len(df))]

    # Classement
    df = df.sort_values('score').reset_index(drop=True)
    df['PredPos'] = range(1, len(df) + 1)

    return df, event_name, circuit, pre_quali, FEATURE_COLS


# ─── Affichage ────────────────────────────────────────────────────────────────

def display(df, event_name, circuit, year, round_number, pre_quali, explain=False):
    mode = "Pré-qualifs (estimation depuis FP)" if pre_quali else "Post-qualifs"

    print(f"\n{'='*62}")
    print(f"  PREDICTION : {event_name} {year}")
    print(f"  Circuit    : {circuit}")
    print(f"  Mode       : {mode}")
    print(f"{'='*62}")
    print(f"  {'P':>3}  {'Pilote':<8}  {'Equipe':<20}  {'Score':>6}  {'Grid':>5}")
    print(f"  {'-'*57}")

    for _, row in df.iterrows():
        grid = int(row.get('GridPosition', 0)) if pd.notna(row.get('GridPosition')) else '?'
        team_short = str(row['TeamName'])[:18]
        score = f"{row['score']:.2f}"
        flag = ""
        if row['PredPos'] <= 3:
            flag = "  ★"
        elif row['PredPos'] <= 10:
            flag = "   ↑" if (row.get('GridPosition') or 999) > row['PredPos'] else ""
        print(f"  {int(row['PredPos']):>3}  {str(row['Abbreviation']):<8}  "
              f"{team_short:<20}  {score:>6}  {str(grid):>5}{flag}")

    print(f"\n  Top-10 prédit : "
          + ", ".join(df.head(10)['Abbreviation'].astype(str).tolist()))

    if pre_quali:
        print(f"\n  [!] Pré-qualifs : grille estimée depuis le classement championnat.")
        print(f"      Relance après les qualifs pour une prédiction plus précise.")

    print(f"{'='*62}\n")

    if explain:
        display_explain(df)


def display_explain(df):
    """Affiche les 3 facteurs clés qui influencent chaque pilote (contributions SHAP XGB)."""
    print(f"{'='*62}")
    print(f"  EXPLICABILITE — Facteurs clés par pilote")
    print(f"  (négatif = pousse vers l'avant, positif = vers l'arrière)")
    print(f"{'='*62}")

    for _, row in df.iterrows():
        contribs = row.get('_shap_contribs')
        if contribs is None:
            continue

        # Top 3 features les plus influentes (valeur absolue)
        top = contribs.abs().nlargest(3)
        abbrev = str(row['Abbreviation'])
        pos = int(row['PredPos'])
        score = row['score']

        print(f"\n  P{pos:>2}  {abbrev}  (score prédit : {score:.1f})")
        for feat, _ in top.items():
            val = contribs[feat]
            label = FEATURE_LABELS.get(feat, feat)
            direction = "▼ favorise" if val < 0 else "▲ pénalise"
            raw_val = row.get(feat, '')
            # Formater la valeur brute lisiblement
            if isinstance(raw_val, float):
                raw_str = f"{raw_val:.2f}"
            else:
                raw_str = str(raw_val)
            print(f"      {direction:>12}  {label:<35}  [{raw_str}]  ({val:+.2f})")

    print(f"\n{'='*62}\n")


# ─── CLI ─────────────────────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(description='Prédit le classement d\'un GP F1.')
    parser.add_argument('--year',  type=int, default=None)
    parser.add_argument('--round', type=int, default=None, dest='round_number')
    parser.add_argument('--pre-quali', action='store_true',
                        help='Mode pré-qualifs : n\'essaie pas de charger les qualifs.')
    parser.add_argument('--explain', action='store_true',
                        help='Affiche les facteurs clés (SHAP) qui expliquent chaque prédiction.')
    parser.add_argument('--driver', type=str, default=None,
                        help='Filtre l\'explicabilité sur un pilote (ex: VER, NOR).')
    return parser.parse_args()


def main():
    args = parse_args()

    year = args.year or date.today().year
    round_number = args.round_number

    if round_number is None:
        print(f"\nRecherche du prochain GP en {year}...")
        round_number, event_name = find_next_race(year)
        if round_number is None:
            print("  Aucun GP trouvé. Spécifie --year et --round manuellement.")
            sys.exit(1)
        print(f"  → {event_name} (Round {round_number})")

    df, event_name, circuit, pre_quali, _ = predict(year, round_number, args.pre_quali)

    # Filtre pilote pour --explain --driver
    df_display = df.copy()
    if args.explain and args.driver:
        driver_mask = df['Abbreviation'].str.upper() == args.driver.upper()
        if driver_mask.any():
            df_explain = df[driver_mask]
        else:
            print(f"  [WARN] Pilote '{args.driver}' non trouvé. Affichage de tous.")
            df_explain = df
    else:
        df_explain = df

    display(df_display, event_name, circuit, year, round_number, pre_quali, explain=False)

    if args.explain:
        display_explain(df_explain)


if __name__ == '__main__':
    main()
