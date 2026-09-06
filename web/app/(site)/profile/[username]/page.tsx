import { notFound } from "next/navigation";
import { createClient, getUser } from "@/lib/supabase/server";
import { CURRENT_SEASON } from "@/lib/constants";
import { formatPoints } from "@/lib/format";
import { pickValue } from "@/lib/champions";
import { driverColor, seasonPickColor, teamColor } from "@/lib/teams";
import type {
  Driver,
  ModelEntry,
  PlayerDetails,
  Profile,
  Race,
  RaceResult,
  Score,
  SeasonPick,
} from "@/lib/types";
import { buildSheet } from "@/lib/duels";
import { type CurvePoint } from "@/components/PointsCurve";
import { type ProfileRace } from "@/components/ProfileRaces";
import ProfileView from "@/components/ProfileView";

export const revalidate = 120;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  return { title: username };
}

/** "March 2026" — the join date, at the resolution anyone actually cares about. */
function joinedOn(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });
}

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const supabase = await createClient();

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("*")
    .eq("username", username)
    .maybeSingle();
  const profile = profileRow as Profile | null;
  if (!profile) notFound();

  const viewer = await getUser();
  const isOwner = viewer?.id === profile.id;

  const nowIso = new Date().toISOString();
  const [
    { data: pickRow },
    { data: scoreRows },
    { data: raceRows },
    { data: rosterRows },
    { data: nextRaces },
  ] = await Promise.all([
    supabase
      .from("season_picks")
      .select("*")
      .eq("user_id", profile.id)
      .eq("season", CURRENT_SEASON)
      .maybeSingle(),
    supabase.from("scores").select("*").eq("user_id", profile.id),
    supabase.from("races").select("*").eq("season", CURRENT_SEASON),
    supabase.from("drivers").select("*").eq("season", CURRENT_SEASON),
    // The Grand Prix still open — only the owner is nudged about it, but the
    // read is one row and it settles whether there is a weekend at all.
    isOwner
      ? supabase
          .from("races")
          .select("id, round, name, race_at")
          .eq("season", CURRENT_SEASON)
          .eq("status", "scheduled")
          .gt("race_at", nowIso)
          .order("race_at", { ascending: true })
          .limit(1)
      : Promise.resolve({ data: null }),
  ]);

  const pick = pickRow as SeasonPick | null;
  const roster = (rosterRows as Driver[]) ?? [];
  const races = new Map(((raceRows as Race[]) ?? []).map((r) => [r.id, r]));
  const byDriverId = new Map(roster.map((d) => [d.driver_id, d]));

  const roundOf = (raceId: number) => races.get(raceId)!.round;

  // Oldest first — the order the form strip and the curve both read in. The
  // duel history below reverses it, because "what happened last time?" is the
  // question that list answers.
  const chrono = ((scoreRows as Score[]) ?? [])
    .filter((s) => races.has(s.race_id))
    .sort((a, b) => roundOf(a.race_id) - roundOf(b.race_id));
  const racedIds = chrono.map((s) => s.race_id);

  const nextRace =
    ((nextRaces as Pick<Race, "id" | "round" | "name" | "race_at">[] | null)?.[0]) ??
    null;

  // Second wave, on what the first told us: the model's side of every duel
  // this player ran and the official result, both public once a race has
  // locked (migration 0009) — and, for the owner, whether this weekend's top
  // 10 is in and the private details row (RLS would hand a visitor nothing
  // for either, so neither is asked for on someone else's profile).
  const [{ data: entryRows }, { data: resultRows }, { data: myPredRows }, detailsRes] =
    await Promise.all([
      racedIds.length
        ? supabase
            .from("model_entries")
            .select("race_id, predicted_order, breakdown, total")
            .in("race_id", racedIds)
        : Promise.resolve({ data: [] }),
      racedIds.length
        ? supabase
            .from("results")
            .select("race_id, classification")
            .in("race_id", racedIds)
        : Promise.resolve({ data: [] }),
      isOwner && nextRace
        ? supabase
            .from("predictions")
            .select("race_id")
            .eq("user_id", profile.id)
            .eq("race_id", nextRace.id)
        : Promise.resolve({ data: [] }),
      isOwner
        ? supabase.from("player_details").select("*").eq("id", profile.id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
  const details = (detailsRes.data as PlayerDetails | null) ?? null;

  const entries = new Map(
    ((entryRows as Pick<ModelEntry, "race_id" | "predicted_order" | "breakdown" | "total">[]) ?? [])
      .map((e) => [e.race_id, e]),
  );
  const results = new Map(
    ((resultRows as Pick<RaceResult, "race_id" | "classification">[]) ?? []).map(
      (r) => [r.race_id, r],
    ),
  );

  // Newest first: "what happened last time?" is the question the list answers.
  const duels: ProfileRace[] = [...chrono].reverse().map((s) => {
    const race = races.get(s.race_id)!;
    return {
      round: race.round,
      name: race.name,
      outcome: s.beat_model ? "W" : s.drew_model ? "D" : "L",
      total: Number(s.total),
      modelTotal: Number(s.breakdown.model_total ?? 0),
      sheet: buildSheet(s, entries.get(s.race_id) ?? null, results.get(s.race_id) ?? null, byDriverId),
    };
  });

  // The owner's weekend: the open Grand Prix, and whether their top 10 is in.
  const weekend =
    isOwner && nextRace?.race_at
      ? {
          round: nextRace.round,
          name: nextRace.name,
          raceAt: nextRace.race_at,
          entered: ((myPredRows as { race_id: number }[] | null) ?? []).length > 0,
        }
      : null;

  const total =
    chrono.reduce((sum, s) => sum + Number(s.total), 0) +
    Number(pick?.awarded_points ?? 0);
  const wins = chrono.filter((s) => s.beat_model).length;
  const draws = chrono.filter((s) => s.drew_model).length;
  const losses = chrono.length - wins - draws;
  const best = chrono.reduce<Score | null>(
    (acc, s) => (acc === null || s.total > acc.total ? s : acc),
    null,
  );

  // Running totals, race by race. The championship bonus is deliberately not
  // in here: it lands in one lump at season end and would draw a cliff that
  // says nothing about how the season was actually raced.
  const curve: CurvePoint[] = [];
  for (const s of chrono) {
    const previous = curve[curve.length - 1];
    curve.push({
      round: roundOf(s.race_id),
      you: (previous?.you ?? 0) + Number(s.total),
      model: (previous?.model ?? 0) + Number(s.breakdown.model_total ?? 0),
      // The last five of these are marked on the line — the form strip that
      // used to sit above the curve, put where the results happened.
      outcome: s.beat_model ? "W" : s.drew_model ? "D" : "L",
    });
  }

  // The profile's colour comes from the championship call, never from the
  // site's red: a roster row with no `team_color` used to make every profile
  // look like a Ferrari pick. `seasonPickColor` is the floor both halves fall
  // back to.
  const championDriver = pick ? (byDriverId.get(pick.champion_driver) ?? null) : null;
  const base = seasonPickColor(pick, roster);
  const driverPaint = championDriver ? driverColor(championDriver, base) : base;
  const teamPaint = pick ? teamColor(pick.champion_team, roster, base) : base;
  const value = pick ? pickValue(pick) : null;

  // Migration 0010. Absent column → "driver", which is also the default: the
  // portrait of that driver is already the face of the page.
  const themeChoice = profile.theme === "team" ? "team" : "driver";
  const paint = themeChoice === "team" ? teamPaint : driverPaint;

  const stats: [label: string, value: string][] = [
    ["Season points", formatPoints(total)],
    ["Best race", best ? formatPoints(Number(best.total)) : "—"],
    ["In the paddock since", joinedOn(profile.created_at)],
  ];

  return (
    <ProfileView
      profile={profile}
      isOwner={isOwner}
      details={details}
      pick={pick}
      value={value}
      championDriver={championDriver}
      driverPaint={driverPaint}
      teamPaint={teamPaint}
      paint={paint}
      themeChoice={themeChoice}
      chrono={chrono}
      duels={duels}
      weekend={weekend}
      curve={curve}
      wins={wins}
      draws={draws}
      losses={losses}
      stats={stats}
      joinedOn={joinedOn}
    />
  );
}
