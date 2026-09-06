import Link from "next/link";
import Wordmark from "@/components/Wordmark";
import { redirect } from "next/navigation";
import { createClient, getUser } from "@/lib/supabase/server";
import { hasDetails, needsPicksPrompt } from "@/lib/auth";
import { CURRENT_SEASON } from "@/lib/constants";
import { teamColor } from "@/lib/teams";
import type { Driver } from "@/lib/types";
import UsernameForm from "@/components/UsernameForm";
import PlayerDetailsForm from "@/components/PlayerDetailsForm";
import SeasonPicksForm from "@/components/SeasonPicksForm";

export const metadata = { title: "Welcome" };

/** Only ever bounce back inside the app. */
function safeNext(next: string | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/game";
}

export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const user = await getUser();
  if (!user) redirect("/login");

  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  const needsName = data?.username_set === false;
  const needsDetails = !(await hasDetails());
  const needsPicks = await needsPicksPrompt();

  // Nothing left to ask.
  if (!needsName && !needsDetails && !needsPicks) redirect(safeNext(next));

  // The name goes first — it's the one thing other players see. Claiming it
  // comes back here, where only the steps still standing remain.
  const backHere = `/welcome?next=${encodeURIComponent(safeNext(next))}`;

  // Counts what this account is still going to be asked — an email sign-up
  // already gave its details, so it never sees a "3".
  const steps = [needsName, needsDetails, needsPicks].filter(Boolean).length;
  const eyebrow = steps > 1 ? `${steps} steps to go` : "One last thing";

  // The championship step needs the grid to choose from — only read when it
  // is the step on screen.
  const roster: Driver[] =
    !needsName && !needsDetails && needsPicks
      ? (((
          await supabase
            .from("drivers")
            .select("*")
            .eq("season", CURRENT_SEASON)
            .eq("active", true)
            .order("team")
        ).data as Driver[]) ?? [])
      : [];
  const teams = [...new Set(roster.map((d) => d.team))].map((team) => ({
    team,
    color: teamColor(team, roster),
  }));

  return (
    <main className="relative flex min-h-svh flex-col items-center justify-center overflow-hidden px-4 py-16">
      <div className="page-glow" />

      <Link
        href="/"
        className="mb-8"
      >
        <Wordmark />
      </Link>

      <div
        className={`glass-card w-full p-6 sm:p-8 ${
          needsName || needsDetails ? "max-w-sm" : "max-w-2xl"
        }`}
      >
        <p className="font-mono text-xs tracking-[0.2em] text-race uppercase">
          {eyebrow}
        </p>

        {needsName ? (
          <>
            <h1 className="display mt-2 text-xl font-extrabold tracking-tight">Pick your name</h1>
            <p className="mt-2 text-sm text-ink-dim">
              This is how you appear on the standings, in leagues and on your
              profile. You can change it later from your profile.
            </p>

            <div className="mt-6">
              <UsernameForm
                initial={data?.username ?? ""}
                mode="choose"
                next={backHere}
              />
            </div>
          </>
        ) : needsDetails ? (
          <>
            <h1 className="display mt-2 text-xl font-extrabold tracking-tight">Tell us who you are</h1>
            <p className="mt-2 text-sm text-ink-dim">
              So we know who&apos;s actually playing. This stays private — your
              username is the only thing other players ever see.
            </p>

            <div className="mt-6">
              {/* Back here rather than straight on: the championship call is
                  the step after this one, and it only shows once the details
                  are in. */}
              <PlayerDetailsForm next={needsPicks ? backHere : safeNext(next)} />
            </div>

            <p className="mt-4 text-center text-xs text-ink-mute">
              <Link href="/privacy" className="underline">
                What we do with your data
              </Link>
            </p>
          </>
        ) : (
          <>
            {/* ── The championship call ──
                The season-long bet, put in front of every new account once,
                before the first top 10: every week it is left uncalled the
                bonus it can pay shrinks (GAME_DESIGN §2.3), and three of the
                first eight players never found the page on their own.
                Skippable, because a pick locked for the season should not be
                made under a redirect — "later" is a real answer and it comes
                back in thirty days (lib/auth `needsPicksPrompt`). */}
            <h1 className="display mt-2 text-2xl font-extrabold tracking-tight">
              Call your {CURRENT_SEASON} world champions
            </h1>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-dim">
              One driver, one constructor, locked the moment you confirm. The
              bigger the outsider and the earlier the call, the bigger the
              bonus at the final flag — it shrinks with every Grand Prix you
              wait. Your profile wears your pick&apos;s colours all season.
            </p>

            <SeasonPicksForm season={CURRENT_SEASON} roster={roster} teams={teams} />

            <form
              action="/welcome/later"
              method="post"
              className="mt-6 flex items-center justify-between gap-4 border-t border-line pt-5"
            >
              <input type="hidden" name="next" value={safeNext(next)} />
              <p className="text-xs text-ink-mute">
                Not sure yet? You can call them any time from{" "}
                <span className="text-ink-dim">The game</span>.
              </p>
              <button
                type="submit"
                className="pressable glass-chip shrink-0 rounded-control px-4 py-2 text-sm text-ink-dim transition-colors hover:border-line-hi hover:text-ink"
              >
                Later
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
