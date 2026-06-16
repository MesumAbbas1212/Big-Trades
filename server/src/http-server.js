import { createServer } from "http";
import config from "./config.js";

export class HTTPServer {
  constructor(aggregator, ringBuffer, baselineTracker) {
    this.aggregator = aggregator;
    this.ringBuffer = ringBuffer;
    this.baselineTracker = baselineTracker;
    this.server = null;
    this.sseClients = new Set();
    this.pendingAnomalies = new Map(); // pair → array of anomaly objects
  }

  start(port = config.httpPort) {
    this.server = createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://localhost:${port}`);

      if (url.pathname === "/api/data") {
        const pair = (url.searchParams.get("pair") || "BTCUSDT").toUpperCase();
        const timeframe = parseInt(url.searchParams.get("timeframe") || "1", 10);
        const threshold = parseFloat(url.searchParams.get("threshold") || config.anomalyThreshold);
        const anomaliesOnly = url.searchParams.get("anomaliesOnly") === "true";
        // Update notional Z when client provides it
        if (url.searchParams.has("notionalZ")) {
          this.aggregator.notionalZ = parseFloat(url.searchParams.get("notionalZ")) || 3;
        }
        const now = Date.now();
        const currentMinute = Math.floor(now / 60_000) * 60_000;

        const liveDeltas = this.aggregator.getLatestDelta(pair, currentMinute);
        const livePrevDeltas = this.aggregator.getLatestDelta(pair, currentMinute - 60_000);
        const allLive = [...liveDeltas, ...livePrevDeltas];

        const candles = this.ringBuffer.getCandles(pair, 500);
        const historical = this.aggregateToTimeframe(candles, timeframe);

        let data = [...historical, ...allLive];
        const volRatio = this.aggregator.getVolumeRatio(pair, now);
        data = this.enrichData(data, pair, threshold, volRatio);

        if (anomaliesOnly) {
          data = data.filter(d => d.isAnomaly);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ pair, timeframe, threshold, data }));
        return;
      }

      if (url.pathname === "/api/stream") {
        const pair = (url.searchParams.get("pair") || "BTCUSDT").toUpperCase();
        const threshold = parseFloat(url.searchParams.get("threshold") || config.anomalyThreshold);

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        res.write(":\n\n");

        const client = { res, pair, threshold };
        this.sseClients.add(client);
        console.log(`[SSE] Client connected for ${pair} (total: ${this.sseClients.size})`);

        req.on("close", () => {
          this.sseClients.delete(client);
          console.log(`[SSE] Client disconnected for ${pair} (total: ${this.sseClients.size})`);
        });
        return;
      }

      if (url.pathname === "/api/poll") {
        const pair = (url.searchParams.get("pair") || "BTCUSDT").toUpperCase();
        // Update notional Z when client provides it
        if (url.searchParams.has("notionalZ")) {
          this.aggregator.notionalZ = parseFloat(url.searchParams.get("notionalZ")) || 3;
        }
        const list = this.pendingAnomalies.get(pair) || [];
        if (list.length > 0) this.pendingAnomalies.set(pair, []);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: list }));
        return;
      }

      if (url.pathname === "/api/pairs") {
        const pairs = Array.from(this.aggregator.candles.keys());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ pairs }));
        return;
      }

      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    this.server.listen(port);
    console.log(`HTTP API on http://localhost:${port}`);
  }

  aggregateToTimeframe(candles, targetMinutes) {
    if (targetMinutes === 1 || candles.length === 0) {
      return this.flattenCandles(candles);
    }

    const grouped = [];
    const groupSize = targetMinutes;
    for (let i = 0; i < candles.length; i += groupSize) {
      const group = candles.slice(i, i + groupSize);
      if (group.length === 0) continue;

      const merged = new Map();
      for (const candle of group) {
        for (const level of candle.levels) {
          if (!merged.has(level.price)) {
            merged.set(level.price, { buy: 0, sell: 0, locked: level.locked || false, ratio: level.ratio || 0, isAnomaly: level.isAnomaly || false });
          }
          merged.get(level.price).buy += level.buy;
          merged.get(level.price).sell += level.sell;
        }
      }

      grouped.push({
        time: group[0].timestamp / 1000,
        levels: Array.from(merged.entries()).map(([price, v]) => ({
          price, buyVol: v.buy, sellVol: v.sell, locked: v.locked, ratio: v.ratio, isAnomaly: v.isAnomaly,
        })),
      });
    }
    return this.flattenLevels(grouped);
  }

  flattenCandles(candles) {
    return this.flattenLevels(
      candles.map(c => ({
        time: c.timestamp / 1000,
        levels: c.levels,
      }))
    );
  }

  flattenLevels(candles) {
    const result = [];
    for (const c of candles) {
      for (const l of c.levels) {
        if (l.buy > 0 || l.sell > 0) {
          result.push({
            time: c.time,
            price: l.price,
            buyVol: l.buy,
            sellVol: l.sell,
            locked: l.locked || false,
            ratio: l.ratio || 0,
            isAnomaly: l.isAnomaly || false,
          });
        }
      }
    }
    return result;
  }

  enrichData(data, pair, threshold, volumeRatio = 1) {
    // volumeRatio = projected candle volume / average candle volume.
    // Clamped to min 1 (quiet candles don't raise the threshold).
    const baseline = this.baselineTracker.getAverages(pair);
    const EPSILON = 0.001;

    let totalSamples = 0;
    for (const [, b] of baseline) totalSamples += b.count;
    const isColdStart = totalSamples < 500;

    // Pair-wide fallback baseline: average of avg/std across all known price
    // levels. Used when a specific level has no history of its own — e.g. a
    // fast spike pushing price into territory it has never traded at before.
    // Without this, brand-new levels were hard-coded isAnomaly:false, which
    // silently dropped the biggest/fastest moves (the ones most worth flagging).
    let fallback = null;
    if (baseline.size > 0) {
      let sumAvgBuy = 0, sumAvgSell = 0, sumStdBuy = 0, sumStdSell = 0, n = 0;
      for (const [, b] of baseline) {
        sumAvgBuy += b.avgBuy; sumAvgSell += b.avgSell;
        sumStdBuy += b.stdBuy; sumStdSell += b.stdSell;
        n++;
      }
      fallback = {
        avgBuy: sumAvgBuy / n, avgSell: sumAvgSell / n,
        stdBuy: sumStdBuy / n, stdSell: sumStdSell / n,
      };
    }

    const enriched = data.map((d) => {
      if (d.locked) {
        return { ...d, ratio: d.ratio || 0, isAnomaly: d.isAnomaly || false, isActive: false };
      }

      let b = baseline.get(d.price);
      let usedFallback = false;
      if (!b && fallback) { b = fallback; usedFallback = true; }

      const isBuy = d.buyVol > d.sellVol;
      const dominantVol = isBuy ? d.buyVol : d.sellVol;
      const avgVol = b ? (isBuy ? b.avgBuy : b.avgSell) : 0;

      if (isColdStart) {
        const ratio = avgVol > 0 ? Math.round(Math.min(dominantVol / avgVol, 5) * 100) / 100 : 1;
        return { ...d, ratio: Math.max(1, ratio), isAnomaly: true, locked: false };
      }

      if (!b) {
        // No per-level baseline AND no pair-wide fallback (baseline totally empty).
        return { ...d, ratio: 0, isAnomaly: false, locked: false };
      }

      const stdVol = isBuy ? b.stdBuy : b.stdSell;

      let zScore = 0;
      if (stdVol > EPSILON) {
        zScore = (dominantVol - avgVol) / stdVol;
      } else if (avgVol > EPSILON) {
        zScore = dominantVol > avgVol ? (dominantVol - avgVol) / (avgVol * 0.1) : 0;
      } else if (usedFallback && dominantVol > EPSILON) {
        // Fallback baseline itself has ~0 avg/std (e.g. very early in session) —
        // any real volume at a brand-new level is still notable.
        zScore = threshold;
      }

      const safeRatio = (typeof volumeRatio === 'number' && !isNaN(volumeRatio)) ? volumeRatio : 1;
      const effectiveThreshold = threshold / Math.max(1, safeRatio);

      return {
        ...d,
        ratio: Math.round(Math.max(0, zScore) * 100) / 100,
        isAnomaly: zScore >= effectiveThreshold,
        locked: false,
      };
    });

    const anomalyCount = enriched.filter(d => d.isAnomaly).length;
    if (anomalyCount === 0 && data.length > 0) {
      const k = `zero_${pair}`;
      const now = Date.now();
      if (!this._lastZeroLog) this._lastZeroLog = {};
      if ((this._lastZeroLog[k] || 0) + 30000 < now) {
        this._lastZeroLog[k] = now;
        console.log(`[enrich] ${pair}: ${data.length} pts, ${baseline.size} levels, 0 anomalies`);
      }
    }
    return enriched;
  }

  pushAnomaly(pair, data) {
    for (const client of this.sseClients) {
      if (client.pair !== pair) continue;
      try {
        client.res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (e) {
        this.sseClients.delete(client);
      }
    }
  }

  pushPendingAnomalies(pair, anomalies) {
    if (!this.pendingAnomalies.has(pair)) {
      this.pendingAnomalies.set(pair, []);
    }
    this.pendingAnomalies.get(pair).push(...anomalies);
  }

  pushHeartbeat() {
    for (const client of this.sseClients) {
      try {
        client.res.write(":\n\n");
      } catch (e) {
        this.sseClients.delete(client);
      }
    }
  }

  stop() {
    if (this.server) this.server.close();
  }
}