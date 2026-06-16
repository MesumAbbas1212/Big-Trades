import { Aggregator } from "../src/aggregator.js";

describe("Aggregator", () => {
  let agg;

  beforeEach(() => {
    agg = new Aggregator();
  });

  test("aggregates buy and sell trades by price level", () => {
    const base = 1728000000000;
    agg.addTrade("BTCUSDT", 50000, 1.0, false, base);
    agg.addTrade("BTCUSDT", 50000, 0.5, true, base);
    agg.addTrade("BTCUSDT", 50001, 2.0, false, base);

    const deltas = agg.getCandleDeltas("BTCUSDT", base);
    expect(deltas).toHaveLength(2);

    const at50000 = deltas.find(d => d.price === 50000);
    expect(at50000.buyVol).toBe(1.0);
    expect(at50000.sellVol).toBe(0.5);

    const at50001 = deltas.find(d => d.price === 50001);
    expect(at50001.buyVol).toBe(2.0);
    expect(at50001.sellVol).toBe(0);
  });

  test("groups trades into 1-minute candles by timestamp", () => {
    const base = 1728000000000;
    const nextMin = base + 60000;

    agg.addTrade("BTCUSDT", 50000, 1.0, false, base);
    agg.addTrade("BTCUSDT", 50000, 2.0, false, nextMin);

    const first = agg.getCandleDeltas("BTCUSDT", base);
    expect(first[0].buyVol).toBe(1.0);

    const second = agg.getCandleDeltas("BTCUSDT", nextMin);
    expect(second[0].buyVol).toBe(2.0);
  });

  test("flushCandle returns data and removes it", () => {
    const base = 1728000000000;
    agg.addTrade("BTCUSDT", 50000, 1.0, false, base);

    const result = agg.flushCandle("BTCUSDT", base);
    expect(result).toHaveLength(1);

    const after = agg.getCandleDeltas("BTCUSDT", base);
    expect(after).toHaveLength(0);
  });

  test("getVolumeRatio returns 1 when no completed candles exist", () => {
    const ratio = agg.getVolumeRatio("BTCUSDT", 1728000000000);
    expect(ratio).toBe(1);
  });

  test("getVolumeRatio returns >1 when current volume exceeds average", () => {
    const base = 1728000000000;

    // Simulate 5 completed candles with 10 units each
    for (let i = 0; i < 5; i++) {
      const ts = base - (i + 1) * 60000;
      agg.candleRunningVolume.set(`BTCUSDT_${ts}`, 10);
      agg.recordCandleCompleted("BTCUSDT", ts);
    }

    // Add 20 units in current candle, 3 seconds elapsed
    const currentMin = base;
    agg.candleRunningVolume.set(`BTCUSDT_${currentMin}`, 20);
    // 3s into the candle: projected = 20 * 60/3 = 400, avg = 10 → ratio = 40
    const ratio = agg.getVolumeRatio("BTCUSDT", base + 3000);
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeCloseTo(40, 0);
  });

  test("getVolumeRatio returns 1 when current volume is 0", () => {
    const base = 1728000000000;
    for (let i = 0; i < 5; i++) {
      const ts = base - (i + 1) * 60000;
      agg.recordCandleCompleted("BTCUSDT", ts);
      agg.candleRunningVolume.set(`BTCUSDT_${ts}`, 10);
    }

    const ratio = agg.getVolumeRatio("BTCUSDT", base + 3000);
    expect(ratio).toBe(1);
  });

  test("getVolumeRatio uses config.candleIntervalMs for timestamps", () => {
    // Candle timestamps are computed via Math.floor(timeMs / 60000) * 60000,
    // matching addTrade's behavior. Test with a non-aligned timestamp.
    agg.addTrade("BTCUSDT", 50000, 15, false, 1728000001000);
    agg.recordCandleCompleted("BTCUSDT", 1728000000000);
    agg.candleRunningVolume.set(`BTCUSDT_${1728000000000}`, 10);

    // Pass a non-aligned timestamp, should floor to the same candle
    const ratio = agg.getVolumeRatio("BTCUSDT", 1728000001000);
    expect(ratio).toBe(1);
  });
});
