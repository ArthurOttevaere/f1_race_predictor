"""Bridge between the game jobs and the ML model in src/.

Exposes the model as a *duel participant*. Two design decisions, both validated
by jobs/backtest.py and documented in docs/GAME_DESIGN.md §2.2:

1. Calibrated probabilities. The model's raw Monte-Carlo position matrix
   (performance ≈ score + N(0, sigma), same noise model as the win/podium
   probabilities on the model page) is blended with an empirical
   P(finish | grid) prior. This makes both the model's entry and the rarity
   multipliers well-calibrated against how F1 races actually play out.

2. Game-optimal order. The model plays the top 10 that maximizes its own
   expected game score under that calibrated matrix — not necessarily its
   argmax finishing order — so it is a genuine opponent rather than a pushover.
"""

from __future__ import annotations

import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))

import predict as model  # noqa: E402  (src/predict.py)

import db  # noqa: E402
import grid_prior  # noqa: E402
import safety_car  # noqa: E402

SIGMA = 2.0
N_SIMS = 10_000
SEED = 42

# Weight on the ML signal when blending with the grid prior (0 = grid only,
# 1 = pure model). ~0.25 makes the model a coin-flip-to-slight-favourite
# opponent versus a grid-copying human across 2025-2026 (see backtest).
CALIBRATION_BETA = 0.25


def _mc_matrix(scores: list[float], sigma: float, n: int, seed: int) -> np.ndarray:
    """Rows = drivers, cols = positions; P(driver finishes at position)."""
    s = np.asarray(scores, dtype=float)
    k = len(s)
    rng = np.random.default_rng(seed)
    sim = s[None, :] + rng.normal(0.0, sigma, size=(n, k))
    ranks = sim.argsort(axis=1).argsort(axis=1)  # 0 = winner
    return np.stack([(ranks == pos).mean(axis=0) for pos in range(k)], axis=1)


def _calibrate(mc: np.ndarray, grid_positions: list[int | None]) -> np.ndarray:
    """Blend each driver's MC row with the historical grid-prior row."""
    k = mc.shape[0]
    out = np.zeros_like(mc)
    for i, g in enumerate(grid_positions):
        prior = grid_prior.kernel_row(g, k)
        row = CALIBRATION_BETA * mc[i] + (1 - CALIBRATION_BETA) * prior
        out[i] = row / row.sum()
    return out


def _expected_points(matrix: np.ndarray) -> np.ndarray:
    """E[game points] for placing each driver at each of positions 1..10.

    Mirrors jobs/scoring.py base points (exact 10, ±1 = 5, elsewhere-top-10 = 2),
    ignoring the rarity multiplier (which the model, playing its own matrix,
    never triggers by construction).
    """
    k = matrix.shape[0]
    p_top10 = matrix[:, :10].sum(axis=1)
    e = np.zeros((k, 10))
    for pos in range(1, 11):
        p_exact = matrix[:, pos - 1]
        p_adj = (matrix[:, pos - 2] if pos >= 2 else 0.0) + (
            matrix[:, pos] if pos < k else 0.0
        )
        e[:, pos - 1] = 10 * p_exact + 5 * p_adj + 2 * np.maximum(
            0.0, p_top10 - p_exact - p_adj
        )
    return e


def _strategic_order(matrix: np.ndarray, driver_ids: list[str]) -> list[str]:
    """Assign drivers to positions 1..10 to maximise total expected points.

    Greedy global assignment (pick the best remaining driver×position cell
    each step). The expected-points matrix is strongly diagonal-dominant, so
    greedy matches the optimal assignment in practice and needs no scipy.
    """
    e = _expected_points(matrix)
    order: list[str | None] = [None] * 10
    used_drivers: set[int] = set()
    filled = 0
    cells = sorted(
        ((e[i, p], i, p) for i in range(e.shape[0]) for p in range(10)),
        reverse=True,
    )
    for _val, i, p in cells:
        if filled == 10:
            break
        if order[p] is None and i not in used_drivers:
            order[p] = driver_ids[i]
            used_drivers.add(i)
            filled += 1
    return [d for d in order if d is not None]


