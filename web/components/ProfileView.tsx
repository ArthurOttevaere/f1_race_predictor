import Link from "next/link";
import Arrow from "@/components/Arrow";
import Countdown from "@/components/Countdown";
import DeleteAccount from "@/components/DeleteAccount";
import PickStub from "@/components/PickStub";
import PointsCurve, { type CurvePoint } from "@/components/PointsCurve";
import ProfileAvatar from "@/components/ProfileAvatar";
import ProfileEditPanel from "@/components/ProfileEditPanel";
import ProfileRaces, { type ProfileRace } from "@/components/ProfileRaces";
import { formatPoints, shortName } from "@/lib/format";
import { tint } from "@/lib/teams";
import type { PickValue } from "@/lib/champions";
import type { Driver, Score, SeasonPick } from "@/lib/types";

export interface ProfileViewProps {
  profile: { username: string; created_at: string };
  isOwner: boolean;
  /** The owner's private row, never fetched for a visitor. */
  details: {
    first_name: string;
    last_name: string;
    country: string | null;
    birth_year: number | null;
  } | null;
  pick: SeasonPick | null;
  value: PickValue | null;
  championDriver: Driver | null;
  /** The two halves of the call, resolved through lib/teams. */
  driverPaint: string;
  teamPaint: string;
  /** Whichever of the two the owner chose to be painted in (migration 0010). */
  paint: string;
  themeChoice: "driver" | "team";
  /** Oldest first — the order the curve reads in. */
  chrono: Score[];
  /** Newest first — every duel raced, each with its sheet. */
  duels: ProfileRace[];
  /** The owner's open Grand Prix, and whether their top 10 is in. Null for a visitor. */
  weekend: { round: number; name: string; raceAt: string; entered: boolean } | null;
  curve: CurvePoint[];
  wins: number;
  draws: number;
  losses: number;
  stats: [label: string, value: string][];
  joinedOn: (iso: string) => string;
}

/**
 * The profile, from the cover down.
 *
 * Everything here is presentational: the page above it does the reading and
 * the arithmetic, which is also what lets this be rendered from fixtures when
 * the local database is a placeholder.
 */
