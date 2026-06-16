import config from "./config.js";

export class RingBuffer {
  constructor() {
    this.buffers = new Map();
  }

  _ensure(pair) {
    if (!this.buffers.has(pair)) {
      this.buffers.set(pair, { candles: [], currentIndex: 0, full: false });
    }
    return this.buffers.get(pair);
  }

  addCandle(pair, timestamp, priceLevels) {
    // priceLevels items: { price, buy, sell }
    const buf = this._ensure(pair);
    const candle = { timestamp, levels: priceLevels };
    if (buf.candles.length < config.maxCandlesInBuffer) {
      buf.candles.push(candle);
    } else {
      buf.candles[buf.currentIndex] = candle;
      buf.currentIndex = (buf.currentIndex + 1) % config.maxCandlesInBuffer;
      buf.full = true;
    }
  }

  addLockedCandle(pair, timestamp, levels) {
    // levels items: { price, buy, sell, locked, ratio, isAnomaly }
    const buf = this._ensure(pair);
    const candle = { timestamp, levels, locked: true };
    if (buf.candles.length < config.maxCandlesInBuffer) {
      buf.candles.push(candle);
    } else {
      buf.candles[buf.currentIndex] = candle;
      buf.currentIndex = (buf.currentIndex + 1) % config.maxCandlesInBuffer;
      buf.full = true;
    }
  }

  getCandles(pair, count) {
    const buf = this._ensure(pair);
    if (buf.candles.length === 0) return [];
    const n = Math.min(count, buf.candles.length);
    const result = [];
    if (!buf.full) {
      for (let i = buf.candles.length - n; i < buf.candles.length; i++) {
        result.push(buf.candles[i]);
      }
    } else {
      const start = (buf.currentIndex - n + config.maxCandlesInBuffer) % config.maxCandlesInBuffer;
      for (let i = 0; i < n; i++) {
        const idx = (start + i) % config.maxCandlesInBuffer;
        result.push(buf.candles[idx]);
      }
    }
    return result;
  }

  getCandlesInRange(pair, fromTs, toTs) {
    const buf = this._ensure(pair);
    return buf.candles.filter(c => c.timestamp >= fromTs && c.timestamp <= toTs);
  }
}
