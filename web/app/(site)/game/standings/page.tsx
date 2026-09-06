import Link from "next/link";
import { createClient, getUser } from "@/lib/supabase/server";
import { CURRENT_SEASON } from "@/lib/constants";
import { formatPoints } from "@/lib/format";
import type { LeaderboardRow, League, Race } from "@/lib/types";
import LeagueSwitcher from "@/components/LeagueSwitcher";
import LeagueCardActions from "@/components/LeagueCardActions";
import SeasonRaces from "@/components/SeasonRaces";
import StandingsBoard, {
  type BoardLine,
  type FormMark,
} from "@/components/StandingsBoard";
import StandingsPager from "@/components/StandingsPager";
import { modelEntries, modelSeason } from "@/lib/model";
import { fieldSummary } from "@/lib/duels";
import { seasonPickColor } from "@/lib/teams";

export const metadata = { title: "Standings" };
export const revalidate = 120;

/** Players per page. Keeps the HTML bounded however many sign up. */
const PER_PAGE = 100;

/** Your own line in a race card: points, and whether you took the model down. */
interface MyRace {
  total: number;
  beat_model: boolean;
  drew_model: boolean;
}

export default async function StandingsPage({
  searchParams,
}: {
  searchParams: Promise<{ league?: string; page?: string }>;
}) {
  const supabase = await createClient();
  const { league: leagueParam, page: pageParam } = await searchParams;

  const [{ data: races }, entries, user, { data: leaguesData }, field] =
    await Promise.all([
      supabase
        .from("races")
        .select("id, round, name, circuit, status")
        .eq("season", CURRENT_SEASON),
      modelEntries(supabase),
      getUser(),
      // RLS returns only the leagues the viewer belongs to. The whole row now:
      // the filter needs the name, and the panel under it needs the code and
      // the owner to decide between "Leave" and "Delete league".
      supabase.from("leagues").select("*").order("name"),
      // How the field did against the model, per race — the race list's
      // two public columns.
      fieldSummary(supabase, CURRENT_SEASON),
    ]);
  const modelByRace = new Map(
    entries
      .filter((e) => e.total !== null)
      .map((e) => [e.race_id, Number(e.total)]),
  );

  const myLeagues = (leaguesData as League[]) ?? [];
  const selectedLeague =
    myLeagues.find((l) => String(l.id) === leagueParam) ?? null;
  const leagueId = selectedLeague?.id ?? null;

  const seasonRaceIds = new Set(((races as Race[]) ?? []).map((r) => r.id));
  const model = modelSeason(entries, seasonRaceIds);

  // Filtering, ordering and counting all happen in SQL. Reading the whole
  // board to slice it here stopped working at 1000 players, which is where
  // PostgREST silently truncates — and a league whose members sat below that
  // cut came back empty.
  const [{ data: countData }, { data: myScoreRows }] = await Promise.all([
    supabase.rpc("standings_count", { p_league_id: leagueId }),
    // At most one row per Grand Prix, so this is a couple of dozen rows —
    // it turns the race list at the bottom into your own season.
    user
      ? supabase
          .from("scores")
          .select("race_id, total, beat_model, drew_model")
          .eq("user_id", user.id)
      : Promise.resolve({ data: null }),
  ]);

  const totalPlayers = Number(countData ?? 0);

  const totalPages = Math.max(1, Math.ceil(totalPlayers / PER_PAGE));
  const page = Math.min(
    Math.max(Number.parseInt(pageParam ?? "1", 10) || 1, 1),
    totalPages,
  );
  const offset = (page - 1) * PER_PAGE;

  // The model is no longer a line in the table — it cannot duel itself, so it
  // has no record and no rank (GAME_DESIGN §2.5). It stands above the board as
  // the bar, which is also what removes the splice this page used to do.
  const { data: rows } = await supabase.rpc("standings_page", {
    p_league_id: leagueId,
    p_limit: PER_PAGE,
    p_offset: offset,
  });
  const board = (rows as LeaderboardRow[]) ?? [];

  // Second wave, on the page we are actually going to draw: the colour each
  // player rides in (their championship call) and the shape of their last
  // five duels. Both are scoped to the hundred rows on screen — the roster is
  // two dozen rows, the picks at most a hundred, the form five a player
  // (migration 0012) — so the board costs the same at any league size.
  const listedIds = board.map((row) => row.user_id);
  const [{ data: pickRows }, { data: rosterRows }, { data: formRows }] =
    listedIds.length > 0
      ? await Promise.all([
          supabase
            .from("season_picks")
            .select("user_id, champion_driver, champion_team")
            .eq("season", CURRENT_SEASON)
            .in("user_id", listedIds),
          supabase
            .from("drivers")
            .select("driver_id, team, team_color")
            .eq("season", CURRENT_SEASON),
          supabase.rpc("player_form", {
            p_season: CURRENT_SEASON,
            p_user_ids: listedIds,
          }),
        ])
      : [{ data: [] }, { data: [] }, { data: [] }];

  const roster =
    (rosterRows as { driver_id: string; team: string; team_color: string | null }[]) ??
    [];
  const pickOf = new Map(
    (
      (pickRows as {
        user_id: string;
        champion_driver: string;
        champion_team: string;
      }[]) ?? []
    ).map((p) => [p.user_id, p]),
  );
  // A missing `player_form` (the migration hasn't landed yet) costs the board
  // its newest column, not its ability to render.
  const formOf = new Map<string, FormMark[]>();
  for (const row of (formRows as (FormMark & { user_id: string })[]) ?? []) {
    const marks = formOf.get(row.user_id) ?? [];
    marks.push({ round: row.round, name: row.name, outcome: row.outcome });
    formOf.set(row.user_id, marks);
  }

  const lines: BoardLine[] = board.map((row, i) => ({
    userId: row.user_id,
    rank: offset + i + 1,
    username: row.username,
    isViewer: row.user_id === user?.id,
    color: seasonPickColor(pickOf.get(row.user_id) ?? null, roster),
    races: row.races_played,
    wins: row.duel_wins,
    draws: row.duel_draws,
    losses: row.duel_losses,
    margin: Number(row.margin),
    points: Number(row.points),
    form: formOf.get(row.user_id) ?? [],
  }));

  const scoredRaces = ((races as Race[]) ?? [])
    .filter((r) => r.status === "scored")
    .sort((a, b) => b.round - a.round);

  const myRaces = new Map<number, MyRace>(
    ((myScoreRows as ({ race_id: number } & MyRace)[]) ?? []).map((s) => [
      s.race_id,
      s,
    ]),
  );

  return (
    <div className="flex flex-col gap-8">
      <header>
        <p className="font-mono text-xs tracking-[0.2em] text-race uppercase">
          Season {CURRENT_SEASON}
        </p>
        <h1 className="display mt-1 text-3xl font-extrabold tracking-tight">Standings</h1>
      </header>

      {/* The model stands above the board, not in it — see GAME_DESIGN §2.5.
          Outside the league switcher on purpose: its season is the same
          whichever league you are looking at, so it should not blink. */}
      <ModelBar points={model.points} races={model.races} />

      {/* Signed out there is nothing to filter and nothing to administer, so
          the board goes straight in. Signed in, everything below the pills is
          the switcher's to dim while the next league loads. */}
      {user ? (
        <LeagueSwitcher
          leagues={myLeagues.map((l) => ({ id: l.id, name: l.name }))}
          selectedId={leagueId}
        >
          {selectedLeague && (
            <section className="glass-card flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
              <div>
                <h2 className="display text-lg font-extrabold tracking-tight">{selectedLeague.name}</h2>
                <p className="mt-1 font-mono text-xs text-ink-mute">
                  {totalPlayers} {totalPlayers === 1 ? "player" : "players"} ·
                  code{" "}
                  <span className="rounded-control border border-line bg-black/25 px-2 py-0.5 text-ink select-all">
                    {selectedLeague.code}
                  </span>
                </p>
              </div>
              <LeagueCardActions
                leagueId={selectedLeague.id}
                name={selectedLeague.name}
                code={selectedLeague.code}
                isOwner={selectedLeague.owner_id === user.id}
                viewerId={user.id}
              />
            </section>
          )}

          <Board lines={lines} model={model} />

          {totalPages > 1 && (
            <StandingsPager
              page={page}
              totalPages={totalPages}
              totalPlayers={totalPlayers}
              leagueId={leagueId}
              perPage={PER_PAGE}
            />
          )}
        </LeagueSwitcher>
      ) : (
        <>
          <Board lines={lines} model={model} />
          {totalPages > 1 && (
            <StandingsPager
              page={page}
              totalPages={totalPages}
              totalPlayers={totalPlayers}
              leagueId={leagueId}
              perPage={PER_PAGE}
            />
          )}
        </>
      )}

      {/* Outside the switcher on purpose: the season's races are the same
          whichever league you are looking at, so they should not blink. */}
      {scoredRaces.length > 0 && (
        <SeasonRaces
          races={scoredRaces.map((r) => ({
            id: r.id,
            round: r.round,
            name: r.name,
            circuit: r.circuit,
          }))}
          model={modelByRace}
          field={field}
          mine={user ? myRaces : null}
        />
      )}
    </div>
  );
}

