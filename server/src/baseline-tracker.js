export class BaselineTracker {
  constructor(ringBuffer) {
    this.ringBuffer = ringBuffer;
    this.cache = new Map();
  }

  compute(pair, count = 5000) {
    const candles = this.ringBuffer.getCandles(pair, count);
    const stats = new Map();

    for (const candle of candles) {
      for (const level of candle.levels) {
        if (level.buy === 0 && level.sell === 0) continue;
        if (!stats.has(level.price)) {
          stats.set(level.price, { totalBuy: 0, totalSell: 0, sumSqBuy: 0, sumSqSell: 0, count: 0 });
        }
        const s = stats.get(level.price);
        s.totalBuy += level.buy;
        s.totalSell += level.sell;
        s.sumSqBuy += level.buy * level.buy;
        s.sumSqSell += level.sell * level.sell;
        s.count++;
      }
    }

    const result = new Map();
    for (const [price, s] of stats) {
      const avgBuy = s.count > 0 ? s.totalBuy / s.count : 0;
      const avgSell = s.count > 0 ? s.totalSell / s.count : 0;
      const varianceBuy = s.count > 1 ? (s.sumSqBuy / s.count) - (avgBuy * avgBuy) : 0;
      const varianceSell = s.count > 1 ? (s.sumSqSell / s.count) - (avgSell * avgSell) : 0;
      let stdBuy = Math.sqrt(Math.max(0, varianceBuy));
      let stdSell = Math.sqrt(Math.max(0, varianceSell));
      // Floor std to 50% of mean for sparse levels — prevents near-zero std
      // from making every tiny trade look like a massive z-score.
      const MIN_STD_FACTOR = 0.5;
      if (avgBuy > 0 && stdBuy < avgBuy * MIN_STD_FACTOR) stdBuy = avgBuy * MIN_STD_FACTOR;
      if (avgSell > 0 && stdSell < avgSell * MIN_STD_FACTOR) stdSell = avgSell * MIN_STD_FACTOR;
      result.set(price, {
        avgBuy: Math.round(avgBuy * 100) / 100,
        avgSell: Math.round(avgSell * 100) / 100,
        stdBuy: Math.round(stdBuy * 100) / 100,
        stdSell: Math.round(stdSell * 100) / 100,
        count: s.count,
      });
    }

    this.cache.set(pair, result);
    return result;
  }

  getAverages(pair) {
    return this.cache.get(pair) || new Map();
  }
}
