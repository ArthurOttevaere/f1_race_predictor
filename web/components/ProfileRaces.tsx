"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Arrow from "@/components/Arrow";
import DuelSheet from "@/components/DuelSheet";
import type { DuelSheetData } from "@/lib/duels";
import { formatPoints } from "@/lib/format";

export interface ProfileRace {
  round: number;
  name: string;
  outcome: "W" | "D" | "L";
  total: number;
  modelTotal: number;
  sheet: DuelSheetData;
}

const TONE = {
  W: "text-emerald-400",
  D: "text-amber-300",
  L: "text-race",
} as const;

/**
 * The season's duels, newest first, each one opening into its sheet.
 *
 * The list used to be a link per race to the race page — which is the
 * *race's* page, with the field and the model and, for a visitor, none of
 * this player's calls on it. The question a profile asks is "what did they
 * call, and what did the machine call?", and the answer is a sheet, here,
 * under the row. One open at a time: two open sheets is forty rows.
 *
 * `#r13` in the URL opens round 13 on arrival — the race page's field links
 * here with it, so "see their race" lands on the race and not on the cover.
 */
export default function ProfileRaces({
  races,
  playerLabel,
}: {
  races: ProfileRace[];
  playerLabel: string;
}) {
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    const m = /^#r(\d+)$/.exec(window.location.hash);
    if (!m) return;
    const round = Number(m[1]);
    if (!races.some((r) => r.round === round)) return;
    // Opened on the next frame, not in the effect body (the server rendered
    // every row closed, and a hash is only known on the client); scrolled
    // on the frame after that, once the sheet exists — the hash the browser
    // resolved on load pointed at a closed row.
    const frame = requestAnimationFrame(() => {
      setOpen(round);
      requestAnimationFrame(() => {
        document.getElementById(`r${round}`)?.scrollIntoView({ block: "start" });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [races]);

  const cols =
    "grid grid-cols-[2rem_1.5rem_minmax(0,1fr)_4rem_1.25rem] items-center gap-x-3 sm:grid-cols-[2.25rem_1.5rem_minmax(0,1fr)_4rem_4rem_1.25rem] sm:gap-x-4";

  return (
    <div>
      <div
        aria-hidden
        className={`${cols} px-2 pb-2 font-mono text-[0.6rem] tracking-wider text-ink-mute uppercase`}
      >
        <span>Rd</span>
        <span />
        <span>Grand Prix</span>
        <span className="hidden text-right sm:block">Model</span>
        <span className="text-right">Pts</span>
        <span />
      </div>

      <ol className="border-b border-line">
        {races.map((r) => {
          const isOpen = open === r.round;
          return (
            <li
              key={r.round}
              id={`r${r.round}`}
              className="scroll-mt-28 border-t border-line"
            >
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={`sheet-${r.round}`}
                onClick={() => setOpen(isOpen ? null : r.round)}
                className={`${cols} w-full rounded-control px-2 py-2.5 text-left transition-colors hover:bg-glass`}
              >
                <span className="font-mono text-xs text-ink-mute tabular-nums">
                  {String(r.round).padStart(2, "0")}
                </span>
                <span
                  className={`text-center font-mono text-sm font-semibold ${TONE[r.outcome]}`}
                >
                  {r.outcome}
                </span>
                <span className="truncate text-sm">
                  {r.name.replace(" Grand Prix", "")}
                </span>
                <span className="hidden text-right font-mono text-xs text-ink-mute tabular-nums sm:block">
                  {formatPoints(r.modelTotal)}
                </span>
                <span className="text-right font-mono text-sm tabular-nums">
                  {formatPoints(r.total)}
                </span>
                {/* A chevron, not a word: the row is the control. */}
                <svg
                  aria-hidden
                  viewBox="0 0 16 16"
                  className={`size-4 text-ink-mute transition-transform ${
                    isOpen ? "rotate-180" : ""
                  }`}
                >
                  <path
                    d="M4 6l4 4 4-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>

              {isOpen && (
                <div id={`sheet-${r.round}`} className="px-1 pt-1 pb-5 sm:px-2">
                  <DuelSheet
                    rows={r.sheet.rows}
                    bonuses={r.sheet.bonuses}
                    totals={r.sheet.totals}
                    playerLabel={playerLabel}
                  />
                  <Link
                    href={`/game/races/${r.round}`}
                    className="pressable group mt-4 inline-flex items-center gap-2 text-xs font-semibold text-ink-dim transition-colors hover:text-ink"
                  >
                    <span className="group-hover:underline">
                      The whole race — the field, why each call scored
                    </span>
                    <Arrow />
                  </Link>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
