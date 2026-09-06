import { cache } from "react";
import Link from "next/link";
import Arrow from "@/components/Arrow";
import { createClient } from "@/lib/supabase/server";
import { CURRENT_SEASON } from "@/lib/constants";
import { formatPoints, shortName } from "@/lib/format";
import { driverColor } from "@/lib/teams";
import {
  fieldSummary,
  modelForm,
  tally,
  type FieldSummary,
  type ModelForm,
} from "@/lib/duels";
import type {
  Driver,
  ModelEntry,
  Race,
  RaceResult,
  SlotScore,
} from "@/lib/types";

/**
 * How a call turned out, in one glyph. The column is the whole argument of
 * this section — the model is good, and it is not perfect — so the three
 * outcomes have to be told apart at a glance rather than read.
 */
const MARKS = {
  exact: { glyph: "✓", label: "exact position", tone: "text-emerald-400" },
  near: { glyph: "~", label: "one off", tone: "text-amber-300" },
  in_top10: { glyph: "•", label: "in the top 10", tone: "text-ink-dim" },
  miss: { glyph: "·", label: "outside the top 10", tone: "text-ink-mute" },
} as const;

type Row = {
  position: number;
  model: { name: string; color: string } | null;
  official: { name: string; color: string } | null;
  kind: SlotScore["kind"];
  points: number | null;
};

function DriverCell({
  driver,
}: {
  driver: { name: string; color: string } | null;
}) {
  if (!driver) return <span className="text-ink-mute">—</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden
        className="h-4 w-0.5 shrink-0"
        style={{ background: driver.color }}
      />
      <span className="truncate">{driver.name}</span>
    </span>
  );
}

export type LastRace = {
  race: Pick<Race, "round" | "name">;
  rows: Row[];
  total: number;
  exact: number;
  /** Exact or one place off. */
  withinOne: number;
  /** Of the model's ten, how many finished anywhere in the top 10. */
  top10: number;
  /**
   * How the field did against it here — "beaten by 5 of 6" — and the model's
   * season so far. Both are what the hero's cue prints instead of a count of
   * exact hits, which on a normal Sunday is two and reads as a failure.
   */
  field: FieldSummary | null;
  form: ModelForm | null;
  /** The season roster, already in hand — see `official` below. */
  roster: Driver[];
  /**
   * The ten drivers who actually finished in the top 10, in order.
   *
   * Nothing in this section uses it: it is here for `PickBoardShot`, which
   * fills the home page's pick board with a real order rather than an invented
   * one. Both reads are the same request-cached call, so the board costs no
   * query of its own.
   */
  official: string[];
};

/**
 * The last scored Grand Prix, as the model played it: its ten picks, what
 * actually happened, and what that was worth.
 *
 * Deduplicated per request, because the hero's scroll cue and the section
 * itself both want it — and both need to know whether it exists at all.
 * Null before the first race of a season is scored: there is no honest
 * version of this block without a result behind it.
 */
export const loadLastRace = cache(async (): Promise<LastRace | null> => {
  const supabase = await createClient();

  const { data: raceRow } = await supabase
    .from("races")
    .select("id, round, name")
    .eq("season", CURRENT_SEASON)
    .eq("status", "scored")
    .order("round", { ascending: false })
    .limit(1)
    .maybeSingle();

  const race = raceRow as Pick<Race, "id" | "round" | "name"> | null;
  if (!race) return null;

  const [entryRes, resultRes, rosterRes, seasonEntriesRes, seasonRacesRes, field] =
    await Promise.all([
      supabase
        .from("model_entries")
        .select("predicted_order, breakdown, total")
        .eq("race_id", race.id)
        .maybeSingle(),
      supabase
        .from("results")
        .select("classification")
        .eq("race_id", race.id)
        .maybeSingle(),
      supabase
        .from("drivers")
        .select("driver_id, code, full_name, team, team_color, active")
        .eq("season", CURRENT_SEASON),
      // The season's worth of totals — two dozen rows — for the form line.
      supabase.from("model_entries").select("race_id, total"),
      supabase.from("races").select("id, name").eq("season", CURRENT_SEASON),
      fieldSummary(supabase, CURRENT_SEASON),
    ]);

  const entry = entryRes.data as Pick<
    ModelEntry,
    "predicted_order" | "breakdown" | "total"
  > | null;
  const result = resultRes.data as Pick<RaceResult, "classification"> | null;
  if (!entry || !result) return null;

  const drivers = new Map(
    ((rosterRes.data as Driver[]) ?? []).map((d) => [d.driver_id, d]),
  );
  const cell = (driverId: string | undefined) =>
    driverId
      ? { name: shortName(driverId), color: driverColor(drivers.get(driverId)) }
      : null;

  const finishers = new Map(
    Object.entries(result.classification).map(([driverId, p]) => [p, driverId]),
  );

  const rows: Row[] = Array.from({ length: 10 }, (_, i) => {
    const slot = entry.breakdown?.slots?.[i];
    return {
      position: i + 1,
      model: cell(slot?.driver ?? entry.predicted_order[i]),
      official: cell(finishers.get(i + 1)),
      kind: slot?.kind ?? "miss",
      points: slot?.points ?? null,
    };
  });

  const counts = tally(entry.breakdown?.slots);
  const seasonRaces = new Map(
    ((seasonRacesRes.data as Pick<Race, "id" | "name">[]) ?? []).map((r) => [r.id, r]),
  );

  return {
    race,
    rows,
    total: entry.total ?? 0,
    exact: counts.exact,
    withinOne: counts.withinOne,
    top10: counts.top10,
    field: field.get(race.id) ?? null,
    form: modelForm(
      (seasonEntriesRes.data as Pick<ModelEntry, "race_id" | "total">[]) ?? [],
      seasonRaces,
    ),
    roster: (rosterRes.data as Driver[]) ?? [],
    official: Array.from({ length: 10 }, (_, i) => finishers.get(i + 1) ?? "")
      .filter(Boolean),
  };
});

