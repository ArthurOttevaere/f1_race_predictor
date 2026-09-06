# F1 Duel — Game Design & Platform Foundation

> Beat the model. Every Grand Prix, until the last lap of the season.

This document is the single source of truth for the game platform built on top of
the F1 Race Predictor model. Every implementation decision should trace back to
a rule or principle written here. When a rule changes, change it here first.

---

## 1. Concept

Every race weekend, each player submits an ordered **top 10 prediction** for the
Grand Prix. The ML model submits its own (its post-qualifying predicted order).
After the race, both are scored with the exact same formula against the official
classification. Player vs model: one duel per Grand Prix, all season long.

**The core design idea — rarity pays.** Points are multiplied by how *unlikely*
the model thought each correct pick was (using the model's own Monte-Carlo
position probabilities). By construction the model always plays its most likely
order, so it almost never earns multipliers. A human beats the model by taking
bold calls that land: that asymmetry is the game.

---

## 2. Rules

### 2.1 The weekly duel

- Predictions open when the race weekend's data is available (schedule is known
  all season, so effectively always open for the next GP).
- Predictions **lock at the official race start time**. Players can edit freely
  until then. The model's entry is its **post-qualifying prediction**, generated
  after qualifying and frozen at the same lock time.
- Other players' predictions are hidden until lock (enforced server-side, see §5).
- Main race only in v1. Sprint races are out of scope (v2 candidate).

### 2.2 Scoring a prediction (identical for players and the model)

For each of the 10 predicted slots, compare with the official race classification:

| Outcome | Base points |
|---|---|
| Driver finished at the **exact predicted position** | **10** |
| Driver finished **±1 position** from prediction | **5** |
| Driver finished elsewhere **inside the top 10** | **2** |
| Driver finished outside the top 10 / not classified | 0 |

**The model as an opponent (calibrated entry).** The model does not play its
raw ML finishing order in the duel. Backtesting the scoring on 2025–2026
(`jobs/backtest.py`) showed the raw order is a weak opponent — a human who
simply copies the starting grid beats it most weekends, because grid position
is a very strong predictor of the finish and exact-position hits dominate the
score. So the model's duel entry is **calibrated**:

- Its position-probability matrix blends the ML Monte-Carlo probabilities with
  an empirical *P(finish | grid)* prior from past seasons (weight 0.25 on the
  ML signal — `jobs/grid_prior.py`, `jobs/model_bridge.py`).
- It plays the top 10 that **maximizes its own expected game score** under that
  calibrated matrix.

After calibration the model is a coin-flip-to-slight-favourite against a
grid-copying human (grid vs model went from 8-0-3 to 3-5-3 across 2026), so the
duel is winnable by *good* play but not by *lazy* play. A human beats it by
deviating from the favourites where they have a genuine read — and the rarity
multiplier pays exactly those correct deviations.

**Rarity multiplier** — applied to *exact-position* hits only. Let `p` be the
model's calibrated probability (frozen at lock time) that this driver finishes
at exactly that position:

| Model probability `p` | Multiplier |
|---|---|
| p ≥ 30 % | ×1 |
| 15 % ≤ p < 30 % | ×1.5 |
| 5 % ≤ p < 15 % | ×2 |
| p < 5 % | ×3 |

**Bonuses:**

| Bonus | Points |
|---|---|
| Exact podium (P1–P2–P3 all exact) | +15 |
| Perfect top 10 (all exact) | +100 |
| Correct Driver of the Day (players only, see §2.4) | +5 |
| Correct safety-car side bet (see §2.6) | +8 |

**There is no bonus for beating the model.** There used to be (+10 for a win,
+3 for a draw) and it was removed in 2026-08 with the standings rework in §2.5.
Once the season is *ranked* on the duel record, paying points for a win counts
the same thing twice: the win already moves you up the board, and the points
bonus then also inflates the margin that breaks ties between equal records. The
duel result is recorded as W/D/L and nothing else.

Maximum realistic GP score ≈ 130–250 pts depending on rarity; a typical decent
weekend lands around 40–70 pts.

