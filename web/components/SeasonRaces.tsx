import Link from "next/link";
import { formatPoints } from "@/lib/format";
import type { FieldSummary } from "@/lib/duels";

export interface SeasonRace {
  id: number;
  round: number;
  name: string;
  circuit: string | null;
}

/** The viewer's own line for a race: points, and whether they took the model down. */
export interface MyRace {
  total: number;
  beat_model: boolean;
  drew_model: boolean;
}

/**
 * The season, one line per Grand Prix.
 *
 * This block has been three things. It was a wrap of identical pills, which at
 * twenty-four rounds read as one undifferentiated heap; then one card per race
 * in a three-column grid, which was a real improvement and still the site's
 * fourth grid of equal cards. It is a table now, because that is the shape a
 * season takes everywhere else in this sport: the round hanging in the margin,
 * the Grand Prix, and the numbers in tabular columns you can run an eye down.
 *
 * Two of those columns are everybody's — what the model scored, and how many
 * of the players who entered beat it — because a signed-out reader used to get
 * a bare list of names, a table promising nothing at all. The last two are the
 * viewer's own and do not exist signed out. The result letter carries the
 * site's own W/D/L tones (§3.2).
 */
export default function SeasonRaces({
  races,
  model,
  field,
  mine,
}: {
  races: SeasonRace[];
  /** The model's total by race id. */
  model: Map<number, number>;
  /** How the field did against it, by race id (migration 0011). */
  field: Map<number, FieldSummary>;
  /** The viewer's scores by race id, or null when signed out. */
  mine: Map<number, MyRace> | null;
}) {
  const cols = mine
    ? "grid-cols-[2rem_minmax(0,1fr)_3.5rem_3.5rem_3.5rem] sm:grid-cols-[2.75rem_minmax(0,1fr)_4rem_5.5rem_5rem_3.5rem]"
    : "grid-cols-[2rem_minmax(0,1fr)_3.5rem_5rem] sm:grid-cols-[2.75rem_minmax(0,1fr)_4rem_5.5rem]";
  return (
      <section>
        <h2 className="font-mono text-xs tracking-[0.2em] text-ink-dim uppercase">
          Race by race
        </h2>

        <div
          aria-hidden
          className={`mt-5 grid ${cols} gap-x-3 px-2 pb-2 font-mono text-[0.6rem] tracking-wider text-ink-mute uppercase sm:gap-x-6`}
        >
          <span>Rd</span>
          <span>Grand Prix</span>
          <span className="text-right">Model</span>
          <span className="text-right">Beat it</span>
          {mine && (
            <>
              <span className="hidden text-right sm:block">You</span>
              <span className="text-right">Duel</span>
            </>
          )}
        </div>

        <ol className="border-b border-line">
          {races.map((r) => {
            const row = mine?.get(r.id);
            const outcome = row
              ? row.beat_model
                ? { letter: "W", tone: "text-emerald-400" }
                : row.drew_model
                  ? { letter: "D", tone: "text-amber-300" }
                  : { letter: "L", tone: "text-race" }
              : null;
            const modelPts = model.get(r.id);
            const f = field.get(r.id);
            return (
              <li key={r.id} className="border-t border-line">
                <Link
                  href={`/game/races/${r.round}`}
                  className={`group grid ${cols} items-center gap-x-3 rounded-control px-2 py-3 transition-colors hover:bg-glass sm:gap-x-6`}
                >
                  <span className="font-mono text-sm text-ink-mute tabular-nums">
                    {String(r.round).padStart(2, "0")}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {r.name.replace(" Grand Prix", "")}
                    </span>
                    <span className="hidden truncate font-mono text-[0.7rem] text-ink-mute sm:block">
                      {r.circuit ?? "Grand Prix"}
                    </span>
                  </span>
                  <span className="text-right font-mono text-sm text-ink-dim tabular-nums">
                    {modelPts === undefined ? "—" : formatPoints(modelPts)}
                  </span>
                  {/* "3 / 6": the players who beat it over the players who
                      entered. Nobody entered is a dash, not "0 / 0". */}
                  <span
                    className={`text-right font-mono text-sm tabular-nums ${
                      f && f.players > 0 && f.beat > 0
                        ? "text-emerald-400"
                        : "text-ink-mute"
                    }`}
                  >
                    {f && f.players > 0 ? (
                      <>
                        {f.beat}
                        <span className="text-ink-mute"> / {f.players}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                  {/* Signed out there is no "your" anything, and two empty
                      columns would be a table promising data it has none
                      of. */}
                  {mine && (
                    <>
                      <span className="hidden text-right font-mono text-sm tabular-nums sm:block">
                        {row ? formatPoints(Number(row.total)) : "—"}
                      </span>
                      <span
                        className={`text-right font-mono text-sm font-semibold ${
                          outcome?.tone ?? "text-ink-mute"
                        }`}
                      >
                        {outcome?.letter ?? "—"}
                      </span>
                    </>
                  )}
                </Link>
              </li>
            );
          })}
        </ol>
      </section>
  );
}
