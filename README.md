# cbBTC Episode Bot — make.fun "Race a BTC trading bot live for 24 hours"

A long-only bot for Coinbase Wrapped BTC (cbBTC) on 1-minute bars, speaking
`agent-fun/bars-replay/v1` through the kit's vendored shim
(`vendor/makefun-bars.ts`, byte-identical to the kit SDK). The strategy lives
in `main.ts` and is fully deterministic: no clock, no randomness, no
environment reads.

## Strategy

One position at a time, 60% of equity per position (trimmed so its own pool
impact stays ≤ 10 bps). It trades *episodes*, not signals — each setup arms,
fires once, and must reset before it can fire again:

- **FLUSH** — the trailing 60-bar return falls to −1.5% while the close is
  already ≥ 3% below its trailing 240-bar high (a mature selloff). Exit at
  +2.0%, −3.0%, or after 150 bars.
- **BURST** — the trailing 30-bar return reaches +1.2% with the trailing
  60-bar return also positive (a thrust in a rising hour). Exit at +1.8%,
  −1.1%, or after 60 bars.

A drawdown guard flattens and benches the bot for 240 bars if equity falls
6% from its peak. No new positions in the last hour of the window; the
harness flattens whatever remains at the final close.

## Dev-window result

Graded locally with the kit's own harness on the frozen 24-hour dev window:
net PnL **+$22.01** on the $1,000 start (+2.20%), 4 round trips, maximum
drawdown 1.16%, $1.58 in fees — profitably through the dev gate, and still
positive (+$20.42) in the scorer's doubled-fees sensitivity.