**Edge cases:**
- Not-classified drivers (DNF/DSQ/DNS) count as outside the top 10.
- The official FIA classification at the time of scoring is final; later
  penalties do not retroactively change scores.
- If the model prediction is unavailable at lock (job failure), the fallback
  model entry is the starting grid order — the duel always happens.

### 2.3 Season-long championship picks

At signup (any point in the season), a player may pick the **Drivers' champion**
and the **Constructors' champion**. Picks lock at first submission and cannot be
changed. Payout at season end:

| Pick standing *at lock time* | Driver bonus | Constructor bonus |
|---|---|---|
| Current championship leader | +50 | +30 |
| Currently P2–P3 | +75 | +50 |
| Currently P4 or lower | +150 | +90 |

The bonus is **prorated by the fraction of the season remaining at lock**
(floor 20 %), so a mid-season pick is worth less than a round-1 pick and the
system works for a mid-season launch.

Since 2026-09 the call is the last step of onboarding (`/welcome`), after the
username and the private details — skippable with a "later" that returns after
thirty days, because a bet locked for the season should not be made under a
redirect. Until it is made, the owner's profile and `/game` both say so.

**Where the payout lands (decided 2026-08).** It is no longer added to the
season points column, because that column stopped being the ranking key (§2.5)
and a race board carrying a non-race bonus reads as a bug. `settle_season.py`
still computes and stores `season_picks.awarded_points` at season end; its
destination is the **season recap** — a year-in-review page in the spirit of a
music-service "wrapped", which replays what each player called back in the
spring against what actually happened, and pays the championship bonus there.
The recap is designed, not built: the season is at round 12 of 24 and it is a
season-end surface. Until it exists the pick is visible on the profile with
what it is on course for, exactly as today.

The champion picks also define the player's **profile theme** (team colors,
driver imagery) — see §4. The theme follows the pick, never the site red: the
picked driver's team colour, else a team-mate's, else the picked constructor's,
and only a neutral grey if the roster knows neither (`web/lib/teams.ts`).

### 2.4 Driver of the Day

Players may optionally vote for the official F1 "Driver of the Day" before race
start (+5 if correct). This is a deliberate human-only edge in the duel: the
model cannot vote. There is no official DotD API; since 2026-09 the scoring job
reads the winner from the "Driver of the Day" article formula1.com links on the
race's hub page (`jobs/dotd.py`), on every pass until it finds one, and the
bonus lands on that pass. When it can't — the site changed, a headline naming
two drivers — `jobs/set_dotd.py` enters it by hand, and nothing is guessed.

### 2.5 Standings & duels

