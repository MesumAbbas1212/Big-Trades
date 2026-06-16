import { EventEmitter } from "events";
import config from "./config.js";
import { roundPrice } from "./price-tick.js";

export class Aggregator extends EventEmitter {
  constructor() {
    super();
    this.candles = new Map();       // pair → candleTs → Map<price, {buy, sell}>
    this.activeCircles = new Map(); // key → circle object
    this.tradeValueHistory = new Map(); // pair → array of trade values ($) for dynamic threshold
    this.candleRunningVolume = new Map(); // "pair_candleTs" → total base volume in current candle
    this.completedCandleVolumes = new Map(); // pair → [volume of last 20 completed candles]
    this.notionalZ = 3; // default Z-score multiplier for notional threshold; adjustable via API
  }

  _recordTradeValue(pair, value) {
    if (!this.tradeValueHistory.has(pair)) {
      this.tradeValueHistory.set(pair, []);
    }
    const arr = this.tradeValueHistory.get(pair);
    arr.push(value);
    if (arr.length > 1000) arr.shift();
  }

  _dynamicThreshold(pair) {
    const floor = config.minNotionalFloor || 5000;
    const arr = this.tradeValueHistory.get(pair);
    if (!arr || arr.length < 50) return floor; // fallback minimum before enough data
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length;
    const std = Math.sqrt(variance);
    // Context.txt: "Threshold = μ(Tick Volume) + (Z × σ(Tick Volume))"
    // Z is adjustable via notionalZ slider (1-10, default 3).
    // Higher Z = fewer circles (stricter), lower Z = more circles (looser).
    return Math.max(floor, mean + this.notionalZ * std);
  }

  _getCandleVolumeRatio(pair, candleTs, timeMs) {
    const cvKey = `${pair}_${candleTs}`;
    const currentVolume = this.candleRunningVolume.get(cvKey) || 0;
    const elapsedSec = (timeMs - candleTs) / 1000;
    const projectedVolume = currentVolume * (60 / Math.max(1, elapsedSec));
    const volumes = this.completedCandleVolumes.get(pair);
    if (!volumes || volumes.length < 5) return 1;
    const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    if (avgVolume <= 0) return 1;
    return projectedVolume / avgVolume;
  }

  getVolumeRatio(pair, timeMs = Date.now()) {
    const candleTs = Math.floor(timeMs / config.candleIntervalMs) * config.candleIntervalMs;
    return this._getCandleVolumeRatio(pair, candleTs, timeMs);
  }

