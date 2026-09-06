import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getOwnProfile } from "@/lib/auth";
import { createClient, getUser } from "@/lib/supabase/server";
import { CURRENT_SEASON } from "@/lib/constants";
import { formatMargin, formatPoints, shortName } from "@/lib/format";
import { driverColor } from "@/lib/teams";
import { buildPosterData } from "@/lib/poster/data";
import Countdown from "@/components/Countdown";
import PosterExport from "@/components/PosterExport";
import RaceBreakdown, {
  type BreakdownEntry,
  type BreakdownRow,
  type Receipt,
} from "@/components/RaceBreakdown";
import { fieldLine, fieldSummary } from "@/lib/duels";
import type {
  Driver,
  ModelEntry,
  Prediction,
  Profile,
  Race,
  RaceResult,
  Score,
  SlotScore,
} from "@/lib/types";

export const revalidate = 120;

/**
 * How many players "The field" lists. The page used to render every score for
 * the race, which is unbounded in the number of players and silently truncated
 * at 1000 by PostgREST anyway. Your own row is fetched separately, so you
 * always see yourself even when you finish outside this cut.
 */
const FIELD_LIMIT = 100;

/** One cell of the side-by-side, in the shape the breakdown component wants. */
function entryFor(
  driverId: string | undefined,
  slot: SlotScore | undefined,
  drivers: Map<string, Driver>,
): BreakdownEntry | null {
  const id = slot?.driver ?? driverId;
  if (!id) return null;
  return {
    name: shortName(id),
    color: driverColor(drivers.get(id)),
    kind: slot?.kind ?? "miss",
    actual: slot?.actual ?? null,
    base: slot?.base ?? 0,
    probability: slot?.probability ?? null,
    multiplier: slot?.multiplier ?? 1,
    points: slot?.points ?? 0,
  };
}

const slotsTotal = (slots: SlotScore[] | undefined) =>
  (slots ?? []).reduce((sum, s) => sum + s.points, 0);

