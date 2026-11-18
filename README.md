# btc-race-24h-20261118-1444 — dip-and-recovery cbBTC bot

Entry for make.fun's "Race a BTC trading bot live for 24 hours"
(`btc-race-24h-20261118-1444`). The bot trades Coinbase Wrapped BTC
against USDC on 1-minute bars, long only, starting from $1,000 of paper
money, speaking `agent-fun/bars-replay/v1` on stdin/stdout.

## Strategy

One-minute cbBTC prices are noisy (a few bps a minute) while the
multi-hour swings are tens to a few hundred bps, and a full-size round
trip costs roughly 35 bps in fees, slippage and price impact at the pool
depths in the dev window. Chasing every wiggle bleeds money; the trades
that pay buy a dip only after it has turned up, and sell the recovery.

- Keep the trailing 6-hour (360-bar) range of closes. Trade only when it
  spans at least 80 bps, so flat chop is ignored.
- **Buy** all cash when the latest close sits in the bottom 45% of that
  range **and** has bounced at least 40 bps off the trailing 60-bar low.
  The bounce confirmation is the whole point: buying a falling knife is
  what kills dip-buyers in a downtrend, so the dip has to show it turned
  before we touch it.
- **Sell** everything when the close climbs into the top 1% of the range,
  or when the position falls 150 bps below its actual fill price
  (hard stop, measured from the fill reported by the harness, never an
  estimate).

Risk rails: at most 8 orders per window; if equity falls 3% below the
start, or 20% below its peak, flatten any open position and stop trading
for the rest of the window. Long only, one position, no averaging down,
no martingale, no leverage, no shorts.

All arithmetic is integer (`bigint`) on the raw u64 prices, so two runs on
the same bars give byte-identical orders. Nothing reads the wall clock,
the environment, any file, or any randomness.

## Files

- `main.ts` — the bot (Node 22, type stripping; erasable syntax only).
- `vendor/makefun-bars.ts` — the kit's protocol shim, copied byte for byte.
- `LICENSE` — MIT.

## Local grade (kit dev window, 1,440 bars)

```
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

Result: **net PnL +$9.52**, 4 trades (win rate 100%), max drawdown
0.81%, Sharpe 0.02 (per bar), 0 rejected orders, fees $1.61, net PnL at
2x fees +$7.91, guardrails met, L1 regrade reproduced byte for byte.
The dev gate (net PnL > $0) passes with a comfortable margin. (For
context, buy-and-hold loses about $28 on the same window, which fell
280 bps end to end.)