/**
 * The board before anybody has scored.
 *
 * It used to say "No duels scored yet — the season table fills in after the
 * first race weekend": honest, and with nothing to take hold of. The hook was
 * already on screen, one block up, in `ModelBar` — **the opponent has a score
 * and you do not.** So the empty state is built on that asymmetry instead of
 * announcing an absence, and it is the one empty state on the site allowed a
 * call to action inside it (§7.8), because the thing it is missing is exactly
 * the thing the button does.
 *
 * Before the model has played either — a genuinely empty season — there is no
 * asymmetry to point at and the screen says the plain thing.
 */
function EmptyBoard({ points, races }: { points: number; races: number }) {
  const started = races > 0;
  return (
    <section className="border-t border-line py-12">
      <h3 className="display max-w-lg text-xl font-extrabold tracking-tight sm:text-2xl">
        {started ? (
          <>
            The model is already on{" "}
            <span className="text-race tabular-nums">
              {formatPoints(points)}
            </span>{" "}
            points. Nobody else is on the board.
          </>
        ) : (
          <>Nobody has played yet — the model included.</>
        )}
      </h3>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-dim">
        {started
          ? `It has played ${races} ${races === 1 ? "Grand Prix" : "Grands Prix"} and won every duel it was offered, because nobody has offered one. The table starts counting the moment somebody does.`
          : "The table fills in after the first Grand Prix is scored — the model files its top 10 after qualifying, you file yours before lights out."}
      </p>
      <Link
        href="/game"
        className="pressable btn-race mt-6 inline-block px-7 py-3 text-sm font-semibold"
      >
        Enter this weekend&apos;s duel
      </Link>
    </section>
  );
}

