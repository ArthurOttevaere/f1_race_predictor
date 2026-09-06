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
 * The season's scored Grands Prix, as an index.
 *
 * This block has been four things. A wrap of identical pills (twenty-four of
 * them, one heap); one card per race in a three-column grid — better, and the
 * site's fourth grid of equal cards; then a table, which is the shape a season
 * takes everywhere else in this sport.
 *
 * The table was right and it became a problem the day the board above it
 * became a tower of the same material: two hairline-ruled lists, one under the
 * other, reading as one endless scroll where a reader could not tell the
 * ranking from the archive. **They are not the same kind of thing.** The board
 * is the page's subject — a standing, dense, two lines a row, textured with
 * form and colour. This is an index you go *into*: every row leads somewhere,
 * and it should read as the lighter, quieter thing it is.
 *
 * So it keeps the table's shape and loses a weight class. One line a row at
 * two-thirds the height, mono a step down, the circuit tucked inline after the
 * Grand Prix instead of on a line of its own, softer rules, and a chevron
 * saying what the board's rows never say — that this one goes somewhere. Above
 * it, a rule, a heading and a sentence of prose: the board has none, which is
 * the other half of telling them apart (§1.4 — space and type, never a band).
 *
 * Two of the columns are everybody's: what the model scored, and how many of
 * the players who entered beat it. Signed out, the viewer's own two are not
 * rendered at all — a table with empty columns promises data it has none of.
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
    ? "grid-cols-[1.75rem_minmax(0,1fr)_2.5rem_2.75rem_2.5rem_0.75rem] sm:grid-cols-[2.25rem_minmax(0,1fr)_3.5rem_4.5rem_4rem_2.5rem_1rem]"
    : "grid-cols-[1.75rem_minmax(0,1fr)_2.5rem_3.5rem_0.75rem] sm:grid-cols-[2.25rem_minmax(0,1fr)_3.5rem_5rem_1rem]";

  return (
    // `mt-6` on top of the page's own gap: the board closes with a rule of
    // its own, and two hairlines a couple of centimetres apart read as a
    // mistake rather than as a break.
    <section className="mt-6 border-t border-line pt-10">
      <h2 className="font-mono text-xs tracking-[0.2em] text-ink-dim uppercase">
        Race by race
      </h2>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-mute">
        Every Grand Prix the model has been scored on this season. Open one for
        its entry, the official result and everyone who took it on.
      </p>

      <div
        aria-hidden
        className={`mt-6 grid ${cols} gap-x-3 px-2 pb-1.5 font-mono text-[0.55rem] tracking-wider text-ink-mute uppercase sm:gap-x-5`}
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
        <span />
      </div>

      <ol className="border-b border-line/60">
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
            <li key={r.id} className="border-t border-line/60">
              <Link
                href={`/game/races/${r.round}`}
                className={`group grid ${cols} items-center gap-x-3 rounded-control px-2 py-2.5 transition-colors hover:bg-glass sm:gap-x-5`}
              >
                <span className="font-mono text-xs text-ink-mute tabular-nums">
                  {String(r.round).padStart(2, "0")}
                </span>
                <span className="min-w-0 truncate">
                  <span className="text-sm">
                    {r.name.replace(" Grand Prix", "")}
                  </span>
                  {/* The circuit rides inline rather than taking a second
                      line: half the row height is what tells this list from
                      the tower above it. */}
                  {r.circuit && (
                    <span className="hidden font-mono text-[0.7rem] text-ink-mute sm:inline">
                      {" · "}
                      {r.circuit}
                    </span>
                  )}
                </span>
                <span className="text-right font-mono text-xs text-ink-dim tabular-nums">
                  {modelPts === undefined ? "—" : formatPoints(modelPts)}
                </span>
                {/* "3 / 6": the players who beat it over the players who
                    entered. Nobody entered is a dash, not "0 / 0". */}
                <span
                  className={`text-right font-mono text-xs tabular-nums ${
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
                {mine && (
                  <>
                    <span className="hidden text-right font-mono text-xs tabular-nums sm:block">
                      {row ? formatPoints(Number(row.total)) : "—"}
                    </span>
                    <span
                      className={`text-right font-mono text-xs font-semibold ${
                        outcome?.tone ?? "text-ink-mute"
                      }`}
                    >
                      {outcome?.letter ?? "—"}
                    </span>
                  </>
                )}
                {/* The board's rows are a standing; these go somewhere, and
                    nothing on a row of numbers says so on its own. */}
                <svg
                  aria-hidden
                  viewBox="0 0 16 16"
                  className="size-3 text-ink-mute/60 transition-transform duration-200 ease-out-strong group-hover:translate-x-0.5 group-hover:text-ink-dim"
                >
                  <path
                    d="M6 3l5 5-5 5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
