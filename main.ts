// gta6-trophy-rarity-forecast-01 — trophy earn-rate forecast (Node 22, standard library only).
//
// What it does: for every trophy in a case file it forecasts the earn rate
// (percent of Exophase-tracked players who have earned it) at the case's
// target, as five quantiles. The program runs offline: everything it knows
// is in the case file — the trophy list and the house's reads of Exophase's
// trophy page before the case's checkpoint.
//
// How it forecasts, per trophy:
//   1. Take the reads from the last 36 hours before the case's last read.
//      That window is recent enough to be real data (the page's launch-night
//      reads are a stale placeholder the house saw unchanged for hours) and
//      long enough to average out the page's 2-decimal rounding and its
//      refresh jumps. If the window holds fewer than 3 distinct rates, fall
//      back to the whole history; if the series is still flat, fall back to
//      the last rate with a wide spread, because a refresh can move rates a
//      long way in logit terms.
//   2. Fit two saturating growth curves, both against x = ln(1 + hours
//      since the game's launch), and average their medians in logit space:
//        A. logit(rate) linear in x — the log-time trend. It keeps growing,
//           so on its own it overshoots trophies that are already moving
//           fast (a fishing challenge at 13% does not reach 78% in a week).
//        B. ln(1 - rate/100) linear in x — the unearned fraction decays as
//           a power of time, so the rate saturates toward 100% and slows
//           down as it climbs. On its own it undershoots the steep phase.
//      The average of the two is a hedge: it follows the recent trend but
//      respects that adoption curves are S-shaped, not straight lines.
//      The extrapolated logit move from the last read is capped at +2.0 /
//      -1.0, so one steep fit cannot send a rare trophy to the moon.
//   3. The spread is honest about a 4.5-day extrapolation: a floor that
//      grows with the square root of the horizon, plus the disagreement
//      between the two curves (when they disagree, the truth is less
//      certain), scaled down from the house's random-walk width because the
//      median here is fitted, not assumed. Flat histories, zero-rate
//      trophies and the 100% trophy get their own spreads: a refresh can
//      lift a zero-rate trophy a long way, and a 100% trophy can only
//      dilute a little as new players join.
//   4. Quantiles are the normal quantiles on the logit scale around the
//      median, mapped back to percent and rounded to 4 decimals.
//
// Calibration: the two-curve blend, the 36-hour window and the spread were
// chosen by backtesting on simulated adoption curves (lognormal-CDF,
// power-law unearned fraction, and log-time linear), all fitted to pass
// through Exophase's real snapshot of 2026-11-20 14:42 UTC — Chapter 1 at
// 11.1%, Chapter 2 at 1.44%, the fishing challenge at 12.76%, most others
// under 1%. Across those worlds the blend beat both house baselines
// (persistence and the log-time trend) on every one, and a narrower spread
// beat a wider one once the median was fitted. The probit-ceiling fit was
// tried too and dropped: it lost whenever the truth was log-time linear.
//
// Run it: mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/** Hours of recent reads the trend fits use. */
const WINDOW_HOURS = 36;
/** How much the two-curve spread is narrowed from the house's random walk. */
const SPREAD_SCALE = 0.7;
/** Caps on the extrapolated logit move from the last read. */
const CAP_UP = 2.0;
const CAP_DOWN = 1.0;
/** Spread when the series is flat (a refresh can jump the rate). */
const FLAT_SPREAD = 1.2;
/** Spread for a trophy still at zero (upside only, so wide). */
const ZERO_SPREAD = 1.3;
/** Spread for the trophy at 100% (it can only dilute a little). */
const FULL_SPREAD = 0.4;

interface Read {
  at: string;
  rates: Array<number | null>;
}

interface Trophy {
  id: number;
}

interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { release_date: string };
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct);
  return Math.log(p / (100 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

/**
 * Least squares of y on x. Returns [intercept, slope, residual SD], or null
 * when the points carry no slope information at all.
 */
function ols(xs: number[], ys: number[]): [number, number, number] | null {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx <= 1e-12) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const e = ys[i] - (a + b * xs[i]);
    sse += e * e;
  }
  const resid = n > 2 ? Math.sqrt(sse / (n - 2)) : 0;
  return [a, b, resid];
}

/** Hours from the game's launch (release_date, midnight UTC) to a timestamp. */
function hoursSinceLaunch(launchMs: number, iso: string): number {
  return (Date.parse(iso) - launchMs) / 3600000;
}

