# Running the database — every action, and the exact command

The practical companion to the Almanac: **"I want to do X, what do I type?"**
Organised by the thing you want to do, not by the tool it lives in.

Nothing here needs you to remember the schema. If you want to know *why* a
thing works the way it does, [`ALMANAC.md`](ALMANAC.md) §7 (database) and §8
(jobs) explain it; [`../supabase/README.md`](../supabase/README.md) is the
security model.

> **Golden rule:** the jobs own the game state. Prefer a command over hand-written
> SQL, and prefer hand-written SQL over the table editor — see
> [§9 What not to do](#9-what-not-to-do) for the four ways to break something
> quietly.

---

## Table of contents

1. [Getting in](#1-getting-in)
2. [The model's season score](#2-the-models-season-score)
3. [Players](#3-players)
4. [Someone asks what you hold on them (GDPR)](#4-someone-asks-what-you-hold-on-them-gdpr)
5. [Calendar and roster](#5-calendar-and-roster)
6. [A race weekend that went wrong](#6-a-race-weekend-that-went-wrong)
7. [Leagues](#7-leagues)
8. [End of season](#8-end-of-season)
9. [What not to do](#9-what-not-to-do)
10. [Is anything broken? (health checks)](#10-is-anything-broken-health-checks)
11. [Reversible or not — the cheat sheet](#11-reversible-or-not--the-cheat-sheet)

---

## 1. Getting in

There are two doors, and they do the same things.

### The SQL editor (no setup)

Supabase dashboard → **SQL editor**. It runs as the database owner, so every
function in this guide is available. Best for one-off questions and for
anything you want to read before you change.

### The terminal (better for the repeatable jobs)

The scripts in `jobs/` read two variables from your shell — they do **not** read
`.env` files:

```bash
export SUPABASE_URL=https://rkavhmvtstzcrciebsqu.supabase.co
export SUPABASE_SERVICE_KEY=<service_role secret>   # Dashboard → Settings → API
```

The service_role key bypasses every security rule in the database. Keep it out
of the repo, out of screenshots, and out of anything that reaches a browser. If
it ever leaks, rotate it in the dashboard immediately.

To avoid re-exporting it every time, keep it in a file **outside** the repo and
source it:

```bash
echo 'export SUPABASE_URL=https://rkavhmvtstzcrciebsqu.supabase.co' >> ~/.f1duel-env
echo 'export SUPABASE_SERVICE_KEY=...'                              >> ~/.f1duel-env
chmod 600 ~/.f1duel-env

source ~/.f1duel-env            # once per terminal session
python jobs/admin.py players    # now this works
```

### Which migrations are applied?

Run in the SQL editor. Every migration in `supabase/migrations/` should show up:

```sql
-- 0006 (operator controls) — should return 6 rows
select proname from pg_proc where proname like 'admin\_%' order by 1;

-- the flag 0006 adds — should return one row
select column_name from information_schema.columns
 where table_name = 'model_entries' and column_name = 'counts_in_standings';

-- older ones
select proname from pg_proc where proname like 'standings%';   -- 0004
select to_regclass('public.player_details');                   -- 0003
```

**Status:** `0001`, `0005` and `0006` are confirmed applied (0006 on
2026-08-11). `0002`–`0004` have never been formally confirmed — the site
behaves as though they are (usernames, private details and paged standings all
work in production), and the queries above settle it in ten seconds.

---

## 2. The model's season score

The model plays every Grand Prix whether or not anyone else is on the platform,
so it collects points from round 1 with nobody watching. `counts_in_standings`
decides whether a race feeds its **season total** on the standings.

**A reset is not a rewrite.** Race pages still show what the model actually
scored that weekend, every duel W/D/L stands, and no player's points move. Only
the model's line on the standings changes — and it prints how many races that
total is made of, so a zero is explainable rather than mysterious.

| I want to… | Terminal | SQL editor |
| --- | --- | --- |
| See what counts, round by round | `python jobs/admin.py model-status` | `select * from admin_model_status(2026);` |
| Put the model on **zero**, from now on | `python jobs/admin.py model-reset` | `select admin_model_reset(2026);` |
| Start the season at round N | `python jobs/admin.py model-count-from 15` | `select admin_model_count_from(2026, 15);` |
| Undo — count the whole season again | `python jobs/admin.py model-restore` | `select admin_model_restore(2026);` |
| Just read the total | — | `select model_season_points(2026), model_season_races(2026);` |

`--season` defaults to the current year and works on either side of the verb
(`admin.py --season 2025 model-status` and `admin.py model-status --season 2025`
are the same). Every write asks for confirmation; `--yes` skips it.

**When you'd use this:** on launch day. Reset drops the races the model has
already been scored on and it starts collecting again at the next Grand Prix, so
the first person to sign up isn't chasing a machine that is 400 points up. It is
fully reversible with `model-restore`.

*As of now: nothing has been run — the model still carries its whole season.*

---

## 3. Players

```bash
python jobs/admin.py players            # everyone: username, email, races, points, joined
```

```sql
select * from admin_players();          -- the same thing in the SQL editor
```

Finding one person:

```sql
select id, username, username_set, created_at
  from public.profiles
 where lower(username) = lower('someuser');
```

### Deleting a player

```bash
python jobs/admin.py delete-player someuser     # retypes the name to confirm
```

```sql
select admin_delete_player('someuser');         -- same call, no second chance
```

This deletes their auth user, and the foreign keys take everything else:
profile, private details, every prediction and score, the championship pick,
league membership, **and any league they own — which disappears for its members
too**. There is no undo and no backup unless you took one.

It raises an error if the username doesn't exist, so a typo can never delete
somebody else. Players can also do this themselves from their profile page.

### Renaming a player

Don't do it by hand — the username has a format check *and* a case-insensitive
uniqueness index, and players can rename themselves from their profile. If you
really must:

```sql
update public.profiles set username = 'newname' where username = 'oldname';
```

---

## 4. Someone asks what you hold on them (GDPR)

Real names, countries and birth years live in `player_details`, which no other
player can read. Collecting them makes you a data controller; these are the two
queries that answer the two questions people are entitled to ask.

**Everything you hold on one person:**

```sql
select p.username, p.created_at,
       d.first_name, d.last_name, d.country, d.birth_year,
       (select count(*) from public.predictions   x where x.user_id = p.id) as predictions,
       (select count(*) from public.scores        x where x.user_id = p.id) as scored_races,
       (select count(*) from public.league_members x where x.user_id = p.id) as leagues
  from public.profiles p
  left join public.player_details d on d.id = p.id
 where lower(p.username) = lower('someuser');
```

Their email lives in `auth.users` (dashboard → Authentication → Users, or
`select * from admin_players();`).

**Erase them:** `python jobs/admin.py delete-player someuser` — §3.

**Everyone who is playing, with the details:**

```sql
select p.username, d.first_name, d.last_name, d.country, d.birth_year, d.created_at
  from public.player_details d
  join public.profiles p on p.id = d.id
 order by d.created_at desc;
```

---

## 5. Calendar and roster

```bash
python jobs/sync_schedule.py 2026        # calendar → races, roster → drivers
```

Runs weekly on its own (Monday, `sync-schedule` workflow). Run it by hand after
a calendar change, when a new season opens, or when the roster is missing data.
It never touches `races.status`, so it is safe at any point in a weekend.

**Check what it produced:**

```sql
select round, name, circuit, status, race_at
  from public.races where season = 2026 order by round;

select driver_id, code, full_name, team, team_color, active
  from public.drivers where season = 2026 order by team, driver_id;
```

**If `team_color` is null** for everyone: FastF1 has no session data for the
season yet. The site paints from its own table of constructor colours
(`web/lib/teams.ts`) until then, so nothing looks broken — re-run the sync once
FastF1 has published a session and the real values land.

**New season checklist:** run the sync for the new year, then set
`NEXT_PUBLIC_SEASON` on Vercel to match.

---

## 6. A race weekend that went wrong

The normal path needs nothing from you: `lock-race` runs hourly Fri–Sun and
`score-race` hourly Sun–Tue. Both are idempotent — running them again is always
safe.

**Run a job now** (either works):

- GitHub → **Actions** tab → the workflow → **Run workflow**
- `python jobs/lock_race.py` / `python jobs/score_race.py`

### The race is finished but nobody has been scored

`score_race` refuses in a few specific cases and each prints its own line in the
job log:

| Log line | Meaning | Fix |
| --- | --- | --- |
| *no official classification yet* | Neither Ergast nor OpenF1 has it yet (OpenF1 usually within the hour of the flag; an `openf1: …` line above it says why if OpenF1 refused) | Wait; it retries every 15 min on Sun/Mon, hourly otherwise |
| *no model entry — run lock_race first* | The race locked without the model playing | `lock-race` backfills it on its next run; see below to hurry it |
| *refusing to score a partial field* | The read and the server row count disagree | Re-run; if it persists, stop and investigate — never force it |

Nothing happens at all until `race_at + 2h`.

### A race locked with no model entry

`lock-race` only scans `scheduled` races, so it will never retry on its own.
Push the race back one step and let the jobs redo it properly:

```sql
update public.races set status = 'scheduled'
 where season = 2026 and round = 13;
```

then run **lock-race**, then **score-race**.

### Re-score a race

Scores are recalculated automatically for **10 days** after the race, so a
correction usually needs nothing. Outside that window:

```sql
update public.races set status = 'locked'
 where season = 2026 and round = 13;
```

then run **score-race**. Re-scoring overwrites the model's entry total, every
player's score and the result row — it does **not** touch
`counts_in_standings` (§2), so an operator choice survives a re-score.

### Driver of the Day

There is no official API. `score_race` reads it itself from the article
formula1.com links on the race hub (`jobs/dotd.py`), on every pass until it
finds one — usually within the hour of the flag. When the log says *no unique
roster match*, or nothing at all about dotd for days, enter it by hand; it
re-scores the race immediately, so the +5 lands right away:

```bash
python jobs/set_dotd.py 2026 13 max_verstappen
```

The `driver_id` is validated against the season roster — check the spelling with
the roster query in §5. A hand-entered DotD is kept: the automatic read only
fills a null.

### Re-score a race, any race

```bash
python jobs/score_race.py --rounds 13              # one
python jobs/score_race.py --rounds 1-13 --dry-run  # all, printed, nothing written
```

Or Actions → **score-race** → *Run workflow* with `rounds` filled in. This is
how the safety-car bet was settled retroactively for the whole of 2026 on
2026-09-06. Result mails are not re-sent (`email_log`), points and standings
move.

### The safety-car flag is wrong

Don't fix it in SQL. `results.safety_car` is **recomputed from OpenF1's race
control every time a race is scored**, so an edit by hand changes nothing
anybody sees and vanishes on the next re-score. Null means race control had
published nothing when the race was scored — the ten-day window asks again,
`--rounds` asks now. If the flag is genuinely wrong, the bug is in
`openf1.safety_car()` (`src/openf1.py`) or in the upstream data.

---

## 7. Leagues

```sql
-- every league, with its owner and size
select l.id, l.name, l.code, p.username as owner,
       (select count(*) from public.league_members m where m.league_id = l.id) as members,
       l.created_at
  from public.leagues l
  join public.profiles p on p.id = l.owner_id
 order by l.created_at desc;

-- who is in one
select p.username, m.joined_at
  from public.league_members m
  join public.profiles p on p.id = m.user_id
 where m.league_id = 42 order by m.joined_at;

-- delete a league (members lose the board, keep every point)
delete from public.leagues where id = 42;
```

A league is only a filter over the same global scoring, so deleting one never
costs anybody points. Owners can delete their own from the standings page.

---

## 8. End of season

Once, in December, after the final race is scored:

```bash
python jobs/settle_season.py 2026
```

It reads the final championship standings, works out each pick's bonus from the
tier it was worth **at lock time** and the fraction of season remaining, and
writes `season_picks.awarded_points` — which the leaderboard adds to every
total. Safe to re-run; it recomputes rather than accumulates.

Check it landed:

```sql
select p.username, s.champion_driver, s.champion_team, s.awarded_points
  from public.season_picks s
  join public.profiles p on p.id = s.user_id
 where s.season = 2026 order by s.awarded_points desc nulls last;
```

---

## 9. What not to do

Four ways to break something quietly:

1. **Don't edit `scores` by hand.** The `breakdown` JSON has to add up to
   `total` — the race page prints both as receipts — and `score_race` will
   overwrite your edit anyway within the 10-day window. Fix the input and
   re-score (§6).
2. **Don't delete from `profiles` directly.** That leaves an orphan in
   `auth.users` who can still sign in but has no profile. Use
   `admin_delete_player()` (§3), which removes the auth user and lets the
   cascade do the rest.
3. **Don't set `races.status = 'scored'` by hand.** The status is what the
   fair-play rules hang off (predictions stay private while a race is
   `scheduled`). Marking a race scored without running the job hides everyone's
   predictions behind a race that has no scores.
4. **Don't hand-write model entries.** `predicted_order` and `prob_matrix` are
   produced together, and the rarity multipliers come from that matrix — an
   entry with an empty matrix silently scores every position at ×1.

And the obvious one: the service_role key bypasses every security rule. Anything
you run with it is unaudited and unguarded.

---

## 10. Is anything broken? (health checks)

```sql
-- the project is awake and the season is seeded
select count(*) as races, count(*) filter (where status = 'scored') as scored
  from public.races where season = 2026;

-- how many people are actually playing
select count(*) from public.profiles;

-- this weekend: is the model in?
select r.round, r.name, r.status, m.pre_quali, m.total, m.counts_in_standings
  from public.races r
  left join public.model_entries m on m.race_id = r.id
 where r.season = 2026 order by r.round desc limit 5;

-- predictions for the next race
select count(*) from public.predictions
 where race_id = (select id from public.races
                   where season = 2026 and status = 'scheduled'
                   order by race_at limit 1);
```

From the terminal, `python jobs/admin.py model-status` answers most of the same
questions in one table.

**If the site is down entirely,** the two usual causes are neither of them SQL:
Supabase pauses a free project after 7 days with no request (un-pause it in the
dashboard — nothing automated can), and GitHub disables scheduled workflows
after 60 days with no commits (the monthly `keepalive` workflow exists to stop
both; run it by hand from the Actions tab if the crons have gone quiet).

---

## 11. Reversible or not — the cheat sheet

| Action | Reversible? |
| --- | --- |
| `admin_model_reset` / `count_from` | ✅ `model-restore` puts every race back |
| Re-running any job | ✅ they are all idempotent |
| `sync_schedule.py` | ✅ upserts; never touches race status |
| `settle_season.py` | ✅ recomputes from scratch |
| `set_dotd.py` | ✅ run it again with the right driver |
| Setting a race back to `scheduled` / `locked` | ✅ the jobs redo the work |
| Deleting a league | ⚠️ gone, but no points are lost |
| `admin_delete_player` | ❌ **permanent** — account, predictions, scores, picks, and any league they own |
| Rotating the service key | ⚠️ update the GitHub Actions secrets or every job stops |