- **Season leaderboard**: ranked on **the duel**, not on a points pile —
  `wins desc, margin desc, points desc`.

  - **wins** — Grands Prix where you outscored the model. A race you did not
    enter does not count, in either direction: your record is over the races
    you played, and `races played` is shown beside it so a full season reads
    as the achievement it is.
  - **margin** — the sum, over the races you played, of (your score − the
    model's score that weekend). The model sits at exactly 0 by construction,
    so it is the axis rather than a competitor.
  - **points** — the raw season total, kept as a column because it is what
    decides every duel, but no longer the ranking key.

  **Why it changed (2026-08).** Ranking on cumulative points makes the board a
  measure of how long you have been here. The model had played eleven Grands
  Prix and sat top with 402 points, and a player joining at round 12 opened the
  standings to find a machine in P1 and a 402-point deficit that no amount of
  good play could close. Ranking on the duel record fixes it at the root:
  everyone starts at 0 wins whenever they arrive, the deficit is expressed in
  weekends rather than points, and the board finally measures the thing the
  site promises on its front page.

  **The model is not a row in the standings.** It cannot duel itself, so it has
  no record and no rank. It appears above the board as the bar to clear — its
  season points and its average per race. Its per-race scores are unchanged and
  still shown on every race page.

- **Duel record vs the model**: W-D-L, shown prominently on profiles.
- **The model's season total is the operator's to set.** It plays every Grand
  Prix whether or not anyone else is on the platform, so at launch it would
  meet its first human with a full season of points already banked. Any race
  can be dropped from its season total (`model_entries.counts_in_standings`),
  which is how "the model starts from zero today" is expressed. This changes
  **only** the standings line: the race pages keep showing what it really
  scored that weekend, and every duel W/D/L stands. Players' totals are never
  touched this way — a player is removed or not, there is no half-counting.
  Operator commands: `jobs/admin.py model-reset | model-count-from N |
  model-restore`.
- **Leagues**: private groups joined via a unique 6-character code or, more
  usually, an invite link (`/join/<code>`) shared by message. A league is just
  a filtered leaderboard — all scoring is global. Members can leave; the owner
  can delete the league for everyone. Holding a code is the credential: any
  code resolves to its league's name, owner and size (`league_by_code()`), and
  nothing more.

### 2.6 Safety-car side bet

Alongside the top 10, each player may bet **Yes/No** on whether a safety car —
full **or** virtual (VSC) — will be deployed during the race. It locks at race
start with the rest of the prediction. A correct call is **+8** and counts
toward the duel total.

Unlike Driver of the Day, **the model bets too**, so this is a genuine part of
the head-to-head. The model has no live signal, so it plays the circuit's
historical rate (`jobs/safety_car.py`): street/high-incident circuits are near
certain, smooth permanent tracks less so; it bets Yes at ≥ 50 %. A human beats
it by reading the specific weekend — weather, grid tension, rookies — the way
the rarity multiplier rewards reading a specific race.

The outcome is detected automatically from the official race-control messages,
read through OpenF1 (`src/openf1.py::safety_car`, via
`jobs/model_bridge.py::safety_car_occurred`) — the timing host itself refuses
GitHub Actions, which is how every race of 2026 went unsettled until 2026-09.
If it can't be determined at scoring time, no one is awarded the bonus (neither
player nor model) and the next pass asks again.

### 2.7 The two emails (added 2026-08)

The game's rhythm is weekly, and until now the product had **no outbound voice
at all**: a player who forgot a Sunday took a zero, was never told, and did not
come back. That is the classic failure mode of a prediction game, and no amount
of on-site polish fixes it.

Exactly two emails per Grand Prix, and never any others:

| When | Trigger | Content |
| --- | --- | --- |
| Saturday evening | `lock-race`, once qualifying is done and the model's entry exists | The model has played its hand. Either "you haven't picked yet" or "yours is in, you can still edit until lights out". |
| Monday | `score-race`, after the scores are written | Your score, the model's, the margin, and the verdict. Only to players who entered. |

Rules that make this safe to run unattended:

- **Idempotent by construction.** `email_log(race_id, user_id, kind)` is written
  after each successful send and `email_recipients()` excludes anyone already
  logged. `score-race` re-runs hourly for ten days; without the log that is ten
  days of hourly mail to every player.
- **Opt-out, with a one-click way out.** `profiles.email_opt_out`, plus a random
  `unsubscribe_token` so `/unsubscribe/<token>` works from a mail client with no
  session. The page shows a **button**: a link that opts you out on GET would
  opt out everyone whose employer scans their inbox.
- **Unconfigured is a no-op.** Without `RESEND_API_KEY` the send is logged and
  skipped; the jobs behave exactly as they did before.
- **A failed send is never marked sent**, so the next hourly run retries it.
- **The nudge is gated on the model's entry actually landing.** Its whole claim
  is that the model has played its hand; `lock_race.py` sends it only when
  `refresh_entry()` returns true, so a weekend where the model was unavailable
  produces no mail rather than a false one.

**Sending one by hand.** The schedule is not the only way out. `send_mail.py`
sends either email for any round on demand — same templates, same recipients,
same log — and the **send-mail** workflow exposes it in the Actions tab for an
operator with no terminal. `--dry-run` lists the recipients and sends nothing;
`--to` restricts to one address; `--force` clears the log for that race and
kind so players who already had it get it again. Everything else about the
mail is identical, deliberately: an override that behaves differently from the
real thing is an override that proves nothing.

---

## 3. Architecture

