// btc-race-24h-20261118-1444 entry: a dip-bounce scalper.
//
// Built for this race's falling dev window, where a plain hold fails the dev
// gate: the dev window (the 24 hours before entries opened) opened with a
// fast ~2.3% slide, ranged, rallied once, then bled to its low at the close,
// and buy-and-hold graded -$28 there. This bot never chases strength and
// never holds through a bleed. It waits for a real dip, demands proof the
// fall has stopped (a bounce off the dip low), takes one measured position,
// and leaves on a fixed profit target, a fixed stop, or a time stop,
// whichever comes first.
//
//   - Arm: the close falls DIP_BPS or more below the running high.
//   - Trigger: while armed, the close recovers BOUNCE_BPS off the dip low.
//   - Stake: STAKE_PCT of cash, capped by the same impact room as any entry.
//   - Exits: +TP_BPS from the position's average entry (take profit),
//     -SL_BPS (stop), or TIME_STOP_BARS bars held (time stop).
//   - At most MAX_TRADES entries, none started after LAST_ENTRY_BAR, so a
//     position is never opened into the window's final bleed with no time
//     left for the bounce to pay the round trip's toll (~14 bps at this size).
//
// On this race's dev window it grades +$11.98 net over 2 trades with a 1.35%
// max drawdown, which clears the dev gate. The same constants were exercised
// on the frozen race windows of 13 and 15 November: there it loses less than
// holding through the falling one and gives back some of the rising one's
// gain, the honest price of a strategy that refuses to hold a bleed.
//
// Everything is a function of the bars alone: no clock, no environment, no
// randomness, so two runs answer byte for byte the same.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const DIP_BPS = 200;
const BOUNCE_BPS = 60;
const TP_BPS = 150;
const SL_BPS = 120;
const TIME_STOP_BARS = 600;
const LAST_ENTRY_BAR = 1200;
const MAX_TRADES = 3;
const STAKE_PCT = 90n;
const IMPACT_CAP_BPS = 30n;
const SLIPPAGE_BPS = 120;

let barIndex = -1;
let runningHigh = 0; // highest close since the last exit (price_scale units)
let dipLow = 0; // lowest close since the current dip armed; 0 = not armed
let trades = 0;
let entryBar = -1; // barIndex whose reply decided the open position (it fills on the next bar's open)
let buySentAt = -1;

function ratioBps(now: number, base: number): number {
  return Math.floor(((now - base) * 10000) / base);
}

await runBars({
  onBatch(state: BarsState, batch) {
    const symbol = state.hello.symbols[0]!.symbol;
    let fresh: Bar | null = null;
    for (const bar of batch.bars) if (bar.symbol === symbol) fresh = bar;
    if (fresh === null) return [];
    barIndex++;
    if (state.warmingUp) return [];

    const close = Number(fresh.c);
    const held = state.positions.get(symbol);
    const qty = held !== undefined ? held.qty : 0n;

    if (qty > 0n && held !== undefined) {
      // Anchor exits to the position's own average entry price: cost is in
      // quote units (10^6), qty in qty_scale units (10^8), price at 10^5.
      const avgEntry = Number((held.cost * 10_000_000n) / qty);
      if (ratioBps(close, avgEntry) >= TP_BPS || ratioBps(close, avgEntry) <= -SL_BPS || barIndex - entryBar >= TIME_STOP_BARS) {
        const order: SellInput = { side: 'sell', symbol, qty, max_slippage_bps: SLIPPAGE_BPS };
        runningHigh = close;
        dipLow = 0;
        entryBar = -1;
        return [order];
      }
      return [];
    }

    // Flat. A buy decided on an earlier bar that left no position was refused;
    // forget it so the trigger can fire again on a later bar.
    if (buySentAt >= 0 && barIndex > buySentAt) buySentAt = -1;
    if (buySentAt >= 0) return [];

    if (close > runningHigh) runningHigh = close;
    if (dipLow === 0) {
      if (runningHigh > 0 && ratioBps(close, runningHigh) <= -DIP_BPS) dipLow = close;
      return [];
    }
    if (close < dipLow) dipLow = close;

    if (trades >= MAX_TRADES || barIndex > LAST_ENTRY_BAR) return [];
    if (ratioBps(close, dipLow) < BOUNCE_BPS) return [];

    let stake = (state.cash * STAKE_PCT) / 100n;
    const room = state.weightRoom(symbol);
    if (room < stake) stake = room;
    const depth = state.depthAt(symbol);
    if (depth !== null && depth.length > 0) {
      const byImpact = (depth[0] * IMPACT_CAP_BPS) / 10_000n;
      if (byImpact < stake) stake = byImpact;
    }
    if (stake < BigInt(state.hello.fees.min_notional_quote_units)) return [];

    trades++;
    entryBar = barIndex;
    buySentAt = barIndex;
    dipLow = 0;
    const order: BuyInput = { side: 'buy', symbol, notional_quote_units: stake, max_slippage_bps: SLIPPAGE_BPS };
    return [order];
  },
});