/**
 * The proof section of the home page.
 *
 * The page described the game in three sections and never showed it — a
 * visitor was asked to take the whole thing on trust before signing up. This
 * is a server component reading public rows, so it costs no client JavaScript,
 * and it re-tells itself every time a race is scored.
 */
export default async function LastRaceProof() {
  const data = await loadLastRace();
  if (!data) return null;
  const { race, rows, total, exact, withinOne, top10 } = data;

  // The tally, largest circle first. "2 of 10 exact" is the truth told in
  // the one way that makes a good race sound like a bad one: exact hits are
  // rare by design (that is what the multipliers pay for). Eight of ten in
  // the top 10 and five within a place is the same race, read the way a
  // pundit would read it.
  const tallyLine = [
    `${top10} of its 10 finished in the top 10`,
    `${withinOne} within a place`,
    `${exact} on the nose`,
  ].join(" · ");

  return (
    <section
      id="last-race"
      className="mx-auto w-[min(64rem,calc(100%-2rem))] scroll-mt-24 py-24"
    >
      <p className="font-mono text-xs tracking-[0.2em] text-race uppercase">
        The last race · Round {race.round}
      </p>
      <h2 className="display mt-3 max-w-xl text-3xl font-extrabold tracking-tight sm:text-4xl">
        The model called the {race.name}. Here&apos;s how it did.
      </h2>
      <p className="mt-4 max-w-xl leading-relaxed text-ink-dim">
        Its ten picks, against the ten drivers who actually finished there.
        Nothing here is a mock-up — it is the entry it filed before the race,
        scored by the same rules as yours.
      </p>

      <div className="glass-card mt-10 overflow-hidden">
        {/* H-6: this section is the only real thing on the page, so it gets the
            page's only staging — and the flag is the honest way to say a race
            is over. It is a quieter cut than the footer's: one row of 6px
            squares instead of two rows of 10px, and it sits *inside* the card's
            top edge rather than banding the section, which §1.4 forbids. */}
        <div aria-hidden className="checker-rule" />
        {/* A grid rather than a table with a min-width: this has to read on a
            390px phone, where an `overflow-x-auto` table would put the last
            column — the points, the reason for the section — off the edge with
            nothing on screen to say so. */}
        <div
          role="table"
          aria-label={`The model's top 10 at the ${race.name}, against the official result`}
          // Two driver names, a mark and a score in 342px of phone: the type
          // steps down rather than the last column stepping off the screen.
          className="text-xs sm:text-sm"
        >
          <div
            role="row"
            className="grid grid-cols-[1.75rem_1fr_1.25rem_1fr_2.75rem] items-center gap-x-2 border-b border-line px-3 py-2.5 font-mono text-[0.6rem] tracking-[0.14em] text-ink-mute uppercase sm:gap-x-4 sm:px-5"
          >
            <span role="columnheader">P</span>
            <span role="columnheader">Model</span>
            <span role="columnheader" className="sr-only">
              Outcome
            </span>
            <span role="columnheader">Official</span>
            <span role="columnheader" className="text-right">
              Pts
            </span>
          </div>

          {rows.map((r) => {
            const mark = MARKS[r.kind];
            return (
              <div
                role="row"
                key={r.position}
                className={`grid grid-cols-[1.75rem_1fr_1.25rem_1fr_2.75rem] items-center gap-x-2 border-b border-line/60 px-3 py-2.5 last:border-b-0 sm:gap-x-4 sm:px-5 ${
                  r.kind === "exact" ? "bg-emerald-400/[0.06]" : ""
                }`}
              >
                <span role="cell" className="font-mono text-ink-mute">
                  {r.position}
                </span>
                <span role="cell" className="min-w-0">
                  <DriverCell driver={r.model} />
                </span>
                <span
                  role="cell"
                  title={mark.label}
                  className={`text-center font-mono ${mark.tone}`}
                >
                  {mark.glyph}
                  <span className="sr-only"> {mark.label}</span>
                </span>
                <span role="cell" className="min-w-0 text-ink-dim">
                  <DriverCell driver={r.official} />
                </span>
                <span
                  role="cell"
                  className={`text-right font-mono tabular-nums ${
                    r.points ? "text-ink" : "text-ink-mute"
                  }`}
                >
                  {r.points ? `+${formatPoints(r.points)}` : "0"}
                </span>
              </div>
            );
          })}
        </div>

        {/* The score used to be set at 18px, in the same line as its label —
            the number the whole section exists to deliver, printed smaller
            than the heading above it. It is a timing-tower total now. */}
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-t border-line bg-glass px-3 py-5 sm:px-5">
          <div>
            <p className="font-mono text-[0.6rem] tracking-[0.14em] text-ink-mute uppercase">
              Model total
            </p>
            <p className="mt-1.5 text-xs text-ink-dim">{tallyLine}</p>
          </div>
          <p className="font-mono text-5xl leading-none font-semibold tabular-nums sm:text-6xl">
            {formatPoints(total)}
          </p>
        </div>
      </div>

      <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-lg font-semibold tracking-tight sm:text-xl">
          Could you have done better?
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/game"
            className="pressable btn-race px-7 py-3 text-sm font-semibold"
          >
            Play the next duel
          </Link>
          <Link
            href={`/game/races/${race.round}`}
            className="group flex items-center gap-2 text-sm font-semibold text-ink-dim underline-offset-4 transition-colors hover:text-ink"
          >
            <span className="group-hover:underline">See the full race</span>
            <Arrow />
          </Link>
        </div>
      </div>
    </section>
  );
}
