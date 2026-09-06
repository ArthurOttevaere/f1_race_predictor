import { cache } from "react";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CURRENT_SEASON } from "@/lib/constants";
import { createClient, getUser } from "@/lib/supabase/server";

/**
 * The signed-in player's own profile row, deduplicated per request — the nav,
 * the game layout and the page all want it.
 */
export const getOwnProfile = cache(async () => {
  const user = await getUser();
  if (!user) return null;
  const supabase = await createClient();
  // `select("*")` rather than naming username_set: the column arrives with
  // migration 0002, and a deploy that lands first must not break the nav.
  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  return (data as { id: string; username: string; username_set?: boolean } | null) ?? null;
});

/**
 * Whether the player still owes us their details, deduplicated per request.
 *
 * A query error means the 0003 migration hasn't landed on this project yet —
 * report "nothing owed" rather than trapping every account in a /welcome loop
 * it has no table to write to.
 */
export const hasDetails = cache(async (): Promise<boolean> => {
  const user = await getUser();
  if (!user) return true;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("player_details")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();
  return error ? true : Boolean(data);
});

/** Only ever bounce back inside the app. */
export function safePath(next: string | undefined | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/game";
}

/**
 * Where a freshly authenticated session should land.
 *
 * Google and magic-link sign-ups never see the sign-up form, so their profile
 * carries a suggested username rather than a chosen one and no details row.
 * Those accounts get one pass through /welcome before anything else. Takes the
 * client that just performed the exchange, whose session is already in memory.
 */
export async function destinationFor(
  supabase: SupabaseClient,
  next: string | undefined | null,
): Promise<string> {
  const safe = safePath(next);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return safe;

  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  // A missing profile means the signup trigger hasn't landed yet: don't trap
  // anyone in a redirect loop over it.
  if (data?.username_set === false) {
    return `/welcome?next=${encodeURIComponent(safe)}`;
  }

  const { data: details, error } = await supabase
    .from("player_details")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  return !error && !details
    ? `/welcome?next=${encodeURIComponent(safe)}`
    : safe;
}

/** True when the signed-in player still carries an auto-generated username. */
export async function needsUsername(): Promise<boolean> {
  return (await getOwnProfile())?.username_set === false;
}

/** True when /welcome still has something to ask the signed-in player. */
export async function needsOnboarding(): Promise<boolean> {
  if (await needsUsername()) return true;
  if (!(await hasDetails())) return true;
  return await needsPicksPrompt();
}

/** The cookie a player sets by saying "later" to the championship call. */
export const PICKS_LATER_COOKIE = "picks_later";

/**
 * Whether /welcome should still put the championship call in front of the
 * signed-in player: no pick for the season, and no "later" on record.
 *
 * The pick is a season-long bet nobody should be forced into on their first
 * screen, so the step is skippable — but a skipped step that never returns
 * is a step that did not exist. "Later" lives in a cookie for thirty days,
 * after which the screen comes back once; the profile and /game carry the
 * reminder in between, deduplicated per request like the rest.
 */
export const needsPicksPrompt = cache(async (): Promise<boolean> => {
  const user = await getUser();
  if (!user) return false;
  const jar = await cookies();
  if (jar.get(PICKS_LATER_COOKIE)) return false;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("season_picks")
    .select("season")
    .eq("user_id", user.id)
    .eq("season", CURRENT_SEASON)
    .maybeSingle();
  return !error && !data;
});
