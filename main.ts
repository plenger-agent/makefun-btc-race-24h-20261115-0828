// Plenger Agent — cbBTC minute bot for the make.fun 24h BTC race (bars-replay/v1).
//
// Long only, one position at a time, $1,000 of paper money. A round trip costs
// roughly 0.25-0.35% in fees, modelled slippage and pool impact, so this bot
// trades rarely and only where the tape has shown moves several times that
// size: it waits for episodes, not signals. Two episode types, each armed and
// triggered once per episode so a long stretch of similar bars is one trade,
// never a drip of them:
//
//   - FLUSH (capitulation bounce): the trailing 60-bar return falls to -1.5%
//     or worse while the close is already at least 3% under its trailing
//     240-bar high — a mature selloff, not the first leg down. On this tape
//     such flushes snap back over the next one to two hours. Exit at +2.0%,
//     at -3.0%, or after 150 bars, whichever comes first.
//   - BURST (momentum thrust): the trailing 30-bar return reaches +1.2% with
//     the trailing 60-bar return also positive — a thrust inside a rising
//     hour, not a bounce inside a falling one. Exit at +1.8%, at -1.1%, or
//     after 60 bars.
//
// An episode re-arms only after its trigger measure has clearly reset (the
// 60-bar return back above -0.6% for a flush, the 30-bar return back under
// +0.4% for a burst). Positions are 60% of equity, trimmed until their own
// pool impact is at most 10 bps. A drawdown guard flattens and benches the
// bot if equity falls 6% from its peak. No new risk in the last hour of the
// window; the harness flattens whatever is left at the final close.
//
// Everything is a deterministic function of the bars seen so far (float64
// + - * / only; no clock, no randomness, no environment), so the two graded
// runs produce byte-identical action logs.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/** Entry orders are picky about the fill; exits insist on getting out. */
const ENTRY_SLIPPAGE_BPS = 60;
const EXIT_SLIPPAGE_BPS = 150;

/** Flush episode: trigger, re-arm, and the mature-selloff depth filter. */
const FLUSH_TRIGGER_60M = -0.015;
const FLUSH_REARM_60M = -0.006;
const FLUSH_DEPTH_FROM_HIGH = -0.03; // close at least 3% under the 240-bar high
const FLUSH_HIGH_BARS = 240;
const FLUSH_TP = 0.02;
const FLUSH_SL = -0.03;
const FLUSH_HOLD_BARS = 150;

/** Burst episode: trigger, re-arm, and the rising-hour filter. */
const BURST_TRIGGER_30M = 0.012;
const BURST_REARM_30M = 0.004;
const BURST_MIN_60M = 0.0;
const BURST_TP = 0.018;
const BURST_SL = -0.011;
const BURST_HOLD_BARS = 60;

/** Sizing: share of equity per position, trimmed so own impact stays small. */
const SIZE_FRACTION = 0.6;
const IMPACT_CAP_BPS = 10n;

/** Drawdown guard: fall from peak equity -> flatten + cooldown. */
const DD_TRIGGER = 0.06;
const DD_HARD = 0.1;
const DD_COOLDOWN = 240;
const DD_HARD_COOLDOWN = 480;

/** Scored bars in a window; stop opening risk near the end (the harness flattens). */
const LAST_ENTRY_BAR = 1380;

type EpisodeKind = 'FLUSH' | 'BURST';

const closes: number[] = [];
let flushArmed = true;
let burstArmed = true;

let positionKind: EpisodeKind | null = null; // kind of the open position
let pendingKind: EpisodeKind | null = null; // kind of a buy decided but not yet filled
let entryPrice: number | null = null; // fill price of the open position, raw price units
let entryBar = -1; // scored-bar index at which the position was filled
let peakEquity = 0n;
let cooldownUntil = -1; // scored-bar index until which entries are benched

function scoredIndex(state: BarsState): number {
  return state.seq - state.warmupBars;
}

function ret(barsBack: number): number | null {
  const n = closes.length;
  if (n <= barsBack) return null;
  return closes[n - 1]! / closes[n - 1 - barsBack]! - 1;
}

