# GTA VI Trophy Rarity Forecast

Forecasts, for every Grand Theft Auto VI trophy on PlayStation 5, the
percent of the players Exophase tracks who will have earned it at
2026-11-26T00:00:00Z, a week after launch — five quantiles per trophy,
scored by pinball loss on the logit scale.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, standard library only) reads every `<id>.in` case file
from the input directory and writes `<id>.out` — one row per trophy,
`{"id": n, "q": [q05, q25, q50, q75, q95]}`. It runs offline, is
deterministic (two runs write identical bytes), and finishes in well under
a second per case.

## Method

Per trophy, the program fits two saturating growth curves to the house's
reads of Exophase's trophy page, both against log-time
(x = ln(1 + hours since launch)), over the last 36 hours of reads:

- **A — log-time trend:** logit(rate) linear in x. It follows the recent
  trend but, alone, overshoots fast movers (a fishing challenge at 13%
  does not reach 78% in a week).
- **B — unearned-fraction decay:** ln(1 − rate/100) linear in x, so the
  rate saturates toward 100% and slows as it climbs. Alone, it undershoots
  the steep phase.

The median is the average of the two curves in logit space — a hedge that
follows the trend but respects that adoption curves are S-shaped. The
extrapolated logit move from the last read is capped at +2.0 / −1.0.

The spread is honest about a 4.5-day extrapolation: a floor growing with
the square root of the horizon, plus the disagreement between the two
curves, narrowed from the house's random-walk width because the median is
fitted. Flat histories (a refresh can jump the rate), zero-rate trophies
(upside only) and the 100% trophy (it can only dilute a little) get their
own spreads.

## Why this beats the house baselines

- The persistence baseline assumes rates freeze; over a launch week they
  move a lot (Chapter 1 went from a 1.25% placeholder to 11.1% real
  within two days of launch).
- The house trend baseline is curve A alone; the blend pulls its
  overshoots back down for fast-growing mid-rate trophies.
- The model was backtested on simulated adoption curves (lognormal-CDF,
  power-law unearned fraction, log-time linear), all calibrated to pass
  through Exophase's real snapshot of 2026-11-20 14:42 UTC. Across those
  worlds the blend beat both house baselines on every one. A probit-ceiling
  fit was tried and dropped: it lost whenever the truth was log-time
  linear.

## Notes

- The trophy list comes from the case file (55 trophies at the opening);
  nothing is hardcoded by name, so the program forecasts whatever
  trophies a case lists.
- The launch-night reads are a stale placeholder page (638 players
  tracked, every rate identical for hours); the 36-hour window keeps the
  fit on real data, and the flat-history fallback covers a case whose
  whole history is flat.
