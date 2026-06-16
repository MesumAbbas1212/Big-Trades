export default {
  wsPort: 3001,
  httpPort: 3002,
  binanceWsBase: "wss://fstream.binance.com/ws",
  defaultPairs: ["BTCUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT"],
  candleIntervalMs: 60_000,
  maxCandlesInBuffer: 5000,
  maxPriceLevelsPerCandle: 500,
  // Z-score threshold: only flag if volume is >= this many std devs above the mean.
  // Context.txt: "activity that is 2 or 3 standard deviations above the norm"
  anomalyThreshold: 2.0,
  baselineRecomputeIntervalMs: 60_000,
  // Minimum notional value floor (USD) — used only before dynamic threshold has data.
  // Once 50+ ticks collected per pair, threshold = mean + 3*std of last 1000 trade values.
  // Context.txt: "Threshold = μ(Tick Volume) + (Z × σ(Tick Volume))"
  minNotionalFloor: 5000,
}