export default function ProfileView({
  profile,
  isOwner,
  details,
  pick,
  value,
  championDriver,
  driverPaint,
  teamPaint,
  paint,
  themeChoice,
  chrono,
  duels,
  weekend,
  curve,
  wins,
  draws,
  losses,
  stats,
  joinedOn,
}: ProfileViewProps) {
  return (
    <main className="mx-auto w-[min(64rem,calc(100%-2rem))] flex-1 pt-24 pb-8 sm:pt-28">
        {/* ── Identity ── */}
        <header className="glass-card overflow-hidden">
          {/* Cover. Everything about it is the chosen colour except the grid —
              the driver's by default, the constructor's if the owner said so
              (migration 0010). */}
          <div
            className="relative h-32 sm:h-44"
            style={{
              backgroundImage: `
                radial-gradient(42rem 22rem at 18% 130%, ${tint(paint, 0.5)}, transparent 70%),
                radial-gradient(30rem 16rem at 88% -30%, ${tint(paint, 0.28)}, transparent 72%),
                linear-gradient(180deg, ${tint(paint, 0.14)}, transparent)
              `,
            }}
          >
            <div aria-hidden className="cover-grid" />
            <div
              aria-hidden
              className="absolute inset-x-0 top-0 h-1"
              style={{
                background: `linear-gradient(90deg, ${paint}, ${tint(paint, 0.15)} 55%, transparent)`,
              }}
            />
          </div>

          <div className="px-5 pb-6 sm:px-8 sm:pb-7">
            {/* The avatar climbs into the cover; the owner's one button sits on
                the same baseline, which is where every profile page puts it. */}
            <div className="flex items-end justify-between gap-4">
              <div className="-mt-16 sm:-mt-20">
                <ProfileAvatar
                  driverId={pick?.champion_driver ?? null}
                  username={profile.username}
                  color={paint}
                />
              </div>
              {isOwner && (
                <ProfileEditPanel
                  username={profile.username}
                  details={{
                    firstName: details?.first_name ?? "",
                    lastName: details?.last_name ?? "",
                    country: details?.country ?? "",
                    birthYear: details?.birth_year ? String(details.birth_year) : "",
                  }}
                  theme={
                    pick
                      ? {
                          value: themeChoice,
                          driverColor: driverPaint,
                          teamColor: teamPaint,
                          driverLabel:
                            championDriver?.full_name ??
                            shortName(pick.champion_driver),
                          teamLabel: pick.champion_team,
                        }
                      : undefined
                  }
                />
              )}
            </div>

            {/* The country used to sit here as a flag emoji, visible to its
                owner alone. An ornament nobody else can see is a setting that
                escaped into the layout, and a colour emoji was the one thing on
                the page that came from outside the charte. The country is still
                collected — it is simply private, and stays that way. */}
            <h1 className="display mt-4 text-4xl font-extrabold tracking-tight sm:text-5xl">
              {profile.username}
            </h1>

            <p className="mt-2 text-sm text-ink-mute">
              In the paddock since {joinedOn(profile.created_at)}
              {chrono.length > 0 && ` · ${chrono.length} duels raced`}
            </p>
          </div>

          {/* ── The record, and the rest ──────────────────────────────────
              Four equal figures used to sit here — season points, record,
              races, best race — which is the site's third centred stat row and,
              worse, four values of equal weight when only one of them is the
              game. The duel record is the game; the other three are context, and
              they read as a spec sheet (§7.11). */}
          <div className="grid gap-6 border-t border-line px-5 py-6 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-12 sm:px-8 sm:py-7">
            <div>
              {chrono.length > 0 ? (
                <>
                  <p className="font-mono text-5xl leading-none font-semibold tracking-tight tabular-nums sm:text-6xl">
                    <span className="text-emerald-400">{wins}</span>
                    <span className="text-ink-mute">–</span>
                    <span className="text-amber-300">{draws}</span>
                    <span className="text-ink-mute">–</span>
                    <span className="text-race">{losses}</span>
                  </p>
                  <p className="mt-2.5 font-mono text-[0.65rem] tracking-[0.18em] text-ink-mute uppercase">
                    Against the model · {chrono.length}{" "}
                    {chrono.length === 1 ? "duel" : "duels"}
                  </p>
                </>
              ) : (
                <>
                  <p className="display text-2xl font-extrabold tracking-tight">
                    No duels yet
                  </p>
                  <p className="mt-2 text-sm text-ink-mute">
                    The record starts at the first scored Grand Prix.
                  </p>
                </>
              )}
            </div>

            <dl className="sm:border-l sm:border-line sm:pl-12">
              {stats.map(([label, figure]) => (
                <div
                  key={label}
                  className="flex items-baseline justify-between gap-6 border-t border-line py-2.5 first:border-t-0 first:pt-0 sm:py-3"
                >
                  <dt className="font-mono text-[0.6rem] tracking-[0.16em] text-ink-mute uppercase">
                    {label}
                  </dt>
                  <dd className="font-mono text-sm text-ink-dim tabular-nums">
                    {figure}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </header>

        {/* ── This weekend, for its owner ────────────────────────────────────
            A profile is where a player goes to look at themselves, and the
            most useful thing it can say about them on a Friday is that their
            top 10 for Sunday is not in. Nothing for a visitor: somebody else's
            unentered race is not their business, and not a call to action. */}
        {weekend && !weekend.entered && (
          <Link
            href="/game"
            className="pressable glass-card group mt-6 flex flex-col gap-3 border-race/40 px-5 py-4 transition-colors hover:border-race/70 sm:flex-row sm:items-center sm:justify-between sm:px-6"
          >
            <div>
              <p className="font-mono text-xs tracking-[0.2em] text-race uppercase">
                Round {weekend.round} · not entered
              </p>
              <p className="display mt-1 text-lg font-extrabold tracking-tight">
                Your top 10 for the {weekend.name} isn&apos;t in.
              </p>
              <Countdown
                to={weekend.raceAt}
                label="Lights out in"
                className="mt-1.5"
              />
            </div>
            <span className="flex shrink-0 items-center gap-2 text-sm font-semibold text-race">
              Make your calls
              <Arrow />
            </span>
          </Link>
        )}

        {/* ── The call that paints this page ────────────────────────────────
            It used to be said twice: two coloured chips under the username, and
            the same two names again in two cards below. The chips are gone —
            the call is told once, here, where there is room to draw it as what
            it is. See PickStub.

            Without one, the section still exists. For the owner it is the
            pitch — a season-long bet with a bonus that shrinks every week they
            leave it, which is the one honest reason to hurry; for a visitor
            it is a line, because the absence is part of who this player is
            this season and a page that skipped it would read as a page with a
            hole in it. */}
        {!pick && (
          <section className="mt-10">
            <h2 className="font-mono text-xs tracking-[0.2em] text-ink-dim uppercase">
              Championship call
            </h2>
            {isOwner ? (
              <Link
                href="/game/picks"
                className="pressable glass-card group mt-5 flex flex-col gap-4 border-race/40 p-5 transition-colors hover:border-race/70 sm:flex-row sm:items-center sm:justify-between sm:p-6"
              >
                <div>
                  <p className="display text-xl font-extrabold tracking-tight sm:text-2xl">
                    You haven&apos;t called your world champions.
                  </p>
                  <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-dim">
                    One driver, one constructor, locked for the season. The
                    bigger the outsider and the earlier the call, the bigger
                    the bonus at the final flag — and it shrinks with every
                    Grand Prix you wait. Your profile wears the colours you
                    choose.
                  </p>
                </div>
                <span className="flex shrink-0 items-center gap-2 text-sm font-semibold text-race">
                  Call them now
                  <Arrow />
                </span>
              </Link>
            ) : (
              <p className="mt-4 text-sm text-ink-mute">
                No championship call this season — yet.
              </p>
            )}
          </section>
        )}

        {pick && value && (
          <section className="mt-10">
            <h2 className="font-mono text-xs tracking-[0.2em] text-ink-dim uppercase">
              Championship call
            </h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-2 sm:gap-5">
              <PickStub
                kind="driver"
                driver={championDriver}
                driverId={pick.champion_driver}
                color={driverPaint}
                lockedAt={pick.locked_at}
                tier={value.driverTier}
                prorate={value.prorate}
                worth={value.driver}
                settled={value.settled}
              />
              <PickStub
                kind="team"
                team={pick.champion_team}
                color={teamPaint}
                lockedAt={pick.locked_at}
                tier={value.teamTier}
                prorate={value.prorate}
                worth={value.team}
                settled={value.settled}
              />
            </div>

            <p className="mt-4 text-xs leading-relaxed text-ink-mute">
              {value.settled ? (
                <>
                  Settled:{" "}
                  <span className="font-mono text-ink-dim">
                    {formatPoints(value.awarded ?? 0)}
                  </span>{" "}
                  points banked from the championship call.
                </>
              ) : (
                <>
                  Locked for good, win or lose. Both halves settle at season end,
                  prorated to how much of it was still to run when you called
                  them.
                </>
              )}
            </p>
          </section>
        )}

        {/* ── The season ────────────────────────────────────────────────────
            Three blocks used to tell the same story in a row: five coloured
            pills of "recent form", the curve in a card, then the full list of
            duels. The pills were an extract of the list underneath them and the
            last capsules on the site; they are five markers on the line now,
            where the results actually happened, and the history sits beside the
            curve as the table the standings page draws. */}
        <section className="mt-10">
          <h2 className="font-mono text-xs tracking-[0.2em] text-ink-dim uppercase">
            The season
          </h2>

          {chrono.length === 0 ? (
            <p className="mt-4 text-sm text-ink-mute">
              No scored races yet —{" "}
              <Link href="/game" className="text-race underline">
                enter this weekend&apos;s duel
              </Link>
              .
            </p>
          ) : (
            <div
              className={`mt-5 grid gap-10 ${
                curve.length >= 2
                  ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-12"
                  : ""
              }`}
            >
              {curve.length >= 2 && <PointsCurve points={curve} color={paint} />}

              {/* Each row opens into the sheet of that duel — the player's ten
                  calls beside the model's, marked and priced. See
                  ProfileRaces; it used to be a link to the race page, which
                  shows a visitor everything about the race except this
                  player's part in it. */}
              <ProfileRaces
                races={duels}
                playerLabel={isOwner ? "You" : profile.username}
              />
            </div>
          )}
        </section>

        {/* ── Account (owner only) ──────────────────────────────────────────
            Two grey rows of equal weight used to carry two actions that have
            nothing in common. The quiet was right — a permanently red panel is a
            panel nobody reads — but it went one step too far: nothing said the
            second row was of another kind. So the account itself is a spec sheet
            (§7.11), and what cannot be undone lives past a real gap, under a red
            hairline and a mono line naming it. The confirmation is unchanged;
            see DeleteAccount. */}
        {isOwner && (
          <section className="mt-12">
            <h2 className="font-mono text-xs tracking-[0.2em] text-ink-dim uppercase">
              Account
            </h2>

            <dl className="mt-5 border-b border-line">
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-line py-3.5">
                <dt className="font-mono text-[0.6rem] tracking-[0.16em] text-ink-mute uppercase">
                  Username
                </dt>
                <dd className="text-sm">{profile.username}</dd>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-line py-3.5">
                <dt className="font-mono text-[0.6rem] tracking-[0.16em] text-ink-mute uppercase">
                  Member since
                </dt>
                <dd className="font-mono text-sm text-ink-dim">
                  {joinedOn(profile.created_at)}
                </dd>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-line py-2">
                <dt className="font-mono text-[0.6rem] tracking-[0.16em] text-ink-mute uppercase">
                  Private details
                </dt>
                <dd className="flex items-center gap-3 text-sm text-ink-mute">
                  <span className="hidden sm:inline">
                    Name, country, birth year — never public
                  </span>
                  {/* The same panel as the button on the cover, opened from the
                      row that talks about it. */}
                  <ProfileEditPanel
                    variant="row"
                    username={profile.username}
                    details={{
                      firstName: details?.first_name ?? "",
                      lastName: details?.last_name ?? "",
                      country: details?.country ?? "",
                      birthYear: details?.birth_year ? String(details.birth_year) : "",
                    }}
                  />
                </dd>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-line py-2">
                <dt className="font-mono text-[0.6rem] tracking-[0.16em] text-ink-mute uppercase">
                  Session
                </dt>
                <dd>
                  {/* The same control as the one in the nav, drawn the same way,
                      because it is the same action. */}
                  <form action="/auth/signout" method="post">
                    <button
                      type="submit"
                      className="pressable glass-chip shrink-0 rounded-control px-4 py-1.5 text-sm text-ink-dim transition-colors hover:border-line-hi hover:text-ink"
                    >
                      Sign out
                    </button>
                  </form>
                </dd>
              </div>
            </dl>

            <div className="mt-12 border-t border-race/45 pt-3">
              <p className="font-mono text-[0.65rem] tracking-[0.18em] text-race uppercase">
                No way back
              </p>
              <DeleteAccount username={profile.username} />
            </div>
          </section>
        )}
        </main>
  );
}
