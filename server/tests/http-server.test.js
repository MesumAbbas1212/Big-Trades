import { jest } from "@jest/globals";
import { BaselineTracker } from "../src/baseline-tracker.js";

// Mock ring buffer
const mockRingBuffer = {
  getCandles: jest.fn(() => []),
};

// We need config for baseline-tracker
jest.unstable_mockModule("../src/config.js", () => ({
  default: {
    maxCandlesInBuffer: 5000,
    candleIntervalMs: 60000,
    maxPriceLevelsPerCandle: 100,
    anomalyThreshold: 2.0,
    minNotionalFloor: 5000,
  },
}));

const { HTTPServer } = await import("../src/http-server.js");

describe("HTTPServer enrichData volume gating", () => {
  let server;
  let baseline;

  beforeEach(() => {
    baseline = new BaselineTracker(mockRingBuffer);
    server = new HTTPServer(null, mockRingBuffer, baseline);
  });

  function addBaselineLevel(price, avgBuy, avgSell, stdBuy, stdSell) {
    // Manually seed the baseline cache with count >= 500 to avoid cold start
    baseline.cache.set("BTCUSDT", new Map([[price, {
      avgBuy, avgSell, stdBuy, stdSell, count: 500,
    }]]));
  }

  test("volumeRatio=1: threshold unchanged", () => {
    addBaselineLevel(50000, 10, 10, 5, 5);
    const data = [{ time: 1000, price: 50000, buyVol: 18, sellVol: 0, locked: false }];

    // With ratio=1: effectiveThreshold = 2/1 = 2
    // zScore = (18-10)/5 = 1.6, 1.6 < 2 → not anomaly
    const result = server.enrichData(data, "BTCUSDT", 2.0, 1);
    expect(result[0].isAnomaly).toBe(false);
  });

  test("volumeRatio=4: lower threshold catches smaller anomalies", () => {
    addBaselineLevel(50000, 10, 10, 5, 5);
    const data = [{ time: 1000, price: 50000, buyVol: 18, sellVol: 0, locked: false }];

    // With ratio=4: effectiveThreshold = 2/4 = 0.5
    // zScore = (18-10)/5 = 1.6, 1.6 >= 0.5 → anomaly
    const result = server.enrichData(data, "BTCUSDT", 2.0, 4);
    expect(result[0].isAnomaly).toBe(true);
  });

  test("locked items unaffected by volumeRatio", () => {
    addBaselineLevel(50000, 10, 10, 5, 5);
    // Locked items have preserverd isAnomaly regardless of ratio
    const data = [{ time: 1000, price: 50000, buyVol: 0, sellVol: 0, locked: true, ratio: 3, isAnomaly: true }];

    const result = server.enrichData(data, "BTCUSDT", 2.0, 100);
    expect(result[0].isAnomaly).toBe(true);
    expect(result[0].ratio).toBe(3);
    expect(result[0].locked).toBe(true);
  });

  test("volumeRatio of 0 clamped to 1", () => {
    addBaselineLevel(50000, 10, 10, 5, 5);
    const data = [{ time: 1000, price: 50000, buyVol: 18, sellVol: 0, locked: false }];

    // ratio=0 should be clamped to max(1, 0) = 1, same as ratio=1
    const resultZero = server.enrichData(data, "BTCUSDT", 2.0, 0);
    const resultOne = server.enrichData(data, "BTCUSDT", 2.0, 1);
    expect(resultZero[0].isAnomaly).toBe(resultOne[0].isAnomaly);
  });

  test("NaN volumeRatio defaults to 1", () => {
    addBaselineLevel(50000, 10, 10, 5, 5);
    const data = [{ time: 1000, price: 50000, buyVol: 18, sellVol: 0, locked: false }];

    const resultNaN = server.enrichData(data, "BTCUSDT", 2.0, NaN);
    const resultOne = server.enrichData(data, "BTCUSDT", 2.0, 1);
    expect(resultNaN[0].isAnomaly).toBe(resultOne[0].isAnomaly);
  });

  test("very high volumeRatio makes almost everything anomaly", () => {
    addBaselineLevel(50000, 10, 10, 5, 5);
    const data = [{ time: 1000, price: 50000, buyVol: 11, sellVol: 0, locked: false }];

    // zScore = (11-10)/5 = 0.2
    // With ratio=50: effectiveThreshold = 2/50 = 0.04
    // 0.2 >= 0.04 → anomaly
    const result = server.enrichData(data, "BTCUSDT", 2.0, 50);
    expect(result[0].isAnomaly).toBe(true);
  });

  test("cold start ignores volumeRatio (always anomaly)", () => {
    // No baseline → cold start
    const data = [{ time: 1000, price: 99999, buyVol: 5, sellVol: 0, locked: false }];

    const result = server.enrichData(data, "BTCUSDT", 2.0, 0.01);
    expect(result[0].isAnomaly).toBe(true);
  });
});