def position_prob_matrix(scores, driver_ids, grid_positions=None,
                         sigma=SIGMA, n=N_SIMS, seed=SEED):
    """Calibrated {driver_id: [P(P1), P(P2), …]} over the whole field."""
    mc = _mc_matrix(list(scores), sigma, n, seed)
    if grid_positions is not None:
        mc = _calibrate(mc, grid_positions)
    return {
        driver_ids[i]: [round(float(v), 4) for v in mc[i]]
        for i in range(len(driver_ids))
    }


def model_entry(season: int, rnd: int) -> dict:
    """Run the model for a race and package its calibrated duel entry.

    Returns {predicted_order, prob_matrix, pre_quali, event_name, sc_prob,
    sc_bet}. Raises if the model cannot produce a prediction at all (caller
    handles fallback).
    """
    df, event_name, circuit, used_pre_quali, _ = model.predict(season, rnd)
    df = df.sort_values("PredPos")
    driver_ids = [str(d) for d in df["DriverId"]]
    scores = [float(s) for s in df["score"]]
    grid_positions = [
        int(g) if g == g else None for g in df.get("GridPosition", [])
    ] or [None] * len(driver_ids)

    matrix = _mc_matrix(scores, SIGMA, N_SIMS, SEED)
    matrix = _calibrate(matrix, grid_positions)
    prob_matrix = {
        driver_ids[i]: [round(float(v), 4) for v in matrix[i]]
        for i in range(len(driver_ids))
    }
    order = _strategic_order(matrix, driver_ids)
    sc_prob, sc_bet = safety_car.model_bet(event_name, circuit)

    return {
        "predicted_order": order,
        "prob_matrix": prob_matrix,
        "pre_quali": bool(used_pre_quali),
        "event_name": event_name,
        "sc_prob": round(float(sc_prob), 4),
        "sc_bet": bool(sc_bet),
    }


def actual_classification(season: int, rnd: int) -> dict[str, int]:
    """Official race classification as {driver_id: position}, {} if not in yet.

    Two sources, in this order, because they disagree only about *when*:

    1. **Ergast** — keyed by `driver_id` already, and the reference the model
       has always trained against. It publishes days after the race.
    2. **F1 live timing** — the same final classification, within the hour, but
       keyed by driver code because the `driver_id` slug is an Ergast notion.
       Only read once the FIA marks the session `Finalised`, so this is the
       official result and not a provisional one.

    Ergast is usually quick — the 2026 Dutch Grand Prix was scored and mailed
    four hours after lights out — but it is not guaranteed, and the Italian
    Grand Prix was still unpublished five hours after the flag. Timing covers
    that gap. Ergast still wins whenever it is there: the ten-day re-score
    window in `jobs/score_race.py` replays a race scored from timing once
    Ergast lands, so the two sources can never drift apart.

    Note that GitHub Actions runners cannot reach the F1 timing API at all, so
    on CI this falls through to {} and scoring waits for Ergast (ALMANAC §8.9).
    """
    official = model.load_actual_results(season, rnd)
    if official:
        return official

    by_code = model.load_live_classification(season, rnd)
    if not by_code:
        return {}

    # `drivers` is written by jobs/sync_schedule.py from the same FastF1 roster,
    # so it is the season's own code → driver_id table rather than a mapping
    # maintained by hand here.
    driver_id_for = {
        d["code"]: d["driver_id"]
        for d in db.select("drivers", {"season": f"eq.{season}"})
    }
    # A code that is not in the roster means the two sources disagree about who
    # is racing, and scoring a partial classification is worse than not scoring
    # at all — the same instinct as the prediction count check in score_race.
    unknown = sorted(set(by_code) - set(driver_id_for))
    if unknown:
        print(f"round {rnd}: timing has unknown driver code(s) {unknown} — "
              f"not scoring from timing, waiting for Ergast")
        return {}

    return {driver_id_for[c]: p for c, p in by_code.items()}


def safety_car_occurred(season: int, rnd: int) -> bool | None:
    """True/False if a safety car was deployed, None if data isn't in yet."""
    return model.safety_car_occurred(season, rnd)
