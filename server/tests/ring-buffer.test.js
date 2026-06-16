import { RingBuffer } from "../src/ring-buffer.js";

describe("RingBuffer", () => {
  let buf;

  beforeEach(() => {
    buf = new RingBuffer();
  });

  test("stores and retrieves candles", () => {
    buf.addCandle("BTCUSDT", 1000, [{ price: 50000, buy: 1, sell: 0 }]);
    buf.addCandle("BTCUSDT", 2000, [{ price: 50001, buy: 0, sell: 2 }]);

    const candles = buf.getCandles("BTCUSDT", 2);
    expect(candles).toHaveLength(2);
    expect(candles[0].timestamp).toBe(1000);
    expect(candles[1].timestamp).toBe(2000);
  });

  test("respects max count", () => {
    for (let i = 0; i < 10; i++) {
      buf.addCandle("BTCUSDT", i * 1000, []);
    }
    expect(buf.getCandles("BTCUSDT", 3)).toHaveLength(3);
  });

  test("returns empty for unknown pair", () => {
    expect(buf.getCandles("UNKNOWN", 5)).toEqual([]);
  });

  test("getCandlesInRange filters by timestamp", () => {
    buf.addCandle("BTCUSDT", 1000, []);
    buf.addCandle("BTCUSDT", 2000, []);
    buf.addCandle("BTCUSDT", 3000, []);

    const result = buf.getCandlesInRange("BTCUSDT", 1500, 2500);
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(2000);
  });
});
