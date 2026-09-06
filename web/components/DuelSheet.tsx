import { formatPoints } from "@/lib/format";
import type { SlotScore } from "@/lib/types";

/**
 * One Grand Prix, one player, against the model — the sheet itself.
 *
 * Three columns of ten: what the player called, what the model called, what
 * happened. Each call carries a mark and its points, so the sheet is read the
 * way a timing screen is read — down a column, at a glance — and nothing on
 * it needs a tap to explain. The race page's `RaceBreakdown` is the
 * inspectable version of the same table, with the arithmetic on demand; this
 * one is the print-out, and it is what a profile shows for every race the
 * player ran and what the field links to from a race page.
 *
 * Presentational, so it renders from fixtures and from either side of the
 * server boundary. `lib/duels.ts` builds the rows.
 */

export type Kind = SlotScore["kind"];

export interface SheetCall {
  name: string;
  color: string;
  kind: Kind;
  points: number;
}

export interface SheetRow {
  position: number;
  mine: SheetCall | null;
  model: SheetCall | null;
  official: { name: string; color: string } | null;
}

export interface SheetBonuses {
  /** Label → points, only the ones that actually fired. */
  mine: [label: string, points: number][];
  model: [label: string, points: number][];
}

/** The same three outcomes the home page's proof table draws. */
export const MARKS: Record<Kind, { glyph: string; label: string; tone: string }> = {
  exact: { glyph: "✓", label: "exact position", tone: "text-emerald-400" },
  near: { glyph: "~", label: "one off", tone: "text-amber-300" },
  in_top10: { glyph: "•", label: "in the top 10", tone: "text-ink-dim" },
  miss: { glyph: "·", label: "outside the top 10", tone: "text-ink-mute" },
};

function Call({ call, muted }: { call: SheetCall | null; muted?: boolean }) {
  if (!call) return <span className="text-ink-mute">—</span>;
  const mark = MARKS[call.kind];
  return (
    <span className="flex min-w-0 items-center gap-1.5 sm:gap-2">
      <span
        aria-hidden
        className="h-4 w-0.5 shrink-0"
        style={{ background: call.color }}
      />
      <span
        className={`truncate ${
          call.kind === "exact" ? "text-ink" : muted ? "text-ink-dim" : "text-ink"
        }`}
      >
        {call.name}
      </span>
      <span
        title={mark.label}
        className={`ml-auto shrink-0 font-mono text-[0.7rem] ${mark.tone}`}
      >
        {mark.glyph}
        <span className="sr-only"> {mark.label}</span>
      </span>
      <span
        className={`w-7 shrink-0 text-right font-mono text-[0.7rem] tabular-nums ${
          call.points ? "text-ink" : "text-ink-mute"
        }`}
      >
        {call.points ? `+${formatPoints(call.points)}` : "0"}
      </span>
    </span>
  );
}

export default function DuelSheet({
  rows,
  bonuses,
  totals,
  playerLabel = "You",
}: {
  rows: SheetRow[];
  bonuses: SheetBonuses;
  totals: { mine: number; model: number };
  /** "You" on your own profile, the username on somebody else's. */
  playerLabel?: string;
}) {
  const cols =
    "grid grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 sm:grid-cols-[1.75rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)] sm:gap-x-5";
  return (
    <div className="text-xs sm:text-sm">
      <div
        aria-hidden
        className={`${cols} border-b border-line px-2 pb-2 font-mono text-[0.6rem] tracking-[0.14em] text-ink-mute uppercase`}
      >
        <span>P</span>
        <span className="truncate">{playerLabel}</span>
        <span>Model</span>
        <span className="hidden sm:block">Official</span>
      </div>

      <ol>
        {rows.map((r) => (
          <li
            key={r.position}
            className={`${cols} items-center border-b border-line/60 px-2 py-2`}
          >
            <span className="font-mono text-ink-mute tabular-nums">
              {r.position}
            </span>
            <Call call={r.mine} />
            <Call call={r.model} muted />
            {/* The official column is the phone's casualty: two calls with
                their marks already fill 358px, and each call's mark says
                where its driver actually finished. */}
            <span className="hidden min-w-0 items-center gap-2 text-ink-dim sm:flex">
              {r.official ? (
                <>
                  <span
                    aria-hidden
                    className="h-4 w-0.5 shrink-0"
                    style={{ background: r.official.color }}
                  />
                  <span className="truncate">{r.official.name}</span>
                </>
              ) : (
                <span className="text-ink-mute">—</span>
              )}
            </span>
          </li>
        ))}
      </ol>

      {/* The receipts. Bonuses only when one fired — an empty "Bonuses: none"
          line is a row that says nothing — then the two totals in the same
          two columns as the calls above them, so the eye lands on the number
          it just ran down to. */}
      <div className={`${cols} px-2 pt-3`}>
        <span />
        <BonusList items={bonuses.mine} />
        <BonusList items={bonuses.model} muted />
        <span className="hidden sm:block" />
      </div>
      <div className={`${cols} items-baseline px-2 pt-2`}>
        <span className="font-mono text-[0.6rem] tracking-[0.14em] text-ink-mute uppercase">
          Σ
        </span>
        <span className="font-mono text-lg font-semibold tabular-nums">
          {formatPoints(totals.mine)}
        </span>
        <span className="font-mono text-lg font-semibold text-ink-dim tabular-nums">
          {formatPoints(totals.model)}
        </span>
        <span className="hidden sm:block" />
      </div>
    </div>
  );
}

function BonusList({
  items,
  muted,
}: {
  items: [string, number][];
  muted?: boolean;
}) {
  if (items.length === 0) return <span />;
  return (
    <ul className={`flex flex-col gap-0.5 ${muted ? "text-ink-mute" : "text-ink-dim"}`}>
      {items.map(([label, points]) => (
        <li key={label} className="flex justify-between gap-2 font-mono text-[0.7rem]">
          <span className="min-w-0 leading-snug">{label}</span>
          <span className="shrink-0 tabular-nums">+{formatPoints(points)}</span>
        </li>
      ))}
    </ul>
  );
}
