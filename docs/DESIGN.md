# The Design System — F1 Duel

> The visual and interaction language of https://f1-duel.com, written down as
> it actually is. Everything here was read out of `web/` rather than invented
> for the document: if a rule appears below, there is code enforcing it, and if
> the code changes, this file is wrong until it is updated.

**Status:** documents `main` as of 2026-08-26, including the F-series
foundation pass (typeface, ground, red split, grain, shadows, weight
hierarchy).
**Scope:** the Next.js site in `web/`. The Flask model platform
(`webapp/static/css/style.css`) is a separate, older surface that shares the
palette and nothing else.
**Maintenance rule:** same as the Almanac's — a change that alters something
described here updates this file in the same PR. See
[§15 Keeping this document true](#15-keeping-this-document-true).

| Related document | Scope |
| --- | --- |
| [`ALMANAC.md`](ALMANAC.md) | The whole system: architecture, jobs, database, deployment. |
| [`GAME_DESIGN.md`](GAME_DESIGN.md) | The game rules. Several visual decisions here exist to express them. |

---

## Table of contents

1. [Principles](#1-principles)
2. [Brand](#2-brand)
3. [Colour](#3-colour)
4. [Typography](#4-typography)
5. [Layout and space](#5-layout-and-space)
6. [Surfaces and materials](#6-surfaces-and-materials)
7. [Components](#7-components)
8. [Motion](#8-motion)
9. [Imagery and icons](#9-imagery-and-icons)
10. [Responsive behaviour](#10-responsive-behaviour)
11. [Accessibility](#11-accessibility)
12. [Data visualisation](#12-data-visualisation)
13. [Voice and content](#13-voice-and-content)
14. [Off-site surfaces](#14-off-site-surfaces)
15. [Keeping this document true](#15-keeping-this-document-true)
16. [Appendix — token reference](#16-appendix--token-reference)

---

## 1. Principles

Six rules explain nearly every decision in the rest of this document. They are
ordered: when two conflict, the earlier one wins.

### 1.1 The rule and the picture are the same thing

The game's central mechanic is that **points are multiplied by how unlikely the
model thought your pick was**. Wherever that rule shows up visually, the visual
*is* the rule — the probability chart's five colour bands are the five
multiplier tiers, not a decorative ramp, so reading the chart teaches the
scoring. Never invent a scale that merely looks like the rule.

### 1.2 Colour is never the only channel

Every quantity is printed as text beside its colour. Every state has a shape or
a word as well as a hue. This is an accessibility floor, but it is also why the
charts survive a phone screen in daylight.

### 1.3 Nothing waits in silence

Any control that fires off work shows a spinner until the work comes back; any
route that can be slow has a `loading.tsx`. There is one spinner
(`components/Spinner.tsx`) and one full-page loader (`components/RaceLoader.tsx`)
— no variants, no exceptions. This is a house rule, not a preference.

### 1.4 Separate with space and type, never with a band

The home page carries no section backgrounds. Two attempts at one — a white
veil (`.zone-fade`), then a blue radial glow (`.zone-glow`) — were both removed
because the reason a section drew the eye was that *only one of them had a
background at all*. A new section is announced by its red eyebrow, its heading
and 6rem of air. The hero's aurora is the single exception, which is what makes
it a signature rather than a motif.

### 1.5 The phone is not a narrower desktop

A table that needs 32–36rem gets a **phone twin**, not a horizontal scrollbar:
iOS draws no bar for overflow, so a column past the edge is a column that does
not exist. Two surfaces are built as twins — the race breakdown and the
standings board. The twin is allowed to show a *different cut* of the data, not
a squeezed one.

The probability matrix was the third, and it is the rule's most useful result:
**the phone cut turned out to be the better chart at every width, and the
desktop one was deleted** (§12.2). Writing for the narrow screen forces the
question "what is actually being asked here", and the answer is not always
narrower — sometimes it is just better.

### 1.6 Comment the decision, not the code

Every non-obvious rule in `web/` carries a comment saying what was tried and
why it lost. That is why this document could be written at all, and it is the
cheapest way to stop a fix from being re-broken. Keep doing it.

---

## 2. Brand

### 2.1 Name and logotype

**F1 Duel.** One component, `components/Wordmark.tsx`, and every appearance of
the name goes through it:

```tsx
<span className="display text-sm font-extrabold tracking-[0.2em] uppercase">
  <span className="text-race">F1</span> Duel
</span>
```

It is set in the **display face** (§4.1) — Archivo at wdth 118, the same width
as every headline — with `F1` in race red and `DUEL` in ink. It was in Geist
Mono until the width axis arrived, which was a category error: mono is this
site's voice for *data* (§4.2), and a name is not data.

Wide letter-spacing, not a wide space between the words: at 14px the expanded
cut needs air or it reads as a bold word rather than as lettering.

It appears in eight places — nav, mobile menu, footer, boot screen, login,
welcome, unsubscribe, 404 — and never any other way. (`TeamWordmark.tsx` is
unrelated: it sets a *constructor's* name in the mono idiom.)

**Since 2026-08-27 there is a logomark, and `Wordmark` is a lockup.**
`components/Logomark.tsx` draws a **D whose counter is a Formula 1 seen from
above, with the start-finish chequer running down the stem.**

**One colour, and a hole.** Everything solid is `currentColor`. The car and
half the chequer are not painted at all: a mask cuts them out of the letter, so
they show *whatever is actually behind the logo* — the page, a glass card, a
red button, a blue banner. On the site's ground the car is `#0a0b10`; on a blue
banner it is blue, with nothing to configure. Painting them `var(--color-bg)`
instead would be right only while the logo sits directly on the page and wrong
the moment it lands on a card or an image. A hole is right everywhere.

Four rules keep it honest.

- **It is inlined, never `<img src>`.** An SVG in an `<img>` is an isolated
  document with no access to the page's `color`, so the letter would render
  black on black and the knockout would show the img's own transparent backdrop
  rather than the surface. The standalone files the platform demands —
  `favicon.ico`, `apple-icon.png`, `public/icon-{192,512}.png` — are baked
  against the site's dark ground for that reason, and are the *only* raster
  copies.
- **The mask is defined once per document,** by `LogoSprite` in the root
  layout, never inside each instance. See §9.7: this is a bug, not a taste.
- **The mark is sized in `em`** (`h-[1.7em]`), so the lockup tracks the type
  size and never needs a second measurement.
- **There are two cuts, and size decides which.** `<Logomark />` is the mark
  alone; `<Logomark withName />` adds the vertical "F1 Duel" that comes with
  the source file. The lettering is about a ninth of the drawing's width, so at
  the 24px the nav gives it the name is three pixels wide — grit on the left
  edge rather than type. Measured at 300 / 96 / 48 / 26px before choosing. The
  named cut therefore appears in exactly one place, the **boot screen**, drawn
  at 120px, where the identity has the whole viewport. Everywhere else the mark
  stands alone beside the Archivo name, which also stops the page printing
  "F1 Duel" twice on one line in two different cuts.

The source file's "Race Prediction Game" line is dropped from both. The
untouched original stays at `public/logo-lockup.svg` for a poster or an
app-store listing, and the site never references it.

**The raster icons are the mark on a red tile.** `favicon.ico`,
`apple-icon.png` and `public/icon-{192,512}.png` are the whole mark, chequer
included, in `#f4f6fa` on a solid `--color-race-deep` (`#c8102e`) ground, at
about 60% of the tile's height.

Two decisions worth keeping. **The red is `race-deep`, not `race`,** because an
icon tile is a *surface* and that is the split those two tokens exist for
(§3.1) — it is also the higher-contrast pair, 5.44:1 against white where bright
red manages 3.53:1. And **only the favicon has its corners rounded.** iOS and
Android mask an app icon themselves, so a pre-rounded PNG is rounded twice and
shows dark corners; those three files are square and full-bleed. A tab favicon
is masked by nobody, so the container has to be in the file: alpha outside a
radius of 22.4% of the side, which is roughly the iOS squircle.

The knockout does the rest of the work — on this tile the car and half the
chequer come out red, with no second drawing and no recolouring.

Coordinates in the mark are rounded to one decimal — 22 kB of path data down to
13 kB, and invisible, because the viewBox is 751 units wide and the mark is
never drawn much above 200 pixels.

### 2.2 What the brand is about

Human versus machine, once a Grand Prix. The tone is **racing broadcast, not
sports-betting app**: confident, dry, specific about numbers, never hyped and
never cute about the odds. See §13.

### 2.3 Motifs

Three, all drawn in CSS, all borrowed from the sport rather than from a UI kit:

| Motif | Where | Meaning |
| --- | --- | --- |
| **Start-light gantry** (`.start-lights`) | Boot screen, full-page loader | Waiting, about to begin |
| **Checkered edge** (`.checker-edge`) | Above the footer, on the race poster | The end of the page as a finish line |
| **Checkered rule** (`.checker-rule`) | The top edge of the last-race card | The end of *a race*. Same two rows, smaller squares, unlit edge — see §6.4 |
| **Circuit trace** (`CircuitTrace.tsx`) | The hero | *This* Sunday. The ornament is a reading of the calendar. |
| **Faint 72px grid** (`.hero-grid`, `.cover-grid`) | Hero, profile cover | Telemetry / technical drawing |
| **Grain** (`.grain`) | Every page, fixed, 3.2% | Tooth. A surface, not a render. |

Use them where they mean something. A start-light gantry that is not a wait, or
a checkered band that is not an ending, is decoration and does not belong.

The grain is the exception: it means nothing, it is everywhere, and that is the
point. See §6.5.

---

## 3. Colour

Dark only. `color-scheme: dark` is declared on `html` and there is no light
theme, no toggle, and no `prefers-color-scheme` branch anywhere in the
stylesheet. Do not add per-component light fallbacks — they would be dead code.

### 3.1 Core tokens

Declared in `web/app/globals.css` under `@theme`, so every one of them is also
a Tailwind utility (`bg-bg`, `text-ink-dim`, `border-line`, …).

| Token | Value | Role |
| --- | --- | --- |
| `--color-bg` | `#0a0b10` | The page. Also the browser chrome (`viewport.themeColor`) and the manifest. |
| `--color-ink` | `#f4f6fa` | Primary text, and the only white in the system. |
| `--color-ink-dim` | `#a7adba` | Body copy, secondary text. |
| `--color-ink-mute` | `#6c7280` | Labels, metadata, disabled, empty states. Also `NEUTRAL_COLOR`. |
| `--color-race` | `#ff1e3c` | The **signal**. Active state, errors, multipliers, eyebrows, emphasis — and the hover of a red button. |
| `--color-race-deep` | `#c8102e` | The **surface**. The resting fill of any red button or large red area. |
| `--color-glass` | `rgb(255 255 255 / 0.045)` | Chip and inert-row fill. |
| `--color-glass-strong` | `rgb(255 255 255 / 0.07)` | The same, one step up — hover, "this is you". |
| `--color-line` | `rgb(255 255 255 / 0.1)` | Default border. |
| `--color-line-hi` | `rgb(255 255 255 / 0.16)` | Border on hover / focus-within. |
| `--color-card` | `rgb(28 31 40 / 0.72)` | The card fill behind `.glass-card`. |

Three greys, one red in two strengths, two membranes and two hairlines. **Do
not add a colour to this table without deleting one.**

Two notes on the values, because both were arrived at rather than picked:

**The ground is `#0a0b10`, not near-black.** `#07080b` is what you get when
nobody chooses a background, and a red sitting on true black has nothing to sit
on. Two points of blue is the whole change and it reads on every page.

**The red splits by area, not by state.** At full saturation `#ff1e3c` is a
signal — perfect for two per cent of a screen, a shout across two hundred
pixels of button. It is also 3.8:1 against white, under the 4.5:1 a button
label needs. `--color-race-deep` is 5.9:1 and unmistakably the same red, so it
takes the fills; `race` is what a button *becomes* under the cursor. The accent
moved into the interaction rather than out of the palette.

### 3.2 Semantic tones

The only hues outside the core palette, and each has exactly one meaning:

| Tone | Class | Means | Used in |
| --- | --- | --- | --- |
| Emerald | `text-emerald-400` (`#34d399` on the poster) | Exact hit, positive margin, won the duel | Race breakdown, standings, poster |
| Amber | `text-amber-300` (`#fbbf24` on the poster) | One place off, a draw, a caution | Race breakdown, poster |
| Race red | `text-race` | Error text, multipliers, the model winning | Everywhere |
| Ink-mute | `text-ink-mute` | Missed, nothing there, not applicable | Everywhere |

Note the deliberate overload: **red is both the brand accent and the failure
tone.** It works because red is never the only signal — an error is a short
sentence, and the model's win is labelled. Do not introduce a separate error
red.

**The timing set — three colours borrowed whole from a qualifying screen.**

| Token | Value | Means |
| --- | --- | --- |
| `--color-sector-purple` | `#b24bf3` | Fastest anyone has gone |
| `--color-sector-green` | `#00e701` | A personal best |
| `--color-sector-yellow` | `#ffd800` | Slower than that |

They exist because a W/D/L triple has no order of its own — emerald, amber and
race red are three categories that happen to sit side by side — where the
mini-sector colours are a **scale the sport has already taught every viewer to
read best → worst at a glance**. `CalibrationRecord` (§12.3) is the only
consumer: the weekends a grid-copying human wins are purple, the draws green,
the ones the model takes yellow.

**They are only ever used together, as that scale.** A lone purple block
somewhere else on the site would mean nothing, and the set costs one real
thing — red means "the model winning" everywhere else (§12.3 says so out loud).
Anything that is a *state* rather than a ranking keeps the emerald/amber/red
row above.

### 3.3 Constructor colours

Team colour is data, not design. `drivers.team_color` comes from FastF1 and is
nullable, so `lib/teams.ts` resolves it in a fixed order and every consumer goes
through one of its helpers:

- `driverColor(driver)` — a driver's stripe, avatar wash, chip.
- `teamColor(team, roster)` — a constructor on its own.
- `seasonPickColor(pick, roster)` — the colour a profile wears all season.
- `tint(color, alpha)` — the *only* way to make a translucent version. Never
  paste an alpha suffix onto a hex string; the database can hand back a
  three-digit hex or an `rgb()` string and that silently produced no colour at
  all.

`NEUTRAL_COLOR` (`#6c7280`) is the last resort. **Red is never a neutral
fallback** — it is Ferrari's colour here, and a Mercedes pick once came out
looking like a Ferrari one because of that.

### 3.4 Probability bands

The one sequential scale in the system. Single hue, low→high, **never a
rainbow**. The five stops are the game's multiplier tiers (`GAME_DESIGN` §2.2),
defined once in **`lib/bands.ts`** — they left `ProbabilityGrid` when `/rules`
needed to draw the rule in the chart's own colours, because a tier that changes
in the game has to have exactly one place to change:

| Probability | Fill | Multiplier |
| --- | --- | --- |
| 30%+ | `rgb(255 30 60 / 0.88)` | ×1 |
| 15–30% | `rgb(255 30 60 / 0.55)` | ×1.5 |
| 5–15% | `rgb(255 30 60 / 0.3)` | ×2 |
| 2–5% | `rgb(255 30 60 / 0.14)` | ×3 |
| under 2% | `rgb(255 255 255 / 0.03)` | ×3 |

Text sits **on top of** its own fill, and it is **light** ink at every band —
counter-intuitive for the brightest one, and checked rather than guessed: the
strongest fill composites to about `#e11b36`, which is 4.9:1 against `#f4f6fa`
and only 4.0:1 against the page black. The middle band is not close — 10:1
light, 1.9:1 dark.

### 3.5 Shadows and glows

Three tokens, declared in `@theme` beside the colours, and nothing hand-rolls a
shadow any more:

| Token | Value | For |
| --- | --- | --- |
| `--shadow-panel` | `0 22px 56px rgb(3 5 16 / 0.62)` | `.glass-card`, desktop. |
| `--shadow-panel-sm` | `0 10px 24px rgb(3 5 16 / 0.44)` | The same card on a phone (§10.3). |
| `--shadow-race` | `0 10px 30px rgb(168 12 40 / 0.38)` | The glow under `.btn-race`, and nowhere else. |

**A shadow takes the hue of what is behind it.** Pure black at low opacity is
the default nobody picked, and it greys a card rather than lifting it — these
are the page ground pushed darker and a touch bluer. The red glow is tinted to
`race-deep`, the colour the button actually is, not to the brighter red it used
to borrow.

The aurora (§6.3) is the only other light source on the site.

---

## 4. Typography

### 4.1 The two faces, and the third that is the first again

| Face | Variable | Loaded as | Carries |
| --- | --- | --- | --- |
| **Archivo** | `--font-archivo` → `font-sans` | `next/font/google`, latin subset, `axes: ["wdth"]` | All prose, buttons, names |
| **Archivo, wdth 118** | `.display` | The same file | Headlines, the wordmark, the nav labels |
| **Geist Mono** | `--font-geist-mono` → `font-mono` | `next/font/google`, latin subset | Every number, label, code, position, timer |

Both families are self-hosted by `next/font`, so there is no external font
request and no FOUT to design around. `-webkit-font-smoothing: antialiased` and
`text-rendering: optimizeLegibility` are set on `body`.

**Why Archivo.** Inter is an excellent typeface and a completely anonymous one:
it is the default of every generated interface, and it says nothing about this
sport or this game. Archivo is a grotesque built to be read small and to be
monumental large, which is the register of pit boards, timing towers and the
name across the top of a livery.

**One family, two widths.** Google ships Archivo variable on both `wdth`
(62–125) and `wght` (100–900), so the display voice is the *same file* opened
along its width axis — no second family, no second request. The served
`@font-face` carries `font-stretch: 62% 125%`; if that line ever disappears
from the build, the width axis went with it and `.display` silently stops
doing anything.

```css
.display {
  font-variation-settings: "wdth" 118;
}
```

Width only. Tracking stays with the utility on each element — a 72px headline
and a 14px uppercase wordmark want opposite amounts of it, and `.display` is
unlayered, so a `letter-spacing` in here would beat every `tracking-*` it
touched.

### 4.2 The mono rule

**Mono means "this is data."** Points, percentages, multipliers, countdowns,
positions (`P4`), round numbers, driver codes, dates, the logotype, and every
small-caps label. Prose is never mono; a driver's *name* is sans, their *code*
is mono.

Numbers that update in place (countdowns, live scores) additionally take
`tabular-nums` so digits do not jitter.

### 4.3 Scale

Measured across `web/app` and `web/components` — this is the real distribution,
not an aspiration:

| Role | Classes | Notes |
| --- | --- | --- |
| Hero headline | `display text-4xl … sm:text-7xl`, `font-extrabold tracking-tight`, `leading-[1.05]`/`sm:leading-[1.02]` | Home only. One per site. |
| Page title (h1) | `display text-4xl font-extrabold tracking-tight sm:text-5xl` | Every top-level page. |
| Section title (h2) | `display text-2xl font-extrabold tracking-tight` | The workhorse — 32 uses. |
| Card title (h3) | `display text-lg font-extrabold tracking-tight` | |
| Section **label** (h2/h3) | `font-mono text-xs tracking-[0.2em] text-ink-dim uppercase` | The eyebrow's shape in ink-dim (§4.4). Fifteen of the site's h2/h3s are these. |
| Lead paragraph | `text-lg leading-relaxed text-ink-dim` | Directly under an h1. |
| Body | `text-sm leading-relaxed text-ink-dim` | The default. 200 uses — if in doubt, this. |
| Metadata | `text-xs text-ink-mute`, usually mono | |
| Micro-label | `text-[0.65rem]` / `text-[0.6rem]`, mono, `tracking-wider uppercase` | Column headers, chip labels. |

`tracking-tight` on every heading; `tracking-wider`/`tracking-widest` only on
uppercase mono, and on the wordmark. Never letter-space lowercase sans.

**The label was sans-semibold, and the caps were typed into the markup.**
`<h2>RACE BY RACE</h2>`, fifteen times over — which is a fourth eyebrow style
on a site that already had one, and worse: capitals in the *text* are read out
letter by letter by some screen readers, cannot be translated, and cannot be
lower-cased by anyone who wants to. The case is now `text-transform` and the
markup says "Race by race". Anything that looks uppercase on this site is
uppercase in CSS.

**Hierarchy is carried by weight and width, not only by three greys.** Every
heading used to be the same `font-bold` and the ranking was left entirely to
ink / ink-dim / ink-mute — consistent, and monotone: one channel doing all the
work, and it runs out after three steps. Headlines are 800 at wdth 118; labels
are 600 at natural width with *positive* tracking, which is what makes them
read as labels rather than as small headlines. And a text does not drop to
`ink-mute` merely for being secondary — that is what the weight is for now.

This is deliberately **not** an `h1, h2 { … }` element rule. Nine of the site's
h2s are `text-sm` section labels, and an unlayered element selector would have
silently overridden every one of them.

### 4.3.1 No orphans

```css
h1, h2, h3, h4 { text-wrap: balance; }
p, li, dd, figcaption { text-wrap: pretty; }
```

Two rules in `globals.css`, and no headline on the site drops its last word
onto a line of its own at an intermediate width. It is most of the difference
between a page that was set and a page that was rendered.

### 4.4 The eyebrow

The site's most repeated typographic device — 40+ uses. A short uppercase mono
line above a heading, in red when it announces a section, in ink-mute when it
labels a value:

```tsx
<p className="font-mono text-xs tracking-[0.2em] text-race uppercase">The opponent</p>
<h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">…</h1>
```

Per §1.4, the eyebrow *is* the section divider. Two lines maximum, no
punctuation.

**Red opens a page, ink-dim labels a block inside it.** A page gets one red
eyebrow — `Season 2026`, `The manual`, `The opponent` — and the section labels
further down take the same shape in `text-ink-dim` (§4.3), so a screen never
has two reds arguing over which one is the top of it. `text-ink-mute` stays for
the smallest labels: column heads, chip labels, the legend under a chart.

The home hero's line is the same device carrying live data —
`Round 13 · Italian Grand Prix · Lights out in 2d 14h`, the countdown lifted
to full `text-ink` so the number is the emphasis rather than a colour change.
It replaced a `.glass-chip` strip: a container drawn around information the
type could carry on its own. **A box is not an eyebrow.**

### 4.5 Emphasis

`<strong className="text-ink">` — a lift from dim to full ink, not a colour
change. Red bold text is reserved for numbers and multipliers.

### 4.6 `.hero-outline` — the stencil

One line on the whole site: the hero's second line, cut out of the page rather
than filled.

```css
.hero-outline {
  color: transparent;
  -webkit-text-stroke: 1.25px var(--color-race);   /* 2px from sm up */
  paint-order: stroke fill;
}
```

It replaced `bg-gradient-to-r from-race to-[#ff7a5c] bg-clip-text
text-transparent`, which was the most recognisable AI tell on the site:
gradient text dates from 2021 and is the first reflex of any model asked for a
hero. A stencil is what a pit board, a vinyl number and a helmet visor band
actually are.

The stroke is drawn centred on the glyph outline, so it has to **grow with the
type** or it disappears at 72px — hence two widths rather than one. It is a
display device and nothing else: never use it under 36px, and never on more
than one line.

---

## 5. Layout and space

### 5.1 Containers

Three widths, and a page picks one:

| Width | Used for |
| --- | --- |
| `w-[min(64rem,calc(100%-2rem))]` | The default. Nav, footer, and every content page. |
| `w-[min(48rem,calc(100%-2rem))]` | Long-form reading: rules, privacy, contact. |
| `w-[min(28rem,calc(100%-2rem))]` | A single form: login, welcome, unsubscribe. |

The `calc(100%-2rem)` half is what gives every page the same 1rem phone gutter
without a `px-4` on each one. Do not swap in `max-w-* mx-auto px-4`.

**One exception, and it is the home hero.** It runs `w-[min(72rem,100%)]`
because it is a two-column composition rather than a column of reading, and
its `px-4` lives on the section. Between seasons — no circuit, so no second
column — it falls back to the long-form 48rem rather than hugging the left of
an empty half. Nothing else on the site is 72rem.

### 5.2 Page frame

```tsx
<main className="mx-auto w-[min(64rem,calc(100%-2rem))] flex-1 pt-28 pb-8">
```

`pt-28` clears the fixed nav — the nav floats over the page rather than
reserving space, so top padding is the page's job. `flex-1` inside the
`flex min-h-full flex-col` body is what pins the footer to the bottom on short
pages.

### 5.3 Vertical rhythm

| Step | Class | Between |
| --- | --- | --- |
| 6rem | `mt-24` | Content and the footer |
| 4rem | `mt-16` | Major sections of a page |
| 2rem | `mt-8` | A heading block and its grid of cards |
| 1.5rem | `mt-6` | A heading and its content |
| 1rem | `mt-4` | Related blocks |
| 0.5rem | `mt-2` | A label and its value |

Grids use `gap-4` between cards, `gap-2`/`gap-1.5` between list rows.

### 5.4 Radii

**Two tokens, and a capsule kept for two jobs.**

| Radius | Token / class | For |
| --- | --- | --- |
| 5px | `--radius-control` → `rounded-control` | Anything you press or type into: buttons, fields, chips, list rows, tiles, segments. |
| 10px | `--radius-panel` → `rounded-panel` | Anything that *holds* things: `.glass-card`, the nav bar, sheets, large panels. |
| 9999px | `rounded-full` | A badge, a status dot — and shapes that genuinely are circles. |
| 0 | *(nothing)* | Bars and stripes. |

The site was **76 `rounded-full`**: every button, chip, badge and field was a
capsule. The capsule is the default control of the last few years, and it is
*soft* — where the visual language of this sport is rectangular and technical.
Pit boards, timing towers, number plates, entry tickets.

Inner corners are tighter than outer ones, so a control inside a panel is 5
inside 10. That relationship is the rule; the absolute values matter less.

**Where the capsule survives, and why:**

- **A badge** (`bg-race/15 px-2 py-0.5` — the `YOU` marker) and **a status
  dot**. Both are read as *shapes* rather than as surfaces, and both would
  read as very small buttons at 5px.
- **Things that are circles.** Driver and profile avatars, the start-light
  bulbs, the spinner, a toggle knob and its track, the sheet's grab handle,
  and a bare-icon tap target (`size-10`, the hamburger and the ✕). A round hit
  area around an icon is a *target*, not a control surface.

**Bars lost their caps.** Constructor stripes, the pick-progress segments, the
nav's active underline, the chart legend swatches: pill ends on a 2px rule are
a UI-kit habit. Square-ended is what a timing bar actually looks like, and at
that size it costs nothing to be right.

### 5.5 Numbered sequences

**A sequence of steps is a hanging numeral and a hairline. It is never a row of
equal cards.**

```tsx
<ol className="border-b border-line">
  <li className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-4 border-t border-line py-7
                 sm:grid-cols-[4rem_minmax(0,1fr)] sm:gap-x-8 sm:py-9">
    <span aria-hidden className="font-mono text-2xl font-semibold text-race tabular-nums sm:text-4xl">01</span>
    <div>…</div>
  </li>
</ol>
```

Three glass cards in `sm:grid-cols-3`, each with a red mono numeral, is what
any model produces when asked "how does it work", and this site had it twice —
the home page's *The game* and `/model`'s pipeline, from the same generation
session. It also fought §1.4: three cards is three bands doing the work that
space and type should do.

The numeral is `aria-hidden`, because the `<ol>` already numbers the list and a
screen reader would otherwise count everything twice. And the number is only
allowed at all when the content **is** a sequence — steps that happen in order.
A set of features numbered 01–04 is decoration pretending to be structure.

**A step does not have to carry its own proof — it can point at it.** The home
page's step 03 ("Boldness pays") went through both other answers first. The
four-rung scale was a block of its own further down the section, which read as
one seven-row list because both halves were drawn in the same hand; then it was
nested inside the step against a `border-l`, which fixed the reading but left
the page reciting a formula that `/rules` already held in full. It is a link
now (§7.9), to `/rules#scoring`.

The general rule the third attempt found: **a marketing page states the claim,
the canonical page holds the numbers, and only one of them gets to be
canonical.** Duplicating a rule in two places is a promise to update both.

**And where the steps carry numbers of their own, the sequence is drawn rather
than numbered.** `/model`'s pipeline was the second instance of the three-card
block — four cards, in a 2×2 grid, which is the one arrangement that destroys
the only thing a sequence has: a reading order. It did not become hanging
numerals. Its four steps already count something — 8 seasons, 2 models, 10,000
simulations, 1 top 10 played — and an `01`–`04` series beside those would be
four indices arguing with four counts.

`components/ModelPipeline.tsx` sets those counts **the size of a car number** —
48px of mono, standing on the connecting rule, one size for all four so that
what varies along the track is the *width* of the number. Left to right that
funnel is the claim the prose makes, so the picture and the rule are the same
thing (§1.1), and race red stays on the one stage that is the model acting
rather than the model reading.

**What lost: the same four counts as tallies** — eight strokes, two, a hatch on
the same 7px pitch running off its own edge, one in red. It was legible as a
funnel and completely mute as to why there were marks there at all: the first
question it raised was what the strokes meant, which is the one question an
illustration may not raise. A number needs no key. (It is also why the numerals
are mono and not `.display`: every number on this site is data, §4.2.)

Two construction notes, both load-bearing:

- **The connecting trait is the cells' own top borders**, touching, not an
  absolutely-positioned rule — so it is continuous by construction and there is
  nothing to keep in sync when the copy changes. Gutters therefore live on the
  content *inside* each cell; a `gap-x` on the grid would cut the line into
  four. Below `lg` the same borders stack and the block is a vertical list
  again, one rule per step.
- **The air above each glyph is a margin, never padding.** The strokes stand in
  a fixed `h-9`, and a `pt-8` on that box left them four pixels tall on a
  phone — a dotted line where a tally should be.

The titles carry a `lg:min-h-[3.5rem]`, because two of the four wrap to a second
line at a quarter of 64rem and four bodies starting at four heights read as four
columns that happen to be adjacent, not as one track.

---

## 6. Surfaces and materials

The site has exactly one background (`--color-bg`) and everything on it is one
of four membranes.

### 6.1 `.glass-card` — the card

```css
background: var(--color-card);           /* rgb(28 31 40 / 0.72) */
border: 1px solid var(--color-line);
border-radius: 1.25rem;
box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.07),  /* top-edge highlight */
            var(--shadow-panel);
```

The inset highlight is what makes it read as a lit pane rather than a grey box.
Padding is the caller's: `p-3` for a dense list, `p-5`/`p-6` for a content card,
`p-8` for a feature panel.

**On phones the drop is cut to `--shadow-panel-sm`** — see §10.3.

### 6.2 `.glass-chip` — the floating element

`--color-glass` fill, `--color-line` border, `backdrop-filter: blur(14px)`. The
nav bar and secondary buttons. It is the only place `backdrop-filter` is used,
and it has a consequence worth knowing: **a `backdrop-filter` creates a
containing block**, which traps `position: fixed` descendants. The mobile menu
overlay is portalled to `<body>` for exactly this reason.

### 6.3 The circuit trace — the hero light

`components/CircuitTrace.tsx`. The next Grand Prix's circuit, drawn as **one
closed hairline**, with the start/finish line ticked in red and a mono caption
naming it:

```
ZANDVOORT · ROUND 12 · 14 CORNERS
```

**What it replaced.** The hero used to carry `.aurora`: two blurred radial
gradients, a 60rem red blob top-right and a 44rem blue counterweight
bottom-left. It was the site's only ornament, and it was also its most generic
gesture — an "ambient glow" is the first thing any generated hero reaches for,
and two soft blobs stay two soft blobs however carefully they are placed.

The trace keeps what was right about it (**one light source, and only in the
hero**) and changes the material. The glow is still there; it sits behind the
thing it is lighting now instead of in a corner. **The blue counterweight did
not come back — one light source means one.**

**It has two forms, and they never appear together.**

*From `lg` up — `HeroRaceCard`.* The right-hand column of the hero: the
circuit, a hairline rule, then what it is and how long is left.

```
   ╭──────╮
 ──╯      ╰─╮        ITALIAN GRAND PRIX
   ╰──╮  ╭─╯         MONZA · ROUND 13 · 11 CORNERS
      ╰──╯▌
                     LIGHTS OUT IN
                     02 : 14 : 06 : 22
                      D    H    M    S
```

Drawn as content, not wallpaper: full contrast, a red start line, a caption.
A trace at six per cent behind the headline would have been the aurora again
with extra steps. **It is not a link** — two labelled buttons sit a few
centimetres away, and a block of data that lights up under the cursor reads as
a button somebody forgot to finish.

*Below `lg` — **nothing**, and that is the decision.* The trace used to run in
from the top-right corner as `HeroTraceBleed`: oversized, cropped by the hero's
frame, behind two nested masks. It was a good answer to the wrong question. On
a phone the trace has no column of its own, so it arrived **behind the first
line anyone reads** — and it was one of three decorative layers stacked under
five blocks of type inside a single screen. The component is deleted; the
circuit keeps its column from `lg` up, where it was always the right idea.

The phone hero is now a different composition rather than a narrower one:

- **One light.** `.page-glow` below `lg`, the trace's own glow above it. Never
  both.
- **No grid below `sm`.** It is telemetry, not atmosphere (§6.4) — and on a
  390px screen it is a third texture behind type that already shares with a
  glow. Tablets keep it.
- **One button.** Two full-width buttons of equal weight is one button: the
  second halves the pull of the first instead of adding to it. Below `sm` the
  secondary is a link with the arrow (§7.9); from `sm` up both are buttons,
  side by side.
- **Air, deliberately.** `pt-36` below `sm`, a sixth rem between the eyebrow
  and the headline, twelve between the copy and the call to action. The
  measure of this hero is how much of it is empty.
- **The foot always invites, in two words.** Below `sm` the cue is
  `Scroll down ↓` and nothing else: the score line it used to carry landed
  within a few pixels of the "Explore the model" link above it on a 390px
  screen, and two pieces of type touching each other read as one broken block.
  The score keeps its place from `sm` up, where there is room between them, and
  falls back to `How the duel works` before the first Grand Prix is scored — a
  hero that ends in nothing is a hero people take for the whole site.
- **The offset carries the safe area.** `bottom-[calc(0.75rem+env(safe-area-inset-bottom))]`,
  because the last thing at the bottom of an iPhone is the home indicator, not
  the page. Measured at 390×844 and 390×700: the gap to the link above is 156
  and 84 pixels, and the arrow sits 12 clear of the viewport before the inset
  is added.

**The geometry is data.** `web/lib/circuits.ts` is generated by
`jobs/build_circuit_traces.py` from FastF1 position telemetry — the fastest
race lap at that venue — simplified and re-emitted as a closed Catmull-Rom
spline in its own viewBox. So the ornament comes out of the same pipeline the
model runs on, and it changes every second Sunday. A venue nobody has driven
yet is simply absent from the file and the hero carries no ornament, which is
better than carrying somebody else's circuit. "Driven", not "raced": the job
takes a lap from practice or qualifying when a circuit is brand new and has no
race behind it, so the blank window is the days before first practice rather
than the entire debut weekend.

**Line weight does not scale.** Every stroke is `vector-effect:
non-scaling-stroke` — 1.75px for the track, 2.5px for the start line, at any
display size. This is a technical drawing, and a technical drawing's line
weight is a property of the pen, not of the paper.

The hero still fades its own bottom 8rem to `--color-bg` so the glow is never
cut at the section change. Eight rem and no more: fourteen was tried and it
reached far enough up to dim the grid.

**`.page-glow`** is the reduced version for `/login` and `/welcome`, which
carried the aurora too — and for the home hero between seasons, when there is
no circuit to light. One red source from the top, no second blob.

### 6.3.1 The clock

`NextRaceCountdown` renders in two shapes and the hero uses exactly one of
them at a time:

| Variant | Where | Shape |
| --- | --- | --- |
| `tower` | The race card, `lg` and up | Four columns of `text-2xl` mono digits separated by colons, unit labels beneath. A lap board. The only place on the site a number is allowed to be this large. |
| `inline` | The line above the headline, below `lg` | The two coarsest non-zero units — `2d 14h`, then `14h 06m`, then `06m 22s`. It settles once a minute instead of ticking under a headline. |

Both are `tabular-nums`, both are unanimated, and both render a same-width
placeholder before mount — the server has no clock that agrees with the
client's, and the shape has to survive hydration without moving a pixel.

**One number, two places, never both.** The clock used to live in a glass chip
floating above the headline, which was a box doing an eyebrow's job (§4.4) and
cost the headline a third of the hero.

### 6.3.2 The marker

`<CircuitTrace interactive>`, and only in the race card. A red dot with a soft
halo follows the pointer **along the track**: it projects onto the nearest
point of the lap rather than sitting under the cursor, so it can only ever be
*on* the circuit. Move the mouse across the infield and it slides round the
outside; leave the drawing and it fades out in 150ms.

It is the site's one piece of direct manipulation that produces no result —
and it is allowed because it is not decoration pretending to be interaction:
it answers a question the drawing invites ("where is that bit of the track?")
and it answers it exactly.

Four rules keep it from costing anything:

- **Mouse only.** `pointerType !== "mouse"` returns immediately. A finger has
  no hover, and the marker would land under whatever was just tapped. This is
  also why it exists only in the card, which is `hidden` below `lg`.
- **Sampled on first hover, not on mount.** Below `lg` the card is
  `display: none`, and path geometry read from an unrendered element is not
  something to rely on. By the time a pointer is over it, it is rendered.
- **800 samples, one pass, no `getPointAtLength` during the move.** At that
  density the nearest sample is already sub-pixel at any size the trace is
  drawn, so a pointer event costs one loop of arithmetic.
- **Written straight onto the element.** No React state: state here would
  re-render the hero on every pointer event, and there is nothing to
  reconcile.

`aria-hidden`, and nothing depends on it. Keyboard users lose nothing because
there is nothing to lose.

### 6.4 Line work

`.hero-grid` (72px cells, radial mask), `.cover-grid` (34px cells, linear
bottom fade), `.checker-edge` (10px squares, two rows, masked at both ends),
`.checker-rule` (6px squares, two rows, 72% white, masked at both ends). All
are `pointer-events: none` decoration drawn with gradients — no images.

**Two cuts of the same flag, and they must not be confused.** `.checker-edge`
runs the full width above the footer: it is the end of the *site*.
`.checker-rule` sits inside the top edge of the home page's last-race card: it
is the end of a *race*, and it stays subordinate so the first one keeps its
weight — smaller squares, no edge highlight, transparent seconds where the
footer has opaque black, and a card's own edge rather than a band across a
section, which §1.4 forbids.

**What it may not economise on is rows.** It ran at one row of 6px squares for
a while, which was the wrong lever: a single row of alternating squares is not
a chequerboard, it is a dashed line, and nobody could tell what it was meant to
be. The pattern only becomes a flag once a square has another square
diagonally beneath it, so **two rows is the floor for any cut of this motif.**

---

### 6.5 `.grain` — the tooth

```css
.grain {
  position: fixed; inset: 0; z-index: 200;
  pointer-events: none;
  opacity: 0.032;
  background-image: url("data:image/svg+xml,…feTurbulence…");
  background-size: 180px 180px;
}
```

One fixed layer of monochrome noise over the whole site, at 3.2%, mounted once
in `app/layout.tsx`.

Absolutely flat colour is what makes a generated page look *rendered* rather
than *made*: real surfaces have a tooth. The noise is an inline `feTurbulence`
— no image file, no request, nothing on the wire beyond the rule — tiled at
180px, and `feColorMatrix type="saturate" values="0"` desaturates it so it adds
texture and not a colour cast.

It deliberately sits above everything, sheets and the boot screen included: a
texture that stops at the edge of an overlay announces itself. `pointer-events:
none` means it never intercepts anything.

If the phone paint budget (§10.3) ever suffers, this is the first layer to go
behind a `@media (min-width: 768px)`. It has not needed to.

---

## 7. Components

### 7.1 Navigation

**Desktop (`md:` and up).** A floating `.glass-chip` bar, `rounded-panel`,
`mt-4`, in the default 64rem container, `position: fixed`. Active section is
`font-medium text-ink` plus a 2px red underline pinned `-bottom-2`; inactive is
`text-ink-dim` hovering to `text-ink`. `aria-current="page"` on the active link.

**Phone (`< md`).** A hamburger opens a full-screen `bg-bg` overlay, portalled
to `<body>`, with links centred at `text-3xl font-semibold` and a per-item stagger
(§8.3). Opening the menu prefetches every destination; body scroll is locked
while it is open.

`lib/nav.ts` is the single source of both, including `activeHref()`'s
most-specific-match rule. Never hardcode a nav link in a component.

**The profile chip.** Signed in, the right of the bar carries a `glass-chip`
holding a bust glyph and the username, then a *Sign out* chip. The glyph is the
house icon idiom (§9) — inline, `size-4`, `strokeWidth 1.5`, `currentColor` —
and because it inherits, the chip reddens as one thing on hover:
`hover:text-race hover:border-line-hi`. A name on its own read as a label; a
name behind a figure reads as the way back to your own page.

### 7.2 Buttons

Three variants and one shared behaviour. Everything clickable gets
`.pressable` (§8.2).

| Variant | Classes | Use |
| --- | --- | --- |
| **Primary** | `pressable btn-race px-8 py-3.5 text-base font-semibold` | One per view. `px-6 py-3 text-sm` at inline size, `px-4 py-1.5` in the nav. |
| **Secondary** | `pressable glass-chip rounded-control px-8 py-3.5 text-base font-semibold text-ink transition-colors hover:border-line-hi` | Beside a primary. |
| **Tertiary / full-width** | `pressable w-full rounded-control border border-line-hi py-3 text-sm font-semibold transition-colors hover:bg-glass-strong` | Sheet and form actions on a phone. |

**`.btn-race` is the primary action, and it lives in `globals.css`.** Fill,
glow, hover and radius are in the class; size, layout and `disabled:opacity-*`
stay utilities at the call site, because those genuinely differ. Twenty-two
call sites used to carry the same four tokens by hand, which meant every change
to the loudest surface on the site was twenty-two edits — and the glow had
already drifted into three different values.

```css
.btn-race          { background: var(--color-race-deep); box-shadow: var(--shadow-race); … }
.btn-race:hover    { background: var(--color-race); }
.btn-race:disabled { box-shadow: none; }   /* and no hover brightening */
```

A button that starts work renders `<Spinner />` in place of, or beside, its
label until the work returns (§1.3). A destructive action is a tertiary button
in `text-race`, never a filled red one — filled red is the primary action.

**And the loudness tracks the risk, not the topic.** A destructive control
*rests grey* (`text-ink-mute`) and only warms to `race` under the pointer; the
red surface — a tint, a rule, an outlined confirm button — arrives with the
confirmation step, because that is the moment something is actually at stake.

The two in the site are drawn the same way. `LeagueCardActions` rests on a
`text-ink-mute` *Leave* / *Delete league* and swaps in a red-outlined **Yes**
beside a plain *Cancel*. `DeleteAccount` rests on a `text-ink-mute` *Delete
account* and, once asked, becomes a `bg-race/[0.05]` row with a
`border-l-2 border-l-race`, a field demanding your own username, an outlined
*Delete permanently* and a quiet *Keep my account*.

What is banned is the permanent danger zone: a red-tinted panel with a red
heading and a red button, sitting there from the moment the page loads. It is a
band (§1.4), it out-shouts everything around it including the routine control
next to it, and a box that is loud before anything has happened is a box people
stop reading — which is the opposite of what a destructive control wants.

### 7.3 Chips and badges

- **Pill badge:** `rounded-full bg-race/15 px-2 py-0.5 font-mono text-[0.65rem] text-race` — the `YOU` marker on a board. One of the two places the capsule survives (§5.4).
- **Chip:** `glass-chip rounded-control px-3 py-1.5 text-xs` — a jump link, a filter, a status. Reads as a tab on an instrument rather than as a small pill.
- **Tint fills** run `bg-race/5` (a selected row) → `/10` (a quiet badge) → `/15` (a loud one). Those three steps only.
- **Toggle button:** `border-race bg-race text-white` when on, `border-line bg-glass text-ink-dim` when off, `aria-pressed` carrying the state. Used by the position picker in §12.2.

### 7.4 Form fields

One shared base, `FIELD` in `components/PlayerDetailsFields.tsx`:

```
min-w-0 rounded-xl border border-line bg-black/25 px-4 py-3 text-sm
outline-none transition-colors placeholder:text-ink-mute focus:border-line-hi
```

The field is *darker* than the card it sits on (`bg-black/25`), which is what
reads as "input" in a dark UI. Width is always the caller's — a `w-full` in the
base beats a sibling's `w-28` in the generated CSS and collapsed a select to
zero width once.

`outline-none` here is safe because the global `:focus-visible` ring is
unlayered (§11.1).

- **Error:** `text-xs text-race` or `text-sm text-race` directly under the field. Never a red border alone.
- **Hint:** `text-xs text-ink-mute`, in a `min-h-[1.25rem]` slot so the layout does not jump when an error replaces it.

### 7.5 Tables and their phone twins

Above `sm:`, a table lives in a `.glass-card` with `p-2`,
`border-separate border-spacing-0`, a `min-w-[Nrem]` and `overflow-x-auto`.
Header row: `text-left font-mono text-xs tracking-wider text-ink-mute uppercase`,
cells `px-3 py-2`.

Below `sm:`, the same data is a `<ul className="flex flex-col gap-1.5 sm:hidden">`
of `rounded-xl border border-line bg-glass px-3 py-2.5` rows — or something
better suited to the shape of the data (§12.2). Both halves live in the same
component so they cannot drift.

The current pairs: `RaceBreakdown` and the standings board. `ProbabilityGrid`
used to be the third and no longer is — see §1.5 and §12.2.

**A season is a table, and it took three tries to admit it.**
`components/SeasonRaces.tsx` was a wrap of identical pills (twenty-four of
them, one undifferentiated heap), then one card per Grand Prix in a
three-column grid — a real improvement, and still the site's fourth grid of
equal cards. It is a line per round now: the number hanging in the margin, the
Grand Prix, then points and result in tabular columns. Twenty-four lines read
faster than twenty-four tiles, an eye can run down a column, and it is the
shape a calendar takes everywhere else in this sport.

It is an `<ol>` of `<Link>` rows rather than a `<table>`, because every line
goes somewhere; the header is a mono `aria-hidden` grid on the same column
template. **Signed out, the two right-hand columns are not rendered at all** —
a table with two empty columns promises data it does not have.

### 7.6 Driver row

The repeated atom of the whole game. Left to right:

1. `h-7 w-1 rounded-full` constructor-colour stripe,
2. `DriverAvatar` — a circular WebP portrait, size passed in (26–36px), falling back to the three-letter code on a `tint(color, 0.2)` wash if the image 404s,
3. the name in `text-sm` sans,
4. numbers, mono, right-aligned.

`DriverAvatar` takes `AvatarDriver` — a `driver_id`, a `code`, and whatever is
known about the colour — deliberately narrower than a full roster row so a
component holding a matrix does not have to fake one.

### 7.7 Waiting

| Surface | Component | When |
| --- | --- | --- |
| Inline | `Spinner` | Any busy control. `1em` square, `currentColor`, so it never needs a variant. |
| Whole route | `RaceLoader` | `loading.tsx`. Start-light gantry over a rotating F1 in-joke, changing every 1.8s. |
| First paint of a session | `BootScreen` | An opaque `#0a0b10` screen, in the server HTML, running the gantry on CSS alone. Lifts on `load`, held for 700ms minimum and 2500ms maximum, once per session (`sessionStorage`). |

The loader phrases are original and name no real driver or team, so they neither
date nor need clearing.

**And no skeletons. Decided, not overlooked** (C-5, 2026-08-27). The received
advice is to replace generic spinners with skeletons shaped like the layout to
come. It is wrong here in both halves: this loader is *not* generic — the
gantry and its rotating line are one of the few moments of character the site
has — while a pulsing grey skeleton is generic in every product that ships one.
The lights stay.

**And the gantry is not only for waiting.** `StartLights` takes an optional
`lit` (0–5): given one, it stops cycling and holds that many lights.
`Countdown` uses it for the last hour before predictions lock — twelve minutes
a light, dark at an hour out, all five from twelve minutes, and the lock itself
is the blackout, which is what a blackout means on a real grid. The digits
never leave: the lights are `aria-hidden` and a five-step scale besides, so the
exact time stays printed beside them (§1.2). It is the site's own asset, put
where it means something rather than only where something is loading.

### 7.8 Empty states

`rounded-xl border border-line bg-glass px-4 py-8 text-center text-sm text-ink-mute`
with one sentence that says what would fill it. Never an illustration, never a
call to action inside the box.

**An empty state is for a container that happens to be empty — not for a moment
that is full.** Two screens looked like empty states and were not:

- **`/game` with no Grand Prix to play** is the end of the season. There is a
  champion, the model has a final total, and the viewer has a record against
  it; a centred card saying "No upcoming race" states the one thing on that
  page that is not interesting. `components/SeasonOver.tsx` prints the season
  instead — a page title, a three-row spec sheet (§7.11), the next lights when
  the calendar already has them, and the way to the final table. With nothing
  scored at all it says the *honest* other thing — the calendar has not been
  synced — because "the season is over" is not a fallback, it is a claim.
- **The standings before anybody has scored** is not "no rows", it is the one
  moment the game's whole proposition is legible: the opponent has a score and
  you do not. `EmptyBoard` composes on that asymmetry — *the model is already
  on 934 points, nobody else is on the board* — and it is the **one empty state
  allowed a call to action inside it**, because the thing it is missing is
  exactly the thing the button does. Before the model has played either, there
  is no asymmetry to point at and it says the plain thing.
- **A signed-out game surface is not empty either**, it is locked. See §7.13.

**The rule this leaves:** reach for the empty box when there is genuinely
nothing to say. When the reason the container is empty is itself the story, the
screen tells that story.

### 7.9 Links, and the one arrow

`components/Arrow.tsx`. Six links used to end their own label with a literal
`→`: *"See the full race →"*, *"Make your picks →"*. A glyph glued to the end of
a sentence is a writing tic — the link is already a link — and it sits on the
text baseline, so it cannot move.

The mark is an element now, which means it can:

```tsx
<Link href="…" className="group flex items-center gap-2 …">
  <span className="group-hover:underline">See the full race</span>
  <Arrow />
</Link>
```

`group` on the link, `group-hover:translate-x-0.5` inside the arrow. Two signs
survive as glyphs, and only these two: **`↗`**, which means *leaving the site*
(§9), and pagination's **`← Previous` / `Next →`**, where the arrow is the
direction rather than an ornament on a label.

### 7.10 The FAQ, and why it is not an accordion any more

`/contact`'s nine questions were nine native `<details>` with a `+` that turned
and lit — a better accordion than most, and still an accordion. It cost a click
per answer to hide three lines of text, and a browser's find-in-page cannot
reach what is shut.

**They are open.** A question in full ink on the left, its answer on the right,
a hairline between entries and no card — the spec sheet of §7.11, at reading
width. Nine short answers read in one pass, and the page is one ⌘F away.

What that decision *keeps* from the old one is worth restating, because it is
the reason the `<details>` was defensible in the first place: no JavaScript, no
hydration to wait for, nothing that only works once a bundle lands. Open text
is simply the shorter road to the same property.

If a disclosure is ever genuinely needed — a long legal block, a debug dump —
it is `<details>` again, never a scripted accordion. The rule that stands is
the one that removed this one: **hide something only when showing it costs the
reader more than the click costs.**

### 7.11 The spec sheet — a label, a rule, a value

The site's answer to any content that is really a two-column list: a mono
uppercase label on the left, the thing itself on the right, hairline `border-t`
between the rows and a `border-b` closing the last one. No card, no fill, no
column headers.

```tsx
<dl className="border-b border-line">
  <div className="grid gap-x-8 gap-y-1.5 border-t border-line py-4
                  sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:py-5">
    <dt className="font-mono text-[0.65rem] tracking-[0.18em] text-ink uppercase">Pace &amp; form</dt>
    <dd className="text-sm leading-relaxed text-ink-dim">recent finishing pace, qualifying gap, …</dd>
  </div>
</dl>
```

`/rules`' `Row` is the same device with the value right-aligned in mono;
`CalibrationRecord`'s two rows are the `<dl>` form. The reason is always the
same: **a card carries hierarchy, and a label-and-value pair has none to
carry.** Six of them side by side is six surfaces drawn to say "these are six
things", which the rule already said.

**It is not the only answer, and `/model`'s six feature groups took the other
one.** Where the right-hand side is a sentence rather than a value — the six
angles are enumerations, not measurements — the rules and the fixed label
column earn nothing, so that block is six small `.display` titles with their
enumeration under them, in two wide columns with `gap-y-12` and no line
anywhere. Same principle (§1.4), less furniture. Reach for the spec sheet when
the right column is a *value*, and for titled blocks when it is prose.

**A titled block needs a mark, or it competes with the section head.** At
`text-lg` extrabold the six titles read as six more headings under a
`text-2xl` one, and the page loses which of the seven is in charge. They are
`text-base` with a **compound ring** hanging beside them (§9) — the same
distance in size, plus a mark that says "item", plus the red the section head
does not have.

On a phone the two halves stack (the grid columns only exist from `sm:`), which
is why the label is set in mono caps rather than in bold sans — it still reads
as a label with nothing to its right.

### 7.12 The page index

One page is long enough to need a spine (`/rules`, eight sections) and it had
eight `glass-chip rounded-full` pills wrapping under the title — a heap that
says neither that it is an index, nor how many sections there are, nor where
you are in them.

`components/RulesIndex.tsx` is a numbered list: `01`–`08` in mono ink-mute, the
label in `text-sm`, sticky beside the reading column from `lg` up
(`lg:sticky lg:top-28 lg:self-start`), the current section lit — label to full
ink, numeral to race red. On a phone it is the same list, once, under the lead
and not sticky: a rail on a 380px screen spends the width the reading needs
(§1.5).

**The section heads carry the same numerals**, in mono at `text-base`, so the
rail is an index and not a second navigation — `01` on the left is `01` on the
right. They are `aria-hidden`; the index is a `<nav aria-label>` of real
anchors and the headings are already the document's structure.

`IntersectionObserver`, never a scroll handler, with `rootMargin:
"-30% 0px -55% 0px"` — a section becomes current when its heading reaches the
upper third of the viewport, which is where the eye is, rather than when it
crosses the top edge under a fixed nav. Entries arrive unordered, so the
visible ones are re-sorted by `boundingClientRect.top` and the topmost wins.

### 7.13 Locked, not veiled

**The site does not blur anything.** `/game`'s editor used to sit under a scrim
and 2px of blur with a card in the middle announcing there was something
behind it. Content blurred behind a wall is a growth pattern that became a
cliché, and here it was wrong twice over: what it hid was not secret — a
finished Grand Prix, played by the model, published on `/model` — and a blur
makes nobody want anything.

The state is **stated** instead, and what it guards stays legible:

- a padlock (§9) and the race it was played at, in the label above the list;
- the list itself at full strength, non-interactive — `Slot` already renders
  clean when `disabled`, without a clear button or a grip;
- the sign-in pitch taking the column that would otherwise hold controls
  nobody can use — a driver pool that cannot be picked from, a Driver of the
  Day that cannot be chosen — and naming those three things in mono rather
  than miming them.

The promise moves from "there is something here" to **"this is what you would
have been up against"**. Anything else that has to be withheld follows the same
shape: say what it is, show what can be shown, and put the way in beside it.

### 7.14 Paging a long table

`components/StandingsPager.tsx`, and it only exists above one page of rows —
most leagues never see it.

**A band of positions, not a pagination.** "← Previous · Page 2 of 5 · Next →"
is the component everybody writes without thinking, arrows glued to their
labels included (§7.9). What a reader of a leaderboard wants is *which places
they are looking at*, so the line reads `21–40 of 96 players`, mono and
tabular, and the two controls are `size-9` squares with a chevron and an
`aria-label` — a chevron is not a word and does not need one beside it. The
disabled end is a `<span>` at 40%, not a dead link.

### 7.15 The betting stub

`components/PickStub.tsx`, on the profile, and the one place the site borrows a
register from outside its own furniture.

A championship call is **a bet locked for life, taken on a date, whose value
depends on that date** — and every part of that is already in the database:
when it was locked, where the driver stood at the time, how much of the season
was still to run, what it finally paid. It used to be two `glass-card`s
carrying a name and a team, and none of that was rendered anywhere.

So the stub prints the four as a ticket: the call, then `Called` / `Standing
then` / `Season left` (a square-ended bar) / `Worth`, in the pick's own colour.
Settled, the value becomes a `✓` and the pair carries what was banked.

The tear line is `.stub-perf` — a `repeating-linear-gradient` and a notch
punched at each end with two page-coloured discs. Like `.checker-edge` (§6.4),
it is a line, not an image.

**The colour is the player's choice** (migration 0010, `ProfileThemeToggle`).
`profiles.theme` is `driver` or `team`, and it repaints the cover, the portrait
ring, the season curve and both stubs. It exists because a driver and their
constructor are frequently two shades of one hue: the site's single identity
choice was invisible half the time. The toggle is two swatches rather than a
dropdown — there are two values and both are colours — with `aria-pressed` and
a ring on the chosen one, so the state is never colour alone (§1.2).

---

## 8. Motion

### 8.1 Easing and duration

Two easings, both tokens: `--ease-out-strong` (`cubic-bezier(0.23, 1, 0.32, 1)`)
for anything entering or responding, `--ease-in-out-strong` for anything
symmetric. Durations cluster in three bands:

- **160–240ms** — response to a touch: press, menu fade, sheet rise.
- **300–340ms** — a change of state: item stagger, loader phrase, boot fade.
- **620–640ms** — an entrance, first view only.

Colour changes are `transition-colors` with Tailwind's default 150ms and are
not tokenised.

### 8.2 `.pressable`

```css
.pressable { transition: transform 160ms var(--ease-out-strong); }
.pressable:active { transform: scale(0.97); }
```

On every clickable thing — 71 uses. It is the site's only universal
interaction feedback and it is what makes the phone feel native. Add it to
anything new that is tappable.

### 8.3 Entrances

`.rise-in` (14px up, 640ms) with `.rise-in-2`…`.rise-in-5` adding 70ms each.
**First view only, and rare** — all six uses on the site are in the home hero.
Never animate content that appears on every navigation.

The mobile menu has its own version: `.menu-in` fades the overlay in 170ms,
`.menu-item` staggers the links.

**No scroll-triggered reveals. Decided, not overlooked** (C-6, 2026-08-27).
Current practice would put a fade-and-rise on every section of every page, and
this document forbids it; both positions are defensible, so it was arbitrated
rather than assumed. The rule holds, for two reasons: a scroll reveal has
itself become one of the tells this whole programme is about, and content that
animates on arrival is content you cannot read until the page has finished
performing. **The motion budget went somewhere better** — the start gantry that
fills through the last hour before a race locks (§7.7). One moment, and it
means something.

### 8.4 Reduced motion

`@media (prefers-reduced-motion: reduce)` is handled per effect, not globally:

- the spinner slows to 1.6s rather than stopping (a frozen spinner reads as a hang),
- the start lights hold lit at `opacity: 0.8` — still a gantry, just not running,
- `.rise-in` becomes a fade with no transform,
- menu items and the sheet appear with no animation at all.

Any new animation adds its own branch here.

---

## 9. Imagery and icons

**There is no icon library.** The handful of icons are inline `<svg>` with
`fill="none" stroke="currentColor" strokeWidth="1.5"` and round caps, sized with
`size-4`/`size-5`, always `aria-hidden`. Typographic glyphs do the rest: `×` for
close, `↗` for an external link, `?` in a disc for "why". The **padlock**
(`PredictionEditor`) is one of the inline ones: it says a surface is locked
without dimming what it locks (§7.13).

**The compound ring** is the one drawn mark, and it is a border:

```tsx
<span aria-hidden className="size-3.5 shrink-0 rounded-full border-[3px] border-race" />
```

A red annulus is how a timing screen says *soft*, so it is a bullet this sport
already owns — and it costs one element, no asset and no `<svg>`. It marks the
items of a titled list (§7.11) and nothing else; it is always the red one,
because varying the compound would promise a meaning the list does not have.

**Driver portraits** live at `web/public/drivers/{driver_id}.webp` — 22 files,
~24 kB each. WebP is not optional: the same portraits as PNG-24 were ~210 kB
each, and the pick screen renders all twenty-two, so it was pulling 4.6 MB.
`lib/format.ts#driverPhoto` is the only place the path is built.

Portraits are `loading="lazy" decoding="async"` and every use has an `onError`
fallback to the driver's code on a tinted disc.

**And no flags.** The profile carried the owner's country as an emoji flag
beside their username, visible to nobody else. An ornament only its owner can
see is a setting that escaped into the layout, and a colour emoji was the one
glyph on the site that came from outside the type. The country is still
collected, and still private.

**There are no other images — including the product shot.**
`components/PickBoardShot.tsx` is the only picture of the product on the home
page and it is not a picture: it is the pick board's own markup, server-rendered
from the real roster, in a top 10 that really happened (the last Grand Prix's
finishing order, borrowed from `loadLastRace()` — the same request-cached call
the proof section below already pays for). No browser chrome, no phone bezel:
both are the clichés that come immediately after "put a screenshot on it". The
board simply runs past its column and dissolves (`.shot-fade-x` /
`.shot-fade-y`, two nested masks rather than `mask-composite`, which still wants
a prefixed keyword in Safari).

Two rules keep it honest. It is caught **mid-task** — five slots filled, the
sixth open and lit — because a finished board says nothing about what you would
do with it; the count is tuned to the crop, not chosen for its own sake. And the
whole replica is `aria-hidden` with one `sr-only` sentence standing in for it,
because it has slot numbers, a grip on every row and an open field, none of
which do anything: announcing ten fake controls would be a lie with ten rows in
it.

Before the first race of a season there is no order to borrow and the board
renders empty. That is not a fallback — it is exactly what the screen looks like
in March.

**There is a second shot, and it follows the same two rules.**
`components/ProbabilityShot.tsx` crops the model's real probability matrix for
the last Grand Prix it played into the opponent section of the home page: eight
drivers, six positions, in `ProbabilityGrid`'s own bands. It is the game's
multiplier tiers as colour, so the pale end of the crop is exactly where the
points are. It bleeds past its column from `lg` up and dissolves into
`.shot-fade-x` / `.shot-fade-y`, and the whole replica is `aria-hidden` behind
one `sr-only` sentence, because two hundred bare percentages read to a screen
reader as noise rather than as the argument. The link beside it leads to the
readable cut.

It replaced a `glass-card` listing `Ensemble · XGBoost + LightGBM` and
`Features · 39`, which is a résumé, next to a paragraph describing a grid
nobody could see. Both shots follow the same shape: the pure renderer is
exported (`PickBoard`, `ProbabilityCrop`) so it can be drawn from fixtures, and
the default export is the async wrapper that loads. Between seasons there is no
matrix, the component renders nothing, and the section collapses to one column
— the rule the hero already follows with its circuit trace.

No stock photography, no illustration, no icon sprites. The grids, the checkered
edge and the glows are CSS; the circuit trace (§6.3) is an inline `<path>`
generated from telemetry, not an asset anyone drew.

**The one drawn asset is the logomark** (§2.1), and it is the exception that
proves the rule: it lives in the repository as vector, it is inlined rather
than linked so it can take its colour from the page, and the four raster copies
in `app/` and `public/` exist only because favicons and install manifests
cannot be given an SVG that inherits anything.

---

## 10. Responsive behaviour

### 10.1 Breakpoints

Tailwind's defaults, used with intent:

| Breakpoint | Width | What changes |
| --- | --- | --- |
| `sm:` | 640px | Data density. Tables replace their phone twins; a name replaces a code. |
| `md:` | 768px | Navigation. Hamburger → inline links, profile and sign-out appear. |
| `lg:` | 1024px | Interaction model. The prediction editor switches from a bottom sheet to a two-column drag-and-drop board. |

`xl:` appears once, on a card grid, and carries no meaning of its own. Design
mobile-up: the phone case is the one written first.

### 10.2 Phone rules

1. **Never a sideways scroll.** See §1.5. If content does not fit, change the cut.
2. **Sheets, not modals.** A phone picker is a bottom sheet (`.sheet-panel`, rising 14% in 240ms) over a fading backdrop, portalled to `<body>`.
3. **Touch targets ≥ 40px.** Rows are `py-2` around a 26–32px element; standalone controls are `h-10`/`size-10`.
4. **Haptics where offered.** `navigator.vibrate?.(8)` on a successful drag pickup — a single 8ms tick, Android only, never for anything else.
5. **`touch-manipulation` and `[-webkit-touch-callout:none]`** on anything draggable, or iOS raises the text-selection callout mid-drag.

### 10.3 Paint budget

Phone GPUs choke on large blurred layers and wide shadows — they land late, as
a flat dark rectangle that only resolves on the next paint. Under `767px`,
`globals.css` therefore cuts the card shadow to `0 10px 24px rgb(0 0 0 / 0.38)`
and shrinks the aurora to roughly half its size at `48px` blur. Same look, a
fraction of the cost. A new large blur or wide shadow needs a matching entry in
that block.

---

## 11. Accessibility

### 11.1 Focus

One ring, on everything, keyboard only:

```css
:focus-visible {
  outline: 2px solid var(--color-race);
  outline-offset: 2px;
}
```

Two details are deliberate. It is **unlayered** — Tailwind's utilities sit in a
cascade layer and unlayered rules beat layered ones at any specificity, so this
covers the elements carrying `outline-none` without hunting them down, and
covers anything added later for free. And it is `:focus-visible`, not `:focus`,
so a mouse click leaves no ring behind — which is why the outlines were removed
in the first place. No `border-radius`: an outline follows the element's own.

**And a focus ring is only as useful as what it can skip.** The nav is fixed
and first in the DOM, so a keyboard reader walked the whole masthead on every
page before reaching the content. `app/layout.tsx` opens with one link —
`.skip-link`, off-screen at `translate(-50%, -160%)` until `:focus-visible`
slides it in, on the overlay layer so it lands above the nav — pointing at
`#content`, which is the wrapper in the `(site)` layout and the `<main>` of
`/login`. Five lines, and the first Tab on any page is now "Skip to content".

### 11.2 Rules

- **Colour is never the only channel** (§1.2). Every chart cell, bar and badge prints its value.
- **Real semantics.** Tables are `<table>` with `<caption>`, `scope="col"`, `scope="row"`. Charts are `<figure>`/`<figcaption>`. Lists of ranked things are `<ol>`.
- **Half an ARIA pattern is worse than none.** Toggle buttons use `aria-pressed` rather than borrowing `role="tab"` without the `aria-controls` and tabpanel the tab pattern owes the reader.
- **`sr-only` carries what colour implies** — `{name}, P{c}, {pct}` inside a heat-map cell, `Loading…` beside a gantry.
- **Live regions** on anything that changes without a click: `role="status" aria-live="polite"` on the loaders.
- **Decoration is `aria-hidden`** — stripes, bars, glyph icons, the gantry itself.
- **Contrast is measured, not assumed.** §3.4 records the numbers for the one place it was close.

---

## 12. Data visualisation

The site ships **no charting library**. Every chart is hand-drawn SVG, CSS, or
canvas, because each one is a few dozen lines and a dependency would be larger
than all of them together.

### 12.1 `PointsCurve` — the season

Two polylines in a `100 × 40` user-unit SVG with `preserveAspectRatio="none"`,
so it stretches to any width; `vector-effect="non-scaling-stroke"` keeps the
strokes an honest 1px through that stretch. Your line is your profile colour
(§7.15), the model's is a dashed grey. Below two scored races it renders
nothing at all — one point is a dot, not a curve.

**The last five duels are marked on the line**, in the W/D/L tones of §3.2.
They were a strip of five coloured capsules above it — a summary of the list
that followed, in the last pills left on the site — and they sit where the
results actually happened now. The markers are **HTML spans positioned over
the SVG**, not `<circle>`s: the stretched viewBox turns any circle into an
ellipse, and the percentages that place them are the same numbers the path is
built from.

It also lost its `glass-card`: it sits beside the duel history inside one "The
season" block, and a card around a chart that is already framed by its own axis
is the surface-on-surface habit M-3 removed on `/model`.

### 12.2 `ProbabilityGrid` — the matrix, one position at a time

The model's Monte-Carlo output: for each driver, P(finishing in exactly this
position), frozen at lock time. It is the same number the rarity multiplier is
read from, which is why its colour bands are the multiplier tiers (§3.4, §1.1).

**One chart, at every width.** Ten position toggles and, beside them, the
drivers ranked by how often they finished *there*:

- the `P1…P10` toggles are a **5×2 pad** below `sm:` and a **vertical rail** from `sm:` up — every position on screen at once at both, because a ten-chip rail that scrolled sideways was never an option (§10.2). Toggle buttons with `aria-pressed`, not `role="tablist"`: the tab pattern owes the reader an `aria-controls` and a real tabpanel, and half a pattern announces worse than none;
- a sentence naming what is being read and who the model actually played there;
- one row per driver: the constructor stripe, the portrait and the name sitting *inside* a bar whose fill is the band colour, with the percentage and multiplier in a reserved right-hand gutter;
- a tail line counting whoever fell under 1%.

Four details are load-bearing. Bars are scaled against **the leader of that
position**, not against 100%, or a flat field draws ten stubs — the printed
percentage is the absolute value and remains the primary channel. The fill
stops short of the numbers, because the multiplier is drawn in race red and
vanished completely on a full-strength red bar. Names are full-strength ink on
every row: the name is the identity, and a 1% driver still has to be legible.
And from `sm:` up the rail carries `self-start`, because a grid item stretched
to the height of an eighteen-row list stretches its own rows with it, and ten
fixed-height buttons ended up spaced across six hundred pixels by gaps that
meant nothing.

**What was deleted, and why it is worth remembering.** Above `sm:` this used to
be a twenty-by-ten heat map — a real `<table>`, two hundred cells, the whole
matrix at once. It is an impressive object and a poor read: answering "who does
the model think finishes third, and what does calling it pay?" meant finding a
column, scanning it against four tints, and then looking the tint up in a
legend below. The list answers it sorted, in one glance, with the number and
the multiplier printed on every row — and it is the shape of the thing the
player is about to do, which is fill P1…P10 with names.

The five-swatch legend went with it. Every row prints its own multiplier beside
its own bar, so the same five tiers spelled out underneath is a key to a chart
that does not need one. The interpretive sentence stays (§12.5, rule 5).

### 12.3 `CalibrationRecord` — what calibration did

Two tracks of eleven blocks, one per version of the opponent: how a human who
does nothing but copy the starting grid fares against the model's raw ML order
(8–0–3) and against the calibrated entry it actually plays (3–5–3,
`GAME_DESIGN` §2.2). One block is one Grand Prix, **grouped by outcome rather
than run in calendar order** — this is a tally, not a season, and the two runs
of green are the whole argument.

It exists because the most interesting decision in the project was a single
grey sentence at the bottom of a card. Nobody reads a proof set in 12px mute.

**The tones are a qualifying screen's** (§3.2, the timing set): purple where
the grid-copier wins, green for a draw, yellow where the model takes the
weekend. Emerald/amber/red were tried first and are the wrong family here —
they are three states, and this is a ranking. The mini-sector colours are the
one scale every viewer of this sport can already read best → worst without a
legend, which is exactly what two records eleven weekends long need.

It costs one thing, and it is worth stating: race red means "the model winning"
everywhere else on the site, and here the model's weekends are yellow. Every
row prints its own record and the legend names the three tones in words, so
colour is never carrying it alone (§1.2).

Blocks are square-ended and 3px apart (§5.4). Below `sm:` the track drops to
its own line under the label and the record, rather than being squeezed into a
third of a phone.

### 12.4 `RarityScale` — the rule, in the chart's colours

Four bars on `/rules`, filled with `lib/bands.ts`'s first four fills, each
carrying its own probability range and a sentence, with the multiplier facing
it outside the fill. Read down, the fill fades and the multiplier climbs:
**colour is how sure the model was, and the pale end is where the points are.**

It replaced four table rows ("≥ 30% → ×1") for the mechanic the whole game
turns on — while the picture of it already existed one page away. Drawing the
rule with the chart's own colours makes `/model` and `/rules` one idea rather
than two descriptions of it (§1.1), and it is the reason the bands are shared
code and not two copies of five hex values.

Two details carried over from the matrix's rows: the fill **stops short of the
multiplier**, because ×3 is drawn in race red and a full-strength red bar
swallowed it whole; and text on a band is light ink at every band, contrast
checked (§3.4). The scale prints **four** steps where the bands have five — the
fifth is a shade for a flat field, it pays the same ×3, and a rule listing two
identical payouts is one nobody finishes reading.

### 12.5 Rules for a new chart

1. One hue, sequential, low→high. Never a rainbow, never a diverging scale unless the data actually diverges.
2. If the scale encodes a game rule, use the rule's own thresholds.
3. Print the value next to the colour.
4. `<figure>` + `<figcaption>`; the caption carries the interpretation, not a restatement of the title.
5. Say what the pale end means. On this site the pale end is where the points are, and that sentence appears under the chart.

---

## 13. Voice and content

### 13.1 Tone

Second person, present tense, short sentences. Confident and specific —
"Ten thousand simulated races, reduced to one number per driver per position" —
never breathless. Dry humour is allowed in exactly one place: the loading
phrases. Nowhere else.

Headlines are declarative and can be fragments: *Beat the model. Every single
Sunday.* Body copy explains the mechanic and then stops.

### 13.2 Capitalisation

Sentence case everywhere — headings, buttons, nav, labels. The only uppercase
is the mono micro-label, where it is a typographic device rather than a
capitalisation rule. `F1 DUEL` is a logotype, not a heading.

### 13.3 Numbers

Formatting lives in `lib/format.ts` and nowhere else:

- `formatPoints` — integers bare, otherwise one decimal.
- `formatMargin` — **always signed**, because the sign is the whole point of the column, and the minus is U+2212 (`−`) so it lines up with the digits in a tabular column. Never a hyphen.
- `pos(n)` → `P4`. Positions are always written this way, never "4th".
- Probabilities are whole percentages. Multipliers are `×1.5`, with the multiplication sign, never `x1.5`.

### 13.4 Domain language

"Grand Prix" not "race" in prose (a *round* is the numbered one). "The model",
lower case, always definite — it is a character in the game. "Lock" is when
predictions close. "Duel" is one player against the model for one Grand Prix.

### 13.5 Footer disclaimer

The site is an unofficial fan project and says so on every page, in
`text-xs text-ink-mute` above the fold of the footer, along with data
attribution to FastF1 and Jolpica. Do not remove or shrink it.

---

## 14. Off-site surfaces

Three places the design has to survive outside a browser tab.

### 14.1 Open Graph cards

`app/opengraph-image.tsx` and the per-route ones under `join/[code]` and
`profile/[username]`, drawn with `next/og` and sharing `lib/og.tsx`.

Same palette, same lockup, **and now the same typefaces**. Satori inherits no
stylesheet and therefore no font: given none it renders in its own bundled face,
which is how the most-seen surface the project has — the thing a stranger meets
first, in a group chat — shipped outside the charte from the day it was added. The
three voices of §3.3 are committed under `lib/fonts/` and handed to Satori
explicitly: Archivo for running text, Archivo at display width for the headline
and the name, Geist Mono for every number and label. Google Fonts has no static
instance at `wdth 118`, so the card takes `semi-expanded` (112.5), the same rung
the poster lands on (§14.2).

`metadataBase` is absolute and read from the environment: a share card is
fetched by WhatsApp or Slack, not by the browser on the page, so a relative base
silently yields a card with no image.

### 14.2 The race poster

`lib/poster/draw.ts` — a 1080×1350 sheet drawn by hand on a canvas at 2× and
downscaled, so it is identical on every device and the same drawing feeds the
PDF writer. Deliberately not an html-to-image screenshot, which renders whatever
the browser supports that day.

It restates the site's language in canvas terms: the dark base, a red glow over
a faint grid, glass rows, the checkered finish line, emerald for exact and amber
for near. Its palette is a literal copy of the tokens in §3.1 — **if a token
changes, change `C` in `draw.ts` in the same commit.**

It signs itself with **the site's lockup** — the drawn mark, then Archivo with
"F1" in race red, at the same proportions `Wordmark.tsx` uses (§4.2): mark at
1.7em, half an em of gap, a fifth of an em of tracking. The sheet used to carry
a lockup of its own, "F1" reversed out of a red tile, which predates the mark
existing at all. Its headline is set in the display voice as far as a canvas can
reach it: `semi-expanded` (112.5%) rather than `.display`'s `wdth 118`, because
a canvas can only name the nine font-stretch keywords and 112.5 is the nearest
of them.

Its footer signs the sheet with the brand on the left and **the site's host on
the right, in mono**. That is a design rule, not a detail: the poster is the one
piece of this site that travels without a browser around it — into a story, a
group chat, a camera roll — and a signature with no address is a dead end. The
same reasoning gives the button that produces it a `primary` variant (`.btn-race`)
under the duel verdict, where the sheet is wanted, rather than a chip in a header.

### 14.3 Off-site assets (`brand/`)

Two 1080 × 1920 story backgrounds — the same ground as the poster's, with the
middle left empty — because a story background is picked from a camera roll and
there is no browser in that moment to render one. `brand/README.md` says which
is which and where the furniture sits relative to Instagram's own chrome. They
are output: the drawing is still the code in `lib/poster/draw.ts`.

### 14.4 Installed app

`app/manifest.ts` and `viewport.themeColor = "#0a0b10"`, so the phone's browser
chrome paints itself in the page colour and the address bar continues the page
instead of ending it in a light grey band.

---

## 15. Keeping this document true

This file is a description, not a proposal. It is wrong the moment the code
disagrees with it, so:

1. **A change to any of these updates this file in the same PR:** the `@theme`
   block, `.glass-card`/`.glass-chip`, `.display`, `.hero-outline`,
   `.btn-race`, `.grain`, `CircuitTrace.tsx`, `PickBoardShot.tsx`,
   `ProbabilityShot.tsx`, `ModelPipeline.tsx`, `CalibrationRecord.tsx`, `RarityScale.tsx`, `RulesIndex.tsx`, `SeasonOver.tsx`, `SeasonRaces.tsx`, `StandingsPager.tsx`, `StartLights.tsx`, `Countdown.tsx`, `PickStub.tsx`, `ProfileView.tsx`, `lib/bands.ts`, `Arrow.tsx`, `Wordmark.tsx`, `Logomark.tsx`, `LogoSprite.tsx`, the focus ring, `.pressable`, the probability bands, the
   container widths, the breakpoint meanings, the button variants, the poster
   palette, or `lib/format.ts`'s number rules.
2. **New patterns get a home here or they get deleted.** A one-off card style, a
   fourth button variant or a second spinner is either promoted into this
   document with a reason, or removed.
3. **Record what lost.** The most useful lines in this file are the ones saying
   what was tried and why it was reverted — the section band, the 90px blur, the
   14rem hero fade, the alpha-suffixed hex, the phone heat map, the aurora, the
   gradient headline, the seventy-six capsules, the three equal numbered cards,
   the centred stat row, the red bullet discs, the arrows glued to labels, the
   two-hundred-cell heat map, the four steps in a 2×2 grid, the four counts
   drawn as tallies, the six feature cards, the card wrapped round the
   fair-fight grid, the table of contents as a heap of capsules, the blurred
   veil over the editor, "No upcoming race" as an empty state, the season as a
   grid of cards, `RACE BY RACE` typed in capitals, "← Previous / Next →", the
   profile's flag emoji, the five form capsules, the "?" disc, the circuit
   bleeding behind the phone's headline.
   Keep adding them; they are what stops a fix from being re-broken.
4. Design decisions that are *game* decisions belong in
   [`GAME_DESIGN.md`](GAME_DESIGN.md); this file only says how they are drawn.

---

## 16. Appendix — token reference

Everything a new component needs, in one place. All of it is already a Tailwind
utility.

**Two surfaces draw outside the cascade** and cannot read any of it: the canvas
poster (§14.2) and the Open Graph cards (§14.1), which render through Satori
with no stylesheet. Their colours come from **`lib/palette.ts`**, the one module
that holds them — they used to be two hand-copied sets of hexes, so every
palette decision left both behind. The debt is now a single link: a colour
changed in `@theme` has to be changed there too, and nowhere else.

```
Surface     bg-bg                #0a0b10        the page, nothing else
            glass-card                          cards
            glass-chip                          floating / secondary
            bg-glass             white 4.5%     inert rows
            bg-glass-strong      white 7%       hover, "this is you"
            bg-black/25                         form fields

Ink         text-ink             #f4f6fa        primary
            text-ink-dim         #a7adba        body
            text-ink-mute        #6c7280        labels, empty, disabled

Accent      text-race / bg-race  #ff1e3c        signal: active, errors, data, hover
            bg-race-deep         #c8102e        surface: any resting red fill
            btn-race                            the primary button, whole
            bg-race/5 /10 /15                   tint steps, only these three

Line        border-line          white 10%      default
            border-line-hi       white 16%      hover / emphasis

Semantic    text-emerald-400                    exact, positive, won
            text-amber-300                      near, draw, caution
            text-race                           error, lost
            text-ink-mute                       missed, none

Timing      bg-sector-purple     #b24bf3        fastest anyone has gone
            bg-sector-green      #00e701        a personal best
            bg-sector-yellow     #ffd800        slower than that
            (the three together, as a scale, or none of them — §3.2)

Type        font-sans (Archivo)                 prose, buttons, names
            .display (Archivo wdth 118)         headlines, wordmark, nav
            .hero-outline                       the hero's second line, once
            font-mono (Geist Mono)              every number and label
            tabular-nums                        anything that ticks

Layer       z-[var(--z-veil)]    40            an inert overlay under the nav
            z-[var(--z-nav)]     50            the fixed masthead
            z-[var(--z-sheet)]   60            a panel anchored to an edge
            z-[var(--z-overlay)] 100           menus, dialogs, the skip link
            z-[var(--z-boot)]    150           the first-paint screen
            z-[var(--z-grain)]   200           the tooth, over everything
            (never a literal — the site once had two layers on 100)

Radius      rounded-control      5px           buttons, fields, chips, rows
            rounded-panel        10px          cards, nav, sheets, panels
            rounded-full                        badges, dots, actual circles
            (nothing)                           bars and stripes

Shadow      --shadow-panel                      glass-card, desktop
            --shadow-panel-sm                   glass-card, phone
            --shadow-race                       under btn-race, nowhere else

Texture     .grain                              mounted once in layout.tsx

Motion      --ease-out-strong    cubic-bezier(0.23, 1, 0.32, 1)
            --ease-in-out-strong cubic-bezier(0.77, 0, 0.175, 1)
            .pressable                          every clickable thing
            .rise-in(-2…-5)                     first-view entrances only

Layout      w-[min(64rem,calc(100%-2rem))]      default container
            w-[min(48rem,calc(100%-2rem))]      long-form
            w-[min(28rem,calc(100%-2rem))]      single form
            pt-28                               clears the fixed nav
```

**Where things live**

| File | Owns |
| --- | --- |
| `web/app/globals.css` | Tokens, all shared classes, all keyframes, the reduced-motion and mobile-paint blocks. |
| `web/app/layout.tsx` | Fonts, metadata defaults, theme colour, the body frame. |
| `web/lib/teams.ts` | Constructor colours, `tint`, `NEUTRAL_COLOR`. |
| `web/lib/format.ts` | Every number, name and asset-path format. |
| `web/lib/nav.ts` | The navigation, desktop and phone. |
| `web/lib/poster/draw.ts` | The off-site palette copy. |
| `web/components/Spinner.tsx`, `RaceLoader.tsx`, `BootScreen.tsx` | Waiting. |
| `web/components/ProbabilityGrid.tsx` | The probability bands and the one reading of the matrix. |
| `web/components/Wordmark.tsx` | The site's name, every appearance of it. |
| `web/components/CircuitTrace.tsx` | One circuit, drawn, and the hover marker. Client, for the pointer. |
| `web/components/HeroRaceCard.tsx` | The hero's right column from `lg`: trace, facts, clock. |
| `web/components/NextRaceLine.tsx` | The hero's eyebrow, and the phone's clock. |
| `web/lib/circuits.ts` | **Generated.** Circuit geometry — rebuild with `jobs/build_circuit_traces.py`, never edit. |