  addTrade(pair, price, quantity, isBuyerMaker, timeMs) {
    const candleTs = Math.floor(timeMs / config.candleIntervalMs) * config.candleIntervalMs;

    // ── Track running candle volume for ratio-based scaling ─────────────
    const cvKey = `${pair}_${candleTs}`;
    this.candleRunningVolume.set(cvKey, (this.candleRunningVolume.get(cvKey) || 0) + quantity);

    // ── 1. Dynamic notional value filter (per-trade size gate) ──────────
    // This identifies individual "big print" trades. NOTE: this gate is
    // intentionally NOT scaled by the candle's volume ratio. Scaling it up
    // during high-volume candles (e.g. a fast sweep made of many medium-sized
    // trades) caused EVERY trade in the spike to fail this check — dropping
    // the entire move from activeCircles/candle buckets and producing zero
    // circles for the biggest, most important moves. Volume-ratio context is
    // still tracked (via candleRunningVolume/_getCandleVolumeRatio) and used
    // by enrichData's z-score for the final isAnomaly decision — that's the
    // correct place for "is this candle unusually busy" to matter, not here.
    const tradeValue = quantity * price;
    this._recordTradeValue(pair, tradeValue);
    const scaledThreshold = this._dynamicThreshold(pair);
    if (tradeValue < scaledThreshold) return;

    // ── 2. Accumulate in candle-level buckets (backward compat) ──────────
    if (!this.candles.has(pair)) {
      this.candles.set(pair, new Map());
    }
    const pairCandles = this.candles.get(pair);
    if (!pairCandles.has(candleTs)) {
      pairCandles.set(candleTs, new Map());
    }
    const candle = pairCandles.get(candleTs);
    const rounded = this._roundPrice(price);
    const atLevelCap = !candle.has(rounded) && candle.size >= config.maxPriceLevelsPerCandle;
    if (!atLevelCap) {
      if (!candle.has(rounded)) {
        candle.set(rounded, { buy: 0, sell: 0 });
      }
      const level = candle.get(rounded);
      if (isBuyerMaker) {
        level.sell += quantity;
      } else {
        level.buy += quantity;
      }
    }

    // ── 3. Active circle tracking with cluster merging ──────────────────
    // Independent of the step-2 level cap above — real-time circle tracking
    // for a busy candle should not be silently disabled by the legacy
    // candle-bucket memory limit.
    // Side = aggressive side (opposite of isBuyerMaker)
    const side = isBuyerMaker ? "sell" : "buy";
    const key = `${pair}_${candleTs}_${rounded}_${side}`;

    if (this.activeCircles.has(key)) {
      const c = this.activeCircles.get(key);
      c.volume += quantity;
      c.lastSeen = timeMs;
      c.totalTrades++;
    } else {
      this.activeCircles.set(key, {
        key,
        pair,
        candleTs,
        price: rounded,
        side,
        volume: quantity,
        firstSeen: timeMs,
        lastSeen: timeMs,
        totalTrades: 1,
        isAnomaly: false,
        ratio: 0,
        isActive: true,
        _lastPushedVolume: 0, // tracks last volume pushed to client
      });
    }
  }

  _roundPrice(price) {
    return roundPrice(price);
  }

  getCandleDeltas(pair, candleTs) {
    const pairCandles = this.candles.get(pair);
    if (!pairCandles) return [];
    const candle = pairCandles.get(candleTs);
    if (!candle) return [];

    const result = [];
    for (const [price, { buy, sell }] of candle) {
      result.push({ time: candleTs / 1000, price, buyVol: buy, sellVol: sell });
    }
    return result;
  }

  getLatestDelta(pair, candleTs) {
    return this.getCandleDeltas(pair, candleTs).filter(d => d.buyVol > 0 || d.sellVol > 0);
  }

  getActiveCircles(pair) {
    const result = [];
    for (const [, c] of this.activeCircles) {
      if (c.pair === pair) result.push(c);
    }
    return result;
  }

  getActiveCirclePoints(pair) {
    const circles = this.getActiveCircles(pair);
    return circles.map(c => ({
      time: c.candleTs / 1000,
      price: c.price,
      buyVol: c.side === "buy" ? c.volume : 0,
      sellVol: c.side === "sell" ? c.volume : 0,
      _circle: c,
    }));
  }

  recordCandleCompleted(pair, candleTs) {
    const cvKey = `${pair}_${candleTs}`;
    const volume = this.candleRunningVolume.get(cvKey) || 0;
    this.candleRunningVolume.delete(cvKey);
    if (!this.completedCandleVolumes.has(pair)) {
      this.completedCandleVolumes.set(pair, []);
    }
    const arr = this.completedCandleVolumes.get(pair);
    arr.push(volume);
    if (arr.length > 20) arr.shift();
  }

  lockActiveCircles(pair, candleTs) {
    const locked = [];
    for (const [k, c] of this.activeCircles) {
      if (c.pair === pair && c.candleTs === candleTs) {
        locked.push({
          price: c.price,
          buy: c.side === "buy" ? c.volume : 0,
          sell: c.side === "sell" ? c.volume : 0,
          locked: true,
          ratio: c.ratio || 0,
          isAnomaly: c.isAnomaly || false,
        });
        this.activeCircles.delete(k);
      }
    }
    return locked;
  }

  flushCandle(pair, candleTs) {
    const pairCandles = this.candles.get(pair);
    if (!pairCandles) return [];
    const data = this.getCandleDeltas(pair, candleTs);
    pairCandles.delete(candleTs);
    return data;
  }
}