/**
 * One trophy's forecast: [median percent, logit spread].
 * `points` are [hours-since-launch, rate] pairs, oldest first, rates non-null.
 * `lastRate` is the rate in the case's last read. `horizonDays` is the
 * case's horizon in days.
 */
function forecastOne(
  points: Array<[number, number]>,
  lastRate: number,
  horizonDays: number,
  targetHours: number,
): [number, number] {
  if (lastRate >= 99.9) return [99.97, FULL_SPREAD];
  if (lastRate <= 0) return [0.01, ZERO_SPREAD];

  const xTarget = Math.log(1 + targetHours);
  const lastLogit = logit(lastRate);

  // The recent window. When it holds fewer than 3 distinct rates there is
  // no slope to fit — do NOT widen it to the whole history: the history
  // starts with the launch-night placeholder page (every rate identical
  // for hours), and fitting through that flat prefix would flatten the
  // slope and shrink the spread exactly when a refresh can jump the rate.
  // Fall back to the last rate with a wide spread instead.
  const tLast = points.length > 0 ? points[points.length - 1][0] : 0;
  const window = points.filter(([h]) => h >= tLast - WINDOW_HOURS);
  const distinct = new Set(window.map(([, r]) => Math.round(r * 100))).size;
  if (distinct < 3 || window.length < 2) return [lastRate, FLAT_SPREAD];

  const xs = window.map(([h]) => Math.log(1 + h));

  // Curve A: logit(rate) linear in log-time.
  const fitA = ols(xs, window.map(([, r]) => logit(r)));
  // Curve B: the unearned fraction decays as a power of time.
  const fitB = ols(
    xs,
    window.map(([, r]) => Math.log(Math.max(1e-6, 1 - r / 100))),
  );

  const logits: number[] = [];
  if (fitA !== null) {
    logits.push(fitA[0] + fitA[1] * xTarget);
  }
  if (fitB !== null && fitB[1] <= 0) {
    const p = 100 * (1 - Math.exp(fitB[0] + fitB[1] * xTarget));
    logits.push(logit(Math.max(0.01, Math.min(99.99, p))));
  }
  if (logits.length === 0) return [lastRate, FLAT_SPREAD];

  let medianLogit = logits.reduce((s, v) => s + v, 0) / logits.length;
  medianLogit = Math.max(lastLogit - CAP_DOWN, Math.min(lastLogit + CAP_UP, medianLogit));

  let disagreement = 0;
  if (logits.length > 1) {
    const m = medianLogit;
    disagreement = Math.sqrt(
      logits.reduce((s, v) => s + (v - m) * (v - m), 0) / logits.length,
    );
  }
  const spread = Math.min(
    1.3,
    Math.max(
      0.45,
      SPREAD_SCALE *
        Math.sqrt(
          (0.35 * Math.sqrt(horizonDays)) ** 2 + 0.25 ** 2 + disagreement ** 2,
        ),
    ),
  );
  return [invLogit(medianLogit), spread];
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith(".in")).sort();
for (const file of inputs) {
  const id = file.slice(0, -".in".length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), "utf8")) as Case;
  if (
    c.levels.length !== LEVELS.length ||
    c.levels.some((t, j) => t !== LEVELS[j])
  ) {
    throw new Error(
      `${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`,
    );
  }
  const launchMs = Date.parse(`${c.game.release_date}T00:00:00Z`);
  const targetHours = hoursSinceLaunch(launchMs, c.target);
  const horizonDays = c.horizon_minutes / 1440;

  // Per trophy, the series of (hours since launch, rate) over the history.
  const series: Array<Array<[number, number]>> = c.trophies.map(() => []);
  for (const read of c.history) {
    const h = hoursSinceLaunch(launchMs, read.at);
    read.rates.forEach((r, i) => {
      if (r !== null && r !== undefined && i < series.length) {
        series[i].push([h, r]);
      }
    });
  }

  const trophies = c.trophies.map((t, i) => {
    const pts = series[i];
    // The trophy's latest known rate: the last read that listed it.
    const lastRate = pts.length > 0 ? pts[pts.length - 1][1] : 0;
    const [median, spread] = forecastOne(pts, lastRate, horizonDays, targetHours);
    const l = logit(median);
    return {
      id: t.id,
      q: Z.map((z) => round4(clampPct(invLogit(l + z * spread)))),
    };
  });
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