/**
 * The model, above the board rather than on it.
 *
 * It used to be a row, and with eleven Grands Prix banked it was the row in
 * P1 — so the first thing a new player saw was a machine winning by 402 points
 * they could never make up. It cannot duel itself, so it has no record and no
 * rank; what it has is a score to clear, every Sunday.
 */
function ModelBar({ points, races }: { points: number; races: number }) {
  const perRace = races > 0 ? points / races : 0;
  return (
    <section className="glass-card flex flex-col gap-3 border-race/25 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-mono text-xs tracking-[0.2em] text-race uppercase">
          The bar
        </p>
        <p className="mt-1.5 text-sm text-ink-dim">
          The model plays every Grand Prix. Outscore it on Sunday and you take
          the win — that is what the table below counts.
        </p>
      </div>
      <div className="flex shrink-0 gap-6 sm:gap-8">
        <div>
          <p className="font-mono text-2xl font-semibold">
            {races > 0 ? formatPoints(Number(perRace.toFixed(1))) : "—"}
          </p>
          <p className="font-mono text-[0.65rem] tracking-wider text-ink-mute uppercase">
            pts / race
          </p>
        </div>
        <div>
          <p className="font-mono text-2xl font-semibold text-ink-dim">
            {formatPoints(points)}
          </p>
          <p className="font-mono text-[0.65rem] tracking-wider text-ink-mute uppercase">
            over {races} {races === 1 ? "race" : "races"}
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * The board, or the reason there isn't one.
 *
 * `StandingsBoard` draws the tower; this only decides whether there is a
 * tower to draw, because "nobody has scored yet" is not an empty list, it is
 * the one moment the game's proposition is legible (§7.8, EmptyBoard).
 */
function Board({
  lines,
  model,
}: {
  lines: BoardLine[];
  /** Only used when there is nobody on the board — see EmptyBoard. */
  model: { points: number; races: number };
}) {
  if (lines.length === 0) {
    return <EmptyBoard points={model.points} races={model.races} />;
  }
  return <StandingsBoard lines={lines} />;
}