**Decisions (2026-07-27):** Vercel frontend + Flask API on Render · lock at race
start · UI in English · all-free hosting.

```
┌─────────────────────────┐     ┌──────────────────────────┐
│  web/  (Next.js, Vercel)│     │ Flask model app (Render) │
│  home + game UI          │────▶│ existing prediction page  │
│  talks to Supabase       │link │ + /api/* live endpoints   │
└───────────┬─────────────┘     └──────────▲───────────────┘
            │ supabase-js (auth + data)     │ runs the model on demand
┌───────────▼─────────────┐     ┌──────────┴───────────────┐
│  Supabase (free tier)    │◀────│ GitHub Actions (free)     │
│  Postgres + Auth + RLS   │write│ jobs/: lock model preds,  │
│  all game state          │     │ score races post-GP       │
└─────────────────────────┘     └──────────────────────────┘
```

- **`web/` — Next.js (App Router, TypeScript, Tailwind) on Vercel.** Home page,
  entire game UI, auth via Supabase (magic link + Google OAuth). Never affected
  by Render cold starts.
- **Flask app on Render free tier** — the existing model page, unchanged. The
  home page CTA links to it (later: `model.` subdomain or Vercel rewrite).
  UptimeRobot ping mitigates the 15-min sleep.
- **Supabase free tier** — Postgres, Auth, Row Level Security. The game state
  lives here and is *never* computed by the Flask server, so the game does not
  depend on Render availability.
- **GitHub Actions** — the model's "player agent". Two scheduled workflows (see
  §6) run the Python model headlessly and write to Supabase via service key.

**Why the game does not call the Flask API:** free-tier servers sleep and jobs
must run even if no one visits. Locking and scoring are batch jobs with strict
timing — GitHub Actions cron + Supabase is deterministic and free.

---

## 4. Site map (`web/`)

