import { BaselineTracker } from "../src/baseline-tracker.js";

function mockRingBuffer(candles) {
  return {
    getCandles: (pair, count) => {
      if (pair !== "BTCUSDT") return [];
      return candles.slice(-count);
    }
  };
}

describe("BaselineTracker", () => {
  let tracker;

  test("compute returns average buy/sell per price level", () => {
    const candles = [
      { timestamp: 1000, levels: [{ price: 50000, buy: 10, sell: 0 }] },
      { timestamp: 2000, levels: [{ price: 50000, buy: 20, sell: 5 }] },
      { timestamp: 3000, levels: [{ price: 50000, buy: 0, sell: 10 }] },
    ];
    tracker = new BaselineTracker(mockRingBuffer(candles));
    const result = tracker.compute("BTCUSDT");

    expect(result.size).toBe(1);
    const stats = result.get(50000);
    expect(stats.avgBuy).toBeCloseTo(10);
    expect(stats.avgSell).toBeCloseTo(5);
    expect(stats.stdBuy).toBeCloseTo(8.16, 1);
    expect(stats.stdSell).toBeCloseTo(4.08, 1);
  });

  test("computes zero std for single candle", () => {
    const candles = [
      { timestamp: 1000, levels: [{ price: 50000, buy: 10, sell: 5 }] },
    ];
    tracker = new BaselineTracker(mockRingBuffer(candles));
    const result = tracker.compute("BTCUSDT");
    expect(result.get(50000).avgBuy).toBeCloseTo(10);
    expect(result.get(50000).stdBuy).toBeCloseTo(0);
    expect(result.get(50000).avgSell).toBeCloseTo(5);
    expect(result.get(50000).stdSell).toBeCloseTo(0);
  });

  test("handles multiple price levels independently", () => {
    const candles = [
      { timestamp: 1000, levels: [
        { price: 50000, buy: 10, sell: 0 },
        { price: 50100, buy: 0, sell: 30 },
      ]},
      { timestamp: 2000, levels: [
        { price: 50000, buy: 0, sell: 20 },
        { price: 50100, buy: 15, sell: 0 },
      ]},
    ];
    tracker = new BaselineTracker(mockRingBuffer(candles));
    const result = tracker.compute("BTCUSDT");

    expect(result.get(50000).avgBuy).toBeCloseTo(5);
    expect(result.get(50000).avgSell).toBeCloseTo(10);
    expect(result.get(50100).avgBuy).toBeCloseTo(7.5);
    expect(result.get(50100).avgSell).toBeCloseTo(15);
  });

  test("getAverages returns cached result after compute", () => {
    const candles = [
      { timestamp: 1000, levels: [{ price: 50000, buy: 10, sell: 0 }] },
    ];
    tracker = new BaselineTracker(mockRingBuffer(candles));
    tracker.compute("BTCUSDT");

    const cached = tracker.getAverages("BTCUSDT");
    expect(cached.get(50000).avgBuy).toBeCloseTo(10);
  });

  test("getAverages returns empty map for unknown pair", () => {
    const candles = [
      { timestamp: 1000, levels: [{ price: 50000, buy: 10, sell: 0 }] },
    ];
    tracker = new BaselineTracker(mockRingBuffer(candles));
    tracker.compute("BTCUSDT");

    const cached = tracker.getAverages("UNKNOWN");
    expect(cached.size).toBe(0);
  });

  test("compute with empty candles returns empty map", () => {
    tracker = new BaselineTracker(mockRingBuffer([]));
    const result = tracker.compute("BTCUSDT");
    expect(result.size).toBe(0);
  });
});
