import Link from "next/link";
import { formatMargin, formatPoints } from "@/lib/format";

/**
 * The season board, drawn as a timing tower.
 *
 * It was a `<table>` in a `.glass-card` above `sm` and a separate stack of
 * cards below it — six columns of numbers of equal weight, boxed, and two
 * cuts of the same data free to drift apart. A tower is what this sport puts
 * a running order in: the position hanging in the margin, the name, and the
 * numbers in tabular columns you can run an eye down. So it is one `<ol>` at
 * every width, hairline-separated, with columns that drop on a phone into a
 * sub-line rather than into a second component (§1.4, §7.5).
 *
 * Three things the old table could not say:
 *
 * - **the shape of a record.** `2-0-0` is a fact; a segmented bar is a
 *   glance. The counts stay under it as the exact reading — the bar is never
 *   the only channel (§1.2).
 * - **form.** The five most recent duels, oldest to newest, as letters in
 *   their own tone — the same W/D/L vocabulary as the profile curve and the
 *   race pages. Colour *and* glyph, and each one titled with its Grand Prix.
 * - **who the player is riding for.** The rule left of every name is their
 *   championship call's colour, the same rule that stands in front of a
 *   driver everywhere else on the site. A player who has not called yet gets
 *   the neutral grey, which is its own quiet nudge.
 *
 * Presentational: the page does the reading, so this renders from fixtures.
 */

export interface FormMark {
  round: number;
  name: string;
  outcome: "W" | "D" | "L";
}

export interface BoardLine {
  userId: string;
  rank: number;
  username: string;
  isViewer: boolean;
  /** The championship call's colour, or the neutral grey when there is none. */
  color: string;
  races: number;
  wins: number;
  draws: number;
  losses: number;
  margin: number;
  points: number;
  /** Oldest first, at most five. Empty until they have raced. */
  form: FormMark[];
}

const OUTCOME = {
  W: { tone: "bg-emerald-400/15 text-emerald-400", label: "beat the model" },
  D: { tone: "bg-amber-300/15 text-amber-300", label: "drew with the model" },
  L: { tone: "bg-race/15 text-race", label: "lost to the model" },
} as const;

/** Rank 1 in full ink, the rest of the podium a step down, then the field. */
function rankTone(rank: number): string {
  if (rank === 1) return "text-ink";
  if (rank <= 3) return "text-ink-dim";
  return "text-ink-mute";
}

function DuelBar({
  wins,
  draws,
  losses,
}: {
  wins: number;
  draws: number;
  losses: number;
}) {
  const total = wins + draws + losses;
  if (total === 0) {
    return <span aria-hidden className="block h-1 rounded-full bg-line" />;
  }
  const segments: [count: number, className: string][] = [
    [wins, "bg-emerald-400"],
    [draws, "bg-amber-300"],
    [losses, "bg-race/70"],
  ];
  return (
    <span aria-hidden className="flex h-1 gap-px overflow-hidden rounded-full">
      {segments.map(([count, className], i) =>
        count > 0 ? (
          <span key={i} className={className} style={{ flexGrow: count }} />
        ) : null,
      )}
    </span>
  );
}

function Form({ marks }: { marks: FormMark[] }) {
  if (marks.length === 0) {
    return <span className="font-mono text-xs text-ink-mute">—</span>;
  }
  return (
    <span className="flex gap-1">
      {marks.map((m) => (
        <span
          key={m.round}
          title={`${m.name.replace(" Grand Prix", "")}: ${OUTCOME[m.outcome].label}`}
          className={`grid size-[1.15rem] shrink-0 place-items-center rounded-[3px] font-mono text-[0.6rem] font-semibold ${OUTCOME[m.outcome].tone}`}
        >
          {m.outcome}
          <span className="sr-only">
            {" "}
            — {m.name}, {OUTCOME[m.outcome].label}
          </span>
        </span>
      ))}
    </span>
  );
}

/** Positive margins are the point of the column, so they get the colour. */
function marginTone(m: number): string {
  return m > 0 ? "text-emerald-400" : m < 0 ? "text-ink-mute" : "text-ink-dim";
}

const COLS =
  "grid grid-cols-[1.75rem_minmax(0,1fr)_2.75rem] gap-x-3 " +
  "sm:grid-cols-[2.5rem_minmax(0,1fr)_7.5rem_5.5rem_4.5rem_4.5rem] sm:gap-x-5";

export default function StandingsBoard({ lines }: { lines: BoardLine[] }) {
  return (
    <div>
      <div
        aria-hidden
        className={`${COLS} px-2 pb-2 font-mono text-[0.6rem] tracking-wider text-ink-mute uppercase`}
      >
        <span>Pos</span>
        <span>Player</span>
        <span className="hidden sm:block">Form</span>
        <span className="hidden sm:block">Record</span>
        <span className="hidden text-right sm:block">Margin</span>
        <span className="text-right">Pts</span>
      </div>

      <ol className="border-b border-line">
        {lines.map((l) => (
          <li
            key={l.userId}
            className={`border-t border-line ${l.isViewer ? "bg-glass" : ""}`}
          >
            <div className={`${COLS} items-center px-2 py-3`}>
              <span
                className={`font-mono text-sm tabular-nums sm:text-base ${rankTone(l.rank)}`}
              >
                {l.rank}
              </span>

              <span className="flex min-w-0 items-stretch gap-2.5 sm:gap-3">
                {/* The championship call, as the rule that stands in front of
                    a driver everywhere else on the site. It stretches to the
                    block rather than sitting at a fixed height, so on a phone
                    — where the dropped columns come back as two more lines —
                    it still reads as the row's own colour. */}
                <span
                  aria-hidden
                  className="w-0.5 shrink-0 rounded-full"
                  style={{ background: l.color }}
                />
                <span className="min-w-0">
                  <span className="flex items-baseline gap-2">
                    <Link
                      href={`/profile/${l.username}`}
                      className="truncate text-sm font-medium hover:underline sm:text-[0.95rem]"
                    >
                      {l.username}
                    </Link>
                    {l.isViewer && (
                      <span className="shrink-0 rounded-full bg-race/15 px-2 py-0.5 font-mono text-[0.6rem] text-race">
                        YOU
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block font-mono text-[0.7rem] text-ink-mute">
                    {l.races} {l.races === 1 ? "race" : "races"}
                    {/* On a phone the three dropped columns come back here,
                        where there is a line's width for them. */}
                    <span className="sm:hidden">
                      {" · "}
                      {l.wins}-{l.draws}-{l.losses}
                      {" · "}
                      <span className={marginTone(l.margin)}>
                        {formatMargin(l.margin)}
                      </span>
                    </span>
                  </span>
                  <span className="mt-1.5 block sm:hidden">
                    <Form marks={l.form} />
                  </span>
                </span>
              </span>

              <span className="hidden sm:block">
                <Form marks={l.form} />
              </span>

              <span className="hidden sm:block">
                <span className="block font-mono text-[0.7rem] text-ink-dim tabular-nums">
                  {l.wins}-{l.draws}-{l.losses}
                </span>
                <span className="mt-1.5 block">
                  <DuelBar wins={l.wins} draws={l.draws} losses={l.losses} />
                </span>
              </span>

              <span
                className={`hidden text-right font-mono text-sm tabular-nums sm:block ${marginTone(l.margin)}`}
              >
                {formatMargin(l.margin)}
              </span>

              <span className="text-right font-mono text-sm tabular-nums sm:text-base">
                {formatPoints(l.points)}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