export default async function RaceReviewPage({
  params,
}: {
  params: Promise<{ round: string }>;
}) {
  const { round } = await params;
  const supabase = await createClient();

  const { data: raceRow } = await supabase
    .from("races")
    .select("*")
    .eq("season", CURRENT_SEASON)
    .eq("round", Number(round))
    .maybeSingle();
  const race = raceRow as Race | null;
  if (!race) notFound();
  if (race.status === "scheduled") redirect("/game");

  const user = await getUser();

  const [
    entryRes,
    resultRes,
    rosterRes,
    scoresRes,
    myScoreRes,
    myPredRes,
    ownProfile,
    nextRaceRes,
    fieldByRace,
  ] = await Promise.all([
      supabase.from("model_entries").select("*").eq("race_id", race.id).maybeSingle(),
      supabase.from("results").select("*").eq("race_id", race.id).maybeSingle(),
      supabase.from("drivers").select("*").eq("season", race.season),
      // The field, capped. Usernames come along the foreign key rather than
      // from a second unfiltered read of every profile on the site.
      supabase
        .from("scores")
        .select("*, profiles!inner(id, username, created_at)")
        .eq("race_id", race.id)
        .order("total", { ascending: false })
        .limit(FIELD_LIMIT),
      // Your own row separately: past FIELD_LIMIT players it is not in the
      // page above, and it is the one row you actually came here for. The
      // username rides along for the poster, which signs itself with it.
      user
        ? supabase
            .from("scores")
            .select("*, profiles!inner(id, username, created_at)")
            .eq("race_id", race.id)
            .eq("user_id", user.id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      // Only your prediction. The page never rendered anyone else's — it just
      // used to download all of them to find this one.
      user
        ? supabase
            .from("predictions")
            .select("*")
            .eq("race_id", race.id)
            .eq("user_id", user.id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      // The poster signs itself with your username, and on a race you skipped
      // there is no score row to carry one. Cached per request, so the nav and
      // the layout don't pay for this read twice.
      getOwnProfile(),
      // Which Grand Prix a visitor could still enter. Only for signed-out
      // visitors: this page is the natural landing spot for a shared link, and
      // it used to end on a two-line receipt and the footer, with no way in.
      user
        ? Promise.resolve({ data: null })
        : supabase
            .from("races")
            .select("round, name, race_at")
            .eq("season", CURRENT_SEASON)
            .eq("status", "scheduled")
            .gt("race_at", new Date().toISOString())
            .order("race_at", { ascending: true })
            .limit(1)
            .maybeSingle(),
      // "Beaten by 5 of 6 players" — the whole field, not the capped page
      // of it above (migration 0011).
      fieldSummary(supabase, race.season),
    ]);

  const field = fieldByRace.get(race.id);
  const entry = entryRes.data as ModelEntry | null;
  const result = resultRes.data as RaceResult | null;
  const drivers = new Map(
    ((rosterRes.data as Driver[]) ?? []).map((d) => [d.driver_id, d]),
  );

  type ScoreWithProfile = Score & { profiles: Profile | null };
  const scoreRows = (scoresRes.data as ScoreWithProfile[]) ?? [];
  const scores = scoreRows as Score[];
  const profiles = new Map(
    scoreRows
      .map((s) => s.profiles)
      .filter((p): p is Profile => p !== null)
      .map((p) => [p.id, p]),
  );

  const nextRace = nextRaceRes.data as Pick<
    Race,
    "round" | "name" | "race_at"
  > | null;

  const myScoreRow = myScoreRes.data as ScoreWithProfile | null;
  const myScore = (myScoreRow as Score | null) ?? undefined;
  const myPrediction = (myPredRes.data as Prediction | null) ?? undefined;

  // Everything the shareable poster needs, or null when the race isn't scored
  // yet. A race you sat out still exports — the sheet becomes the official
  // result and the model's race, so the button doesn't come and go.
  const poster =
    race.status === "scored"
      ? buildPosterData({
          race,
          drivers,
          prediction: myPrediction,
          score: myScore,
          entry,
          result,
          player:
            myScoreRow?.profiles?.username ?? ownProfile?.username ?? "you",
        })
      : null;

  const actualOrder: (string | undefined)[] = Array.from({ length: 10 }, (_, i) => {
    if (!result) return undefined;
    return Object.entries(result.classification).find(([, p]) => p === i + 1)?.[0];
  });

  // The side-by-side, flattened for the client component that explains it.
  const breakdownRows: BreakdownRow[] = Array.from({ length: 10 }, (_, i) => {
    const official = actualOrder[i];
    return {
      position: i + 1,
      mine: entryFor(myPrediction?.picks[i], myScore?.breakdown.slots[i], drivers),
      model: entryFor(
        entry?.predicted_order[i],
        entry?.breakdown?.slots?.[i],
        drivers,
      ),
      official: official
        ? {
            name: shortName(official),
            color: driverColor(drivers.get(official)),
          }
        : null,
    };
  });

  // The receipts add up exactly: both totals are the ten positions plus the
  // bonuses that fired, which is the question the page kept failing to answer.
  const myReceipt: Receipt | null = myScore
    ? {
        slots: slotsTotal(myScore.breakdown.slots),
        bonuses: myScore.breakdown.bonuses ?? {},
        total: myScore.total,
      }
    : null;
  const modelReceipt: Receipt | null = entry?.breakdown
    ? {
        slots: slotsTotal(entry.breakdown.slots),
        bonuses: entry.breakdown.bonuses ?? {},
        total: entry.total ?? 0,
      }
    : null;

  return (
    <div className="flex flex-col gap-6">
      <nav className="text-sm text-ink-mute">
        <Link href="/game" className="hover:text-ink">
          ← This weekend
        </Link>
      </nav>

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-xs tracking-[0.2em] text-race uppercase">
            Round {race.round} · {race.country}
          </p>
          <h1 className="display mt-1 text-3xl font-extrabold tracking-tight">{race.name}</h1>
          {/* The race in one line: what the machine scored and how the field
              did against it. It used to take the whole page to learn this. */}
          {race.status === "scored" && entry?.total != null && (
            <p className="mt-2 font-mono text-xs text-ink-dim">
              The model scored{" "}
              <span className="text-ink">{formatPoints(entry.total)}</span>
              {fieldLine(field) && (
                <>
                  {" "}·{" "}
                  <span className={field && field.beat > 0 ? "text-emerald-400" : ""}>
                    {fieldLine(field)!.toLowerCase()}
                  </span>
                </>
              )}
            </p>
          )}
        </div>
        {/* The poster is rendered exactly once — its data is serialized into
            the page, so a second copy would ship it twice — and it moves to
            wherever it is most wanted. Played the race: the duel banner, under
            the verdict. Signed out: the closing block. This header chip is the
            leftover case, a scored race you sat out. */}
        {poster && user && !myScore && <PosterExport data={poster} />}
      </header>

      {/* ── Duel banner ── */}
      {race.status === "scored" && myScore && (
        <section
          className={`glass-card p-6 ${
            myScore.beat_model
              ? "border-emerald-400/40"
              : myScore.drew_model
                ? "border-amber-300/40"
                : "border-race/40"
          }`}
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-ink-dim">
                {myScore.beat_model
                  ? "You beat the model 🎉"
                  : myScore.drew_model
                    ? "Dead heat with the model"
                    : "The model takes this one"}
              </p>
              <p className="mt-1 font-mono text-2xl font-semibold">
                {formatPoints(myScore.total)}{" "}
                <span className="text-ink-mute">—</span>{" "}
                {formatPoints(entry?.total ?? 0)}
              </p>
            </div>
            {/* The margin, not a bonus. Beating the model stopped paying points
                when the standings started ranking on the duel itself — this is
                the number that breaks ties between equal records. */}
            <div className="text-right text-xs text-ink-mute">
              <p>you · model</p>
              <p
                className={`mt-1 font-mono ${
                  myScore.beat_model
                    ? "text-emerald-400"
                    : myScore.drew_model
                      ? "text-amber-300"
                      : "text-race"
                }`}
              >
                {formatMargin(myScore.total - (entry?.total ?? 0))} on the
                season margin
              </p>
            </div>
          </div>

          {/* Reading the verdict is the moment you want to show it to someone,
              and the poster used to be a grey chip in the header two hundred
              pixels away. It belongs here, under the score it depicts, worded
              for the result it carries. */}
          {poster && (
            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-5">
              <PosterExport
                data={poster}
                variant="primary"
                label={
                  myScore.beat_model
                    ? "Share the win"
                    : myScore.drew_model
                      ? "Share the dead heat"
                      : "Share the race"
                }
              />
              <p className="text-xs text-ink-mute">
                A 1080 × 1350 sheet of this race, signed with your name — sized
                for a story.
              </p>
            </div>
          )}
        </section>
      )}

      {race.status === "locked" && (
        <p className="glass-chip rounded-panel px-5 py-3 text-sm text-ink-dim">
          🏁 Race locked — scoring lands once the official classification is in.
        </p>
      )}

      {/* ── Side-by-side, with the arithmetic on demand ── */}
      <RaceBreakdown
        rows={breakdownRows}
        me={myReceipt}
        model={modelReceipt}
        signedIn={Boolean(user)}
      />

      {result?.dotd && (
        <p className="text-sm text-ink-dim">
          Driver of the Day:{" "}
          <span className="font-medium text-ink">{shortName(result.dotd)}</span>
          {myPrediction?.dotd === result.dotd && (
            <span className="ml-2 text-emerald-400">you called it, +5</span>
          )}
        </p>
      )}

      {result && result.safety_car !== null && (
        <section className="glass-card flex flex-wrap items-center gap-x-6 gap-y-2 p-5 text-sm">
          <span className="text-ink-dim">
            Safety car:{" "}
            <span className="font-semibold text-ink">
              {result.safety_car ? "Yes — deployed" : "No — none"}
            </span>
          </span>
          {myPrediction && myPrediction.sc_bet !== null && (
            <span
              className={
                myPrediction.sc_bet === result.safety_car
                  ? "text-emerald-400"
                  : "text-race"
              }
            >
              You bet {myPrediction.sc_bet ? "Yes" : "No"}
              {myPrediction.sc_bet === result.safety_car ? " · +8" : " · missed"}
            </span>
          )}
          {entry && entry.sc_bet !== null && (
            <span className="text-ink-mute">
              Model bet {entry.sc_bet ? "Yes" : "No"}
              {entry.sc_bet === result.safety_car ? " ✓" : " ✗"}
            </span>
          )}
        </section>
      )}

      {/* ── Everyone's race ── */}
      {scores.length > 0 && (
        <section>
          <h2 className="mb-3 font-mono text-xs tracking-[0.2em] text-ink-dim uppercase">
            The field
            {scores.length === FIELD_LIMIT && (
              <span className="ml-2 font-normal text-ink-mute normal-case">
                — top {FIELD_LIMIT}
              </span>
            )}
          </h2>
          <ol className="flex flex-col gap-1.5">
            {scores.map((s, i) => {
              const p = profiles.get(s.user_id);
              return (
                <li
                  key={s.user_id}
                  className={`flex items-center gap-3 rounded-control border border-line bg-glass px-4 py-2.5 text-sm ${
                    user && s.user_id === user.id ? "border-line-hi" : ""
                  }`}
                >
                  <span className="w-6 font-mono text-ink-mute">{i + 1}</span>
                  {/* `#r<round>` opens this race's sheet on their profile —
                      their ten calls beside the model's — rather than the
                      cover. */}
                  <Link
                    href={`/profile/${p?.username ?? ""}#r${race.round}`}
                    title={`${p?.username ?? "player"}'s calls at the ${race.name}`}
                    className="flex-1 font-medium hover:underline"
                  >
                    {p?.username ?? "player"}
                  </Link>
                  <span
                    className={`font-mono text-xs ${
                      s.beat_model
                        ? "text-emerald-400"
                        : s.drew_model
                          ? "text-amber-300"
                          : "text-race"
                    }`}
                  >
                    {s.beat_model ? "beat the model" : s.drew_model ? "drew" : "lost"}
                  </span>
                  <span className="font-mono">{formatPoints(s.total)}</span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {/* ── The way in ──
             A shared link lands here, and the page used to end on a two-line
             receipt and the footer — no button anywhere. For a signed-out
             visitor this is the close: what the model scored, when the next
             one starts, and the poster of this race to take away. */}
      {!user && (
        <section className="glass-card border-race/30 p-6 sm:p-8">
          <p className="font-mono text-xs tracking-[0.2em] text-race uppercase">
            Your turn
          </p>
          <h2 className="display mt-2 max-w-2xl text-2xl font-extrabold tracking-tight sm:text-3xl">
            {entry?.total != null
              ? `The model scored ${formatPoints(entry.total)} here. Could you have done better?`
              : "The model has filed its top 10. Yours goes right next to it."}
          </h2>
          <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-dim">
            Every Grand Prix you call the finishing order, the model calls its
            own, and the one with more points wins the weekend. The less the
            model believed in a call you got right, the more it pays.
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href="/login"
              className="pressable btn-race px-7 py-3 text-sm font-semibold"
            >
              Enter the duel — it takes 20 seconds
            </Link>
            {poster && <PosterExport data={poster} />}
          </div>

          {nextRace?.race_at && (
            <div className="mt-5 border-t border-line pt-4">
              <Countdown
                to={nextRace.race_at}
                label={`Next up · ${nextRace.name} locks in`}
              />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
