import Link from "next/link";
import { createClient, getUser } from "@/lib/supabase/server";
import { CURRENT_SEASON } from "@/lib/constants";
import { formatMargin, formatPoints } from "@/lib/format";
import type { LeaderboardRow, League, Race } from "@/lib/types";
import LeagueSwitcher from "@/components/LeagueSwitcher";
import LeagueCardActions from "@/components/LeagueCardActions";
import SeasonRaces from "@/components/SeasonRaces";
import StandingsPager from "@/components/StandingsPager";
import { modelEntries, modelSeason } from "@/lib/model";
import { fieldSummary } from "@/lib/duels";

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
  const lines = board.map((row, i) => ({ row, rank: offset + i + 1 }));

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

          <Board
            lines={lines}
            empty={board.length === 0}
            viewerId={user.id}
            model={model}
          />

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
          <Board
            lines={lines}
            empty={board.length === 0}
            viewerId={null}
            model={model}
          />
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

function Board({
  lines,
  empty,
  viewerId,
  model,
}: {
  lines: { row: LeaderboardRow; rank: number }[];
  empty: boolean;
  viewerId: string | null;
  /** Only used when there is nobody on the board — see EmptyBoard. */
  model: { points: number; races: number };
}) {
  // One empty state, not an empty list on a phone and an empty table beside
  // it: with no rows there is nothing for the two cuts to disagree about.
  if (empty) return <EmptyBoard points={model.points} races={model.races} />;

  const rows = lines.map(({ row, rank }) => ({
    key: row.user_id,
    rank,
    username: row.username,
    isViewer: row.user_id === viewerId,
    races: row.races_played,
    wins: row.duel_wins,
    record: `${row.duel_wins}-${row.duel_draws}-${row.duel_losses}`,
    margin: Number(row.margin),
    points: Number(row.points),
  }));

  const name = (r: (typeof rows)[number]) => (
    <>
      <Link
        href={`/profile/${r.username}`}
        className="font-medium hover:underline"
      >
        {r.username}
      </Link>
      {r.isViewer && (
        <span className="ml-2 rounded-full bg-race/15 px-2 py-0.5 font-mono text-[0.65rem] text-race">
          YOU
        </span>
      )}
    </>
  );

  // Positive margins are the point of the column, so they get the colour.
  const marginTone = (m: number) =>
    m > 0 ? "text-emerald-400" : m < 0 ? "text-ink-mute" : "text-ink-dim";

  return (
    <>
      {/* ── Phone: one card per player ──────────────────────────────────
          The table below needs 32rem to lay its six columns out and a phone
          hands it 21. Everything past that would sit behind a sideways scroll
          with no visible bar on iOS. Same data, stacked. */}
      <ul className="flex flex-col gap-1.5 sm:hidden">
        {rows.map((r) => (
          <li
            key={r.key}
            className={`flex items-center gap-3 rounded-control border px-3 py-2.5 ${
              r.isViewer
                ? "border-line-hi bg-glass-strong"
                : "border-line bg-glass"
            }`}
          >
            <span className="w-5 shrink-0 font-mono text-sm text-ink-mute">
              {r.rank}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{name(r)}</span>
              <span className="mt-0.5 block font-mono text-[0.7rem] text-ink-mute">
                {r.races} {r.races === 1 ? "race" : "races"} · {r.record} ·{" "}
                <span className={marginTone(r.margin)}>
                  {formatMargin(r.margin)}
                </span>
              </span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block font-mono text-base">{r.wins}</span>
              <span className="block font-mono text-[0.6rem] tracking-wider text-ink-mute uppercase">
                {r.wins === 1 ? "win" : "wins"}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {/* ── Tablet and up: the full table ── */}
      <section className="glass-card hidden overflow-x-auto p-2 sm:block">
        <table className="w-full min-w-[32rem] border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="text-left font-mono text-xs tracking-wider text-ink-mute uppercase">
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Player</th>
              <th className="px-3 py-2 text-right font-medium">Wins</th>
              <th className="px-3 py-2 text-right font-medium">W-D-L</th>
              <th className="px-3 py-2 text-right font-medium">Margin</th>
              <th className="px-3 py-2 text-right font-medium">Points</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className={`border-t border-line ${r.isViewer ? "bg-glass" : ""}`}
              >
                <td className="px-3 py-2.5 font-mono text-ink-mute">{r.rank}</td>
                <td className="px-3 py-2.5">
                  {name(r)}
                  <span className="ml-2 font-mono text-xs text-ink-mute">
                    {r.races} {r.races === 1 ? "race" : "races"}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right font-mono font-semibold">
                  {r.wins}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-xs text-ink-dim">
                  {r.record}
                </td>
                <td
                  className={`px-3 py-2.5 text-right font-mono ${marginTone(r.margin)}`}
                >
                  {formatMargin(r.margin)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-ink-dim">
                  {formatPoints(r.points)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
