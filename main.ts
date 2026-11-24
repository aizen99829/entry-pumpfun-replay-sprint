// Pump.fun Replay Sprint — momentum sniper with strict exits.
//
// Strategy (all decisions deterministic, from harness state only):
//   - Buy: on a coin's CreateEvent, mark it a candidate. Buy it once, on the first batch
//     where the size cap (1% of real SOL reserve) is at least 0.01 SOL and the coin is still
//     young (created within the last 1200 slots), for 0.15 SOL or the cap if smaller.
//     At most 5 open positions, at most 16 orders per batch, never more than free cash.
//     At most 5 open positions, at most 16 orders per batch, never more than free cash.
//   - Entry price: recorded from the buy fill (lamports spent per token received).
//   - Exit: sell the FULL position in one order when any of these fires:
//       take-profit at 1.8x the entry price; stop-loss at 0.65x; TRAILING STOP —
//       once the price has peaked at least 1.10x the entry price, sell when it falls
//       to 0.85x of that peak; or a 1500-slot time exit. The trailing stop is the main
//       exit: the first true grade (correct price math) showed coins spike then dump —
//       41 coins banked over +0.05 SOL while 387 coins bled -0.03..0 SOL waiting for the
//       time exit, and the tail (62 coins under -0.05 SOL) cost -4.42 SOL. A fixed TP
//       misses spikes that turn before 1.8x; the trailing stop banks them after they
//       turn down 15% from their peak.
//     All price comparisons use bigint cross-multiplication.
//     CORRECTNESS NOTE: the first versions of priceAtOrAbove/priceAtOrBelow had num and
//     den swapped, so TP/SL fired on nearly every batch (the bot sold each position
//     immediately after its buy fill and bled ~the fee drag on 599 coins). The local
//     grades of those versions — and the momentum-filter and TP-lowering experiments
//     measured on top of them — are invalid. The formula is fixed here (vq*et*den
//     against vt*eq*num) and TP is restored to the original 1.8x design.
//   - Breadth: fast exits free the 5 slots so the bot turns over many new coins, aiming
//     for the 20-distinct-mint round-trip guardrail; a dead coin is never held while fresh
//     candidates wait.
//
// Determinism: no clock, no environment, no Math.random; only harness state. Iteration
// order is Map insertion order. All arithmetic is bigint.

import { LAMPORTS_PER_SOL, runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 15n) / 100n; // 0.15 SOL per coin
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL
const MAX_AGE_SLOTS = 1200; // a candidate older than this is dropped
const MAX_HOLD_SLOTS = 1500; // time exit: sell whatever remains
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 1000;

// Take-profit 1.8x and stop-loss 0.65x, as (numerator, denominator) pairs.
const TP_NUM = 18n;
const TP_DEN = 10n;
const SL_NUM = 65n;
const SL_DEN = 100n;
// Trailing stop: once the peak is at least 1.10x the entry price, sell when the
// price has fallen to 0.85x of the peak.
const TRAIL_PEAK_NUM = 11n;
const TRAIL_PEAK_DEN = 10n;
const TRAIL_DROP_NUM = 85n;
const TRAIL_DROP_DEN = 100n;

interface Entry {
  quote: bigint; // lamports spent on the buy fill (fees included)
  tokens: bigint; // tokens received on the buy fill
  slot: number; // slot the buy fill resolved
  peakQ: bigint; // virtual quote reserves at the highest price seen since entry
  peakT: bigint; // virtual token reserves at the highest price seen since entry
}

// Candidates in first-seen order: mint -> created slot.
const candidates = new Map<string, number>();
// Coins already decided (bought once, or dropped): never bought again.
const decided = new Set<string>();
// Live entries: mint -> entry price record.
const entries = new Map<string, Entry>();

/** current price vq/vt >= (num/den) * (eq/et), via bigint cross-multiplication:
 *  vq/vt >= (num/den)*(eq/et)  <=>  vq*et*den >= vt*eq*num. */
function priceAtOrAbove(
  vq: bigint,
  vt: bigint,
  eq: bigint,
  et: bigint,
  num: bigint,
  den: bigint,
): boolean {
  return vq * et * den >= vt * eq * num;
}

/** current price vq/vt <= (num/den) * (eq/et), via bigint cross-multiplication:
 *  vq/vt <= (num/den)*(eq/et)  <=>  vq*et*den <= vt*eq*num. */
function priceAtOrBelow(
  vq: bigint,
  vt: bigint,
  eq: bigint,
  et: bigint,
  num: bigint,
  den: bigint,
): boolean {
  return vq * et * den <= vt * eq * num;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const caps = state.hello.caps;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // 1. Fold fills: record entries on buy fills; clear them on sell fills
    // (our own sells and the harness's closes alike).
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') {
        entries.set(f.mint, {
          quote: BigInt(f.quote_lamports),
          tokens: BigInt(f.token_amount),
          slot: f.slot,
          // The peak starts at the entry price itself.
          peakQ: BigInt(f.quote_lamports),
          peakT: BigInt(f.token_amount),
        });
      } else {
        entries.delete(f.mint);
      }
    }

    // 2. Register new candidates; drop completed ones.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!decided.has(e.mint) && !candidates.has(e.mint)) {
          candidates.set(e.mint, e.slot);
        }
      } else if (e.event === 'CompleteEvent') {
        candidates.delete(e.mint);
        entries.delete(e.mint);
      }
    }

    // 3. Exits first: take-profit, stop-loss, trailing stop, or time — sell the
    // full position. Update each position's peak from the latest reserves first.
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      const entry = entries.get(mint);
      if (entry === undefined) continue;
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      if (vt === 0n || entry.tokens === 0n) continue;
      // Track the peak price since entry (as a reserves ratio).
      if (vq * entry.peakT > vt * entry.peakQ) {
        entry.peakQ = vq;
        entry.peakT = vt;
      }
      const tp = priceAtOrAbove(vq, vt, entry.quote, entry.tokens, TP_NUM, TP_DEN);
      const sl = priceAtOrBelow(vq, vt, entry.quote, entry.tokens, SL_NUM, SL_DEN);
      const peaked = priceAtOrAbove(
        entry.peakQ,
        entry.peakT,
        entry.quote,
        entry.tokens,
        TRAIL_PEAK_NUM,
        TRAIL_PEAK_DEN,
      );
      const trailing =
        peaked &&
        priceAtOrBelow(
          vq,
          vt,
          entry.peakQ,
          entry.peakT,
          TRAIL_DROP_NUM,
          TRAIL_DROP_DEN,
        );
      const aged = batch.slot - entry.slot > MAX_HOLD_SLOTS;
      if (tp || sl || trailing || aged) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (free < tx) break;
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        free -= tx;
      }
    }

    // 4. Buys: candidates in first-seen order, one buy per coin.
    for (const [mint, createdSlot] of candidates) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      if (batch.slot - createdSlot > MAX_AGE_SLOTS) {
        candidates.delete(mint);
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        candidates.delete(mint);
        continue;
      }
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      free -= amount + tx;
      slots -= 1;
      decided.add(mint);
      candidates.delete(mint);
    }

    return orders;
  },
});
