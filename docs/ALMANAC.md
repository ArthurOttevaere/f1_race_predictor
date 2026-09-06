# The Almanac — F1 Race Predictor & F1 Duel

> The complete internal manual for this project: what every part does, why it
> exists, how the pieces are wired together, and what to do when something
> breaks. If you can only read one document, read this one.

**Status:** live in production.
**Last reviewed:** 2026-09-06 (`feat/openf1-sources` — OpenF1 as the timing source Actions can reach: same-evening scoring, safety car, grid, Driver of the Day; live on https://f1-duel.com).
**Maintenance rule:** this file must be updated in the same change that alters
behaviour it describes — schema, scoring, jobs, routes, env vars, deployment,
workflows. See [§14 Keeping this document true](#14-keeping-this-document-true).

Related documents (this one links them together, it does not replace them):

| Document | Scope |
| --- | --- |
| [`GAME_DESIGN.md`](GAME_DESIGN.md) | Source of truth for the **game rules**. Change rules there first. |
| [`DESIGN.md`](DESIGN.md) | Source of truth for the **design system** — palette, type, components, motion, a11y, the phone rules. §9.6 here is the short version. |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Step-by-step first-time deployment (Supabase → Actions → Vercel → Render). |
| [`DATABASE.md`](DATABASE.md) | **"I want to do X, what do I type?"** — every operator action against the live database, as a command. Start there; §12 here is the reasoning behind it. |
| [`../supabase/README.md`](../supabase/README.md) | Database setup, security model, migrations, the 1000-row cap. |
| [`../jobs/README.md`](../jobs/README.md) | Job cheat-sheet + why keepalive exists. |
| [`../web/README.md`](../web/README.md) | Frontend local development. |
| [`../README.md`](../README.md) | Public-facing project pitch. |

---

## Table of contents

1. [What this project actually is](#1-what-this-project-actually-is)
2. [System architecture](#2-system-architecture)
3. [Repository map](#3-repository-map)
4. [Part I — The machine-learning model](#4-part-i--the-machine-learning-model)
5. [Part II — The Flask model platform](#5-part-ii--the-flask-model-platform)
6. [Part III — The game: rules and scoring engine](#6-part-iii--the-game-rules-and-scoring-engine)
7. [Part IV — The database](#7-part-iv--the-database)
8. [Part V — Jobs and automation](#8-part-v--jobs-and-automation)
9. [Part VI — The web frontend](#9-part-vi--the-web-frontend)
10. [Part VII — Configuration, secrets, environments](#10-part-vii--configuration-secrets-environments)
11. [Part VIII — Git and GitHub workflow](#11-part-viii--git-and-github-workflow)
12. [Part IX — Operations runbook](#12-part-ix--operations-runbook)
13. [Part X — Known issues, debt and roadmap](#13-part-x--known-issues-debt-and-roadmap)
14. [Keeping this document true](#14-keeping-this-document-true)
15. [Appendices](#15-appendices)

---

## 1. What this project actually is

Two products living in one repository, sharing one machine-learning model.

### 1.1 The model (the original project)

A supervised-learning system that predicts the **finishing order of a Formula 1
Grand Prix** from data that exists *before* the race starts. Trained on
2018–2025 real session data collected via FastF1, it outputs a continuous
"score" per driver (lower = further forward), which is sorted into a predicted
classification. It ships with an explainability layer (SHAP), Monte-Carlo win /
podium probabilities, and a self-contained Flask web app that presents all of
that plus weather, circuit maps, championship standings and title scenarios.

### 1.2 The game — **F1 Duel** (what the project became)

A season-long game where humans predict the top 10 of every Grand Prix and are
scored against the model with *exactly the same formula*. The design twist that
makes it a game rather than a leaderboard: **points are multiplied by how
unlikely the model thought your correct pick was.** The model, by construction,
plays what it considers most likely, so it rarely earns multipliers. A human
beats it only by making bold calls that land.

### 1.3 Why they are one repository

The game needs the model — the model *is* the opponent, and its probability
matrix *is* the scoring currency. Separating them into two repos would mean
versioning a prediction API across a network boundary for no benefit. Instead:
**model work and game work are separated by directory, not by branch or repo.**
There is one long-lived branch (`main`).

### 1.4 Design principles that explain most decisions

1. **Everything runs on free tiers.** Vercel hobby, Supabase free, GitHub
   Actions free, Render free (optional). This constraint explains the batch-job
   architecture, the keepalive workflow, and the aggressive caching.
2. **The game must never depend on a server that sleeps.** Free Render
   instances sleep after 15 minutes; therefore the game never calls the Flask
   app. Locking and scoring are cron jobs writing straight to Postgres.
3. **Fair play is enforced by the database, not the UI.** Row Level Security
   decides who can write a prediction and when, and who can read someone
   else's. A malicious client with the anon key still cannot cheat.
4. **One place per rule.** Scoring lives only in `jobs/scoring.py`. Nav links
   live only in `web/lib/nav.ts`. Game rules live only in `GAME_DESIGN.md`.
5. **Batch, cache, and pre-warm.** FastF1 calls are slow (seconds to minutes).
   Every layer caches: FastF1's own SQLite HTTP cache, JSON disk caches, Flask
   in-memory caches, Next.js `revalidate`.

---

## 2. System architecture

### 2.1 The four runtimes

```
        ┌──────────────────────────────────────────────────────────────┐
        │                        THE INTERNET                          │
        └───────┬──────────────────────────────────┬───────────────────┘
                │                                  │
     ┌──────────▼───────────┐          ┌───────────▼─────────────┐
     │  web/  (Next.js 16)  │          │  src/app.py (Flask)     │
     │  Vercel              │          │  Render (optional)      │
     │  ── the GAME         │  link →  │  ── the MODEL platform  │
     │  home, duel, boards  │          │  predictions, weather,  │
     │  auth, profiles      │          │  circuits, standings    │
     └──────────┬───────────┘          └───────────┬─────────────┘
                │ @supabase/ssr (anon key, RLS)    │ reads models/ + data/
                │                                  │ calls FastF1 + Open-Meteo
     ┌──────────▼──────────────────────────────────▼─────────────┐
     │  Supabase — Postgres + Auth + RLS  (all game state)        │
     └──────────▲────────────────────────────────────────────────┘
                │ service-role key (bypasses RLS)
     ┌──────────┴───────────────────────────────────────────────┐
     │  GitHub Actions — jobs/ (the model's "player agent")      │
     │  sync-schedule · lock-race · score-race · keepalive       │
     │  imports src/predict.py, calls FastF1                     │
     └───────────────────────────────────────────────────────────┘
```

Key structural facts:

- **The Next.js app never talks to Python.** It only reads/writes Supabase.
- **The Flask app never talks to Supabase.** It only reads local model
  artifacts + `data/`, and calls FastF1 / Open-Meteo.
- **`jobs/` is the only bridge**: it imports `src/predict.py` in-process and
  writes to Supabase over PostgREST.
- The Flask app is **optional in production**. `web/app/(site)/model/page.tsx`
  explains the model natively; `NEXT_PUBLIC_MODEL_URL` only adds an outbound
  link when the Flask app is actually deployed.

### 2.2 External dependencies

| Service | Used by | Auth | What breaks without it |
| --- | --- | --- | --- |
| **FastF1** (→ F1 live timing API + Ergast mirrors) | `src/collect.py`, `src/predict.py`, `src/app.py`, `jobs/*` | none | Collection, the reference classification, the local model page. Its timing half is **unreachable from GitHub Actions** (§8.9) |
| **OpenF1** (`api.openf1.org`, `src/openf1.py`) | `src/predict.py`, `jobs/model_bridge.py`, `jobs/sync_schedule.py` | none (free tier: 3 req/s, 30 req/min) | Same-evening scoring, the safety car, the model's grid and practice on Actions, team colours — everything the timing host would give if it answered |
| **formula1.com** (race hub pages, `jobs/dotd.py`) | `jobs/score_race.py` | none | The Driver of the Day; `set_dotd.py` by hand instead |
| **Open-Meteo** (forecast + archive + geocoding) | `src/app.py` only | none (keyless) | Weather panel on the Flask page |
| **Jolpica/Ergast** (`api.jolpi.ca`) | `jobs/sync_schedule.py`, `jobs/settle_season.py`, `src/openf1.py` (round → date, code → `driver_id`) | none | Championship-pick rank-at-lock, season settlement, the round-to-session bridge |
| **Supabase** | `web/`, `jobs/` | anon key / service-role key | The entire game |
| **Vercel** | hosting `web/` | GitHub OAuth | The site |
| **GitHub Actions** | running `jobs/` | repo secrets | Model entries and scoring stop |

### 2.3 The life of a race weekend (the single most important flow)

```
Mon 05:00 UTC   sync-schedule    calendar + roster upserted into Supabase;
                                 new season_picks get rank + prorate
   ↓
any time        player           opens /game, drags a top 10, picks DotD +
                                 safety-car bet, saves → predictions row
                                 (RLS: only while status='scheduled' and now < race_at)
   ↓
Sat ~quali+1h30 lock-race        runs the model post-quali → model_entries
   (every 15 min Fri-Sun)        (calibrated order + probability matrix;
                                  qualifying + practice from FastF1, or
                                  OpenF1 when timing is unreachable — always,
                                  on Actions) → the Saturday nudge mail
   ↓
Sun race_at     lock-race        first run after lights out:
                                 races.status = 'locked'
                                 → RLS now refuses prediction writes
                                 → everyone's picks become publicly readable
   ↓
Sun race_at+2h  score-race       classification available?
   (every 15 min Sun-Mon,        (Ergast first; else OpenF1, which carries
    hourly Tue-Sat)               the timing feed's final result within
                                  the hour) + safety car (OpenF1 race
                                  control) + Driver of the Day (formula1.com)
                                 → score model, score every player,
                                   write results + scores, status='scored'
                                 → the result mail, the same evening
   ↓
later passes    score-race       re-scores races scored in the last 10 days:
                                 a Driver of the Day published later, race
                                 control published later, and the Ergast
                                 classification superseding OpenF1's
   ↓
(manual)        set_dotd.py      only if dotd.py never finds the article
   ↓
December        settle_season.py championship-pick bonuses awarded
```

---

## 3. Repository map

```
f1-duel/
├── src/                     ML pipeline + Flask model app  (Python)
│   ├── collect.py           FastF1 → CSV                    (377 lines)
│   ├── features.py          CSV → ML training set           (373)
│   ├── train.py             Optuna + XGB/LGBM ensemble      (267)
│   ├── predict.py           Predict one GP (lib + CLI)      (890)
│   └── app.py               Flask app + JSON API            (1659)
├── webapp/                  Frontend of the Flask model page
│   ├── templates/index.html Single-page shell               (351)
│   └── static/
│       ├── js/app.js        All model-page behaviour        (2238)
│       ├── css/style.css    Design language (origin of it)  (1596)
│       ├── drivers/*.png    Driver headshots (by driver_id)
│       └── teams/*.png      Team logos (by slug)
├── models/                  Trained artifacts (tracked in git)
│   ├── xgb_model.json       XGBoost booster
│   ├── lgb_model.txt        LightGBM booster
│   └── meta.json            Features, splits, weights, encoders
├── data/
│   ├── processed/           Collected CSVs + features.csv (tracked)
│   │   └── seasons/<year>/  Per-season raw CSVs
│   ├── champ_cache/         Per-round points cache (tracked)
│   ├── schedule_cache/      Calendars      (gitignored)
│   ├── track_cache/         Circuit SVG paths (gitignored)
│   └── accuracy_cache/      Per-race accuracy (gitignored)
├── fastf1_cache/            FastF1 HTTP cache, SQLite (gitignored)
├── jobs/                    Game automation (Python, no Flask)
│   ├── db.py                PostgREST client with paging    (138)
│   ├── scoring.py           THE rules engine                (159)
│   ├── grid_prior.py        P(finish | grid) kernel         (57)
│   ├── safety_car.py        Model's SC bet (circuit priors) (104)
│   ├── model_bridge.py      Model as a duel participant     (162)
│   ├── sync_schedule.py     Weekly calendar/roster sync     (146)
│   ├── lock_race.py         Model entry + lock              (94)
│   ├── score_race.py        Scoring pass                    (112)
│   ├── set_dotd.py          Manual Driver of the Day        (46)
│   ├── settle_season.py     Championship-pick payout        (62)
│   ├── admin.py             Operator console (§8.5)         (191)
│   ├── backtest.py          Offline rules validation        (102)
│   └── build_circuit_traces.py  Circuit SVG paths → web/lib/circuits.ts
├── supabase/
│   ├── schema.sql           Full schema for a fresh project (484)
│   └── migrations/000N_*.sql Incremental changes for a live project
├── web/                     Next.js 16 App Router (the game)
│   ├── app/                 Routes (see §9.2)
│   │   ├── favicon.ico      Logomark on red, 16/32/48 (see §9.6)
│   │   ├── apple-icon.png   180px, same mark
│   │   └── manifest.ts      Install manifest (start_url = /game)
│   ├── components/          33 components
│   ├── lib/                 supabase clients, types, helpers
│   │   └── circuits.ts      GENERATED circuit geometry (see §9.6)
│   │   └── poster/          The shareable race poster (see §9.9)
│   ├── public/drivers/*.webp  Driver portraits, by driver_id (see §9.6)
│   └── proxy.ts             Session refresh (Next 16's "middleware")
├── .github/workflows/       4 workflows (see §8.6)
├── docs/                    GAME_DESIGN, DEPLOYMENT, DATABASE, ALMANAC
├── requirements.txt         Python deps (pinned)
└── Launch F1 Predictor.command   macOS double-click launcher
```

### 3.1 What is tracked in git and why

| Tracked | Rationale |
| --- | --- |
| `models/*` | The model is a deliverable; CI (`lock-race`) must predict without retraining. |
| `data/processed/**` | `predict.py` needs history to compute form features at run time; regenerating in CI would cost hours of FastF1 calls. |
| `data/champ_cache/**` | Cheap, immutable per round, makes the Flask standings instant on a cold Render boot. |
| **Not** tracked | `fastf1_cache/`, `data/schedule_cache/`, `data/track_cache/`, `data/accuracy_cache/`, `venv/`, `.env.local`, `node_modules/`, `.next/` |

Note the deliberate `.gitignore` subtlety: `/lib/` is **anchored to the repo
root** (it's a Python packaging artifact); `web/lib/` is application source and
must stay tracked. Do not un-anchor it.

---

## 4. Part I — The machine-learning model

### 4.1 Problem framing

- **Unit of observation:** one driver in one Grand Prix.
- **Target:** `Position` — the official finishing position (integer).
- **Model type:** *regression* on position, not classification or
  learning-to-rank. The predicted order is obtained by sorting the regressed
  score ascending. This is the single most important thing to know about the
  model: the score is a continuous "expected position", and the gaps between
  scores carry information (they drive confidence and Monte-Carlo spread).
- **Hard constraint — no leakage:** every feature must be computable strictly
  *before* lights out. All rolling statistics use `.shift(1)` before any
  rolling/expanding window; circuit history excludes the current event.

### 4.2 Stage 1 — Collection (`src/collect.py`)

Downloads raw session data with FastF1 and writes CSVs.

```bash
python src/collect.py                    # all seasons 2018-2026, race/quali/sprint
python src/collect.py 2026               # one season
python src/collect.py 2026 --force       # re-collect after a new race
python src/collect.py 2026 --practice    # FP1/FP2/FP3 (heavier: loads laps)
python src/collect.py 2026 --force --practice
```

- **Sessions:** `R` (race), `Q` (qualifying), `S` (sprint, only for weekends
  whose `EventFormat` contains sprint), and separately `FP1/FP2/FP3`.
- **Practice is a separate pass** because it requires `laps=True`, which is far
  heavier on the API. It aggregates per driver: `BestLapTime`, `AvgLapTime`,
  `LapCount`, `GapToFastest` (seconds behind the session's fastest lap).
- **Weather** is summarised per session into `AirTemp_mean`, `TrackTemp_mean`,
  `Humidity_mean`, `WindSpeed_mean`, `Rainfall` (any rain during the session).
- **Only past events** are collected (`EventDate <= today`).
- **Failures are non-fatal**: a missing session prints `[SKIP]` and continues.
  FP2/FP3 legitimately do not exist on 2023+ sprint weekends.
- **Standings are computed locally**, not fetched: `_compute_standings()`
  accumulates points race by race and emits `driver_standings.csv` /
  `constructor_standings.csv` keyed by `BeforeRound` — i.e. the standings *as
  they were going into* that round. That "before" framing is what makes them
  leakage-free.

Outputs: `data/processed/seasons/<year>/{race,qualifying,sprint,practice}_results.csv`,
then merged into `data/processed/*.csv` plus the two standings files.

### 4.3 Stage 2 — Feature engineering (`src/features.py`)

`python src/features.py` → `data/processed/features.csv` (currently ~3,600 rows).

It starts from race results (which define the row set), left-joins every
feature family, then imputes. There is an assertion that the row count never
changes across joins — a silent many-to-many join would otherwise corrupt the
dataset.

**The 39 features, by family:**

| Family | Features | Meaning / why |
| --- | --- | --- |
| Qualifying | `GridPosition`, `quali_position`, `best_quali_time`, `quali_gap_to_pole` | The dominant signal. `best_quali_time` = best of Q3 → Q2 → Q1; gap measured to the session's best. |
| Practice | `fp3_gap`, `fp3_laps`, `fp_avg_gap`, `fp3_vs_quali_delta` | Raw pace read before quali; the delta captures "improved between FP and Q". |
| Championship | `driver_champ_pos/pts`, `constructor_champ_pos/pts` | Season-long quality prior; car strength proxy. |
| Recent form | `driver_form_pos_5`, `driver_form_pts_5`, `driver_last_pos`, `driver_last_pts`, `team_form_pos_5` | Rolling 5-race means, all shifted by one race. |
| Reliability | `driver_reliability_10` | Share of the last 10 races finished. |
| Circuit history | `driver_circuit_avg`, `team_circuit_avg` | Expanding mean at *this* circuit, shifted. |
| Teammate | `teammate_grid`, `driver_vs_teammate_rate` | Same-car benchmark; 10-race beat-rate. |
| Derived | `grid_champ_delta`, `season_progress` | Over/under-qualified flag; where we are in the year. |
| Weather | `AirTemp_mean`, `TrackTemp_mean`, `Humidity_mean`, `WindSpeed_mean`, `Rainfall` | Session conditions. |
| Wet/chaos | `driver_wet_advantage`, `circuit_wet_rate`, `circuit_dnf_rate` | Driver's dry-minus-wet average (positive = better in rain); circuit rain and attrition rates. |
| Momentum | `driver_momentum` | mean(last 3) − mean(races 4–6). Negative = improving. |
| Track type | `is_street_circuit` | Hard-coded set (Monaco, Baku, Marina Bay, Jeddah, Miami, Las Vegas, Melbourne, Montréal…). |
| Identity | `driver_encoded`, `team_encoded`, `circuit_encoded` | Label-encoded categoricals; the trees learn per-entity effects. |
| Context | `Season`, `Round` | Era/calendar position. |

**Imputation policy** (deliberate, not a fallback to zero):

| Missing | Filled with |
| --- | --- |
| `driver_circuit_avg` / `team_circuit_avg` | that driver's/team's 5-race form (first visit to a track) |
| `fp3_gap` | `fp_avg_gap` (sprint weekends have no FP3) |
| `driver_champ_pos` / `constructor_champ_pos` | 11 / 6 (mid-grid neutral, round 1) |
| championship points | 0 |
| `driver_last_pos/pts` | the 5-race form (rookies) |
| `driver_wet_advantage`, `driver_momentum` | 0.0 |
| `circuit_wet_rate` | `Rainfall × 0.1` |
| `circuit_dnf_rate` | 0.15 (global average) |
| `driver_vs_teammate_rate` | 0.5 |

Rows without a `Position` (DNS, no classification) are dropped at the end.

### 4.4 Stage 3 — Training (`src/train.py`)

```bash
python src/train.py       # ~10-30 min depending on the machine
```

- **Split — strictly temporal** (`meta.json` records it):
  - train `2018–2023`, validation `2024`, test `2025–2026`.
  - Random splits would leak a race's own weekend across folds.
- **Tuning:** Optuna, `N_TRIALS = 60` per model, objective = validation MAE.
  (The public README says 50; the code is the authority — 60.)
- **Models:** `XGBRegressor` and `LGBMRegressor`, both with early stopping
  (50 rounds) against the validation set.
- **Ensembling:** weights inversely proportional to validation MAE, normalised.
  Current artifacts: **XGB 0.5071 / LGBM 0.4929** — essentially a 50/50 blend,
  which is itself a signal that the two learners are equally good here.
- **Metrics printed:** MAE, RMSE, Spearman ρ, and a Top-3 hit rate computed per
  race (how many of the real top 3 the model put in its top 3).
- **Saved artifacts:** `models/xgb_model.json`, `models/lgb_model.txt`,
  `models/meta.json` (feature list, target, splits, ensemble weights, best
  hyperparameters, and the **label-encoder class lists** — 44 drivers, 21
  teams, 35 circuits at time of writing).

> **Why the encoders live in `meta.json`:** `predict.py` must map a driver to
> the exact integer the trees were trained on. Anything unknown maps to `-1`
> (see §4.5), which the trees treat as its own branch. Retraining reshuffles
> these indices, so **model artifacts and `meta.json` must always ship
> together**.

### 4.5 Stage 4 — Prediction (`src/predict.py`)

The most intricate file in the repo, because it has to build a *feature row per
driver for a race that has not happened*, from partial live data.

```bash
python src/predict.py                                  # next GP of the current year
python src/predict.py --year 2026 --round 12           # specific GP (post-quali)
python src/predict.py --year 2026 --round 12 --pre-quali
python src/predict.py --year 2026 --round 12 --explain --driver VER
```

**Two modes:**

- **Post-qualifying** (default, sharpest): real grid, real qualifying times.
- **Pre-qualifying** (`--pre-quali`, or automatic fallback when Q isn't
  available): the grid is *estimated* by ranking drivers on their practice
  `GapToFastest`; `quali_gap_to_pole` becomes the FP gap.

**How the driver list is determined** — in strict priority order, because this
is where 90 % of prediction bugs come from:

1. Qualifying results (`DriverId`, `TeamName`, `Abbreviation`).
2. Practice results, cross-referenced against `features.csv` for the season —
   FastF1 sometimes returns null `DriverId`s for brand-new teams/drivers, so
   the historical CSV is treated as the reliable identity source.
3. No sessions at all (a future race): the line-up of **that season only**,
   taken from the last round each driver appears in. Deliberately *not* merged
   with earlier seasons — that resurrected departed drivers (Doohan, Tsunoda in
   2026 testing).
4. Unknown season: the line-up of the single most recent known season.

**Weather resolution:** `DEFAULT_WEATHER` → practice weather → qualifying
weather (last write wins). The defaults guarantee `Rainfall` and friends always
exist even with no session data at all.

**Weather what-if** (`weather_override`):
- `'wet'` → `Rainfall=True`, humidity ≥ 88, track temp ≤ 24, air temp ≤ 18.
- `'dry'` → `Rainfall=False`, humidity ≤ 45.

**Imputation cascade for grid-like features** (subtle and important):
`GridPosition` ← `quali_position` ← championship order. In a FastF1 `Q`
session, `GridPosition` is `NaN` for everyone (a grid only exists in the race),
so the qualifying classification is the correct stand-in. Championship order is
the last resort so a data-less future race doesn't fall back to alphabetical
ordering. `quali_gap_to_pole` falls back to `(quali_position − 1) × 0.3 s`.

**Inference:**
1. Encode `DriverId`/`TeamName`/`Circuit` via `meta['encoders']`; unknown → `-1`.
2. Any feature column still missing → `0.0`.
3. `score = w_xgb · xgb.predict(X) + w_lgb · lgb.predict(X)`.
4. **SHAP contributions** from the XGBoost booster
   (`predict(dmat, pred_contribs=True)`), stored per driver as `_shap_contribs`
   (last column, the bias, is dropped). Negative contribution = pushes the
   driver forward.
5. Sort by score ascending → `PredPos` 1..N.

Two extra helpers used by the game:

- `load_actual_results(year, rnd)` → `{driver_id: finishing position}` or `{}`.
- `safety_car_occurred(year, rnd)` → `True` / `False` / `None`. Parses the
  official **race control messages** for "SAFETY CAR"/"VIRTUAL SAFETY CAR" plus
  a "DEPLOYED" token (or a `SafetyCar` category). `None` means the data isn't
  published yet, and callers must treat that as *unknown*, never as "no".

### 4.6 Probabilities and confidence

Two closely-related Monte-Carlo simulations exist, and it matters which is
which:

| Where | Params | Purpose |
| --- | --- | --- |
| `src/app.py::_race_probabilities` | σ=2.0, n=4,000, seed 42 | `p_win`, `p_podium`, `confidence` shown on the model page |
| `jobs/model_bridge.py::_mc_matrix` | σ=2.0, n=10,000, seed 42 | full driver × position matrix used by the game |

Model: `true performance ≈ score + N(0, σ)`. Simulate n races, rank each,
count. **σ = 2.0 positions** is the assumed race-day noise — it is a tuned
constant, not derived, and it directly sets how "confident" the model looks.
Changing it changes both the displayed probabilities and every rarity
multiplier in the game.

`confidence` is a different idea: the gap in score to the nearest neighbour,
normalised to 0..1. A driver isolated in score space is a confident call.

---

## 5. Part II — The Flask model platform

`src/app.py` (1,659 lines) serves `webapp/` and a JSON API. Run it with
`python src/app.py` → <http://127.0.0.1:5050>.

Port 5050, not 5000: macOS Control Center's AirPlay receiver squats on 5000 and
answers instead of Flask (symptom: a blank page). `F1_PORT` overrides it;
`F1_NO_RELOAD=1` disables the debug reloader (used by the launcher so the
browser doesn't open against a restarting process).

### 5.1 API reference

| Endpoint | Params | Returns |
| --- | --- | --- |
| `GET /` | — | the single-page app |
| `GET /api/next` | — | `{year, round, event_name}` of the next GP (rolls to next year in the off-season) |
| `GET /api/current` | — | the GP of the current calendar week (Mon–Sun UTC), else the last completed one; falls back to last season |
| `GET /api/schedule` | `year` | `{year, races:[{round,name,location,country,date}]}` |
| `GET /api/raceinfo` | `year`, `round` | start time (UTC + local), `is_past`, and weather (Open-Meteo forecast or archive) |
| `GET /api/track` | `year`, `round` | `{available, path (SVG), length_km, corners, laps, source_year}` |
| `GET /api/predict` | `year`, `round`, `pre_quali?`, `weather?=wet\|dry` | full prediction: per-driver position, score, probabilities, confidence, SHAP factors, actual result + accuracy when past |
| `GET /api/season` | `year` | background job: per-race accuracy for a whole season + aggregate summary (`status`, `done`, `total` for polling) |
| `GET /api/championship` | `year` | background job: driver & constructor standings with cumulative series |
| `GET /api/contention` | `year` | who is still mathematically alive for the drivers' title |
| `GET /api/session_data` | `year`, `round` | FP1/FP2/FP3/Quali classifications for the modal |

### 5.2 Caching layers (four of them, on purpose)

1. **FastF1's own HTTP cache** — `fastf1_cache/fastf1_http_cache.sqlite`,
   enabled at import time in both `collect.py` and `predict.py`. The directory
   is created if missing, because it's gitignored and therefore absent on a
   fresh CI runner (`enable_cache()` raises `NotADirectoryError` otherwise).
2. **Flask in-memory `_cache`** — keyed tuples like
   `('predict', year, round, pre_quali, weather)`, guarded by `_lock`.
   A prediction is **not cached when fewer than 15 drivers** came back: that
   means FastF1 returned a partial session and caching it would freeze a broken
   grid.
3. **Disk JSON caches** — `data/schedule_cache/<year>.json` (past seasons only,
   since they're immutable), `data/track_cache/<slug>.json`,
   `data/accuracy_cache/<year>_<round>.json` (versioned: entries without a
   `top3` key are the old format and get deleted and recomputed),
   `data/champ_cache/<year>_<round>.json` (only written when ≥ 10 drivers, to
   avoid freezing a partial upload).
4. **Pre-warming threads at startup** — `_prewarm_schedules()` then
   `_prewarm_tracks()`, upcoming races first. Without this, opening a future GP
   triggers a full telemetry download to draw the circuit (tens of seconds of
   apparently broken UI).

### 5.3 Background workers

`/api/season`, `/api/championship` and `/api/contention` are too slow to serve
synchronously. Each spawns a daemon thread on first request, stores progress in
a module-level dict (`_SEASON_JOBS`, `_CHAMP_JOBS`) behind a lock, and returns
`{status, done, total, …}` immediately. The frontend polls until
`status === 'done'`. `/api/contention` reuses the championship worker's rounds.

**Title contention maths** (`_remaining_points_info` + `_contention`):
- Max per race = 26 for 2019–2024 (fastest-lap point existed), else 25.
- Sprint = 8 from 2022, 3 in 2021, 0 before.
- A driver is alive if `total + remaining_max ≥ leader_points`.
- The leader has clinched when even P2 at maximum cannot equal them.
- Deliberately **conservative**: a weekend in progress may be over-counted, but
  no one is ever eliminated wrongly.

### 5.4 Explainability presentation

`FACTOR_LABELS` maps every raw feature name to human English, and `FACTOR_HELP`
gives a one-sentence explanation surfaced by the little "i" buttons.
`_fmt_feature_value` renders raw values by type: positions as `P4`, rates as
percentages, times as seconds, points as `pts`, encoded features as the actual
driver/team/circuit name rather than an integer.

In **pre-qualifying mode**, `_PRE_QUALI_LABELS` / `_PRE_QUALI_HELP` override the
qualifying-derived labels ("Estimated grid (FP pace)" instead of "Qualifying
position"), because otherwise the UI would claim a qualifying result that does
not exist.

`_build_factors` returns the top 4 SHAP features per driver with
`effect: boost|penalty` and a `weight` normalised to the strongest factor.

### 5.5 The model-page frontend (`webapp/`)

One HTML shell + one 2,238-line vanilla-JS file. No framework, no build step.
Notable features: boot screen with progress, searchable season/GP combobox,
podium + full grid with team colours and headshots, driver modal with SHAP
factors, session-data modal, circuit SVG, countdown, weather, day/night theme
(persisted), what-if weather toggles, season-accuracy dashboard, championship
standings with cumulative charts, title-contention view, and a
**canvas-rendered shareable poster** exportable as PNG or a hand-built
single-page PDF (no external PDF library).

`webapp/static/css/style.css` is the **origin of the whole design language** —
the Next.js app's palette and easings are carried over from it.

Assets are matched by convention: `static/drivers/<driver_id>.png` (e.g.
`max_verstappen.png`), `static/teams/<team_slug>.png`. Missing files fall back
to an initials avatar / abbreviation badge; nothing breaks.

### 5.6 The macOS launcher

`Launch F1 Predictor.command` (double-clickable): `cd`s to the repo, creates
`venv/` and installs `requirements.txt` if needed, verifies `models/meta.json`
and `data/processed/features.csv` exist (and tells you which pipeline steps to
run if not), kills any stale `src/app.py`, exports `F1_PORT=5050` and
`F1_NO_RELOAD=1`, starts Flask, and opens the browser once the port answers.

---

## 6. Part III — The game: rules and scoring engine

> Rules are normative in [`GAME_DESIGN.md`](GAME_DESIGN.md). This section
> documents the **implementation** and the reasoning.

### 6.1 The scoring formula (`jobs/scoring.py`)

Pure functions, standard library only, zero I/O — so both `score_race.py` and
`backtest.py` import the identical rules. **Never duplicate scoring logic
anywhere else.**

Per slot (positions 1..10 of the prediction):

| Outcome | Base |
| --- | --- |
| Driver finished at exactly that position | 10 |
| Driver finished ±1 away | 5 |
| Driver finished elsewhere in the top 10 | 2 |
| Anything else (incl. DNF/DSQ/not classified) | 0 |

**Rarity multiplier — exact hits only.** `p` = the model's *frozen calibrated*
probability that this driver finishes at exactly that position:

| p | multiplier |
| --- | --- |
| ≥ 30 % | ×1 |
| 15–30 % | ×1.5 |
| 5–15 % | ×2 |
| < 5 % | ×3 |
| `None` (no matrix, e.g. fallback entry) | ×1 |

**Bonuses:** exact podium +15 · perfect top 10 +100 · correct DotD +5 (players
only) · correct safety-car bet +8 (players **and** model).

**There is no bonus for beating the model** (removed 2026-08 with the standings
rework, §7.7). It was +10 for a win and +3 for a draw. Once the season is
*ranked* on the duel record, paying points for a win counts the same result
twice: the win moves you up the board, and the bonus then also inflates the
margin that breaks ties between equal records. `finalize()` still returns
`beat_model` / `drew_model` — the verdict is recorded, not paid — and now also
returns the per-race `margin`.

The verdict did not move when the bonus went: `finalize()` always decided
beat/draw on the total *before* adding the bonus, so migration 0007 subtracting
it lands exactly on the number the verdict was taken from.

`score_table()` returns `{slots, bonuses, total}` — the per-slot breakdown is
persisted so the UI can show exactly where each point came from.
`finalize()` layers DotD and the safety-car bonus on top, then settles the duel.

**The duel comparison is deliberate:** the player's `table + dotd + safety_car`
is compared against the model's `table + its own safety_car`. DotD is excluded
from the model's side because the model cannot vote — that asymmetry is the
human's structural edge.

### 6.2 Why the model does not play its raw order (the most important design decision)

Backtesting (`jobs/backtest.py`) over 2025–2026 showed the raw ML order is a
**weak opponent**: a human who simply copies the starting grid beat it roughly
**8–0–3**. Grid position predicts the finish extremely well and exact-position
hits dominate the score, so "copy the grid" was a winning lazy strategy.

The fix, in two parts:

1. **Calibration** (`jobs/grid_prior.py` + `model_bridge._calibrate`).
   `grid_kernel()` builds `K[g][f] = P(finish f | start g)` from all historical
   race results (22×22, Laplace-smoothed with α=0.5, rows normalised). Each
   driver's Monte-Carlo row is blended:
   ```
   calibrated = β · MC + (1 − β) · grid_prior   with β = CALIBRATION_BETA = 0.25
   ```
   Only 25 % weight on the ML signal — the empirical grid prior dominates,
   because empirically it deserves to.
2. **Game-optimal ordering** (`model_bridge._strategic_order`).
   `_expected_points()` computes E[game points] for placing each driver at each
   position 1..10 under the calibrated matrix (mirroring the base points, and
   ignoring the multiplier, which the model can never trigger against its own
   matrix). A greedy global assignment picks the best remaining
   driver × position cell repeatedly. The matrix is strongly diagonal-dominant,
   so greedy matches the optimal assignment in practice — which is why there's
   no `scipy.optimize.linear_sum_assignment` dependency.

Result: grid-copying went from **8–0–3** to **3–5–3** against the model. The
duel is winnable by good play, not by lazy play. **Do not "simplify" this back
to `argmax` order** — it re-breaks the opponent *and* de-calibrates every
rarity multiplier, since the same matrix drives both.

### 6.3 The safety-car side bet (`jobs/safety_car.py`)

Both the player and the model bet Yes/No on whether a full SC **or** VSC is
deployed. The model has no live signal, so it plays a static per-circuit
historical rate looked up by keyword against the race name / circuit / country:

- `_HIGH = 0.85` — street & chaos circuits (Monaco, Singapore, Baku, Jeddah,
  Melbourne, Miami, Las Vegas, Montréal).
- `_MED = 0.60` — busy permanent tracks (Zandvoort, Silverstone, Hungaroring,
  Imola, Spa, Interlagos, Mexico, COTA, Lusail).
- `_LOW = 0.45` — smooth, wide run-off (Suzuka, Barcelona, Red Bull Ring,
  Bahrain, Yas Marina, Shanghai, Monza).
- `DEFAULT_RATE = 0.55` for anything unmatched.

The model bets Yes at ≥ 50 %. This is intentionally crude: reading *this
specific* weekend is exactly the human edge the game is built to reward.

Outcome detection is automatic (`predict.safety_car_occurred`). If it returns
`None`, **nobody** gets the bonus — neither player nor model.

### 6.4 Championship picks (`jobs/settle_season.py`)

One-shot pick of the Drivers' and Constructors' champion, locked at first
submission (enforced by the *absence* of an UPDATE policy on `season_picks`).

Payout = tier × prorate:

| Rank at lock | Driver | Constructor |
| --- | --- | --- |
| Championship leader | 50 | 30 |
| P2–P3 | 75 | 50 |
| P4 or lower | 150 | 90 |

`prorate = max(0.2, races_remaining_at_lock / total_races)` — so a mid-season
signup still gets something, and a round-1 call is worth the most. **This table
exists twice**: here (and in the job, which pays out) and in
`web/lib/champions.ts`, which is what the profile page tells the player their
pick is on course for. Change one, change the other. Rank and
prorate are filled in by the weekly sync job; the champion is read from
Jolpica/Ergast at season end. The job is idempotent (it recomputes
`awarded_points`, never accumulates).

### 6.5 Backtesting (`jobs/backtest.py`)

Local only, no database. Replays the rules over past races and scores four
archetypes against the model:

| Archetype | Behaviour | Expectation |
| --- | --- | --- |
| `mirror` | copies the model exactly | must tie every race (+3 draw bonus) — a rules sanity check |
| `grid` | plays the starting grid | the lazy baseline the calibration is tuned against |
| `bold` | model order with P1/P2 and P5/P6 swapped, model's P11 promoted to P9 | should win when the calls land |
| `chaos` | podium reversed, model's P14 at P10 | high variance, usually loses |

```bash
python jobs/backtest.py 2026 --rounds 1-13
```

Run this after **any** change to scoring, the calibration constant, σ, or the
prior. `mirror` failing to draw every race means the rules engine is broken.

---

## 7. Part IV — The database

Supabase project ref: **`rkavhmvtstzcrciebsqu`**. All game state lives here and
nowhere else.

### 7.1 Tables

| Table | PK | Written by | Notes |
| --- | --- | --- | --- |
| `profiles` | `id` = `auth.users.id` | signup trigger + owner | `username` unique, regex `^[A-Za-z0-9_]{3,20}$`, plus a **case-insensitive** unique index. `username_set=false` means "auto-suggested, send them to /welcome". |
| `player_details` | `id` → profiles | owner only | Real name, ISO-3166 country, birth **year**. The one table with **no public read policy**. |
| `drivers` | `(season, driver_id)` | `sync_schedule` | Roster + team colour, powers the picker and profile theming. |
| `races` | identity, unique `(season, round)` | `sync_schedule` (never `status`), `lock_race`/`score_race` (status only) | `status ∈ scheduled \| locked \| scored` — the whole fair-play model hangs off this column. |
| `model_entries` | `race_id` | `lock_race`, then `score_race` | `predicted_order` (full ordered list), `prob_matrix` `{driver: [p1..pN]}`, `pre_quali`, `sc_prob`, `sc_bet`, and after scoring `total` + `breakdown`. **Readable only once the race is no longer `scheduled`** (0009) — same lock as `predictions`; `model_entry_status` publishes `pre_quali`/`locked_at` for an open race and nothing else. `counts_in_standings` (0006) is the operator's switch for whether this race feeds the model's **season** total — the race page ignores it. The jobs never send that column, so a re-lock or re-score leaves the choice alone. |
| `predictions` | identity, unique `(user_id, race_id)` | the player | `picks` validated by `valid_picks()`: a JSON array of **exactly 10 distinct** entries. Plus optional `dotd`, `sc_bet`. |
| `results` | `race_id` | `score_race`, `set_dotd` | Official `classification`, `dotd`, `safety_car`, `scored_at`. |
| `scores` | `(race_id, user_id)` | `score_race` | `total`, full `breakdown` JSON, `beat_model`, `drew_model`. The model's score lives in `model_entries`, **not** here. |
| `season_picks` | `(user_id, season)` | player inserts; jobs update | `driver_rank_at_lock`, `team_rank_at_lock`, `prorate`, `awarded_points`. |
| `leagues` | identity | owner | `code` = 6 uppercase chars, defaulted from `md5(random())`. |
| `league_members` | `(league_id, user_id)` | `join_league()` RPC / owner trigger | |

Indexes: `predictions(race_id)`, `scores(user_id)`, `league_members(user_id)`.

### 7.2 Functions, triggers and the view

- **`handle_new_user()`** (trigger `on_auth_user_created`, `security definer`).
  Runs on every `auth.users` insert. Uses `raw_user_meta_data.username` if it
  matches the regex; otherwise derives a suggestion from `name` / `full_name` /
  the email local-part, sanitises it, and falls back to
  `player_<8 hex>`. Collisions get a numeric suffix rather than failing the
  signup. Sets `username_set = (candidate is the chosen one)`. Also writes
  `player_details` when first *and* last name are present — wrapped so a
  malformed `birth_year` can never fail the whole signup.
- **`username_available(text)`** — used live by the username form.
- **`valid_picks(jsonb)`** — array, length 10, 10 distinct values. This is why
  a partially-filled top 10 cannot be saved.
- **`touch_updated_at()`** — on `predictions` and `player_details`.
- **`is_league_member(bigint)`** — `security definer` so league RLS policies
  can check membership without recursing into `league_members`' own policy.
- **`join_league(code)`** — `security definer`. You join **by code without
  being able to read the leagues table**, so codes are never enumerable.
- **`league_by_code(code)`** — `security definer`. The read half of an invite
  link: for one code it returns that league's name, owner and member count and
  nothing else, so `/join/<code>` can say what it is inviting you to while the
  leagues table stays unreadable to non-members. Holding a code is the
  credential — treat a league link like a party invite, not a password.
- **`add_owner_as_member()`** — trigger; creating a league joins you to it.
- **`delete_account()`** — `security definer`, granted to `authenticated` only.
  Deletes `auth.users` for `auth.uid()` and nothing else; every table follows
  by foreign key, including leagues the player owns (which therefore disappear
  for their members). Called from the profile page (§9.4).
- **`leaderboard`** view (`security_invoker`) — per player: `races_played`,
  `points` (sum of scores + awarded season-pick points), `duel_wins/draws/losses`.
- **`standings_page(league, limit, offset)`**, **`standings_count(league)`**,
  **`standings_rank_at(points, league)`** — see §7.4.
- **`model_season_points(season)`** / **`model_season_races(season)`** — the
  one definition of the model's season line: the sum of `model_entries.total`
  over that season's scored races **where `counts_in_standings`**. Public, like
  the rest of the board.
- **Operator-only (0006), revoked from `anon`/`authenticated`, granted to
  `service_role`, and callable in the SQL editor as owner:**
  `admin_model_status(season)` (round by round: scored? counting?),
  `admin_model_reset(season)` (drop every already-scored race → the model shows
  0 and starts again next Grand Prix), `admin_model_count_from(season, round)`
  ("the season starts here"), `admin_model_restore(season)` (undo),
  `admin_players()` (everyone, with email and points — it reaches `auth.users`,
  hence `security definer`), `admin_delete_player(username)` (deletes the auth
  user; every table follows by foreign key, exactly like `delete_account()`.
  Takes a **username** and raises if it doesn't exist, so a typo can never
  delete the wrong player). Driven from `jobs/admin.py` (§8.5).

### 7.3 Row Level Security — the fair-play layer

| Table | Policy |
| --- | --- |
| `profiles`, `drivers`, `races`, `model_entries`, `results`, `scores`, `season_picks` | public SELECT; writes only via service role |
| `profiles` | owner may UPDATE their own row (rename) |
| `player_details` | SELECT/INSERT/UPDATE **owner only** — no public read at all |
| `predictions` SELECT | your own row always; **anyone else's only once `races.status <> 'scheduled'`** |
| `predictions` INSERT/UPDATE | `auth.uid() = user_id` **and** the race is `scheduled` **and** `now() < race_at` |
| `season_picks` | INSERT only (no UPDATE policy exists → picks are immutable by construction) |
| `leagues` | SELECT for owner or members; INSERT as owner; DELETE by owner |
| `league_members` | SELECT for members; DELETE own row (leave) |

The double lock on predictions (`status = 'scheduled'` **and** `now() <
race_at`) is not redundant: `status` only flips when the hourly `lock-race` job
runs, so the timestamp check closes the window between lights-out and the next
cron tick.

### 7.4 The 1000-row cap (read this before adding any query)

PostgREST truncates every response at `db-max-rows` (**1000** on Supabase) and
returns **no error** when it does. A naive `.select()` silently returns "the
first thousand" forever.

Mitigations already in place — keep them:

- `jobs/db.py::select()` pages with `Range` headers until exhausted, and
  refuses to page past 500k rows.
- `jobs/db.py::count()` exists so `score_race.py` can compare its read against
  the server's exact count and **refuse to score a partial field** (scoring 900
  of 1,100 players would look successful while silently zeroing 200 people).
- Standings and league boards go through the SQL functions, which do filtering,
  ordering, counting and limiting server-side. `standings_page` orders by
  `duel_wins desc, margin desc, points desc, username asc` (§7.7) — a total
  order, so a player can't appear on two pages or none.
- `/game/races/[round]` caps "THE FIELD" at 100 and fetches *your* row
  separately, so you always see yourself.

**Never** add an unfiltered `.select()` on `profiles`, `predictions`, `scores`
or `leaderboard`. It will look perfect until the thousand-and-first row.

### 7.5 Migrations

`schema.sql` is the state of record **for a fresh project**. An existing
project applies the numbered files in order, by hand, in the Supabase SQL
editor.

| File | Adds | Applied to prod? |
| --- | --- | --- |
| `0001_safety_car.sql` | `predictions.sc_bet`, `model_entries.sc_prob/sc_bet`, `results.safety_car` | ✅ confirmed 2026-07-29 |
| `0002_username_choice.sql` | `profiles.username_set` + rewritten signup trigger + `username_available()` | ⚠️ **verify before assuming** — the app degrades quietly without it (`select("*")` everywhere), but `/welcome` never triggers |
| `0003_player_details.sql` | `player_details` table + policies + trigger extension | ⚠️ verify |
| `0004_standings_pagination.sql` | `standings_page/count/rank_at` | ⚠️ verify |
| `0005_league_invites_and_account_deletion.sql` | `league_by_code()`, `delete_account()` | ✅ confirmed 2026-08-02 |
| `0006_admin_controls.sql` | `model_entries.counts_in_standings`, `model_season_points/races()`, the `admin_*` operator functions | ✅ confirmed 2026-08-11 |
| `0007_duel_standings.sql` | strips the duel bonus from `scores` history; `leaderboard` gains `margin` and drops the championship payout from `points`; `standings_page` returns `margin` and orders on the duel | ✅ confirmed 2026-08-15 |
| `0008_race_emails.sql` | `profiles.email_opt_out` + `unsubscribe_token`, `email_log`, `email_recipients()`, `email_prefs()`, `set_email_opt_out()` | ✅ confirmed 2026-08-15 |
| `0009_model_picks_secret_until_lock.sql` | replaces `public read` on `model_entries` with `read post-lock`; adds the `model_entry_status` view | ⚠️ **apply before the next race weekend** — until it runs, the model's picks are readable while the race is open |
| `0010_profile_theme.sql` | `profiles.theme` (`driver` \| `team`, default `driver`) — which half of the championship call paints the profile | ✅ confirmed 2026-08-27 |

The app is written to survive a missing migration rather than crash: profile
reads use `select("*")` instead of naming new columns, and `lib/auth.ts`
`hasDetails()` treats a query **error** as "nothing owed" so a missing
`player_details` table can't trap every account in a `/welcome` loop. The 0005
features fail closed the same way: without the migration every invite link
reads "this invite has expired" and the delete button reports that deletion
isn't enabled, rather than throwing. The standings do the same for 0006: they
ask for `counts_in_standings`, and if the column isn't there they re-read
without it and count every race, so the board loses the new behaviour rather
than the ability to render.

To check what's applied, run in the SQL editor:

```sql
select column_name from information_schema.columns
 where table_schema='public' and table_name='profiles';
select to_regclass('public.player_details');
select proname from pg_proc where proname like 'standings%';
select proname from pg_proc where proname like 'admin\_%';
```

### 7.6 Personal data / GDPR

`profiles` is world-readable (it *is* the standings). Real names, countries and
birth years therefore live in `player_details`, owner-read only. Collecting
this makes you a data controller: `/privacy` explains what is collected and
why, and deleting the auth user cascades to both tables. **Deletion is
self-serve** since 0005 — the profile page calls `delete_account()`, guarded by
typing your username — so a request should almost never reach you by email. If
one does (or a test account needs clearing out), `python jobs/admin.py
delete-player <username>` does exactly the same thing operator-side. To
see who is playing,
query from the SQL editor (service role):

```sql
select p.username, d.first_name, d.last_name, d.country, d.birth_year, d.created_at
  from public.player_details d
  join public.profiles p on p.id = d.id
 order by d.created_at desc;
```

### 7.7 The standings, and what they rank on

Rule of record: `GAME_DESIGN.md` §2.5. Changed 2026-08 by migration
`0007_duel_standings.sql`.

**The problem.** Ranking on cumulative points makes the board a measure of how
long a player has been on the platform. The model plays every Grand Prix
whether or not anyone else is here, so by round 12 it sat top of the table with
**402 points over 11 races** — and someone signing up that week opened the
standings to find a machine in P1 and a deficit that no amount of good play
could close. The site's own front page promises "Beat the model. Every single
Sunday", and the board was measuring something else entirely.

**The order is now `duel_wins desc, margin desc, points desc, username asc`.**

| Key | What it is |
| --- | --- |
| `duel_wins` | Grands Prix where the player outscored the model. A race not entered counts neither way — `races_played` sits beside the name so a full season reads as the achievement it is. |
| `margin` | Summed over the races entered, of (player total − model total that weekend). **The model is exactly 0 by construction**, which is the whole trick: it is the axis, not a competitor, and a mid-season arrival starts level. |
| `points` | The raw season total. Still what decides every duel; no longer the ranking key. |

**The model is not a row.** It cannot duel itself, so it has no record and no
rank. `ModelBar` on `/game/standings` shows its season points and its average
per race above the table — the bar to clear. This removed the splice the page
used to do (`standings_rank_at` + inserting a synthetic line on the right
page), which was the fiddliest code on the route.

`standings_rank_at` and the 0006 operator hatches
(`model_entries.counts_in_standings`, `admin_model_reset`) are **deliberately
kept**, unused, as the way back if the model is ever wanted in the table again.
`ModelBar` still reads `counts_in_standings`, so a `model-reset` correctly
zeroes the bar.

**`points` no longer includes the championship payout.** A board of race
results carrying a bonus that came from no race read as a bug once points
stopped ranking anything. `settle_season.py` still writes
`season_picks.awarded_points`; its destination is the **season recap**, a
year-in-review surface replaying each player's spring predictions against what
actually happened (GAME_DESIGN §2.3). Designed, not built — it is a season-end
page and the season is at round 12.

---

## 8. Part V — Jobs and automation

All scripts live in `jobs/`, run identically locally and in CI, and need
exactly two env vars:

```bash
export SUPABASE_URL=https://<project>.supabase.co
export SUPABASE_SERVICE_KEY=<service_role secret>
python jobs/<script>.py
```

### 8.1 `db.py` — the PostgREST client

~120 lines of `requests` rather than `supabase-py`, because the jobs need only
four verbs and precise control over paging. `select` (paged), `count`
(server-side exact), `upsert` (`Prefer: resolution=merge-duplicates` +
`on_conflict`), `update` (PATCH with PostgREST operator filters like
`{"id": "eq.4"}`). Uses the **service-role key**, which bypasses RLS — this
key must never reach a browser.

### 8.2 `sync_schedule.py` — weekly

```bash
python jobs/sync_schedule.py [season]     # defaults to the current year
```

1. **Calendar** → upserts `races` on `(season, round)` with name, circuit,
   country, `quali_at`, `race_at` (both UTC ISO). **It deliberately never sends
   a `status` key**, so an upsert can't revert a `locked`/`scored` race to
   `scheduled`.
2. **Roster** → walks completed rounds newest-first until one yields results,
   upserts `drivers` (code, full name, team, `team_color` from FastF1).
3. **Season picks** → for rows with `prorate is null`, looks up the pick's rank
   in the Jolpica standings and computes `prorate`. If the standings API is
   down it logs and retries next week rather than writing wrong tiers.

### 8.3 `lock_race.py` — every 15 minutes Fri–Sun

For each `scheduled` race with a `race_at`, ordered ascending, stopping at
anything more than 3 days out:

- **Before the race**, and once `now > quali_at + 1h30` (or there is no
  `quali_at`): re-run the model and upsert `model_entries`. Running repeatedly
  is intentional — the entry on record is always the freshest pre-race one.
- **At/after `race_at`**: if there's still no entry, try once more; failing
  that, use the grid-order fallback; then set `races.status = 'locked'`.

The 1h30 delay after qualifying is a pragmatic buffer for the session to be
published (OpenF1 has it within the hour; FastF1's Ergast read can take
longer). The model's qualifying and practice reads (`predict.load_qualifying`,
`load_practice`) try FastF1 first and OpenF1 second — on Actions that is
always OpenF1, since the timing host answers 403 there (§8.9). Before
2026-09-06 there was no second source, and every entry of the season was
`pre_quali` (§13.1.1).

**The fallback** (`quali_order()` + `grid_fallback()`) stores the qualifying
classification as the model's entry, with an empty `prob_matrix` — so every
rarity multiplier on that race is ×1 (`rarity_multiplier(None) == 1.0`). It
sorts explicitly by `Position` rather than trusting frame order, and skips rows
with a null `DriverId`, which FastF1 emits for brand-new entrants. In a `Q`
session `GridPosition` is NaN for everyone, so the qualifying order is the
correct stand-in for the starting grid (before penalties).

If qualifying data is unavailable too, no entry is stored — but `main()` locks
the race regardless, which is right for fairness (predictions must close at
lights-out). Since 2026-09-06 every run also scans `locked` races **without**
an entry and tries again (model, then grid fallback) until one exists, so
`score_race.py`'s "no model entry — run lock_race first" is a delay, not a
dead end. Before that it was one (§13.1.1).

### 8.4 `score_race.py` — every 15 minutes Sun–Mon, hourly the rest of the week

Processes every `locked` race, plus every `scored` race whose `race_at` is
within the last 10 days (the re-score window that catches a Driver of the Day
or a safety car published later, and replays an OpenF1-scored race against
Ergast when it publishes, §8.4.1).

1. Refuse if `now < race_at + 2h` (race can't plausibly be over).
2. Fetch the official classification (§8.4.1); if empty, wait for the next pass.
3. Require a `model_entries` row (otherwise: "run lock_race first" — and
   `lock-race` now does, §8.3).
4. Driver of the Day: the one on record, else `jobs/dotd.py` asks
   formula1.com (§8.5); `None` until it publishes.
5. Detect the safety car from OpenF1's race-control messages (`None` =
   unknown → nobody scores that bonus, next pass asks again).
6. Score the model: `score_table` + its own SC bonus, written back to
   `model_entries.total` / `.breakdown`.
7. Read every prediction for the race, **verify the count against the server**,
   and abort loudly on mismatch rather than score a partial field.
8. `finalize()` each player against the model total → upsert `scores`, then
   the result mail (§8.8).
9. Upsert `results` (classification, dotd, safety_car, `scored_at` = this
   pass — it is a last-touch timestamp, not a classification date), set
   `races.status = 'scored'`.

Fully idempotent — re-running recomputes identical rows. Two switches for the
operator, also on the Actions form:

```bash
python jobs/score_race.py --rounds 13             # one race, whatever its age
python jobs/score_race.py --rounds 1-13 --dry-run # every total printed, nothing written, nobody mailed
```

`--rounds` is how the safety-car bet was settled retroactively on 2026-09-06
for the twelve races it had silently skipped; `--dry-run` is how that was
checked first, from the branch, before anything was written.

#### 8.4.1 Where the classification comes from

Step 2 has two sources, tried in order, and they differ only in *when* they are
available. `jobs/model_bridge.actual_classification` is the only place that
knows about both.

| Source | Keyed by | Available | Used |
| --- | --- | --- | --- |
| **Ergast** (`predict.load_actual_results`) | `driver_id` | usually within hours — the Dutch GP was mailed 4h00 after lights out; the Italian GP was still unpublished six hours on | first, whenever it answers |
| **OpenF1** (`openf1.classification`) | driver code (`VER`) | within the hour of the flag, and **from Actions** | whenever Ergast is still empty |

Ergast is what the model has always trained against, and it is the reference.
It is usually quick but it is not guaranteed, and the game cannot wait on it:
OpenF1 mirrors the F1 timing feed over a plain REST API that GitHub Actions
*can* reach (the timing host itself cannot be — §8.9), so the same evening's
result is the norm rather than the exception.

`openf1.classification` is Ergast-shaped on purpose: OpenF1 gives a retired
driver no position, Ergast ranks retirements after the finishers by laps
completed, and the scoring engine was built on the latter — so the read
reproduces that convention (finishers, then retirements by laps, then
disqualifications, then non-starters), and a race scored from either source
scores the same. The driver code is translated to a `driver_id` through the
season's `drivers` table (written by `sync_schedule` from the same roster); a
code that is not in that table aborts the whole read rather than scoring a
partial field, the same instinct as the prediction count check in step 7.

Because Ergast is preferred whenever present, the ten-day re-score window
replays every OpenF1-scored race against Ergast as soon as it publishes. The
two sources therefore cannot end the season disagreeing — and if a late
steward's decision changes the order, the points move on that pass, silently:
the result mail goes out once, on the first scoring (§8.8).

The **safety car** (`openf1.safety_car`) and the model's **grid and
practice** (§8.3) come from OpenF1 too; there is no Ergast for those.
`predict.load_live_classification` — the direct FastF1 timing read this
replaced — still exists for a laptop that wants it, but no job calls it.

### 8.5 The hand-run jobs: `set_dotd.py`, `settle_season.py`, `admin.py`

```bash
python jobs/set_dotd.py 2026 13 max_verstappen   # ~2 minutes, Monday
python jobs/settle_season.py 2026                # once, in December
```

`set_dotd` validates the `driver_id` against the season roster, writes
`results.dotd`, and immediately re-scores the race so the +5 lands right away.

There is no official DotD API. What there is — and what `jobs/dotd.py` reads
on every scoring pass until it finds one — is the article formula1.com
publishes after each race, whose URL slug starts with `driver-of-the-day-
<name>-…`, linked from the race's hub page (`/en/racing/<season>/<slug>`,
kept for past races too). The hub is found by matching the slug's words to
the race's name, circuit and country (`hub_candidates`), and confirmed by its
`<title>` naming the Grand Prix — what tells `barcelona-catalunya` from
`spain` on the year Spain has two rounds. The slug's name words are matched
to the roster's surnames; anything but exactly one driver is `None` (a
headline naming two — "Norris edges Alonso" — keeps the first). Verified
2026-09-06 on the Italian, Dutch, Belgian, British and Barcelona hubs; the
Monza article was up 35 minutes after the flag.

Scraping, so it fails closed and `set_dotd` stays the hand for the day the
markup changes. Nothing is ever guessed: a race with no readable article is a
race whose DotD bonus nobody gets, until a human enters it.

**`admin.py` — the operator console.** Never scheduled; it is what you run when
you are running the platform rather than playing on it. Every command is a thin
wrapper over an operator-only SQL function from migration 0006 (§7.2), so the
terminal and the Supabase SQL editor do literally the same thing.

```bash
python jobs/admin.py model-status              # round by round: scored? counting?
python jobs/admin.py model-reset               # the model's season total -> 0
python jobs/admin.py model-count-from 15       # the season starts at round 15
python jobs/admin.py model-restore             # undo: the whole season counts
python jobs/admin.py players                   # everyone, with email and points
python jobs/admin.py delete-player someuser    # remove a player for good
```

`--season` defaults to the current year and works on either side of the verb.
Writes prompt for confirmation (`--yes` skips it); `delete-player` makes you
retype the username, because it cascades to the player's predictions, scores,
championship pick, league membership and any league they own — for its members
too, and with no undo.

Why the model needs a reset at all: it has been scoring every Grand Prix since
round 1 with nobody watching, so on launch day it would be several hundred
points ahead of every human who has just signed up. `model-reset` drops the
races it has already been scored on from its **season total** and it starts
collecting again at the next Grand Prix. It is not a rewrite of history: the
race pages, the breakdowns and every duel W/D/L are untouched (§6.2 explains
why the model's *entry* is calibrated; this is the separate question of what
its season line says).

### 8.6 GitHub Actions

| Workflow | Schedule (UTC) | Job |
| --- | --- | --- |
| `sync-schedule.yml` | `0 5 * * 1` (Mon 05:00) | `sync_schedule.py` |
| `lock-race.yml` | `*/15 * * * 5,6,0` (every 15 min Fri/Sat/Sun) | `lock_race.py` |
| `score-race.yml` | `*/15 * * * 0,1` + `45 * * * 2-6` (every 15 min Sun/Mon, hourly otherwise) | `score_race.py` — inputs `rounds`, `dry_run`, `verbose` |
| `keepalive.yml` | `0 6 1 * *` (monthly) | commit + re-enable + DB ping |
| `send-mail.yml` | none — manual only | `send_mail.py` (§8.8) |

All five support `workflow_dispatch` (manual run from the Actions tab);
`send-mail` is *only* that, and takes inputs (kind, round, dry run, force, to).

Shared patterns worth knowing:

- **Configuration guard.** Every game job first checks that
  `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` exist; if not it emits a notice and the
  run ends **green**. This is why an unconfigured fork never sends failure
  emails.
- **Concurrency group `game-jobs`** with `cancel-in-progress: false` — lock and
  score never run simultaneously against the database.
- **FastF1 cache is restored via `actions/cache@v4`** with key
  `fastf1-${{ github.run_id }}` and restore-key `fastf1-`, so each run seeds
  from the previous one and saves a fresh entry.
- Python 3.12, `pip install -r requirements.txt`, pip cached.

### 8.7 `keepalive.yml` — why it exists

Two idle timers can quietly kill this project between seasons:

1. **GitHub disables scheduled workflows in a public repo after 60 days with no
   repository activity.** A workflow *run* is not activity — a **commit** is.
   So the crons cannot keep themselves alive.
2. **Supabase pauses a free project after 7 days with no database request.**
   `score-race` normally covers this by querying hourly every day — but only
   while timer 1 hasn't already stopped it.

Timer 1 is therefore the load-bearing one. Monthly (half the 60-day window, so
one skipped run isn't fatal), keepalive:

- writes a UTC timestamp to `.github/keepalive`, commits and pushes (this is
  the step that actually resets the clock);
- calls the Actions API to **re-enable** all four workflows (a no-op normally,
  the recovery path when they've been disabled — needed because a
  `GITHUB_TOKEN` push doesn't trigger further runs and sources disagree on
  whether it counts as activity);
- pings Supabase REST and **fails loudly** on anything but HTTP 200, because a
  paused project needs a human in the dashboard.

It uses its own concurrency group (`keepalive`), **not** `game-jobs`: a pending
run in a group is cancelled when the next is queued, and `score-race` queues
hourly — sharing the lock could drop the one run we can't afford to miss.

### 8.8 `mailer.py` — the two race emails

Rule of record: `GAME_DESIGN.md` §2.7. Added 2026-08 by migration
`0008_race_emails.sql`.

The game's rhythm is weekly and the product had **no outbound voice at all**: a
player who forgot a Sunday took a zero, was never told, and did not come back.
Two emails per Grand Prix, no others ever — the Saturday nudge once qualifying
is done and the model's hand is on the table, and the Monday result.

Both are sent from **inside the existing jobs**, not on a clock of their own:
`lock_race.py` sends the nudge right after `refresh_entry()`, so it can never
go out claiming a model entry that doesn't exist, and `score_race.py` sends the
result right after `db.upsert("scores", …)`, so nobody is told a score that
failed to save.

**Four properties, each load-bearing:**

| Property | How |
| --- | --- |
| Idempotent | `email_log(race_id, user_id, kind)` written after each success; `email_recipients()` excludes anyone already logged. `score-race` re-runs hourly for ten days — without the log that is ten days of hourly mail to every player. |
| Retryable | A failed send is **never** logged, so the next hourly run picks it up. Nothing is queued and nothing is retried in-process. |
| Silent when unconfigured | No `RESEND_API_KEY` → `send()` prints and returns `False`. The jobs behave exactly as before. |
| Non-fatal | A bad address returns `False` rather than raising. One bounce must not take down a scoring run. |

The address lives in `auth.users`, which is not reachable from the API schema —
hence `email_recipients()` being `security definer` and granted to
`service_role` only. It also filters on `email_confirmed_at is not null`,
because an address nobody has confirmed is an address that bounces.

**The unsubscribe link is a page with a button, not a link that unsubscribes.**
`/unsubscribe/<token>` is keyed on a random `unsubscribe_token`, so it works
from a mail client for someone with no session (the same trade the league
invite codes make) — but the opt-out happens on POST. Mail clients and
corporate scanners prefetch every URL in a message; a GET that opted someone
out would opt out everyone whose employer scans their inbox.

**The templates are tables and inline styles.** This is email: no stylesheet,
no flexbox worth trusting, and a dark background only survives if it is painted
on an element rather than assumed.

**Sending one by hand — `jobs/send_mail.py` and the `send-mail` workflow.**

The crons are `lock-race` hourly Fri–Sun at :15 and `score-race` hourly daily
at :45, so the nudge lands on the first run after qualifying + 1h30 and the
result on the first run after the classification appears. When that is not
enough — a weekend the job missed, a template you want to re-send, a test on
yourself — this is the override:

```bash
python jobs/send_mail.py lock 12 --dry-run             # who would get it
python jobs/send_mail.py result 11 --force             # again, to everyone
python jobs/send_mail.py result 11 --preview me@x.com  # just show me the thing
```

Actions → **send-mail** runs the same script from the browser, with `dry_run`
**ticked by default** — the destructive-by-omission default is the wrong one
for a thing that mails your whole player base.

Three properties worth keeping:

- **`--force` is implemented as "delete the log rows, then send normally"**,
  not as a second code path that skips the log. One path means one thing to get
  wrong.
- **It refuses to lie.** `lock` exits if the race has no `model_entries` row —
  the mail's entire claim is that the model has played its hand. `result` exits
  unless the race is `scored` and the model has a total.
- **Nothing about the mail differs** from the scheduled send: same templates,
  same recipient query, same log. An override that behaves differently from the
  real thing proves nothing when you use it to check the real thing.

**`--to` filters, `--preview` sends.** This distinction cost an evening. `--to`
narrows the *recipient list* to one player, so an address belonging to no
account matches nobody and silently sends nothing — which is precisely what
happens when an operator tries to mail themselves before any player exists.
`--preview` is the one for that: one copy to any address at all, real values
where the database has them and representative ones where it doesn't, and
**never written to `email_log`** — a preview must not leave a player looking
already-emailed. On a platform with no players and no scores yet, `--preview`
is the only way to see what you are about to ship.

---

### 8.9 GitHub Actions cannot reach the F1 timing API

**The single most consequential constraint in this system, and it is silent.**

Every FastF1 data source falls into one of two families:

| Family | Host | From a laptop | From an Actions runner |
| --- | --- | --- | --- |
| **Ergast / Jolpica** | `api.jolpi.ca` | works | **works** |
| **F1 live timing** | `livetiming.formula1.com` | works | **fails, always** |

A verbose run (§8.4, `FASTF1_VERBOSE=1`) shows it plainly: `Failed to load
session info data!`, `Failed to load driver list`, `Failed to load session
status data!`, `Failed to load timing data!`, `Failed to load race control
messages!` — every timing endpoint, while Ergast answers in the same pass.

FastF1 reports a source it could not fetch as a **WARNING and then carries on**
returning empty structures. It does not raise. Combined with `src/predict.py`
pinning FastF1's loggers to `CRITICAL`, this failed invisibly for an entire
season. Three consequences, all verified against the live database:

| Symptom | Extent | Why |
| --- | --- | --- |
| `model_entries.pre_quali` = `true` | **every race of 2026** | the grid comes from timing, so the model has never once had qualifying when it locked its entry |
| `results.safety_car` = `null` | **every scored race of 2026** | race-control messages come from timing, so the safety-car side bet has never been settled for anybody |
| Same-evening scoring never fires | always, in CI | `actual_classification` falls through to `{}` and waits for Ergast |

The third is benign — Ergast is usually quick (§8.4.1). The first two are not:
`pre_quali` degrades the opponent every player is scored against, and a side
bet that silently never pays is a scoring bug.

**What this means for anything you add.** Before a job depends on a FastF1
field, ask which family it comes from. Anything about a *session in progress or
just finished* — timing, positions, race control, the grid, tyre stints — is
timing-only and will not work on Actions. Anything about a *published result*
is Ergast and will.

**Status: resolved on 2026-09-06 — by a second host, not a second machine.**
`api.openf1.org` mirrors the same timing feed over a plain REST API, and it
answers Actions runners (200, verified from a runner the same evening the
timing host answered 403). `src/openf1.py` reads it, and every timing-only
need now has a path that works on Actions: the classification and the safety
car (`jobs/model_bridge.py`), the model's qualifying and practice
(`predict.load_qualifying` / `load_practice`, FastF1 first, OpenF1 when that
comes back empty), the roster's team colours (`sync_schedule`). Nothing
depends on a laptop being awake, which the earlier plan — a split
`lock_race.py` with the refresh on the operator's Mac — would have.

The rule for new code stands, with one word changed: before a job depends on
a FastF1 field, ask which family it comes from — and if it is timing, read it
through `openf1.py`. The `probe-network` experiment that established all
this (curl to the four hosts from a runner) lived on a throwaway branch and
is gone; re-running it is a five-line workflow.

One oddity worth knowing: FastF1's Ergast-backed qualifying read
(`Session.results` for a `Q` session with timing down) came back **empty on
Actions** for the 2026 Italian Grand Prix while Jolpica plainly served the
same qualifying from the same runner — not rate-limited, not a 4xx, an empty
table. It works from a laptop. Not diagnosed; irrelevant now that OpenF1
answers, noted in case it ever matters again.

## 9. Part VI — The web frontend

`web/` — Next.js **16.2.12**, React 19.2, App Router, TypeScript, Tailwind v4,
deployed on Vercel with **Root Directory = `web`**.

> ⚠️ `web/AGENTS.md` warns that this Next.js version has breaking changes
> versus most training data. Check `node_modules/next/dist/docs/` before
> writing framework-level code. The clearest example: **Next 16 renamed
> `middleware.ts` → `proxy.ts`**, exporting a function called `proxy`.

### 9.1 Dependencies

`@supabase/supabase-js` + `@supabase/ssr` (auth/data), `@dnd-kit/core` +
`sortable` + `utilities` (drag-and-drop top 10), `@vercel/analytics`,
`tailwindcss` v4 via `@tailwindcss/postcss`.

### 9.2 Routing

```
app/
├── layout.tsx                 root: fonts (Archivo, Geist Mono), metadata,
│                              viewport.themeColor, BootScreen, <Analytics/>
├── not-found.tsx              404 for a URL matching no route (see below)
├── manifest.ts                install manifest
├── robots.ts                  crawler rules + a pointer to the sitemap
├── sitemap.ts                 the public pages + every raced Grand Prix
├── globals.css                design tokens + shared classes
├── (site)/                    ROUTE GROUP: everything with nav + footer
│   ├── layout.tsx             renders SiteNav + SiteFooter ONCE
│   ├── loading.tsx            RaceLoader skeleton
│   ├── not-found.tsx          404 for a notFound() thrown inside the group
│   ├── page.tsx               Home (hero, game section, opponent section)
│   ├── model/page.tsx         Native explanation of the opponent
│   ├── rules/page.tsx         The full rulebook
│   ├── privacy/page.tsx       GDPR notice
│   ├── contact/page.tsx       Contact + FAQ + credits
│   ├── profile/[username]/    Cover + avatar, stats, championship call,
│   │                          form, season curve, duel history
│   ├── join/[code]/           The far end of a league invite link
│   └── game/
│       ├── layout.tsx         onboarding gate + content width
│       ├── loading.tsx        skeleton
│       ├── page.tsx           THE dashboard: next GP, editor, last duel
│       ├── races/[round]/     Duel review: you vs model vs official
│       ├── standings/page.tsx Paged leaderboard with the model spliced in
│       ├── leagues/page.tsx   Create / join / invite / leave, league boards
│       └── picks/page.tsx     Championship picks (one shot)
├── login/page.tsx             email+password / magic link / Google
├── welcome/page.tsx           one-time onboarding (username + details)
└── auth/
    ├── callback/route.ts      OAuth + PKCE code exchange
    ├── confirm/route.ts       email OTP (token_hash) verification
    └── signout/route.ts       POST → clears session, redirects to /login
```

**`robots.ts` / `sitemap.ts` — the disallow list is about credentials, not
secrecy.** A league code and an unsubscribe token *are* the credential in their
flows (`supabase/README.md`), so `/join/<code>` and `/unsubscribe/<token>` are
disallowed and kept out of the sitemap; `/auth/*`, `/login` and `/welcome` are
simply nothing to land on from a search result. Profiles are world-readable but
also left out: a player's page is theirs to share, not the site's to file with
Google. The sitemap reads races through **`lib/supabase/public.ts`** — a
cookie-free client — because `lib/supabase/server.ts` calls `cookies()`, which
would turn a crawler's file into a per-request render; a failed read drops the
race URLs and still returns the static half.

**Why the `(site)` route group exists:** it renders the nav and footer once, so
they stay mounted across navigations and the loading spinner appears *below*
them. Before this, every navigation flashed a blank screen. `/login`,
`/welcome` and `/auth/*` sit outside the group (no nav). Pages provide their own
`<main>`; the group layout adds no width constraint, so the home hero can be
full-bleed.

**There are two 404s, and both had to be written.** Next's built-in one ships a
stylesheet that sets `body { background: #fff; color: #000 }`, which on a site
that is dark everywhere else produced two different broken pages in production:
an unknown URL gave a bare white page with none of the site on it, and an
unknown *profile* gave the nav and the checkered footer rendered **in white**.
Providing our own removes that stylesheet. `app/(site)/not-found.tsx` catches a
`notFound()` thrown inside the group and inherits its nav and footer;
`app/not-found.tsx` catches everything else and rebuilds the shell by hand.
Both render `components/NotFoundBody.tsx`, so the words are written once.

**The root one must not read the session.** It is part of the render tree of
every route resolving above the group — `/login` included — so putting
`SiteNav` (which calls `getUser()`) in it turned `/login` from a static page
into a dynamic one. It carries a wordmark-only bar instead. Check
`npm run build` still prints `○ /login` after touching that file.

### 9.3 Authentication

Three ways in, all Supabase Auth:

1. **Email + password** (primary) — `signInWithPassword` / `signUp`. The signup
   form passes `username`, `first_name`, `last_name`, `country`, `birth_year`
   as user metadata, which the `handle_new_user()` trigger consumes.
2. **Magic link** — `signInWithOtp`, lands on `/auth/callback` or
   `/auth/confirm`.
3. **Google OAuth** — `signInWithOAuth`, lands on `/auth/callback`.

**Session plumbing:** `proxy.ts` runs on `/game/*`, `/profile/*`, `/join/*`,
`/login`, `/welcome`, `/auth/*` and calls `supabase.auth.getUser()` purely to
refresh the session cookie for server components. `/join/*` is on that list
because invite links are opened hours after the last visit: without the refresh
a returning member would be told to sign in again to join. Server components use
`lib/supabase/server.ts`; browser components use `lib/supabase/client.ts`.

**Performance note:** `getUser()` is a network round-trip to the Auth server.
`lib/supabase/server.ts` wraps it in React `cache()`, and `lib/auth.ts` does the
same for `getOwnProfile()` / `hasDetails()`. Without this, the nav, the layout
and the page each made their own call — 2–3 round-trips per navigation.

**Onboarding gate:** `destinationFor()` (used by both auth routes) sends a
freshly authenticated session to `/welcome` when `username_set === false` **or**
there's no `player_details` row; otherwise to the requested `next` (validated by
`safePath()` — internal paths only, no `//` protocol-relative escapes).
`app/(site)/game/layout.tsx` re-checks with `needsOnboarding()` so nobody lands
in the standings as `player_3f9a…`.

**`?next=`** is honoured end to end: `/login` reads it (validating it the same
way `safePath()` does) and passes it to password sign-in, `signUp`'s
`emailRedirectTo`, the magic link and the Google `redirectTo`. This is what
lets `/join/<code>` survive a sign-up: you land back on the invite, not on
`/game` having forgotten why you came.

### 9.4 Page-by-page behaviour

**`/`** — the hero is a two-column composition from `lg` up, and the next Grand
Prix appears in exactly one of two places depending on width. `lib/nextRace.ts`
is the single request-cached read both of them share, so they cannot disagree
about which race is next.

- **`lg` and up:** `HeroRaceCard` fills the right column — the circuit trace,
  a rule, the race name, `MONZA · ROUND 13 · 11 CORNERS`, and the countdown as
  a four-column lap board. The eyebrow above the headline is hidden here, so
  the headline opens the page.
- **Below `lg`:** no circuit at all. It used to run in from the top-right
  corner (`HeroTraceBleed`, deleted 2026-08-27) where it landed behind the
  first line anyone reads, on a screen that was already carrying five blocks of
  type over three layers of decoration. The phone hero is one light, one
  headline, one button and a link, with `NextRaceLine` carrying the words and
  the clock above the headline — and a foot that always invites the scroll: the
  last Grand Prix's score when there is one, `How the duel works ↓` when there
  is not. See `DESIGN.md` §6.3.

On the card the trace carries a marker: a red dot that follows the mouse
**along the track**, projecting onto the nearest point of the lap rather than
sitting under the cursor. `CircuitTrace` is a client component for that alone.
It samples the path on first hover rather than on mount — below `lg` the card
is `display: none` and path geometry read from an unrendered element is not
reliable — takes 800 samples once, and writes the marker's transform straight
onto the element instead of through React state, which would re-render the
hero on every pointer event. `pointerType !== "mouse"` returns immediately.

Only the digits are client-side (`NextRaceCountdown`), so the race is in the
HTML whether or not the clock ever starts, and the placeholder holds the same
width so hydration shifts nothing. Between seasons there is no race and no
circuit: the grid collapses to one column, `.page-glow` stands in for the
trace's light, and the line falls back to `2026 season · one duel per Grand
Prix`. Same when nobody has yet driven the venue — until first practice on the Friday,
Madrid has no telemetry in existence, so `circuitTrace()` returns null and the
hero carries no ornament rather than somebody else's circuit. Kuala Lumpur was
in that list by accident — FastF1 files the Bahrain Grand Prix under that
location — and `PREV_ALIAS` in the trace job now maps it back to Sakhir.

The glass chip that used to sit above the headline is gone. It was a box doing
an eyebrow's job, and it pushed the headline a third of the way down the hero.

Below the hero, **`LastRaceProof`** is the page's evidence: the model's ten
picks at the last **scored** Grand Prix, the ten drivers who actually finished
there, the outcome of each call (`✓` exact / `~` one off / `•` in the top 10 /
`·` miss) and what it scored. The home page used to describe the game in three
sections and never show it, so a visitor was asked to take the whole thing on
trust before signing up. Three things about it:

- `loadLastRace()` is wrapped in React `cache`, because the hero's scroll cue
  and the section both read it — and the cue must not point at a section that
  isn't there. Before the first race of a season is scored, both render
  nothing.
- It is a **five-column CSS grid, not a table**, and deliberately: §9.6's rule
  is that `overflow-x-auto` over a `min-w-[Nrem]` table is a column you have
  decided nobody on a phone will read, and the column at risk here would have
  been the points.
- The **scroll cue** is the answer to the 40% of empty viewport that used to
  sit under the hero buttons with nothing saying the page continued. It reads
  `Last time out it scored 32 · 6 of 10 exact`, so the invitation to scroll is
  itself a piece of evidence. `.rise-in-5` (280ms) was added for it.

It is also the page's one staged section, which is deliberate: it is the only
real content on the page, and everything below it was deflated so that it reads
as the culmination. It carries a `.checker-rule` inside the card's top edge —
the *end of a race*, at half the height and half the rows of the footer's
`.checker-edge`, which is the end of the site — and the model's total is printed
at `text-5xl sm:text-6xl` mono tabular, as a timing tower would. It used to be
18px, in the same line as its own label.

**The two marketing sections below it were the site's concentration of
generated shape, and they are rebuilt:**

- **The game.** The three glass cards numbered `01 / 02 / 03` are an `<ol>` of
  hanging numerals separated by hairlines (DESIGN §5.5), and the right column
  is **`PickBoardShot`** — the pick board's own markup, server-rendered from
  the real roster in the last Grand Prix's finishing order, caught at five
  slots filled with the sixth open and lit, running past its column and
  dissolving. It is not a screenshot and there is nothing to re-capture when
  the editor changes. It reads `loadLastRace()`, so it costs no query of its
  own; it is `aria-hidden` behind one `sr-only` sentence, because ten fake
  controls announced as real controls is a lie with ten rows in it; and with no
  scored race yet it renders empty, which is what the screen genuinely looks
  like in March.
- **The barème is not here any more.** Step 03 used to print the four rungs
  (`ScoringScale`, deleted); it links to `/rules#scoring` instead, which held
  the whole formula all along. A marketing page states the claim, the canonical
  page holds the numbers, and only one of them gets to be canonical.
- **The opponent.** "Under the hood" was four red bullet discs in front of four
  sentences that were really key/value pairs. It is a `<dl>` spec sheet now —
  mono label, sans value, hairline between — which is the shape `/rules` has
  used all along.

**`/game`** (`revalidate = 60`) — finds the next `scheduled` race with
`race_at > now`, then fetches in parallel: the active roster, **`model_entry_status`**
(`pre_quali`/`locked_at` — has the model filed, and in which mode), your
prediction, the last scored race, and whether you have season picks. Renders
the countdown, a "last duel" strip, and the editor. `canPlay = signed in &&
race_at is in the future`.

**The model's picks are secret until the lock, and that is now a policy rather
than a habit.** This page was careful never to select `predicted_order` for the
upcoming race — but `model_entries` was `public read`, and `lock_race.py`
refreshes the entry hourly through the weekend, so the order, the probability
matrix (what rarity multipliers are computed from) and the safety-car bet were
all one anon-key query away, and `/model` printed the grid of the race everyone
was still playing. Migration 0009 cuts reads of the table to races that are no
longer `scheduled`, exactly mirroring `predictions`' `read own or post-lock`,
and adds `model_entry_status` for the part that was never secret. `/model` also
filters `status <> 'scheduled'` itself, so the page cannot quietly come to
depend on being denied.

The one `predicted_order` this page reads is the **last scored race's**, and
only for a signed-out visitor: it fills the grid on the signed-out surface
(§9.5).

**The D series of the redesign programme (2026-08-27) rebuilt three states of
this page:**

- **The sign-in gate stopped being a blur** (D-1). The editor sat under a scrim
  and 2px of blur; the model's ten are simply legible now, labelled with a
  padlock and the Grand Prix they were played at, and the column that used to
  hold controls a signed-out visitor cannot use (driver pool, DotD, safety car)
  holds the pitch instead. `DESIGN.md` §7.13.
- **"No upcoming race" became the end of the season** (D-2,
  `components/SeasonOver.tsx`). Same branch, new reads: the scored-race count
  and the model's season (`lib/model.ts`, extracted from the standings page so
  both count it the same way), the top of `standings_page`, the viewer's own
  `scores` rows for their record, and the next `scheduled` race **in any
  season** for the clock. With nothing scored it says the calendar has not been
  synced — never "the season is over" on missing data. It is deliberately not
  the season recap of `GAME_DESIGN` §2.3, which is still unbuilt.
- **The countdown speaks the sport's language under the last hour** (D-3).
  `StartLights` takes a `lit` count (0–5) and holds it; `Countdown` lights one
  bulb every twelve minutes and the lock is the blackout. The digits stay
  printed beside the lights, which are `aria-hidden`.

⚠️ The Flask app (§5) predicts the *upcoming* race by design. It is not
deployed; deploying it publicly would reopen exactly what 0009 closed.

**`/game/races/[round]`** (`revalidate = 120`) — redirects to `/game` if the
race is still `scheduled`. Shows the duel banner (win/draw/loss + the margin),
the side-by-side breakdown (below), DotD, the safety-car outcome with both bets,
and "THE FIELD" (top 100 by score, usernames joined via the FK rather than a
second unfiltered read of every profile). Your own score row is read separately
**with the profile attached**, so the poster can sign itself with your username;
on a race you skipped there is no such row, and the name falls back to
`getOwnProfile()` (cached per request, so the nav doesn't pay for it twice).

**Signed out, the page closes instead of stopping.** This is the best landing
page the site has — a shared link lands here — and it used to end on a two-line
receipt and the footer, with no button anywhere. A visitor now gets a final
block: what the model scored here, a live countdown to the next Grand Prix
(one extra `races` read, signed-out only), a sign-in call to action, and the
race poster. The poster button **moves** rather than doubling — `PosterExport`
serializes its data into the HTML and two of them would ship it twice — and it
goes wherever it is most wanted: **under the duel verdict** on a race you
played, in this closing block signed out, and only in the header on the
leftover case, a scored race you sat out.

**The share lives with the verdict.** Reading "You beat the model" is the one
moment you want to show someone, and the poster used to be a grey `Export
poster` chip in the page header, two hundred pixels away and worded like a file
menu. The banner now carries a `variant="primary"` `PosterExport` under a
divider, labelled for the result it depicts — *Share the win* / *Share the dead
heat* / *Share the race* — with the sheet's dimensions spelled out beside it.
`PosterExport` takes `label` and `variant` for exactly this; the default
(`"Export poster"`, `chip`) is what the two quieter placements still render.

`RaceBreakdown` (client) owns the 4-column table — Pos / You / Model /
Official — above `sm`, one stacked card per position below it, and takes
`signedIn` to drop the whole "You" side for a visitor (§9.6). It makes the
arithmetic inspectable, which it was not: the table
said "Norris +20 ×2" and the three things that decide a slot's score (base
points, where the driver actually finished, how unlikely the model thought the
call was) were all invisible. Tapping a position opens one explanation per
side — outcome sentence, `10 base ×2 = 20 pts`, and the model's own
probability behind the multiplier, including the "a favourite, so no
multiplier" case. Two decisions worth keeping:

- the panel sits **outside** the horizontally scrolling table, because prose in
  a 36rem grid would have to be read sideways on a phone;
- the trigger sits in the **first** column next to the position, because a
  control parked past the last column is one nobody finds on a phone. The whole
  row is tappable too.

Underneath, two receipts account for both totals line by line: the ten
positions, then each bonus that fired (exact podium, DotD, safety car, duel),
then the total. Every number was already in `scores.breakdown` and
`model_entries.breakdown` — none of it was surfaced. Scores are drawn as chips
**pinned to their own driver's name**; right-aligned in the cell they sat
against the next column and read as its score.

**`/game/standings`** (`revalidate = 120`) — 100 players per page via
`standings_page`. The model's season total is the sum of `model_entries.total`
for this season's races; `standings_rank_at` says how many players are at or
above it, and the model line is **spliced into the exact page it belongs on**,
with ranks after it shifted by one. That splice is why the model appears inside
every league board and not only the global one: `standings_rank_at` takes the
same `p_league_id`, so the model is ranked against whichever field is on screen.
`Board` renders that list as a table above `sm` and as cards below it, both fed
from one normalised `BoardRow[]` (§9.6).

Since PR #26 this page **is** the leagues page (see below). Three parts:

1. **The filter row** (`LeagueSwitcher`, client) — Global, one pill per league
   from RLS (you only see leagues you're in), then `LeagueActions`. Pills are
   real `<Link>`s, but a plain click is intercepted and re-issued as
   `router.push` inside a `useTransition`. Switching costs a server round-trip
   (the board is ranked in SQL), and a bare `<Link>` spends it showing the
   *previous* league — the site read as frozen. The transition gives a
   `pending` flag for exactly that window: the board dims and a spinner sits
   over it. Modified clicks (⌘, ctrl, shift, alt, middle) fall through to the
   browser so "open in new tab" still works.
2. **The league panel** — rendered when a league is selected: name, player
   count (`standings_count`, which counts league members, so no extra query),
   the code, and `LeagueCardActions`. **Invite a friend** (the native share
   sheet — one tap to a text message) and **Copy invite link** both point at
   `/join/<code>`; leave (or, for the owner, delete the league) sits behind an
   inline confirm and then `router.replace`s back to Global, because the URL
   still names a league that no longer exists.
3. **Race by race** — one card per scored race (a responsive 1/2/3-column
   grid), each carrying the round, the circuit and, for a signed-in viewer,
   their own score and duel verdict from a single `scores` read. It used to be
   a wrap of identical pills, which at 24 rounds read as one heap. Deliberately
   rendered *outside* the switcher: the season's races are the same whichever
   league you look at, so they must not blink on every switch.

**The S series of the redesign programme (2026-08-27)** rebuilt three of this
page's four blocks and one site-wide habit:

- **Capitals moved from the markup into CSS** (S-1). `<h2>RACE BY RACE</h2>`
  was fifteen headings across the standings, the profile, the race review, the
  editor, `PointsCurve` and two forms — unreadable to some screen readers,
  untranslatable, and a fourth eyebrow style on a site that already had one.
  They are `font-mono text-xs tracking-[0.2em] text-ink-dim uppercase` now,
  with sentence case in the text (`DESIGN.md` §4.3, §4.4).
- **The season became a table** (S-2, `components/SeasonRaces.tsx`). Pills →
  cards → one line per round, number hanging in the margin, points and duel
  result in tabular columns; signed out, those two columns are not rendered.
  The result letter also picked up the site's own W/D/L tones, correcting a
  card that drew *your* win in race red — the colour that means the model won
  everywhere else.
- **The empty board leans on the asymmetry** (S-3): the model has a score and
  nobody else does. It is the one empty state on the site with a call to
  action in it (`DESIGN.md` §7.8).
- **Pagination became a band of positions** (S-4,
  `components/StandingsPager.tsx`): `21–40 of 96 players` and two square
  chevron controls, above one page only.

**`/game/leagues`** — a `redirect()` to `/game/standings`, nothing more. Kept
because invite links, bookmarks and messages players already sent point at it.

Historical note: the leagues page used to filter with
`?user_id=in.(<every uuid>)`, which blew past the HTTP request-line limit at
~200 members. Until 2026-08-02 it was also **unreachable** — missing from
`NAV_LINKS`, linked only from the footer — so it was promoted to a nav entry
(PR #21). PR #26 went further and removed it: two tabs answering one question
("where do I stand?" / "…among my friends?") with two different-looking boards
was the actual discoverability problem. There is one board now, and the filter
is the league.

**`/join/<code>`** — resolves the code through `league_by_code()` and shows the
league's name, owner and size, then one button. Signed out it shows the same
card and carries `?next=/join/<code>` through sign-in; already a member, it
links to the board instead; unknown code, it says the invite has expired.
Joining goes through `join_league()` and lands on
`/game/standings?league=<id>` — the board is the answer to "what did I just
join".

**`/game/picks`** — if a `season_picks` row exists it renders read-only, because
the pick is immutable at the database level.

**`/profile/[username]`** (`revalidate = 120`) — rebuilt in PR #29. It was a
grey card with a headline and four numbers, and it never showed the one thing
that makes a profile personal: the two calls that player made for the season.
It is now laid out the way a profile page is laid out anywhere — cover, avatar,
name, stats band — with every colour on it coming from the championship pick:

- **The cover** is a team-coloured gradient set inline (the colour changes with
  the pick, so it cannot live in a stylesheet) under `.cover-grid`, a grid trame
  masked to fade out at the bottom so the banner melts into the card instead of
  ending on a hard line.
- **The avatar** (`ProfileAvatar`) is the **portrait of the driver that player
  backed for the title**, ringed in their constructor's colour, climbing into
  the cover. It falls back to a two-letter monogram at the same size — for a
  player with no pick yet, and for a driver `public/drivers/` has no portrait
  for (a mid-season call-up). Same disc, same size, so nothing reflows.
- **The stats band** (season points, duel record, races played, best race) is
  flush to the card edges: 2 columns on a phone, 4 above `sm`.
- **The championship call** — the picked driver's portrait and full name beside
  the constructor drawn as a `TeamWordmark` (spaced capitals over a bar of its
  colour). There are **no team logos in this repository and no plan to add
  any**: they are trademarks, and the grid changes. Under it, what the pick is
  on course for, from `lib/champions.ts` — the §2.3 tier table (50/75/150 and
  30/50/90) times `prorate`. That table lives here a second time on purpose:
  `jobs/settle_season.py` is what pays out, `lib/champions.ts` is what the page
  *says* it is worth. **Any change to the tiers has to land in both.** A pick
  whose `driver_rank_at_lock` is still null (the weekly sync hasn't run) says so
  rather than quoting a number, and a settled pick shows `awarded_points`.
- **Recent form** (`FormStrip`) — the last five duels as W/D/L pills, oldest
  left, the football convention, each linking to that race's review.
- **The season curve** (`PointsCurve`) — your running total against the model's,
  drawn by hand in SVG. No chart dependency: it is two polylines.
  `preserveAspectRatio="none"` lets it stretch to any width and
  `vector-effect="non-scaling-stroke"` keeps the strokes 1px through that
  stretch. The championship bonus is deliberately **not** in the series: it
  lands in one lump at season end and would draw a cliff that says nothing
  about how the season was raced. Hidden below two scored races.
- **Duel history** — one card with divided rows (round, verdict, race, model's
  score, yours) instead of the old stack of separate pills.

Theming is `seasonPickColor()` in `lib/teams.ts`: the picked driver's team
colour, then a team-mate's, then the picked constructor's, then a neutral grey
— **never** the site red, which is what made a Mercedes pick look like a
Ferrari one when `drivers.team_color` came back null.

`player_details` is fetched **only for the owner** (RLS would return nothing to
a visitor anyway, so the round-trip would be pure waste), and the country flag
beside the name is owner-only for the same reason. Owner controls are one
**Edit profile** button opening `ProfileEditPanel` — username and private
details in a single dialog, portalled onto `<body>` for the reason in §9.7 —
which is why `UsernameEditor` and `PlayerDetailsEditor` no longer exist.

**ACCOUNT** closes the page: one section in the same heading idiom as *RECENT
FORM* and *DUEL HISTORY*, holding two hairline rows — sign out, then delete.
They used to be two stacked panels, the second tinted red from the moment the
page loaded, which gave a routine reversible action the same weight as the one
that cannot be undone. The red is held back until the delete is armed (§7.2 of
the design doc). Typing your username arms it, it calls `delete_account()`,
signs out and leaves through a full navigation to `/login?deleted=1` so no
server-rendered page is left holding dead cookies.

**The profile was rebuilt (2026-08-27)** — the P series of the redesign
programme plus the owner's own review. `components/ProfileView.tsx` is now the
whole page as a presentational component and the route only reads and counts,
which is also what lets the page be rendered from fixtures while the local
database is a placeholder.

- **The nationality flag is gone.** It was owner-only, which made it an
  ornament nobody else could see, and a colour emoji in an Archivo headline.
  The country is still collected in `player_details` and still private.
- **A profile picks the colour it wears** (migration 0010). `profiles.theme`
  is `driver` or `team`; `ProfileThemeToggle`, inside the edit panel, writes
  it, and everything the pick paints — cover, ring, curve, stubs — follows.
  A driver and their constructor are often two shades of one hue, so the site's
  one identity choice used to be invisible half the time.
- **The four equal figures became one** (P-1): the duel record at 60px with
  the other three as a spec sheet beside it. Only one of the four is the game.
- **The championship call is told once, as a betting stub** (P-2,
  `components/PickStub.tsx`). It was said twice — chips under the username and
  two cards below — and never showed what the database already holds:
  `locked_at`, the standing at lock, `prorate`, and what it finally paid.
- **Form, curve and history became one "The season" block.** The five capsules
  of `FormStrip` (deleted) are five markers on the curve now, drawn in HTML
  over the SVG because `preserveAspectRatio="none"` turns a `<circle>` into an
  ellipse. The history is the standings' own table, so the two pages read the
  same way.
- **The account section is a spec sheet, then a danger zone**: username,
  member since, private details (the same edit panel, opened from the row) and
  the sign-out, then a gap, a red hairline, a mono `No way back`, and the
  delete row with a red-outlined button. The confirmation flow is unchanged.
- **P-4:** the race review's `?` disc is the word `why` / `close`
  (`RaceBreakdown`). The site has no icon set and did not need one here.

**`/contact`** — where a player takes a bug or an idea, the FAQ, and the
credits. The FAQ is native `<details>` rather than a JavaScript accordion: it
works before hydration and find-in-page can search inside it. Two routes in,
deliberately — a GitHub issue for anyone with an account, and a mailbox for
everyone else. The address comes from `NEXT_PUBLIC_CONTACT_EMAIL` (§10.1) and
the block simply doesn't render when it is unset, so publishing an address (or
retiring one) is an env-var change, not a deploy.

**`/model`** (`revalidate = 300`) — a native explanation of the opponent. It
exists so the site never depends on the Flask app being deployed;
`LIVE_MODEL_URL` adds an outbound link only when `NEXT_PUBLIC_MODEL_URL` is set
to a real remote URL (a `localhost` value is ignored on purpose).

It now also **shows** the model rather than only describing it.
`latestMatrix()` (`lib/latestMatrix.ts`, `cache()`-wrapped)
finds the highest-round race of the season that has a `model_entries` row and
draws its `prob_matrix` (`components/ProbabilityGrid.tsx`) — the
actual output of the 10,000-run simulation the page had been describing in
prose. The read is deliberately three cheap steps (races → the set of race_ids
with entries → that one entry) rather than one clever join, because a matrix is
a fat JSON blob and only the one being drawn should cross the wire.

**The chart's colour bands are the game's own multiplier tiers** (§6.1), not a
generic ramp. That is the point of it: intensity is the model's confidence, and
since the multiplier runs the other way, *the pale end is where the points
are*. Rule and data become the same picture.

**The home page reads the same matrix.** `latestMatrix()` used to live inside
this page; it moved to `lib/latestMatrix.ts` when `components/ProbabilityShot.tsx`
started cropping the same rows into the home page's opponent section, replacing
a card that listed the model's libraries. Two callers, one query: `cache()`
collapses them for the request, like `nextRace()` and `getOwnProfile()`. The
crop is `aria-hidden` behind an `sr-only` sentence and links here for the
readable cut; with no matrix it renders nothing and the section collapses to a
single column.

One thing not to undo: text sits on top of its own fill and is **light** ink at
every band — the strongest fill composites to ≈`#e11b36`, which is 4.9:1
against `#f4f6fa` and only 4.0:1 against the page black, so the instinctive
dark-on-bright treatment is the worse one, and on the middle band (≈`#8f1426`)
it is 1.9:1.

**It reads one position at a time, and it used to read two ways.** Above `sm`
this was a twenty-by-ten heat map — a real `<table>`, two hundred cells at
once. Below `sm` it could not be: 26px cells cannot carry their own numbers, so
a phone got the colour and nothing else, which is the one thing this project's
charts may not do. The phone therefore got a **different cut** — ten position
toggles, then the drivers ranked by P(finishing exactly there), each row a bar
in its band colour with the percentage and multiplier in a reserved right-hand
gutter, and a tail line counting whoever fell under 1%.

That cut then won outright, and the heat map is gone. Two hundred cells is an
impressive object and a poor read: answering "who finishes third, and what does
calling it pay?" meant finding a column, scanning four tints and looking the
tint up in a legend. The list answers it sorted, in one glance. What changed
for the desktop is only the furniture: the ten toggles are a 5×2 pad on a phone
and a vertical timing-tower rail from `sm:` up (with `self-start` — a stretched
grid item stretches its own rows, which spaced the ten buttons across six
hundred pixels), rows and numbers step up a size, and the five-swatch legend
went with the heat map because every row already prints its own multiplier.

This is the phone-first rule (`DESIGN.md` §1.5) producing its most useful
result: writing for the narrow screen forces the question *what is actually
being asked here*, and the answer is not always narrower. Details in
[`DESIGN.md`](DESIGN.md) §12.2.

**The rest of the page stopped looking generated too** (the redesign
programme's M-1…M-4, 2026-08-27). Everything around the matrix was the same
three blocks the home page had been carrying:

- **The pipeline is drawn** (`components/ModelPipeline.tsx`). Four numbered
  glass cards in a 2×2 grid — the arrangement that destroys a sequence's
  reading order — became one horizontal track standing on a single rule, where
  the picture is the four counts set the size of a car number: **8** seasons,
  **2** models, **10,000** simulated races, **1** top 10 played, the last in
  race red. They are mono, because every number on this site is (§9.6). An
  earlier cut drew the same counts as tallies of strokes and was thrown away:
  it raised the question "what are those marks?", which a number never does.
  `DESIGN.md` §5.5 carries that and the two construction rules (the trait is
  the cells' touching top borders; the air above the numerals is a margin,
  never padding).
- **The six feature groups are six titled blocks**, not six cards — a small
  `.display` title, its enumeration under it, two wide columns, no rule and no
  fill (`DESIGN.md` §7.11, which also says when to reach for the spec sheet
  instead: when the right-hand column is a *value*, not prose). It was the
  third grid of equal cards on the site.
- **"Why it's a fair fight" lost its outer card** — a `glass-card` wrapped
  round a two-column grid is a surface stacked on a surface with no hierarchy
  to carry.
- **Calibration has a picture** (`components/CalibrationRecord.tsx`,
  `DESIGN.md` §12.3). The line that proves the duel is fair — a grid-copying
  human goes from 8–0–3 against the raw ML order to 3–5–3 against the
  calibrated entry (§4.4, `GAME_DESIGN.md` §2.2) — was a grey 12px sentence at
  the bottom of that card. It is two eleven-block tracks now, grouped by
  outcome, **in a qualifying screen's colours**: purple where the grid-copier
  wins, green for a draw, yellow where the model takes the weekend. Those three
  tokens (`--color-sector-*`) are new to the palette and exist only as that
  scale — see `DESIGN.md` §3.2 for the rule and for what the borrow costs. **The numbers live in
  `GAME_DESIGN.md`; the component is the only place that draws them, and if the
  backtest is ever re-run both have to move.**

**`/rules`** — the rulebook, and the longest read on the site. Static, no
database. The redesign programme's R series (2026-08-27) gave it three things:

- **A spine** (`components/RulesIndex.tsx`, R-1). The table of contents was
  eight capsules wrapping under the title; it is a numbered `01`–`08` list now,
  sticky beside the reading column from `lg` up, with the current section lit
  by an `IntersectionObserver` banded `-30% / -55%` — a section is current once
  its heading reaches the upper third of the viewport. The **section heads
  carry the same numerals**, so the rail is an index rather than a second
  navigation. On a phone it is the same list, once, not sticky (`DESIGN.md`
  §7.12).
- **The multiplier has a picture** (`components/RarityScale.tsx`, R-2). Four
  bars in the matrix's own bands, the multiplier facing each one: read down,
  the fill fades and the multiplier climbs. This is why the bands moved out of
  `ProbabilityGrid` into **`lib/bands.ts`** — `/model` and `/rules` now draw
  the same four thresholds from one definition, and a tier that changes in
  `GAME_DESIGN.md` §2.2 has one place to change here (`DESIGN.md` §12.4).
- **A lead that says something** (R-3). "Everything you need to know is below"
  told the reader what the scrollbar already had. It now gives the price and
  the payoff: eight sections, about ten minutes, and which one decides most
  weekends.

### 9.5 `PredictionEditor` — the most complex component (733 lines)

- A fixed **10-slot list**, `null` = empty, so positions are stable while you
  fill them.
- **Reordering** uses `@dnd-kit` with **`MouseSensor` + `TouchSensor` rather
  than one `PointerSensor`**, because the two inputs want different gestures:

  | Input | Gesture |
  | --- | --- |
  | Mouse | drag from the grip after 6px |
  | Touch, on the row | press and hold 220ms (8px tolerance), then drag |
  | Touch, on the grip | drags immediately, via `bypassActivationConstraint` |
  | Keyboard | `KeyboardSensor` + `sortableKeyboardCoordinates` |

  Only the touch listener goes on the `<li>`; the mouse listeners stay on the
  grip, so desktop behaviour is unchanged and a click on the name or the cross
  can never become a drag. The 220ms delay is what leaves a plain swipe free to
  scroll and a tap free to open the picker — dnd-kit cancels a pending
  activation past the tolerance and swallows the click once a drag starts.
  Because a finger on the row has no grip to confirm the gesture, the lifted
  row scales 2%, turns opaque (translucent `bg-glass` let the row underneath
  show through) and ticks the haptics.
- **Mobile:** tap a slot → bottom-sheet driver picker (rendered through a
  **portal**, see §9.7), with `navigator.vibrate(8)` haptics where available.
  An empty slot says "Tap to choose a driver" **only under
  `pointer-coarse:`** — it used to say it to a mouse as well, and the
  instruction is genuinely different per input: a finger opens the sheet from
  the slot, a mouse clicks a driver in the pool on the right. The variant is a
  pointer media query, not a width: it is about what you are holding.
- Forward-fill by default; a targeted replacement sets `replacing.current` so
  the next pick resumes filling forward instead of jumping.
- A 10-tick progress rail; save is a single `upsert` on
  `(user_id, race_id)` carrying `picks`, `dotd`, `sc_bet`.
- Save state machine `idle → saving → saved | error`, with a snapshot
  comparison so "saved" is accurate.
- The database rejects fewer than 10 distinct picks (`valid_picks`), so the
  editor's own validation is a UX nicety, not the guarantee.
- **The sign-in gate shows the game, it does not hide it.** It used to be a
  70% veil plus 3px of blur over an *empty* editor, which turned the one screen
  where the game happens into a grey rectangle for every visitor who had not
  signed up — the ten slots, the portraits and the safety-car bet were all
  unreadable, and there was nothing behind them anyway. The veil is 45% / 2px,
  the call to action carries its own `glass-card` surface (at that opacity the
  grid reads through the type), and `previewEntry` fills the grid with a real
  top 10. **That entry is always the last *scored* race's** — see the rule in
  §9.4: this page never reads `predicted_order` for the upcoming race, and a
  preview is not a reason to start. The heading reads `THE MODEL'S TOP 10` and
  the `x/10` counter comes off, where it would read as a score. Drivers no
  longer on the active roster are filtered out so the preview has no holes.

### 9.6 Design system

> The **full** design system — palette, semantic tones, type scale, containers,
> every component pattern, motion, accessibility, the data-viz rules and the
> voice guide — is [`DESIGN.md`](DESIGN.md). What follows is the operational
> subset: the tokens and the decisions that cost debugging time.

Tokens live in `app/globals.css` under Tailwind v4's `@theme`:

```
--color-bg #0a0b10   --color-ink #f4f6fa   --color-ink-dim #a7adba
--color-ink-mute #6c7280   --color-race #ff1e3c   --color-race-deep #c8102e
--color-glass / glass-strong / line / line-hi / card   (translucent layers)
--shadow-panel / panel-sm / race   (tinted to the ground, never pure black)
--radius-control 5px   --radius-panel 10px   (rounded-control / rounded-panel)
--font-sans Archivo (wdth axis)   --font-mono Geist Mono
--ease-out-strong cubic-bezier(.23,1,.32,1)
--ease-in-out-strong cubic-bezier(.77,0,.175,1)
```

Two of those carry a rule that is easy to undo by accident:

- **`race` is the signal, `race-deep` is the surface.** A resting red fill is
  `race-deep` (`.btn-race` does it for you); `race` is the hover and everything
  small — multipliers, eyebrows, the active tab, errors. `#ff1e3c` on white is
  3.8:1 and fails AA for a button label; `#c8102e` is 5.9:1.
- **`rounded-full` now means something.** Two tokens carry every corner on the
  site — `rounded-control` (5px) for anything you press or type into,
  `rounded-panel` (10px) for anything that holds things. The capsule survives
  only on a badge, a status dot and shapes that genuinely are circles
  (avatars, bulbs, the spinner, a toggle knob, a bare-icon tap target). Bars
  and stripes are square-ended. Reaching for `rounded-full` on a new button is
  the regression to watch for.
- **`web/lib/circuits.ts` is generated — never edit it.** It holds one SVG
  path per circuit, built from FastF1 position telemetry by
  `jobs/build_circuit_traces.py`, and the hero draws the next race's. Re-run
  the job when the calendar gains a venue: `python jobs/build_circuit_traces.py
  2026`. Two things in that job exist because of real bugs — it looks sessions
  up by **round number**, because FastF1's fuzzy name match answers "Madrid"
  with the Miami Grand Prix; and it skips events whose **first session** is
  still in the future, because asking for telemetry that does not exist is a
  network round-trip that times out, twenty times over. The gate is first
  practice rather than the race so a brand-new venue is drawn on the Friday it
  is first driven, instead of staying blank across the whole weekend it is new
  — which is what happened to Madrid. A venue with no lap yet is
  absent from the file and the hero renders without a trace.
- **Archivo is loaded with `axes: ["wdth"]`.** Drop that and the served
  `@font-face` loses its `font-stretch: 62% 125%`, and `.display` — the
  headlines, the wordmark, the nav — silently falls back to normal width with
  no error anywhere.

**One focus ring, unlayered.** `:focus-visible { outline: 2px solid
var(--color-race); outline-offset: 2px }` sits in `globals.css` outside any
`@layer`, which is what makes it win over the `outline-none` on the three text
inputs — unlayered rules beat layered ones whatever the specificity, and
Tailwind's utilities are layered. Before it, the app had **zero** focus styles:
every button, link and driver slot fell back to the user agent's outline, which
against `#0a0b10` is a dark hairline on a dark surface. `:focus-visible` rather
than `:focus`, so a mouse click leaves nothing behind — which is why the
outlines were suppressed in the first place. No `border-radius` on it: an
outline already follows the element's own.

Shared classes: `.glass-card` (the card surface), `.glass-chip` (blurred pill),
`.display` (Archivo opened to wdth 118 — headlines, wordmark, nav labels),
`.btn-race` (the whole primary button: fill, glow, hover, radius),
`.grain` (one fixed 3.2% noise layer over the site, mounted in `layout.tsx`),
`.hero-outline` (the hero's second line, stroked and unfilled — one use),
`.page-glow` (the single red source on `/login` and `/welcome`),
`.pressable` (everything clickable answers a press with `scale(.97)`),
`.hero-grid` (hero background — the aurora that sat beside it is gone, see
below), `.cover-grid` (the same trame over
the profile cover, masked to fade out at the bottom), `.checker-edge`
(checkered footer separator — the end of the *site*), `.checker-rule` (the
quieter cut of the same flag, inside the last-race card's top edge — the end of
a *race*; half the height, half the rows, dimmer, and the two must not be
confused), `.shot-fade-x` / `.shot-fade-y` (the two nested masks that let
`PickBoardShot` run past its column and dissolve — nested rather than
`mask-composite`, which still wants a prefixed keyword in Safari),
`.rise-in` (staggered hero entrance), `.spinner`
(the one busy indicator), `.start-lights` / `.sl-*` (the gantry),
`.sheet-backdrop` / `.sheet-panel` (the driver picker on mobile, and the
profile's Edit panel — a dialog that rises from the bottom edge on a phone and
lands centred above `sm`).

**Sections are separated by space and type, never by a background — house
rule, arrived at the long way.** The home page's last section carried a
`.zone-fade`: a 5.5% white veil, on at 20% of its height and off at 80%. It was
replaced by `.zone-glow`, a blue radial glow, and then removed outright. Both
were answers to the wrong question. What drew the eye was never the ramp or the
colour — it was that **only one of the two sub-sections had a background at
all**, so whatever went there read as a patch next to a section that has
nothing and looks perfectly fine.

There is now no treatment between the home page's sub-sections. The page is one
uninterrupted surface from the hero's fade down to the footer's checkered edge,
and a new section is announced by its red eyebrow, its heading and 6rem of air
— exactly what "The game" always had. The hero keeps its aurora because it is
the **only** section with one, which makes it a signature rather than a motif.
The note where `.zone-glow` used to live in `globals.css` records this so the
band is not invented a third time.

**The hero is the exception to all of this and stays exactly as it is.** Its
aurora and grid are what dress it, and they are the reason it reads as a hero
rather than as a headline on black. Its bottom fade to `--color-bg` is **8rem**
(`h-32` on the overlay div in `app/(site)/page.tsx`) — it was pushed to 14rem
to soften the step into the section below, and 14rem reaches far enough up to
dim the aurora and the grid. Softening that step is not worth dimming them; it
went back to 8rem. Leave the hero alone.

**Nothing waits in silence — house rule.** Any control that fires off work
shows `components/Spinner.tsx` until the work comes back, and any view that is
fetching shows something rather than a frozen screen. The spinner is `1em`
square and drawn in `currentColor`, so it inherits the size and colour of
whatever it is dropped into and never needs a variant; the label beside it
stays put while it spins, because swapping the label out makes a row of
buttons jump about mid-action. This covers save, join, create, leave, delete,
lock-in, sign-in, the username check, the league switch and every poster
export — including the poster redraw itself, which is tens of milliseconds on
a laptop and long enough to look broken on a phone.

**The arrival screen** (`BootScreen` + `StartLights`, `#boot-screen` in
`globals.css`) is the first thing anyone sees: five lights fill left to right
and then all go out at once. It is plain markup animated in CSS — no hooks, no
client boundary — because it renders in the server HTML and has to animate
before any JavaScript arrives. It holds for at least 700ms (a screen that
appears and vanishes inside a blink reads as a glitch, not an intro) and never
more than 2500ms whatever the network is doing, then fades; `sessionStorage`
keeps it to once per session. The same gantry is the route-level loader
(`RaceLoader`, under the nav), with the rotating quips underneath. Each column
has its own keyframes rather than one shared set with a delay — the lights come
on in sequence but must go **out together**, and a delay would stagger the
blackout too.

The palette is carried over from `webapp/static/css/style.css` so the game and
the model page read as one product — and redrawn by hand on canvas for the
poster (§9.9), which is why `.checker-edge`'s finish line has a twin in
`lib/poster/draw.ts`.

The desktop nav and the account buttons appear at **`md`**, not `sm`: six nav
entries plus the profile pill do not fit a 640px bar. Below that everything is
the `MobileNav` overlay.

**A table wider than the phone is a table with hidden columns — house rule.**
`overflow-x-auto` on a `min-w-[Nrem]` table is not a responsive layout; it is a
column you have decided nobody on a phone will read, because iOS draws no
scrollbar and nothing on screen says the row continues. It cost the two screens
that matter most:

| Screen | Table asked for | A 390px phone gives | What fell off the edge |
| --- | --- | --- | --- |
| `/game/standings` | 30rem (480px) | 342px | **Points** — the only number anyone opens a leaderboard for |
| `/game/races/[round]` | 36rem (576px) | 342px | **Official** — the actual result of the Grand Prix |

(342px = 390 − 32 of page gutter − 16 of the card's `p-2`.)

Both now carry a second layout under `sm` and keep the table from `sm` up:

- **`Board`** (`game/standings/page.tsx`) normalises each line into a
  `BoardRow` first, so the card list and the table render the same data from
  one source instead of drifting apart. The card is rank · name · `11 races ·
  7-1-3 vs model` · points, points right-aligned and large.
- **`RaceBreakdown`** stacks one card per position — `You` / `Model` /
  `Official` down the card, each a `DriverLine` — and the card is the button
  that opens the explanation, so the `?` disc keeps working. The shared
  `DriverLine` / `EntryLine` pair is what keeps a cell and a stacked row
  looking identical.

`RaceBreakdown` also takes **`signedIn`**: signed out there is no "you" to
compare, so the You column, the You row and the You panel all come off, and the
desktop table drops to `min-w-[28rem]`. It used to render ten rows of `—`.

**Driver portraits are WebP, and it is not cosmetic.** They are photographs
with an alpha channel; PNG-24 stored them at ~210 kB each, and the driver pool
renders all twenty-two at once, so the one screen where you actually play was
pulling **4.6 MB**. Same pixels as WebP q82: ~24 kB each, 0.52 MB for the set.
`driverPhoto()` in `lib/format.ts` is the single place the extension is
written, `DriverAvatar` lazy-loads (the pool starts inside a closed sheet on a
phone), and the canvas poster reads the same files — every browser that can run
the export can decode WebP. Regenerate with `sharp(...).webp({ quality: 82,
alphaQuality: 90 })`; do not resize below ~300px, the profile avatar draws at
128px on a 2× screen.

**The tab has a mark.** `app/favicon.ico` was `create-next-app`'s file until
2026-08-15 — every tab, bookmark and home-screen icon wore the Next.js logo.
It then wore `F1` knocked out of red, which was the riskiest asset in the
repository: black-on-red letters in a rounded square is a short distance from
the thing this project cannot use. Since 2026-08-27 all four raster icons are
the **logomark** (DESIGN §2.1) on the site's own `#0a0b10`: `favicon.ico`
(16/32/48), `apple-icon.png` (180), `public/icon-{192,512}.png` from
`app/manifest.ts`. `viewport.themeColor` in the root layout paints the phone's
address bar `#0a0b10`.

They are the whole mark, chequer included, in `#f4f6fa` on a solid `#c8102e`
tile (DESIGN §2.1) — `race-deep` because a tile is a surface, and because it is
the higher-contrast pair. The three app icons are **square and full-bleed**,
since iOS and Android round them themselves and a pre-rounded PNG comes out
double-rounded with dark corners; only `favicon.ico`, which nothing masks,
carries its own 22.4% radius. They are generated rather than drawn by hand, and
**the `.ico` must be RGBA** — Next's image pipeline rejects an RGB one outright
with *"The PNG is not in RGBA format"*, which fails the whole page, not just
the icon.

### 9.6.1 The cross-cutting pass (C-1 → C-7, 2026-08-27)

The last series of the redesign programme, and the only one that touches every
page rather than one:

- **The FAQ is not an accordion** (C-1). `/contact`'s nine `<details>` are open
  text: question left, answer right, hairlines between. A click per answer to
  hide three lines, and find-in-page cannot reach what is shut.
- **The sign-in screen lost its segmented control** (C-2). One form; the
  heading says which one it is and a single line under the button switches it.
- **Every fixed layer is named** (C-3). `--z-veil / nav / sheet / overlay /
  boot / grain` in `@theme`, used as `z-[var(--z-nav)]`. There is no
  `--z-index-*` namespace in Tailwind v4, so these are plain custom properties
  rather than generated utilities. The mobile menu and the boot screen both sat
  on `z-[100]` before this.
- **A skip link** (C-4), first in the DOM of every page, pointing at
  `#content` — the `(site)` layout wrapper and `/login`'s `<main>`.
- **No skeletons** (C-5) and **no scroll reveals** (C-6): both arbitrated in
  favour of what the charte already said, and written down as decisions in
  `DESIGN.md` §7.7 and §8.3 so they are not silently "fixed" later.
- **One palette for everything drawn outside the DOM** (C-7). `lib/palette.ts`
  is read by the canvas poster and the Open Graph cards, which each carried
  their own hand-copied hexes. `globals.css` remains the site's own source; the
  two files are named together in `DESIGN.md` §16.

**Every navigation starts at the top** (`components/ScrollReset.tsx`, in the
`(site)` layout). The App Router decides case by case whether to scroll, and
with a fixed nav, `min-h-svh` sections and a `loading.tsx` in between it got it
wrong where it shows most: measured at 390×844, tapping *The model* from the
bottom of `/rules` landed at **scrollY 228** — past the page title, and past
the loader, so the wait looked like nothing happening. It is 0 now. Three
guards, each measured: a URL with a hash still lands on its section (1975, the
same as clicking the anchor), the back button still restores where you were
(unchanged from before the component existed), and the first paint is never
touched.

### 9.7 Three gotchas that cost real debugging time

0. **An SVG resource inside `display: none` is dead in Chrome.** The logomark
   is a `currentColor` rect with a `<mask>` cutting the car out of it. The mask
   first lived inside every `Logomark`, under one shared id, on the reasoning
   that identical duplicates resolve to the first and draw the same thing.
   `url(#…)` does resolve to the first definition **in the document** — and the
   first one belonged to `BootScreen`, which the pre-hydration script marks
   `hidden`, and `#boot-screen[hidden]` is `display: none`. Chrome does not
   build SVG resources in a `display: none` subtree, so *every* reference on the
   page failed at once and all three marks rendered as unmasked white squares.
   The fix is `components/LogoSprite.tsx`: the definitions, in the root layout,
   in a zero-sized but **rendered** `<svg>` (`position: absolute`, `width/height:
   0`, never `display: none`). It also took the page from a copy of the path
   data per instance to one. It holds two masks — `duel-cut` for the mark and
   `duel-cut-name` for the cut with the vertical "F1 Duel", which the boot
   screen alone draws (DESIGN §2.1).

1. **`backdrop-filter` traps `position: fixed`.** The nav uses `.glass-chip`,
   whose `backdrop-filter` creates a containing block. A `position: fixed`
   child (the mobile menu overlay) is then positioned and clipped relative to
   the nav rather than the viewport — it looked completely broken. Fix:
   `MobileNav` renders its overlay via `createPortal(…, document.body)`. **Keep
   any future full-screen overlay out of backdrop-filtered ancestors.**
2. **Safari needs `-webkit-mask-image`.** The missing prefix on `.aurora`,
   `.hero-grid` and `.checker-edge` clipped the hero into a hard seam on
   Safari only.

### 9.8 Preview vs production (this has bitten twice)

Vercel **preview URLs are a different domain**, and Supabase auth redirect URLs
are whitelisted only for production + localhost. So a "logged-in" session on a
preview often isn't recognised server-side: no sign-out button appears,
navigations hard-reload, the loading spinner never shows. **Always validate
auth-dependent UI on production** (`f1-race-predictor-one.vercel.app`), never on
a preview deployment.

### 9.9 The race poster (`lib/poster/`, `components/PosterExport.tsx`)

Any scored race can be exported as a shareable 1080×1350 sheet: your top 10
against the official classification, per-slot points with rarity multipliers, a
stats band (points, exact hits, drivers landed in the top 10, average positions
missed) and the two side bets, over the site's own dark base, red aurora and
checkered finish line. Races you skipped export the same way, minus your
column — see the third bullet.

- **Drawn on a canvas, not screenshotted from the DOM.** No html-to-image
  dependency: the same sheet comes out of every browser, and the same canvas
  feeds the PNG, the clipboard, the share sheet and the PDF. The approach and
  the PDF writer are ported from the model platform's export
  (`webapp/static/js/app.js`).
- `pdf.ts` writes a **one-page PDF by hand** — five objects, an xref table and
  the JPEG as an image XObject (`DCTDecode`). A PDF library would cost more
  bundle than the sixty lines it takes to emit.
- `data.ts` builds the payload on the server from rows the review page already
  loaded, carrying only the drivers that appear (the object is serialized into
  the HTML). Driver photos are always offered and the drawing falls back to the
  three-letter code when one 404s, so a mid-season rookie can't break it.
- **A race you never picked exports too**, and that is the reason the table is
  column-driven rather than a fixed You / Official / Model triple. `data.ts`
  needs only the official classification: `total`, `stats` and `verdict` go
  null, your column disappears, and the official one takes the lead (portraits,
  team names, the row's colour stripe). The points column follows whoever is
  actually being scored — you, or the model on a race you sat out (hence
  `modelPoints`/`modelMultiplier` on each slot) — and vanishes when neither is.
  The verdict card reads `THE MODEL'S RACE` with the model's total, or
  `OFFICIAL RESULT` with the winner's name when there is no model entry either;
  the stats band shows the model's numbers, or nothing at all, and the legend
  goes with it since no column is graded. The point is that the button means the
  same thing on every scored race instead of appearing only where you played.
- **next/font hashes its family names** (`__Archivo_e8ce0c`), so the canvas
  can't ask for "Archivo". `draw.ts` reads `--font-archivo` / `--font-geist-mono` off
  `<html>` and preloads them through `document.fonts.load` — without this the
  poster silently renders in a system fallback.
- The dialog's one option is **Include the model**: off, the model's column,
  the duel verdict and the margin all go, the remaining columns widen and the
  card reads `FINAL SCORE` (or `OFFICIAL RESULT` on a race you skipped). It's
  for showing your race rather than the duel, and it's disabled outright when
  the race has no model entry.
- **Copy has to be issued before the first `await`.** `clipboard.write` needs
  the click's transient activation, and an `await` hands control back to the
  event loop, which spends it. Encoding the 1080×1350 bitmap first still lands
  inside Chrome's window; WebKit's is stricter, so Copy was the one button that
  reported failure while PNG and PDF — neither of which needs activation —
  worked beside it. `ClipboardItem` accepts a **promise** of a blob for exactly
  this: the write is issued synchronously inside the gesture and the encoding
  runs behind it. A successful copy also says so now, in the line under the
  buttons rather than in the button, because swapping "Copy" for "Copied ✓"
  resizes it and makes the row jump — the same reason the spinner joins the
  label instead of replacing it. Nothing else on the sheet leaves a trace: no
  file lands, no sheet opens, so silence looked identical to failure.
- Layout is **self-fitting**: the table's row height is derived from the space
  left between the verdict card and the stats band, so no arithmetic slip can
  push content off the sheet.
- **It signs itself with the site's lockup**, not with a lockup of its own. The
  header used to reverse "F1" out of a red rounded tile and set "DUEL" beside
  it — a mark that predates the site having one, and the last place still
  signing the project in a shape it no longer uses. `drawLockup()` is
  `components/Wordmark.tsx` in canvas terms, down to its proportions (mark at
  1.7em, 0.5em gap, 0.2em of tracking, "F1" in race red), and the footer
  repeats it small the way every page's footer does.
- **The mark is fetched and recoloured, not re-drawn.** `public/logo-mark.svg`
  paints itself in `currentColor` and knocks the car out of the letter with a
  mask; through an `<img src>` neither works, because an SVG loaded that way is
  an isolated document with no cascade to inherit from — `currentColor` falls
  back to black, on a black sheet. `loadLogomark()` fetches the file as text,
  substitutes the colour, retargets the viewBox to the ink's own bounds (the
  numbers `Logomark.tsx` uses) and loads the result from a blob URL. The
  knockout survives, because it is a mask inside the file rather than a cascade
  trick, so the car shows the poster's aurora exactly as it shows the page.
- **The headline is set in the display voice** — or as near as a canvas reaches.
  `.display` is Archivo at `wdth 118`; `ctx.font` parses the CSS `font`
  shorthand, which admits only the nine `font-stretch` keywords, and
  `ctx.fontStretch` is a keyword enum too. Both silently ignore `118%`, measured
  rather than assumed. `semi-expanded` (112.5%) is the nearest rung and lands
  within about half a percent across a headline; `expanded` is 125%, Archivo's
  ceiling and visibly wider than the site. The width has to travel with
  `fitFont` as well, or a headline fitted at one width and drawn at another
  runs off the sheet.
- **The footer prints the address.** A PNG in a group chat or an Instagram
  story carries no link of its own, so a poster without its domain on it is a
  dead end — the whole point of the sheet is that it travels. The right-hand
  tagline ("Humans versus the machine", which the left one already implied) gave
  its place to the host, in mono. `posterHost()` prefers `CANONICAL_HOST`
  (`lib/constants.ts`, set from `NEXT_PUBLIC_SITE_URL`) so a sheet exported from
  a Vercel URL still points at the real domain, and falls back to
  `location.host`. `SITE_URL` itself is unusable here: its Vercel fallback reads
  a server-only variable, so in the browser it would resolve to the hardcoded
  default.

### 9.10 Share cards (`lib/og.tsx` + `opengraph-image` routes)

The project had **no Open Graph metadata at all** until 2026-08, which was the
worst possible omission for this particular game: leagues are joined by pasting
`/join/<code>` into a group chat, so the entire growth loop arrived as naked
text. Three cards now, all drawn by one `shareCard()` helper so only the words
differ:

| Route | Card |
| --- | --- |
| `app/opengraph-image.tsx` | The default, inherited by every page without its own — headline, strapline, the three scoring numbers |
| `app/(site)/join/[code]/opengraph-image.tsx` | League name, who is inviting, how many players |
| `app/(site)/profile/[username]/opengraph-image.tsx` | Username, W-D-L against the model, races, points |

The two dynamic ones are served at a **hashed path** — `/join/<code>/opengraph-image-bp3zyz`
— not at the plain segment, which is worth knowing before concluding from a
404 that the route is broken.

The join card leaks nothing new: `league_by_code()` already answers name, owner
and size to anyone holding the code (§7.3), and the card shows exactly that.

**The lockup is the site's**, not a second one drawn here. The card used to set
"F1" + "DUEL" by hand, which predates the mark existing. `loadAssets()` reads
`public/logo-mark.svg` and recolours it exactly as the poster does — the file
paints itself in `currentColor`, which resolves to black once it is an image
rather than an element in a page — then hands Satori a base64 data URI. The
knockout survives, so the car shows the card's own ground.

**Assets are read with `readFile`, not `fetch`.** Next's documented pattern for
this is `fetch(new URL(…, import.meta.url))`, which is written for the Edge
runtime; these routes run on Node, where the bundler resolves that to a `file:`
URL and Node's fetch refuses the scheme outright — `TypeError: fetch failed`,
caused by `not implemented... yet...`. `readFile` takes the file URL directly:
same asset reference, no network in the middle. Verified by build rather than by
argument — `next build` prerenders `/opengraph-image` as static, which it can
only do if the fonts and the mark resolved.

**Four things `ImageResponse` will punish you for.** It renders through
Satori, not a browser:

1. **No stylesheet, and a very small CSS subset.** Inline styles only —
   Tailwind classes do nothing here.
2. **No block layout.** A `<div>` with more than one child and no
   `display: flex` throws at render time, not at build time.
3. **No font, either.** Satori inherits nothing, so given no `fonts` option it
   falls back to its own bundled face — and from the day these cards were added
   until 2026-08-29 they went out in a typeface that appears nowhere else on the
   site. That is the worst surface to
   lose: it is what a stranger meets first, in a group chat, before any page.
   `lib/fonts/` now holds three committed cuts, the charte's three voices —
   Archivo 400 for running text, Archivo at display width 800 for the headline
   and the name, Geist Mono 700 for numbers and labels. Committed rather than
   fetched at render: a card that must reach fonts.gstatic.com before it can
   answer is a card that sometimes doesn't. Both families are OFL.

   Google Fonts has **no static instance at `wdth 118`**, the width `.display`
   uses — `semi-expanded` (112.5) and `expanded` (125) and nothing between. The
   card takes 112.5, which is the same rung the canvas poster lands on for the
   same reason by a different route (§9.9).
4. **`radial-gradient(closest-side …)` renders as a ring with a dark hole.**
   The hero's glow had to become a corner-anchored `linear-gradient`, and its
   transparent stop sits at 55% so the box has a dead margin — at 72% the
   corners furthest from the gradient origin still carried colour and left a
   visible seam down the middle of the card.

`metadataBase` comes from `SITE_URL` (§10.1) and must be absolute: the card is
fetched by WhatsApp or Slack, not by the browser on the page, and a relative
base silently produces a card with no image at all.

---

## 10. Part VII — Configuration, secrets, environments

### 10.1 Every environment variable

| Variable | Where | Required | Purpose |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel, `web/.env.local` | ✅ | Supabase project URL (browser-visible) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel, `web/.env.local` | ✅ | Anon key — safe to ship, RLS is the guard |
| `NEXT_PUBLIC_SEASON` | Vercel | recommended | Pins the game season; defaults to the current year |
| `NEXT_PUBLIC_MODEL_URL` | Vercel | optional | Link out to the Flask app; `localhost` values are ignored |
| `NEXT_PUBLIC_SITE_URL` | Vercel | optional | Absolute origin the share cards are built against (`metadataBase`). Unset it falls back to Vercel's own `VERCEL_PROJECT_PRODUCTION_URL`, then to the production URL — so it only needs setting on a custom domain. Previews deliberately resolve to the **production** origin: a preview build minting card URLs pointing at itself would put a throwaway address into somebody's group chat |
| `NEXT_PUBLIC_CONTACT_EMAIL` | Vercel, `web/.env.local` | optional | The mailbox `/contact` publishes. Unset (or not an address) → the page shows the GitHub route only. An env var on purpose: an address can then be created, changed or retired without a deploy |
| `SUPABASE_URL` | GitHub Actions secret, local shell | ✅ for jobs | Same URL, server side |
| `SUPABASE_SERVICE_KEY` | GitHub Actions secret, local shell | ✅ for jobs | **service_role** — bypasses RLS, never ship to a client |
| `RESEND_API_KEY` | GitHub Actions **secret** | optional | Sends the two race emails (§8.8). Unset → every send is a logged no-op and the jobs are otherwise unchanged |
| `MAIL_FROM` | GitHub Actions **variable** | with the above | e.g. `F1 Duel <duel@yourdomain>`. Resend sends only from a **domain verified with it by DNS** — a Gmail or Proton mailbox cannot be a `from` address, however much it is yours |
| `MAIL_REPLY_TO` | GitHub Actions **variable** | optional | Any mailbox at all. How the project's own address receives replies while the verified domain does the sending |
| `SITE_URL` | GitHub Actions **variable** | optional | Where the email buttons point; defaults to the production URL. On a custom domain this and `NEXT_PUBLIC_SITE_URL` must move together, or the emails link to one origin while the share cards claim another |
| `F1_PORT` | local shell | optional | Flask port (default 5050) |
| `F1_NO_RELOAD` | local shell | optional | `1` disables the Flask reloader |

Deployment status (as of 2026-08-01): Supabase schema applied; calendar + roster
seeded; auth redirect URLs configured; GitHub Actions secrets set. Render/Flask
hosting is **not** deployed — `/model` covers it natively.

### 10.2 Local setup from zero

```bash
# 1 — Python side
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# 2 — Data + model (only if models/ or data/processed/ are missing)
python src/collect.py                 # hours on a cold cache
python src/collect.py --practice
python src/features.py
python src/train.py

# 3 — Flask model page
python src/app.py                     # http://127.0.0.1:5050
#   or double-click "Launch F1 Predictor.command" on macOS

# 4 — Game frontend
cd web
cp .env.local.example .env.local      # fill in Supabase URL + anon key
npm install
npm run dev                           # http://localhost:3000

# 5 — Jobs, against the real project
export SUPABASE_URL=… SUPABASE_SERVICE_KEY=…
python jobs/sync_schedule.py 2026
```

### 10.3 Production topology

| Component | Host | Config |
| --- | --- | --- |
| Game site | Vercel | Root Directory `web`, 4 env vars, auto-deploy from `main` |
| Database + Auth | Supabase free | project `rkavhmvtstzcrciebsqu`; redirect URLs must include prod + `http://localhost:3000/auth/callback` |
| Jobs | GitHub Actions | 2 repo secrets |
| Model platform | Render free (optional) | build `pip install -r requirements.txt`, start `gunicorn --chdir src app:app` (add `gunicorn` to requirements first); UptimeRobot ping every 10 min to fight the 15-minute sleep |

---

## 11. Part VIII — Git and GitHub workflow

Repository: <https://github.com/ArthurOttevaere/f1-duel>

Renamed from `f1_race_predictor` in August 2026, once the game — not the
model — became the product. GitHub redirects the old URL and the old git
remote indefinitely, so nothing breaks, but new clones should use the new
name. The Vercel *project* is named separately and still answers on
`f1-race-predictor-one.vercel.app`; renaming the repo does not touch it.

- **`main` is the only long-lived branch.** The historical `model` branch was
  merged and retired; model work and game work are separated by *directory*.
- **Never commit directly to `main`.** Every change goes on a short-lived
  branch: `feat/…`, `fix/…`, `tweak/…`, `chore/…`, `docs/…`.
- **Every branch lands through a PR.** History reads
  `Merge PR #N: <summary>` on `main`, with one descriptive commit per branch.
- **Claude owns the whole git side of a task without being asked**: create the
  branch, commit, push, open the PR with `gh`. Merging remains the user's call
  unless stated otherwise.
- Vercel builds every push (previews for branches, production for `main`).
  Remember §9.8: **validate auth UI on production, not previews.**

Commit message style used in this repo: `type(scope): imperative summary` —
e.g. `feat(web): next-race countdown widget in place of the season banner`,
`fix(ci): create the FastF1 cache dir`, `chore: keepalive <timestamp>`.

---

## 12. Part IX — Operations runbook

### 12.1 Routine tasks

**[`DATABASE.md`](DATABASE.md) is the command-by-command version of this
section** — organised by what you want to do, with the SQL and the CLI side by
side, what is reversible, and what not to touch by hand. This table is the
index; that file is the manual.

| Task | How |
| --- | --- |
| Add a new season | `python jobs/sync_schedule.py <year>`, then set `NEXT_PUBLIC_SEASON` on Vercel |
| Move to a custom domain | `DEPLOYMENT.md` §4b — and **add `https://<domain>/auth/callback` to the Supabase redirect list**, or every magic link and Google sign-in bounces on the new domain the moment it goes live |
| Enter Driver of the Day | `python jobs/set_dotd.py <season> <round> <driver_id>` (Monday) |
| Settle the season | `python jobs/settle_season.py <season>` (December, once) |
| Force a lock / score now | Actions tab → workflow → **Run workflow** |
| Re-score a race | It re-scores automatically for 10 days; otherwise set `races.status='locked'` in SQL and run `score-race` |
| Refresh the model after new races | `python src/collect.py <year> --force` (+ `--practice`), `python src/features.py`, then optionally `python src/train.py` |
| Validate a rules change | `python jobs/backtest.py 2026 --rounds 1-13` — `mirror` must draw every race |
| Inspect players | `python jobs/admin.py players`, or the SQL editor query in §7.6 |
| Send a race email out of schedule | `python jobs/send_mail.py lock\|result <round> [--dry-run] [--force] [--to X]`, or Actions → **send-mail** (§8.8) |
| Zero the model's season score | `python jobs/admin.py model-reset` (or `select admin_model_reset(2026);`). Use it at launch so newcomers aren't chasing a machine with a season's head start. Reversible: `model-restore` |
| Start the season at round N | `python jobs/admin.py model-count-from N` |
| See why the board shows what it shows | `python jobs/admin.py model-status` |
| Remove a player | `python jobs/admin.py delete-player <username>` — cascades to everything they own, no undo |

### 12.2 Troubleshooting — symptom → cause → fix

**Every invite link says "this invite has expired", or the delete-account
button reports that deletion isn't enabled.**
Migration `0005` hasn't been applied to this project — `league_by_code()` /
`delete_account()` don't exist, and both features fail closed by design. → Run
the file in the SQL editor (§7.5). Codes and `join_league()` keep working
meanwhile, so "join with a code" is the fallback.

**"No upcoming race" on `/game`.**
Either the season is over, or `races` has no `scheduled` row with
`race_at > now` for `NEXT_PUBLIC_SEASON`. → Run `sync-schedule`; check
`NEXT_PUBLIC_SEASON` matches the seeded season.

**The race is over, hours have passed, `score-race` still says "no official
classification yet".**
Ergast hasn't published and OpenF1 answered nothing. The log says which:
`openf1: …` lines are the client refusing (network, 5xx after retries, a
4xx); "OpenF1 has unknown driver code(s)" means the season roster in
`drivers` is missing someone — run `sync-schedule`. Silence from both means
OpenF1 has no `session_result` yet (the free tier serves a session ~30 min
after it ends). → Wait a pass; if OpenF1 is down, Ergast will do in a few
hours, as before.

**`results.dotd` stays null; the log says `no unique roster match` or nothing
about dotd.**
formula1.com's article slug named nobody the roster recognises — a nickname,
a headline about the vote rather than the driver — or the race hub could not
be matched (the log prints the slug it read; no line at all means no hub
matched or no article yet). → `python jobs/set_dotd.py <season> <round>
<driver_id>`; the +5 lands immediately. Then look at `jobs/dotd.py::
driver_from_slug` if the pattern will recur.

**`results.safety_car` is null on a scored race.**
Race control had published nothing when the race was scored (OpenF1 lag or
outage). The ten-day re-score window asks again on every pass; older than
that, `python jobs/score_race.py --rounds <n>` does.

**The model has no entry for this weekend.**
`lock-race` runs hourly Fri–Sun and only refreshes once `now > quali_at +
1h30`. → Check the Actions log. `model unavailable (…)` means `predict.py`
raised — usually FastF1 not yet publishing the session, or `data/processed/`
being stale for a brand-new driver/team.

**A race is `locked` but never becomes `scored`.**
In order: is it `race_at + 2h` yet? Does FastF1 have the classification
(`python -c "import sys;sys.path.insert(0,'src');import predict;print(predict.load_actual_results(2026,13))"`)?
Is there a `model_entries` row? Did the count check abort ("refusing to score a
partial field")? Each prints a distinct message in the job log.
If the cause is a **missing model entry**, `lock-race` will not retry on its own
(it only scans `scheduled` races). Recover with
`update races set status='scheduled' where season=<Y> and round=<R>;`, run
**lock-race**, then **score-race**.

**Every profile is red, and team colours are grey everywhere.**
`drivers.team_color` is null for the season — FastF1 has no session data for it
yet, or it doesn't recognise a new team. Since `lib/teams.ts` this is a
cosmetic fallback rather than a bug (the site falls back to its own table of
constructor colours), but the roster is still incomplete. → Re-run
`python jobs/sync_schedule.py <year>` once FastF1 has published a session, and
check `select team, team_color from drivers where season=<Y>;`. A team the
table doesn't know either falls back to neutral grey — add it to `TEAM_COLORS`.

**The model's points on the standings don't match its race pages.**
Working as designed: some races are excluded from its season total
(`counts_in_standings`, §7.2). The number of races on its line is the honest
footnote. → `python jobs/admin.py model-status` shows which, `model-restore`
puts them all back.

**Scores look wrong / all multipliers are ×1.**
`prob_matrix` is empty — the race was locked with the grid-order fallback.
`rarity_multiplier(None)` returns 1.0 by design. Check `model_entries.prob_matrix`.

**Standings are missing players / a league board is empty.**
The 1000-row cap (§7.4). Confirm migration `0004` is applied and that the query
goes through `standings_page`, not a raw `.select()`.

**"No sign-out button" / navigations hard-reload.**
You're on a Vercel **preview** domain that Supabase doesn't have in its redirect
allow-list. Test on production (§9.8).

**Signup succeeds but `/welcome` never appears.**
Migration `0002` isn't applied — `username_set` doesn't exist, so nothing
flags an auto-generated name.

**Flask page is blank on `http://127.0.0.1:5000`.**
macOS AirPlay receiver. Use **5050** (the app's default) or set `F1_PORT`.

**Circuit outline missing for an upcoming race.**
`_prewarm_tracks()` hasn't reached it yet, or telemetry for every past edition
failed. The first `/api/track` call builds and caches it — slow once, instant
after. Delete `data/track_cache/<slug>.json` to force a rebuild.

**Turbopack build fails on this Mac.**
The native `@next/swc-darwin-arm64` binary download can truncate on a slow
network. Reinstall that single package.

**Scheduled workflows stopped running.**
GitHub's 60-day rule (§8.8). Run `keepalive` manually, or push any commit, then
re-enable the workflows in the Actions tab.

**Supabase project paused.**
7 days with no database request. Un-pause in the dashboard — no job can do this
for you; that's why the keepalive ping fails loudly.

### 12.3 Health checks

```bash
# Model can predict at all
python src/predict.py --year 2026 --round 13

# Rules engine is intact (mirror must draw every race)
python jobs/backtest.py 2026 --rounds 1-5

# Database reachable with the service key
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  "$SUPABASE_URL/rest/v1/races?select=id&limit=1"     # expect 200

# Frontend typechecks + lints
cd web && npx tsc --noEmit && npm run lint

# Frontend builds (catches what tsc alone doesn't: route types, RSC boundaries)
cd web && npm run build
```

**Looking at front-end work.** There is no browser on the dev machine and no
test suite, so visual changes are checked by driving a headless Chrome:

```bash
npx -y @puppeteer/browsers install chrome@stable --path /tmp/browsers
"/tmp/browsers/chrome/<ver>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
  --headless=new --disable-gpu --window-size=1100,900 \
  --virtual-time-budget=15000 --screenshot=out.png http://localhost:3000/<route>
```

Three things to know.

**One — the 500px floor is a trap, and there is a way round it.** Headless
Chrome enforces a **minimum 500px window width** on macOS: a
`--window-size=390,844` run lays out at 500 and merely *crops* the capture. For
years that meant phone-width bugs read as false positives — and it is why the
hidden Points and Official columns (§13.1.1) survived every previous look. The
command line cannot go narrower, but **CDP can**: drive the same binary with
`--remote-debugging-port`, then

```
Emulation.setDeviceMetricsOverride  { width: 390, height: 844,
                                      deviceScaleFactor: 2, mobile: true }
Page.captureScreenshot              { captureBeyondViewport: true }
```

which lays out at a true 390 *and* gives full-page shots in one call. Node 24's
built-in `fetch` and `WebSocket` are enough — no npm package. **Check any
`min-w` layout this way before believing it is responsive.**

**Two — a full-page shot of a `min-h-svh` hero needs the viewport, not a tall
window.** `--window-size=1440,3400` makes the hero itself 3400px tall and tells
you nothing. Use a normal viewport with `captureBeyondViewport`.

**Three**, pages that need auth or scored rows are best rendered through a
**throwaway route** under `web/app/dev-*/` holding mock data, deleted before
committing; that is how the poster, the points explanation, the mobile
standings board and breakdown, and the press-and-hold gesture were verified
(the gesture with `puppeteer-core` touch emulation, asserting that a quick
swipe does *not* reorder and a hold does). Note that a folder named `_foo` is a
**private folder** in the App Router and will 404 — name it `dev-foo`.
`web/.env.local` holds placeholder Supabase credentials, so every data-driven
page renders empty locally; the harness is not optional.

---

## 13. Part X — Known issues, debt and roadmap

### 13.1 Open

| # | Issue | Impact | Fix |
| --- | --- | --- | --- |
| 2 | README says Optuna runs 50 trials; `train.py` uses 60 | Documentation only | Align the README |
| 5 | The model's history (`data/processed/*.csv`, form and standings features) is refreshed by hand — `collect.py` + `features.py` on a laptop, committed | Between refreshes the model's "recent form" and championship standings are stale; they were frozen at round 7 from June to September 2026 | Refresh after each race until collection has an OpenF1 path of its own (`collect.py` needs timing for weather and practice laps) |
| 6 | `model_entries` of rounds 1–13 of 2026 were locked `pre_quali` (§13.1.1 #3) and stay so | Those duels were played against an opponent without a grid; entries are frozen at lock and are not rewritten after the fact | None — by design. From round 14 the model has qualifying |

### 13.1.1 Fixed

- **The timing feed, from Actions** (fixed 2026-09-06, `feat/openf1-sources`).
  Three open issues with one cause — `livetiming.formula1.com` answers 403 to
  GitHub Actions and FastF1 carries on with empty tables (§8.9):
  - *#1 — a race locked with no model entry could never be scored*:
    `lock_race.py` now retries `locked` races without an entry on every run
    (§8.3).
  - *#3 — the model had never had the grid*: `predict.load_qualifying` /
    `load_practice` read OpenF1 when FastF1 comes back empty; the first
    entry with qualifying is round 14. `pre_quali` was `true` on all 13
    rounds before it.
  - *#4 — the safety-car bet had never been settled*: `results.safety_car`
    now comes from OpenF1's race control. Settled retroactively for rounds
    1–13 with `score_race.py --rounds 1-13` the same evening — which moved
    the Dutch Grand Prix's totals (three players, +8 each where the call was
    right) and the model's season line.
  Also in the same change: same-evening scoring from OpenF1's classification
  (Monza was scored six hours after the flag, from the branch, while Ergast
  still had nothing), the Driver of the Day read from formula1.com (§8.5),
  and the crons at 15 minutes on race days.

- **The model's picks were public while you were still picking** (fixed
  2026-08-16, `fix/model-picks-secret-until-lock`, migration 0009). `predictions`
  had carried "yours until the race locks" since day one; `model_entries` was
  `public read` with no such test, and `lock_race.py` writes the model's entry
  as soon as qualifying is over and refreshes it hourly. So from Saturday
  afternoon, one anon-key query — or a visit to `/model`, which printed the
  grid of the highest round that had an entry — gave you the machine's top 10
  **and** its probability matrix, which is what decides whether your own call
  counts as bold. Found while wiring the signed-out preview on `/game` (P-3):
  the page had a comment explaining it must never read the order, which was
  true of the page and not of the database. The rule is a policy now, and the
  frontend filters on `status` as well rather than relying on being denied.

- **The phone hid the two numbers the game is played for** (fixed 2026-08-15,
  `fix/mobile-worksite`). Found by an audit of the live site driven at a real
  390px viewport, not at the 500px minimum headless Chrome forces on the
  command line — see §12.3, the difference is exactly what made these
  invisible. Four separate faults, one theme: **desktop layouts left to cope on
  their own.** `/game/standings` put Points past the right edge and
  `/game/races/[round]` put Official there (both `overflow-x-auto` over a
  `min-w`, both now stacked under `sm` — §9.6); `/game`'s last-duel bar ran
  "Hungarian Grand" straight into "See the breakdown" (a `justify-between` with
  no `gap` and no `shrink-0`); and the driver pool shipped 4.6 MB of PNG to do
  the work of 0.52 MB of WebP. The tab also stopped calling itself Next.js.

- **The 404 was white** (fixed 2026-08-15, same branch). Next's default
  `not-found` carries `body { background: #fff }`, so a mistyped URL landed on
  a bare white page and a mistyped *profile* link landed on the site's own nav
  and checkered footer rendered in white. Two `not-found.tsx` files now, one
  per boundary, sharing `NotFoundBody` — §9.2 for why the root one cannot
  render `SiteNav`.

- **Every profile wore the site's red** (fixed 2026-08-11, PR #27). The header
  theme was `championDriver?.team_color ?? "#ff1e3c"`, so a null `team_color`
  on the roster — which is what a season FastF1 has no sessions for yet looks
  like — themed a Mercedes pick in Ferrari red, with no way to tell a fallback
  from a real choice. `lib/teams.ts` now resolves a colour through the driver,
  their team-mates, the picked constructor and a table of constructor colours
  before giving up, and gives up to grey rather than to a team's colour. The
  same helper replaced every scattered `?? "#6c7280"`. Also fixed there: tints
  were built by pasting an alpha suffix onto the hex string (`${theme}2e`),
  which silently produced an invalid colour for any value that wasn't a
  six-digit hex with a leading `#`.

- **Leagues were invisible** (fixed 2026-08-02, PR #21). Nothing gated them:
  `/game/leagues` was missing from `NAV_LINKS` and linked only from the footer,
  so new players never found the page and concluded the feature wasn't for
  them. The lesson is worth more than the fix — RLS being correct says nothing
  about a feature being reachable.
- **A failed league join looked like a success** (fixed 2026-08-02, PR #21).
  `LeagueActions` read the `error` state immediately after setting it — still
  the previous render's value — so the form closed and refreshed as though the
  join had worked. Read the value you just computed, not the state you just set.
- **`lock_race.grid_fallback()` crashed instead of falling back** (written
  2026-08-02 on `fix/grid-fallback-tuple`, **but that branch sat unmerged until
  2026-08-15** — this entry claimed the fix was live for a fortnight while
  production still carried the bug. A fix is not fixed until it is on `main`;
  check the branch, not the note). It subscripted the tuple returned by
  `load_qualifying()` as `quali["DriverId"]` → `TypeError`, and the
  `is not None` guard never fired because a tuple is not `None`. The one path
  that guarantees "the duel always happens" took the job down instead. Now
  unpacked in `quali_order()`, which also sorts by position and tolerates
  missing sessions, empty frames and null `DriverId`s.

### 13.2 Debt and limitations

- **Sprint races are out of scope in v1.** Only the main race is predicted and
  scored, though sprint *points* are counted in the Flask standings.
- **DotD is manual.** No official API exists.
- **The safety-car model is a static lookup table**, not learned. Deliberate
  (it's the human's edge), but it will drift as circuits change.
- **σ = 2.0 is a hand-set constant** that silently governs every probability
  and multiplier. It has never been fitted against realised outcomes.
- **Marketing pages are dynamic** (`/`, `/model`, `/rules`) because `SiteNav`
  calls `getUser()`. Making that button client-side would let them be static.
  Identified, not attempted.
- **`FIELD_LIMIT = 100`** on the race review means players outside the top 100
  see only their own row in context.
- **League codes are 6 hex characters** (~16M combinations) and both
  `join_league()` and `league_by_code()` answer for any code. Enumeration is
  theoretically possible; for a friends-and-family game the trade (a link that
  works with no account lookup) is deliberate. Rate-limiting or longer codes
  are the fix if a league ever needs to be private in earnest.
- **Deleting an account deletes the leagues that account owns**, for everyone
  in them. Said plainly in the confirm dialog, but there is no hand-over.
- **No automated test suite.** `backtest.py` is the closest thing, and it
  covers only the scoring rules. Front-end work in this repo is verified by
  driving headless Chrome against a throwaway harness route (see §12.3).
- **The model retrains manually.** There's no scheduled retraining job; the
  committed artifacts are whatever was last trained locally.

### 13.3 Roadmap (from `GAME_DESIGN.md` §8 and current state)

Phases 0–4 are merged and live. Remaining candidates: sprint-weekend support,
a custom domain, deploying the Flask platform on Render, Google OAuth
configuration in Supabase, static marketing pages, and automated retraining.

---

## 14. Keeping this document true

**This file is part of the change, not a follow-up to it.** Whenever a change
touches the areas below, update the matching section in the *same* branch and
PR — a stale almanac is worse than no almanac.

| If you change… | Update |
| --- | --- |
| Game rules, points, bonuses, tiers | `GAME_DESIGN.md` **first**, then §6 here |
| `jobs/scoring.py`, `model_bridge.py`, `grid_prior.py`, `safety_car.py` | §6 (+ re-run `backtest.py` and record the outcome) |
| `src/openf1.py`, `jobs/dotd.py` — a data source | §2.2, §8.4.1 / §8.5, and §8.9 if it is about what Actions can reach |
| Features, training, splits, σ | §4 |
| `src/app.py` routes or caching | §5 |
| `supabase/schema.sql` or a new migration | §7 (including the migration table) and `supabase/README.md` |
| `jobs/*` or `.github/workflows/*` | §8 |
| Routes, components, auth flow | §9 |
| Anything visual — tokens, a component pattern, motion, a chart, the voice | `DESIGN.md` **first**, then §9 here if it also changed behaviour |
| Env vars, hosting, secrets | §10 and `DEPLOYMENT.md` |
| Git conventions | §11 |
| A new failure mode you had to debug | §12.2 — write the symptom, cause and fix while it's fresh |
| A bug you found but didn't fix | §13.1 |
| Anything a player waits for | §9.6 — it needs a spinner; that is a house rule, not a preference |
| A table, or any layout with a `min-w` | §9.6 — check it at a **real** 390px (§12.3) before calling `overflow-x-auto` responsive |
| Operator-only actions (model score, players) | §7.2, §8.5 and the §12.1 runbook |

Also refresh the **Last reviewed** line and commit hash at the top.

---

## 15. Appendices

### A. Glossary

| Term | Meaning |
| --- | --- |
| **FastF1** | Python library wrapping the official F1 timing API; the sole source of session data |
| **DriverId** | FastF1's slug, e.g. `max_verstappen`. The join key everywhere: CSVs, DB, headshot filenames |
| **Score (model)** | Regressed expected finishing position. Lower = better. Sorted → predicted order |
| **Prob matrix** | `{driver_id: [P(P1), P(P2), …]}`, calibrated, frozen at lock. Drives rarity multipliers |
| **Rarity multiplier** | ×1 / ×1.5 / ×2 / ×3 on exact hits, by how unlikely the model thought them |
| **Calibrated entry** | The model's duel picks: MC probabilities blended with the grid prior, then ordered to maximise expected game points |
| **β / `CALIBRATION_BETA`** | 0.25 — weight on the ML signal vs the historical grid prior |
| **σ / `SIGMA`** | 2.0 positions of assumed race-day noise in the Monte-Carlo |
| **Lock** | The moment `races.status` flips to `locked` (at `race_at`): predictions close, picks become public |
| **Duel** | One player vs the model on one Grand Prix. Recorded as W/D/L and a points margin; worth no bonus points (§7.7) |
| **Prorate** | Fraction of the season remaining when a championship pick was locked (floor 0.2) |
| **Anon key** | Browser-side Supabase key, constrained by RLS |
| **Service-role key** | Server-side Supabase key that bypasses RLS. Jobs only |

### B. File index — "where do I go to change X?"

| I want to change… | File |
| --- | --- |
| A game rule or point value | `docs/GAME_DESIGN.md`, then `jobs/scoring.py` |
| How hard the model plays | `jobs/model_bridge.py` (`CALIBRATION_BETA`, `_strategic_order`) |
| The safety-car priors | `jobs/safety_car.py` |
| A model feature | `src/features.py` + `src/train.py` `FEATURE_COLS` (retrain required) |
| Prediction-time behaviour | `src/predict.py` |
| A Flask endpoint or cache | `src/app.py` |
| Model-page UI | `webapp/templates/index.html`, `webapp/static/js/app.js`, `…/css/style.css` |
| Database structure | `supabase/schema.sql` + a new `supabase/migrations/000N_*.sql` |
| Who can read/write what | RLS policies in `supabase/schema.sql` |
| Job scheduling | `.github/workflows/*.yml` |
| A game page | `web/app/(site)/…` |
| Nav links | `web/lib/nav.ts` |
| Circuit geometry | `web/lib/circuits.ts` — **generated**, rebuild with `jobs/build_circuit_traces.py` |
| Colours, spacing, motion | `web/app/globals.css` — and record the rule in `docs/DESIGN.md` |
| A design rule, pattern or convention | `docs/DESIGN.md` |
| The probability chart | `web/components/ProbabilityGrid.tsx` |
| The prediction UX (incl. the press-and-hold reorder) | `web/components/PredictionEditor.tsx` |
| How a race's points are explained | `web/components/RaceBreakdown.tsx` |
| The shareable poster | `web/lib/poster/{draw,data,pdf,types}.ts`, `web/components/PosterExport.tsx` |
| League invites and the join flow | `web/app/(site)/join/[code]/page.tsx`, `web/components/{LeagueCardActions,JoinLeagueButton}.tsx` |
| Account deletion | `web/components/DeleteAccount.tsx` + `delete_account()` |
| The profile page | `web/app/(site)/profile/[username]/page.tsx` + `web/components/{ProfileAvatar,ProfileEditPanel,TeamWordmark,FormStrip,PointsCurve}.tsx` |
| What a championship pick is worth on screen | `web/lib/champions.ts` (**mirror of the §2.3 tiers — keep in step with `jobs/settle_season.py`**) |
| Row types shared by the frontend | `web/lib/types.ts` |

### C. Feature quick reference (39)

`GridPosition` · `quali_position` · `quali_gap_to_pole` · `best_quali_time` ·
`fp3_gap` · `fp3_laps` · `fp_avg_gap` · `fp3_vs_quali_delta` ·
`driver_champ_pos` · `driver_champ_pts` · `constructor_champ_pos` ·
`constructor_champ_pts` · `driver_form_pos_5` · `driver_form_pts_5` ·
`driver_last_pos` · `driver_last_pts` · `driver_reliability_10` ·
`team_form_pos_5` · `driver_circuit_avg` · `team_circuit_avg` ·
`teammate_grid` · `grid_champ_delta` · `season_progress` · `AirTemp_mean` ·
`TrackTemp_mean` · `Humidity_mean` · `WindSpeed_mean` · `Rainfall` ·
`driver_wet_advantage` · `circuit_wet_rate` · `circuit_dnf_rate` ·
`driver_momentum` · `driver_vs_teammate_rate` · `is_street_circuit` ·
`driver_encoded` · `team_encoded` · `circuit_encoded` · `Season` · `Round`

### D. Command cheat-sheet

```bash
# ── Model pipeline ─────────────────────────────────────────────
python src/collect.py [year] [--practice] [--force]
python src/features.py
python src/train.py
python src/predict.py [--year Y --round R] [--pre-quali] [--explain] [--driver VER]
python src/app.py                      # http://127.0.0.1:5050

# ── Game jobs (need SUPABASE_URL + SUPABASE_SERVICE_KEY) ───────
python jobs/sync_schedule.py [season]
python jobs/lock_race.py
python jobs/score_race.py                            # the scheduled pass
python jobs/score_race.py --rounds 1-13 [--dry-run]  # re-score any race; dry-run writes nothing
python jobs/set_dotd.py <season> <round> <driver_id> # only when dotd.py found nothing
python jobs/settle_season.py <season>
python jobs/backtest.py [season] [--rounds 1-13]     # no DB needed

# ── Frontend ───────────────────────────────────────────────────
cd web && npm install && npm run dev
npm run build && npm run lint

# ── Git ────────────────────────────────────────────────────────
git checkout -b feat/<slug>
git commit -m "feat(scope): summary"
git push -u origin feat/<slug>
gh pr create --fill
```
