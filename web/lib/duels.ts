import type { createClient } from "@/lib/supabase/server";
import { shortName } from "@/lib/format";
import { driverColor } from "@/lib/teams";
import type { SheetBonuses, SheetCall, SheetRow } from "@/components/DuelSheet";
import type {
  Driver,
  ModelEntry,
  RaceResult,
  Score,
  ScoreBreakdown,
  SlotScore,
} from "@/lib/types";

/**
 * The arithmetic behind a duel sheet, and the two other numbers the site
 * keeps re-deriving about the model: how the field did against it in a race,
 * and how it is running over the season.
 *
 * Everything here is pure except `fieldSummary`, which is one RPC.
 */

const BONUS_LABEL: Record<string, string> = {
  podium: "Exact podium",
  perfect: "Perfect top 10",
  dotd: "Driver of the Day",
  safety_car: "Safety-car bet",
};

function firedBonuses(breakdown: ScoreBreakdown | null | undefined): [string, number][] {
  return Object.entries(breakdown?.bonuses ?? {})
    .filter(([, points]) => Number(points) > 0)
    .map(([key, points]) => [BONUS_LABEL[key] ?? key, Number(points)]);
}

function call(
  slot: SlotScore | undefined,
  driverId: string | undefined,
  drivers: Map<string, Driver>,
): SheetCall | null {
  const id = slot?.driver ?? driverId;
  if (!id) return null;
  return {
    name: shortName(id),
    color: driverColor(drivers.get(id)),
    kind: slot?.kind ?? "miss",
    points: Number(slot?.points ?? 0),
  };
}

export interface DuelSheetData {
  rows: SheetRow[];
  bonuses: SheetBonuses;
  totals: { mine: number; model: number };
}

/**
 * A player's scored race against the model's, as the ten rows of a sheet.
 *
 * Both breakdowns are read as stored — `scores.breakdown.slots` and
 * `model_entries.breakdown.slots` — so the sheet shows the race exactly as it
 * was scored, multipliers included, and never re-derives a point.
 */
export function buildSheet(
  score: Pick<Score, "total" | "breakdown">,
  entry: Pick<ModelEntry, "predicted_order" | "breakdown" | "total"> | null,
  result: Pick<RaceResult, "classification"> | null,
  drivers: Map<string, Driver>,
): DuelSheetData {
  const finishers = new Map(
    Object.entries(result?.classification ?? {}).map(([id, p]) => [p, id]),
  );
  const rows: SheetRow[] = Array.from({ length: 10 }, (_, i) => {
    const official = finishers.get(i + 1);
    return {
      position: i + 1,
      mine: call(score.breakdown.slots?.[i], undefined, drivers),
      model: call(entry?.breakdown?.slots?.[i], entry?.predicted_order[i], drivers),
      official: official
        ? { name: shortName(official), color: driverColor(drivers.get(official)) }
        : null,
    };
  });
  return {
    rows,
    bonuses: {
      mine: firedBonuses(score.breakdown),
      model: firedBonuses(entry?.breakdown),
    },
    totals: {
      mine: Number(score.total),
      model: Number(entry?.total ?? score.breakdown.model_total ?? 0),
    },
  };
}

/** How many of the model's ten calls landed where — the tally the home page prints. */
export function tally(slots: SlotScore[] | undefined) {
  const kinds = (slots ?? []).map((s) => s.kind);
  const exact = kinds.filter((k) => k === "exact").length;
  const near = kinds.filter((k) => k === "near").length;
  const inTop10 = kinds.filter((k) => k === "in_top10").length;
  return {
    exact,
    /** Exact or one place off. */
    withinOne: exact + near,
    /** Anywhere in the actual top 10. */
    top10: exact + near + inTop10,
  };
}

export interface FieldSummary {
  players: number;
  beat: number;
  drew: number;
}

/**
 * Per race, how the field did against the model (migration 0011). Keyed by
 * race id. Empty — never an error — when the function is not there yet, so a
 * deploy that lands before the migration loses a column, not a page.
 */
export async function fieldSummary(
  supabase: Awaited<ReturnType<typeof createClient>>,
  season: number,
): Promise<Map<number, FieldSummary>> {
  const { data, error } = await supabase.rpc("race_field_summary", {
    p_season: season,
  });
  if (error || !data) return new Map();
  return new Map(
    (data as ({ race_id: number } & FieldSummary)[]).map((r) => [
      r.race_id,
      { players: r.players, beat: r.beat, drew: r.drew },
    ]),
  );
}

/** "3 of 6 beat it" — or nothing, when nobody entered. */
export function fieldLine(summary: FieldSummary | undefined): string | null {
  if (!summary || summary.players === 0) return null;
  const who = summary.players === 1 ? "player" : "players";
  if (summary.beat === 0) {
    return `Unbeaten by ${summary.players} ${who}`;
  }
  return `Beaten by ${summary.beat} of ${summary.players} ${who}`;
}

export interface ModelForm {
  races: number;
  average: number;
  best: { points: number; raceName: string } | null;
}

/**
 * The model over the season it has actually played — every scored entry,
 * whether or not it counts in the standings (that flag is about the table,
 * this is about the machine's form).
 */
export function modelForm(
  entries: Pick<ModelEntry, "race_id" | "total">[],
  races: Map<number, { name: string }>,
): ModelForm | null {
  const scored = entries.filter(
    (e) => e.total !== null && races.has(e.race_id),
  );
  if (scored.length === 0) return null;
  const best = scored.reduce((a, b) => (Number(b.total) > Number(a.total) ? b : a));
  return {
    races: scored.length,
    average:
      scored.reduce((sum, e) => sum + Number(e.total), 0) / scored.length,
    best: {
      points: Number(best.total),
      raceName: races.get(best.race_id)!.name,
    },
  };
}
