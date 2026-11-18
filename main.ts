// btc-race-24h-20261118-1444 — dip-and-recovery range bot for cbBTC.
//
// Idea: one-minute cbBTC prices are noisy (a few bps a minute) while the
// multi-hour swings are tens to a few hundred bps, and a full-size round
// trip costs roughly 35 bps in fees, slippage and price impact at the pool
// depths in the dev window. Chasing every wiggle bleeds money; the trades
// that pay buy a dip only after it has turned up, and sell the recovery.
//
//   - Keep the trailing 6-hour (360-bar) range of closes. Trade only when
//     it spans at least 80 bps, so flat chop is ignored.
//   - BUY all cash when the latest close sits in the bottom 45% of that
//     range AND has bounced at least 40 bps off the trailing 60-bar low.
//     The bounce confirmation is the whole point: buying a falling knife
//     is what kills dip-buyers in a downtrend, so the dip has to show it
//     turned before we touch it.
//   - SELL everything when the close climbs into the top 1% of the range
//     (range-top exit), or when the position falls 150 bps below its
//     actual fill price (hard stop).
//
// Risk rails (never overridden by the strategy above):
//   - At most 8 orders per window (about 4 round trips).
//   - If equity falls 3% below the start, or 20% below its peak, flatten
//     any open position and stop trading for the rest of the window.
//   - Long only, one position, full cash per trade, no averaging down,
//     no martingale, no leverage, no shorts.
//
// All arithmetic is integer (bigint) on the raw u64 prices the harness
// sends, so two runs on the same bars give byte-identical orders. Nothing
// reads the wall clock, the environment, any file, or any randomness.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Strategy parameters (bps = basis points, 1 bp = 0.01%).
const RANGE_BARS = 360; // 6 hours of 1-minute closes
const BOUNCE_BARS = 60; // bounce-confirmation window
const MIN_SPAN_BPS = 80; // range must span at least this
const BUY_POS_PCT = 45; // buy when close is in the bottom 45% of the range
const SELL_POS_PCT = 99; // sell when close is in the top 1% of the range
const BOUNCE_BPS = 40; // close must be this far above the 60-bar low
const STOP_BPS = 150; // hard stop below the entry fill price

// Risk rails.
const MAX_ORDERS = 8;
const DAILY_LOSS_BPS = 300; // halt new trades at -3% vs the start
const MAX_DD_BPS = 2000; // halt at a 20% drawdown vs the peak equity
const BUY_SLIPPAGE_BPS = 100; // dev window's worst 1-min move was 64 bps
const SELL_SLIPPAGE_BPS = 150;

const BPS = 10000n;

const closes: bigint[] = [];
let entryPrice: bigint | null = null; // fill price of the open position
let ordersSent = 0;
let halted = false;
let flattenSent = false;
let startEquity = 0n;
let peakEquity = 0n;

function rangeOf(n: number): { lo: bigint; hi: bigint } {
  let lo = closes[closes.length - 1];
  let hi = lo;
  const from = closes.length - n;
  for (let i = from; i < closes.length; i++) {
    const c = closes[i];
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }
  return { lo, hi };
}

await runBars({
  onHello(state: BarsState): void {
    startEquity = BigInt(state.hello.capital.quote_units);
    peakEquity = startEquity;
  },

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // 1. Fold in the fills of the orders decided on the previous batch.
    //    The entry price is the actual fill price, never an estimate.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.symbol !== SYMBOL) continue;
      if (fill.side === 'buy') entryPrice = BigInt(fill.price);
      if (fill.side === 'sell') {
        entryPrice = null;
        flattenSent = false;
      }
    }

    // 2. Record this batch's close (the symbol may be absent on gap bars).
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(BigInt(bar.c));
    }
    if (closes.length === 0) return [];

    // 3. Risk rails: track the equity peak; halt on the daily-loss or
    //    drawdown limit, flattening any open position first.
    if (state.equity > peakEquity) peakEquity = state.equity;
    if (!halted) {
      const lossLimit = (startEquity * (BPS - BigInt(DAILY_LOSS_BPS))) / BPS;
      const ddLimit = (peakEquity * (BPS - BigInt(MAX_DD_BPS))) / BPS;
      if (state.equity <= lossLimit || state.equity <= ddLimit) halted = true;
    }
    if (state.warmingUp || halted) {
      const pos = state.positions.get(SYMBOL);
      if (halted && !flattenSent && pos !== undefined && pos.qty > 0n) {
        flattenSent = true;
        return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: SELL_SLIPPAGE_BPS }];
      }
      return [];
    }
    if (closes.length < RANGE_BARS || ordersSent >= MAX_ORDERS) return [];

    const close = closes[closes.length - 1];
    const { lo, hi } = rangeOf(RANGE_BARS);
    const position = state.positions.get(SYMBOL);
    const holding = position !== undefined && position.qty > 0n;

    if (!holding) {
      // BUY: range wide enough, close in the bottom of it, and the dip
      // has bounced off the trailing 60-bar low.
      const spanBps = ((hi - lo) * BPS) / lo;
      if (spanBps < BigInt(MIN_SPAN_BPS)) return [];
      if ((close - lo) * 100n > BigInt(BUY_POS_PCT) * (hi - lo)) return [];
      const { lo: bounceLow } = rangeOf(BOUNCE_BARS);
      if (close * BPS < bounceLow * (BPS + BigInt(BOUNCE_BPS))) return [];
      if (state.cash <= 0n) return [];
      ordersSent++;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: BUY_SLIPPAGE_BPS }];
    }

    // SELL: range-top exit, or the hard stop below the entry fill.
    const atTop = (close - lo) * 100n >= BigInt(SELL_POS_PCT) * (hi - lo);
    const stopped = entryPrice !== null && close * BPS <= entryPrice * (BPS - BigInt(STOP_BPS));
    if (atTop || stopped) {
      ordersSent++;
      return [{ side: 'sell', symbol: SYMBOL, qty: position.qty, max_slippage_bps: SELL_SLIPPAGE_BPS }];
    }
    return [];
  },
});
