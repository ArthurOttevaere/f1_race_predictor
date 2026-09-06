import Link from "next/link";
import Arrow from "@/components/Arrow";
import { createClient, getUser } from "@/lib/supabase/server";
import { getOwnProfile } from "@/lib/auth";
import { CURRENT_SEASON } from "@/lib/constants";
import { formatPoints, formatRaceDate, formatRaceTime } from "@/lib/format";
import type { Driver, LeaderboardRow, ModelEntry, Race, Score } from "@/lib/types";
import Countdown from "@/components/Countdown";
import PredictionEditor from "@/components/PredictionEditor";
import SeasonOver from "@/components/SeasonOver";
import { modelEntries, modelSeason } from "@/lib/model";
import { fieldLine, fieldSummary, type FieldSummary } from "@/lib/duels";

export const metadata = { title: "This weekend" };
export const revalidate = 60;

export default async function GamePage() {
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  const user = await getUser();

  const { data: nextRaces } = await supabase
    .from("races")
    .select("*")
    .eq("season", CURRENT_SEASON)
    .eq("status", "scheduled")
    .gt("race_at", nowIso)
    .order("race_at", { ascending: true })
    .limit(1);
  const race = (nextRaces?.[0] as Race | undefined) ?? null;

  // ── No race to play: the end of the season, not an empty state (D-2) ──
  // Everything below is read only on this branch, so the weekly page pays
  // nothing for it.
  if (!race) {
    const [{ data: seasonRaces }, entries, { data: board }] = await Promise.all([
      supabase
        .from("races")
        .select("id, status")
        .eq("season", CURRENT_SEASON),
      modelEntries(supabase),
      supabase.rpc("standings_page", {
        p_league_id: null,
        p_limit: 3,
        p_offset: 0,
      }),
    ]);

    const seasonRows = (seasonRaces as Pick<Race, "id" | "status">[]) ?? [];
    const seasonIds = new Set(seasonRows.map((r) => r.id));
    const racesScored = seasonRows.filter((r) => r.status === "scored").length;
    const podium = (board as LeaderboardRow[]) ?? [];

    // The viewer's own season, counted from their own rows rather than by
    // paging the board looking for themselves — that read is capped at a
    // thousand players and a season is at most two dozen scores.
    const [{ data: myScores }, profile] = user
      ? await Promise.all([
          supabase
            .from("scores")
            .select("race_id, total, beat_model, drew_model")
            .eq("user_id", user.id),
          getOwnProfile(),
        ])
      : [{ data: null }, null];

    const mine = (
      (myScores as Pick<Score, "race_id" | "total" | "beat_model" | "drew_model">[]) ??
      []
    ).filter((r) => seasonIds.has(r.race_id));

    // Whatever the calendar holds next, even if it belongs to another season:
    // between seasons that clock is the only thing on the page facing
    // forwards.
    const { data: upcoming } = await supabase
      .from("races")
      .select("name, race_at, season")
      .eq("status", "scheduled")
      .gt("race_at", nowIso)
      .order("race_at", { ascending: true })
      .limit(1);
    const next = (upcoming?.[0] as Pick<Race, "name" | "race_at" | "season"> | undefined) ?? null;

    return (
      <SeasonOver
        season={CURRENT_SEASON}
        racesScored={racesScored}
        model={modelSeason(entries, seasonIds)}
        podium={podium}
        mine={
          mine.length > 0
            ? {
                username: profile?.username ?? null,
                won: mine.filter((r) => r.beat_model).length,
                drawn: mine.filter((r) => r.drew_model).length,
                lost: mine.filter((r) => !r.beat_model && !r.drew_model).length,
                points: mine.reduce((sum, r) => sum + Number(r.total), 0),
              }
            : null
        }
        nextRace={next}
      />
    );
  }

  const [
    { data: roster },
    { data: entry },
    predictionRes,
    lastScoredRes,
    seasonPickRes,
  ] = await Promise.all([
    supabase
      .from("drivers")
      .select("*")
      .eq("season", race.season)
      .eq("active", true)
      .order("team"),
    // The view, not the table: since migration 0009 the model's entry for a
    // race that is still open is unreadable through the anon key — picks,
    // matrix and safety-car bet alike. `model_entry_status` publishes the part
    // that was never secret, which is whether it has filed and in which mode.
    supabase
      .from("model_entry_status")
      .select("race_id, pre_quali, locked_at")
      .eq("race_id", race.id)
      .maybeSingle(),
    user
      ? supabase
          .from("predictions")
          .select("picks, dotd, sc_bet")
          .eq("race_id", race.id)
          .eq("user_id", user.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("races")
      .select("*")
      .eq("season", CURRENT_SEASON)
      .eq("status", "scored")
      .order("round", { ascending: false })
      .limit(1),
    user
      ? supabase
          .from("season_picks")
          .select("season")
          .eq("user_id", user.id)
          .eq("season", CURRENT_SEASON)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const prediction = predictionRes.data as {
    picks: string[];
    dotd: string | null;
    sc_bet: boolean | null;
  } | null;
  const lastScored = (lastScoredRes.data?.[0] as Race | undefined) ?? null;

  let lastDuel: {
    race: Race;
    score: Score | null;
    model: number | null;
    field: FieldSummary | undefined;
  } | null = null;
  // The order the model played *last* time out — what a signed-out visitor
  // sees behind the sign-in veil (see `previewOrder` below). Safe to read here
  // and nowhere else on this page: that race is over.
  let lastModelOrder: string[] | null = null;
  if (lastScored) {
    const [scoreRes, modelRes, field] = await Promise.all([
      user
        ? supabase
            .from("scores")
            .select("*")
            .eq("race_id", lastScored.id)
            .eq("user_id", user.id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("model_entries")
        .select(user ? "total" : "total, predicted_order")
        .eq("race_id", lastScored.id)
        .maybeSingle(),
      fieldSummary(supabase, CURRENT_SEASON),
    ]);
    const model = modelRes.data as Pick<
      ModelEntry,
      "total" | "predicted_order"
    > | null;
    lastDuel = {
      race: lastScored,
      score: (scoreRes.data as Score | null) ?? null,
      model: model?.total ?? null,
      field: field.get(lastScored.id),
    };
    lastModelOrder = model?.predicted_order ?? null;
  }

  // eslint-disable-next-line react-hooks/purity -- server render: "now" is the request time
  const raceOpen = new Date(race.race_at ?? 0).getTime() > Date.now();
  const needsPicks = Boolean(user) && !seasonPickRes.data;

  // What a signed-out visitor sees behind the sign-in veil. The editor used to
  // be veiled over an *empty* form, so the one screen where the game actually
  // happens showed a grey rectangle to everyone who had not signed up yet.
  //
  // It is the **last scored race's** model order, never this weekend's, and
  // that restriction is the whole design: this page deliberately never reads
  // `predicted_order` for the upcoming race, because that would hand the
  // model's picks to anyone who signs out before the lock. A finished race
  // gives the same "here is what a real entry looks like" for free.
  // Drivers who have since left the grid are dropped rather than left as holes
  // in the preview: the roster read here is the *active* one.
  const activeIds = new Set(
    ((roster as Driver[]) ?? []).map((d) => d.driver_id),
  );
  const previewEntry =
    !user && lastModelOrder && lastScored
      ? {
          order: lastModelOrder.filter((id) => activeIds.has(id)).slice(0, 10),
          raceName: lastScored.name,
        }
      : null;

  return (
    <div className="flex flex-col gap-6">
      {needsPicks && (
        <Link
          href="/game/picks"
          className="pressable glass-chip group flex items-center justify-between gap-4 rounded-panel border-race/30 px-5 py-3 text-sm transition-colors hover:border-race/60"
        >
          <span>
            🏆 Call your {CURRENT_SEASON} world champions — one shot, big
            season-end bonus
          </span>
          <span className="flex shrink-0 items-center gap-2 font-semibold text-race">
            Make your picks
            <Arrow />
          </span>
        </Link>
      )}
      {/* ── Race header ── */}
      <section className="glass-card flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-mono text-xs tracking-[0.2em] text-race uppercase">
            Round {race.round} · {race.country}
          </p>
          <h1 className="display mt-1 text-2xl font-extrabold tracking-tight">
            {race.name}
          </h1>
          <p className="mt-1 text-sm text-ink-dim">
            {race.circuit} · {formatRaceDate(race.race_at)} ·{" "}
            {formatRaceTime(race.race_at)}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          {race.race_at && (
            <Countdown to={race.race_at} label="Predictions lock in" />
          )}
          <p
            className={`glass-chip rounded-control px-3 py-1 text-xs ${
              entry ? "text-ink-dim" : "text-ink-mute"
            }`}
          >
            {entry
              ? `Model entry is in ${entry.pre_quali ? "(pre-quali)" : "(post-quali)"}`
              : "Model enters after qualifying"}
          </p>
        </div>
      </section>

      {/* ── Last duel ──
          One line of grey used to sit here — "Last duel · Italian Grand Prix
          — See the breakdown" — the same weight as a footnote, for the one
          result on the page that is *yours*. It is a card now: the verdict in
          the tone the site uses for it everywhere, the two totals at timing-
          tower size, and for somebody who sat the race out, what the model
          did and how many of the others beat it — the bar they are about to
          be measured against. */}
      {lastDuel && (
        <Link
          href={`/game/races/${lastDuel.race.round}`}
          className={`pressable glass-card group flex flex-col gap-4 p-5 transition-colors sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-6 ${
            lastDuel.score
              ? lastDuel.score.beat_model
                ? "border-emerald-400/40 hover:border-emerald-400/70"
                : lastDuel.score.drew_model
                  ? "border-amber-300/40 hover:border-amber-300/70"
                  : "border-race/40 hover:border-race/70"
              : "hover:border-line-hi"
          }`}
        >
          <div className="min-w-0">
            <p className="font-mono text-xs tracking-[0.2em] text-ink-mute uppercase">
              Last duel · Round {lastDuel.race.round}
            </p>
            <p className="display mt-1 truncate text-lg font-extrabold tracking-tight">
              {lastDuel.score
                ? lastDuel.score.beat_model
                  ? `You beat the model at the ${lastDuel.race.name}`
                  : lastDuel.score.drew_model
                    ? `Dead heat at the ${lastDuel.race.name}`
                    : `The model took the ${lastDuel.race.name}`
                : user
                  ? `The ${lastDuel.race.name}, without you`
                  : `The ${lastDuel.race.name}, as the model played it`}
            </p>
            <p className="mt-1 text-sm text-ink-dim">
              {lastDuel.score ? (
                fieldLine(lastDuel.field) ? (
                  <>
                    The model was {fieldLine(lastDuel.field)!.toLowerCase()}.
                  </>
                ) : null
              ) : (
                <>
                  The model scored {formatPoints(lastDuel.model ?? 0)}
                  {fieldLine(lastDuel.field) && (
                    <> and was {fieldLine(lastDuel.field)!.toLowerCase()}</>
                  )}
                  . See how they did it.
                </>
              )}
            </p>
          </div>

          {lastDuel.score ? (
            <div className="flex shrink-0 items-baseline gap-3 font-mono">
              <span className="text-3xl font-semibold tabular-nums">
                {formatPoints(lastDuel.score.total)}
              </span>
              <span className="text-ink-mute">–</span>
              <span className="text-3xl font-semibold text-ink-dim tabular-nums">
                {formatPoints(lastDuel.model ?? 0)}
              </span>
              <span
                className={`ml-1 text-sm font-semibold ${
                  lastDuel.score.beat_model
                    ? "text-emerald-400"
                    : lastDuel.score.drew_model
                      ? "text-amber-300"
                      : "text-race"
                }`}
              >
                {lastDuel.score.beat_model
                  ? "W"
                  : lastDuel.score.drew_model
                    ? "D"
                    : "L"}
              </span>
            </div>
          ) : (
            <span className="flex shrink-0 items-center gap-2 text-sm font-semibold text-ink-dim transition-colors group-hover:text-ink">
              See the breakdown
              <Arrow />
            </span>
          )}
        </Link>
      )}

      {/* ── Editor ── */}
      <section className="glass-card p-6">
        <PredictionEditor
          race={race}
          roster={(roster as Driver[]) ?? []}
          initialPicks={prediction?.picks ?? []}
          initialDotd={prediction?.dotd ?? null}
          initialScBet={prediction?.sc_bet ?? null}
          canPlay={Boolean(user) && raceOpen}
          signedIn={Boolean(user)}
          previewEntry={previewEntry}
        />
      </section>

      <p className="text-xs leading-relaxed text-ink-mute">
        Scoring: 10 pts exact position (×1.5–×3 the less the model believed in
        it), 5 pts one off, 2 pts anywhere in the top 10. Podium +15, perfect
        top 10 +100, Driver of the Day +5, safety-car bet +8. Outscore the model
        and you win the Grand Prix — that&apos;s what the season table counts.{" "}
        <Link href="/rules" className="underline">
          Full rules
        </Link>
      </p>
    </div>
  );
}
