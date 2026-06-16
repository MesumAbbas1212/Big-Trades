import { roundPrice, getTick } from "./price-tick.js";

export class Backfill {
  constructor(ringBuffer, baselineTracker) {
    this.ringBuffer = ringBuffer;
    this.baselineTracker = baselineTracker;
  }

  async fetchKlines(pair, limit = 1500, interval = "1m") {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.log(`[backfill] HTTP ${resp.status} for ${pair}`);
      return [];
    }
    return resp.json();
  }

  toCandles(rawKlines) {
    const candles = [];
    for (const k of rawKlines) {
      const openTime = k[0];
      const open = parseFloat(k[1]);
      const high = parseFloat(k[2]);
      const low = parseFloat(k[3]);
      const close = parseFloat(k[4]);
      const volume = parseFloat(k[5]);
      const takerBuyVol = parseFloat(k[9]);
      if (volume === 0) continue;

      const buyTotal = takerBuyVol;
      const sellTotal = volume - takerBuyVol;

      const levels = this._distributeVolume(low, high, open, close, buyTotal, sellTotal);
      candles.push({ timestamp: openTime, levels });
    }
    return candles;
  }

  _distributeVolume(low, high, open, close, buyTotal, sellTotal) {
    // Distribute volume across fixed price levels (coarse $1.0 grid) so levels
    // overlap across candles.  Without overlap the baseline has only 1 sample
    // per level, producing zero z-scores everywhere.
    const tick = getTick(close);
    const bodyLow = Math.min(open, close);
    const bodyHigh = Math.max(open, close);
    const distLow = low;
    const distHigh = high;
    const center = close;
    const maxDist = Math.max(center - distLow, distHigh - center, 0.01);

    const startLevel = roundPrice(distLow);
    const endLevel = roundPrice(distHigh);
    const candidates = [];

    for (let level = startLevel; level <= endLevel + tick / 2; level += tick) {
      const dist = Math.abs(level - center);
      const triWeight = Math.max(0, 1 - dist / maxDist);
      if (triWeight <= 0.01) continue;
      const noise = 1 + (Math.random() - 0.5) * 0.6;
      candidates.push({ price: roundPrice(level), weight: triWeight * noise, dist });
    }

    // Sort by distance from close, keep nearest levels.
    // Fewer levels → more volume per level → more robust baselines with realistic stds.
    // 15 levels concentrates volume while still covering the candle's range.
    candidates.sort((a, b) => a.dist - b.dist);
    const selected = candidates.slice(0, 15);

    const totalWeight = selected.reduce((s, l) => s + l.weight, 0);
    const result = [];
    for (const l of selected) {
      const fraction = l.weight / totalWeight;
      const buy = Math.round(buyTotal * fraction * 100) / 100;
      const sell = Math.round(sellTotal * fraction * 100) / 100;
      if (buy > 0 || sell > 0) result.push({ price: l.price, buy, sell });
    }

    return result.length > 0 ? result : [{ price: roundPrice(close), buy: buyTotal, sell: sellTotal }];
  }

  async seedPair(pair) {
    console.log(`[backfill] Fetching klines for ${pair}...`);
    try {
      const raw = await this.fetchKlines(pair);
      if (raw.length === 0) {
        console.log(`[backfill] No klines for ${pair}`);
        return;
      }
      const candles = this.toCandles(raw);
      console.log(`[backfill] ${pair}: ${candles.length} candles`);
      for (const c of candles) {
        this.ringBuffer.addCandle(pair, c.timestamp, c.levels);
      }
      this.baselineTracker.compute(pair);
      console.log(`[backfill] ${pair}: seeded ${candles.length} candles, baseline computed`);
    } catch (e) {
      console.log(`[backfill] Error for ${pair}: ${e.message}`);
    }
  }
}