/** Depth of the close under the highest close of the last `bars` bars. */
function depthFromHigh(bars: number): number | null {
  const n = closes.length;
  if (n < bars) return null;
  let high = 0;
  for (let i = n - bars; i < n; i++) if (closes[i]! > high) high = closes[i]!;
  return closes[n - 1]! / high - 1;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL) ?? batch.bars[0];
    if (bar === undefined) return [];
    const close = Number(bar.c);
    closes.push(close);

    // Fold fills in: a filled buy opens the position and names its episode.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice = Number(fill.price);
        entryBar = scoredIndex(state);
        positionKind = pendingKind;
        pendingKind = null;
      } else {
        entryPrice = null;
        positionKind = null;
      }
    }

    if (state.warmingUp) return [];
    const idx = scoredIndex(state);
    if (state.equity > peakEquity) peakEquity = state.equity;

    const mom30 = ret(30);
    const mom60 = ret(60);

    // Episodes re-arm on their own measures, position or not.
    if (mom60 !== null && mom60 > FLUSH_REARM_60M) flushArmed = true;
    if (mom30 !== null && mom30 < BURST_REARM_30M) burstArmed = true;

    const held = state.positions.get(SYMBOL);
    const holding = held !== undefined && held.qty > 0n;

    // ------------------------------------------------------------ exits first
    if (holding && entryPrice !== null && entryPrice > 0) {
      const gain = close / entryPrice - 1;
      const heldBars = idx - entryBar;
      const dd = peakEquity > 0n ? Number(((peakEquity - state.equity) * 10000n) / peakEquity) / 10000 : 0;
      const tp = positionKind === 'BURST' ? BURST_TP : FLUSH_TP;
      const sl = positionKind === 'BURST' ? BURST_SL : FLUSH_SL;
      const hold = positionKind === 'BURST' ? BURST_HOLD_BARS : FLUSH_HOLD_BARS;

      let exit = false;
      if (gain >= tp) exit = true;
      else if (gain <= sl) exit = true;
      else if (heldBars >= hold) exit = true;
      else if (dd >= DD_TRIGGER) exit = true; // the guard flattens too

      if (exit) {
        if (dd >= DD_TRIGGER) {
          cooldownUntil = Math.max(cooldownUntil, idx + (dd >= DD_HARD ? DD_HARD_COOLDOWN : DD_COOLDOWN));
        }
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: EXIT_SLIPPAGE_BPS }];
      }
      return []; // one position at a time: while holding, only exits speak
    }

    // ------------------------------------------------------------ entries
    if (idx < cooldownUntil) return [];
    if (idx > LAST_ENTRY_BAR) return [];
    if (mom30 === null || mom60 === null) return [];

    let kind: EpisodeKind | null = null;
    if (flushArmed && mom60 <= FLUSH_TRIGGER_60M) {
      const depth = depthFromHigh(FLUSH_HIGH_BARS);
      if (depth !== null && depth <= FLUSH_DEPTH_FROM_HIGH) kind = 'FLUSH';
    }
    if (kind === null && burstArmed && mom30 >= BURST_TRIGGER_30M && mom60 >= BURST_MIN_60M) {
      kind = 'BURST';
    }
    if (kind === null) return [];

    // The episode is spent the moment it triggers, filled or not.
    if (kind === 'FLUSH') flushArmed = false;
    else burstArmed = false;

    // Size: a fixed share of equity, trimmed until its own impact is capped,
    // and never past the weight room the caps leave.
    let notional = (state.equity * BigInt(Math.round(SIZE_FRACTION * 10000))) / 10000n;
    if (notional > state.cash) notional = state.cash;
    const room = state.weightRoom(SYMBOL);
    if (notional > room) notional = room;
    while (notional > state.hello.fees.min_notional_quote_units) {
      const impact = state.impactBps(SYMBOL, notional);
      if (impact === null || impact <= IMPACT_CAP_BPS) break;
      notional = (notional * 3n) / 4n;
    }
    if (notional < state.hello.fees.min_notional_quote_units || notional <= 0n) return [];

    pendingKind = kind;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: ENTRY_SLIPPAGE_BPS }];
  },
});