| Route | Content |
|---|---|
| `/` | Hero (full-bleed high-quality F1 photo, headline, 2 CTAs: **Play the duel** / **Explore the model**), scroll sections explaining the game and the model, footer. |
| `/game` | Dashboard: next GP countdown, prediction editor (ordered top 10 + DotD pick — drag the grip, or press and hold a row on touch), current duel status, season summary strip. |
| `/game/races/[round]` | Duel review: player vs model vs actual, side-by-side. Tapping a position explains that row in words — base points, the driver's actual finish, and the rarity multiplier with the model's own probability — and two receipts underneath account for every point in both totals. **Export poster**: a 1080×1350 sheet of the race (your call vs the official result, stats band, finish line) as PNG/PDF/share, with the model's column and the duel verdict optional. |
| `/game/standings` | Global leaderboard + duel records, and **the leagues page too**: the filter switches Global ↔ one of your leagues, and picking a league also brings up its code, invite link (Web Share / copy) and leave-or-delete. Create / join a league by code or invite link happens from the same row. Below the board, one card per scored Grand Prix with your score and the duel verdict. |
| `/game/leagues` | Redirect to `/game/standings` — kept alive for links players already sent each other. |
| `/join/<code>` | The far end of an invite link: shows the league, its owner and its size, then joins — signing in first if needed. |
| `/profile/[username]` | The player's page, themed end to end by their championship pick: a team-coloured cover, the picked driver's portrait as the avatar, the name large, then season points / duel record / races / best race. Below: the **championship call** (driver portrait + constructor wordmark + what the bonus is on course for), **recent form** (last five duels as W/D/L pills), the **season curve** (your running total against the model's), and the full duel history. Owner only: one **Edit profile** panel (username + private details), sign out, and delete the account (`delete_account()`, cascades to everything including leagues you own). |
| `/model` | The opponent, explained **and shown**: the pipeline, the 39 features, why the fight is fair — and the model's actual position-probability matrix for the last Grand Prix it played, drawn as a heat map whose colour bands are the rarity-multiplier tiers of §2.2. Links out to the Flask platform only when `NEXT_PUBLIC_MODEL_URL` is set. |
| `/contact` | Contact & FAQ: how to report a bug or suggest a feature (issue tracker + optional mailbox), the questions players actually ask, and the credits. |
| `/login` | Supabase auth (magic link + Google). |

Design language: dark, premium motorsport aesthetic consistent with the existing
model page (reuse its palette and typography so the two apps feel like one
product).

---

## 5. Data model (Supabase / Postgres)

```
profiles          id (= auth.users.id), username UNIQUE, created_at
races             id, season, round, name, circuit, country,
                  quali_at, race_at, status ∈ {scheduled, locked, scored}
model_entries     race_id PK→races, predicted_order jsonb (10 codes),
                  prob_matrix jsonb (driver × position probabilities),
                  sc_prob numeric, sc_bet bool, locked_at
predictions       id, user_id→profiles, race_id→races, picks jsonb (10 codes),
                  dotd text NULL, sc_bet bool NULL, updated_at,
                  UNIQUE(user_id, race_id)
results           race_id PK→races, classification jsonb, dotd text NULL,
                  safety_car bool NULL, scored_at
scores            race_id, user_id NULL = the model, total numeric,
                  breakdown jsonb, beat_model bool, PK(race_id, user_id)
season_picks      user_id, season, champion_driver, champion_team,
                  locked_at, driver_tier, team_tier, prorate numeric
leagues           id, name, code CHAR(6) UNIQUE, owner_id
league_members    league_id, user_id, joined_at
```

**Row Level Security (the fair-play layer):**
- `predictions`: a user can INSERT/UPDATE only their own row and only while
  `races.status = 'scheduled'` AND `now() < races.race_at`. SELECT own rows
  always; others' rows only when the race is locked or scored.
- `scores`, `results`, `model_entries`, `races`: public read, service-role write.
- `season_picks`: insert-only by owner (no update — locked by design).

---

## 6. Automated jobs (`jobs/` + `.github/workflows/`)

1. **`sync-schedule`** (weekly): upserts the season calendar into `races` from
   FastF1.
2. **`lock-race`** (hourly during race weekends): once qualifying results exist
   and the race hasn't started → run the model (`jobs/model_bridge.py`), upsert
   `model_entries` (calibrated order + probability matrix, see §2.2). At
   `race_at`, set `races.status = 'locked'`.
3. **`score-race`** (hourly Sun–Tue): for locked races whose classification is
   available via FastF1 → write `results`, compute `scores` for every prediction
   and the model with the §2.2 formula, settle each duel (W/D/L, no bonus), set
   `status = 'scored'`. Re-runs are idempotent (DotD entered late is picked up
   by the next pass).

All jobs are plain Python scripts in `jobs/`, runnable locally with the same
env vars (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`) — GitHub Actions is just the
scheduler.

---

## 7. Repository layout & git workflow

```
f1-duel/
  src/        ML pipeline + Flask model app (existing, unchanged)
  webapp/     model page frontend (existing, unchanged)
  models/     trained artifacts
  data/       datasets + caches
  web/        Next.js site — home + game (Vercel)
  jobs/       lock/score/sync scripts (GitHub Actions)
  supabase/   schema.sql, RLS policies, seed
  docs/       this document
  .github/workflows/
```

Workflow: `main` is the single source of truth. The historical `model` branch is
merged into `main` and retired. All new work happens on short-lived feature
branches (`feat/…`, `fix/…`) merged via PR. Model work and game work are
separated by *directory*, not by long-lived branches.

---

## 8. Build phases

| Phase | Deliverable |
|---|---|
| **0 — Foundation** | Merge `model` → `main`, repo layout above, this doc. |
| **1 — Backbone** | Supabase schema + RLS; `jobs/` scripts validated against past 2026 races (backtest the scoring on real data). |
| **2 — Site core** | Next.js app: home page (hero, sections, footer), auth, prediction editor for the next GP. |
| **3 — The duel** | Scoring display, race-by-race duel review, season standings, profile with team theming. |
| **4 — Extras** | Leagues by code, DotD voting, championship picks flow, polish pass. |
| **5 — Launch** | Vercel + Render + Actions in production, custom domain if desired. |
