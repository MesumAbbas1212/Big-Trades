import { BinanceWS } from "./binance-ws.js";
import { Aggregator } from "./aggregator.js";
import { RingBuffer } from "./ring-buffer.js";
import { LocalWSServer } from "./ws-server.js";
import { HTTPServer } from "./http-server.js";
import { BaselineTracker } from "./baseline-tracker.js";
import { Backfill } from "./backfill.js";
import config from "./config.js";

const binance = new BinanceWS();
const aggregator = new Aggregator();
const ring = new RingBuffer();
const baseline = new BaselineTracker(ring);
const backfill = new Backfill(ring, baseline);
const wsServer = new LocalWSServer();
const httpServer = new HTTPServer(aggregator, ring, baseline);

wsServer.on("message", (msg, ws) => {
  if (msg.type === "subscribe") {
    for (const pair of msg.pairs) {
      binance.connect(pair);
    }
    ws.send(JSON.stringify({ type: "subscribed", pairs: msg.pairs }));
  }

  if (msg.type === "unsubscribe") {
    for (const pair of msg.pairs) {
      binance.disconnect(pair);
    }
    ws.send(JSON.stringify({ type: "unsubscribed", pairs: msg.pairs }));
  }

  if (msg.type === "getHistorical") {
    const candles = ring.getCandles(msg.pair, msg.limit || 500);
    const aggregated = aggregateToTimeframe(candles, msg.timeframe || 1);
    ws.send(JSON.stringify({
      type: "historical",
      pair: msg.pair,
      timeframe: msg.timeframe || 1,
      data: aggregated,
    }));
  }
});

// ── Active circle enrichment & push (every 200ms) ──────────────────────
// Checks ALL active circles' cumulative volume against the baseline and
// pushes UPDATED circle state to the poll buffer when volume grows.
// Last-write-wins on the client enables real-time circle GROWING.
let lastActiveCheck = 0;
const ACTIVE_CHECK_INTERVAL = 200;

function buildCircleUpdates(points, enriched) {
  const updates = [];
  for (let i = 0; i < enriched.length; i++) {
    const e = enriched[i];
    const circle = e._circle;
    if (!e.isAnomaly) continue;

    circle.ratio = e.ratio;
    circle.isAnomaly = true;

    const prevVol = circle._lastPushedVolume || 0;
    if (circle.volume === prevVol) continue;

    circle._lastPushedVolume = circle.volume;
    updates.push({
      time: e.time,
      price: e.price,
      buyVol: circle.side === "buy" ? circle.volume : 0,
      sellVol: circle.side === "sell" ? circle.volume : 0,
      ratio: e.ratio,
      isAnomaly: true,
      isActive: true,
    });
  }
  return updates;
}

function pushUpdates(p, updates) {
  if (updates.length === 0) return;
  httpServer.pushAnomaly(p, { type: "anomaly", data: updates });
  httpServer.pushPendingAnomalies(p, updates);
}

binance.on("trade", ({ pair, price, quantity, isBuyerMaker, time }) => {
  aggregator.addTrade(pair, price, quantity, isBuyerMaker, time);

  const now = Date.now();
  if (now - lastActiveCheck < ACTIVE_CHECK_INTERVAL) return;
  lastActiveCheck = now;

  for (const p of config.defaultPairs) {
    const points = aggregator.getActiveCirclePoints(p);
    if (points.length === 0) continue;
    const volRatio = aggregator.getVolumeRatio(p);
    const enriched = httpServer.enrichData(points, p, config.anomalyThreshold, volRatio);
    pushUpdates(p, buildCircleUpdates(points, enriched));
  }
});

// ── Backup loop (every 500ms) — catches state the trade handler missed ──
setInterval(() => {
  for (const p of config.defaultPairs) {
    const points = aggregator.getActiveCirclePoints(p);
    if (points.length === 0) continue;
    const volRatio = aggregator.getVolumeRatio(p);
    const enriched = httpServer.enrichData(points, p, config.anomalyThreshold, volRatio);
    pushUpdates(p, buildCircleUpdates(points, enriched));
  }
}, 500);

function aggregateToTimeframe(candles, targetMinutes) {
  if (targetMinutes === 1 || candles.length === 0) {
    return flattenCandles(candles);
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
          merged.set(level.price, { buy: 0, sell: 0 });
        }
        merged.get(level.price).buy += level.buy;
        merged.get(level.price).sell += level.sell;
      }
    }

    grouped.push({
      time: group[0].timestamp / 1000,
      levels: Array.from(merged.entries()).map(([price, v]) => ({
        price, buyVol: v.buy, sellVol: v.sell,
      })),
    });
  }
  return flattenLevels(grouped);
}

function flattenCandles(candles) {
  return flattenLevels(
    candles.map(c => ({
      time: c.timestamp / 1000,
      levels: c.levels,
    }))
  );
}

function flattenLevels(candles) {
  const result = [];
  for (const c of candles) {
    for (const l of c.levels) {
      if (l.buy > 0 || l.sell > 0) {
        result.push({
          time: c.time,
          price: l.price,
          buyVol: l.buy,
          sellVol: l.sell,
        });
      }
    }
  }
  return result;
}

// ── Candle close: lock active circles, flush, recompute baseline ──────
setInterval(() => {
  const now = Date.now();
  const currentMinute = Math.floor(now / 60_000) * 60_000;
  const prevMinute = currentMinute - 60_000;

  for (const pair of config.defaultPairs) {
    // 1. Lock active circles for the completed minute
    const locked = aggregator.lockActiveCircles(pair, prevMinute);
    if (locked.length > 0) {
      ring.addLockedCandle(pair, prevMinute, locked);
    }

    // 2. Flush remaining candle deltas to ring buffer
    const deltas = aggregator.flushCandle(pair, prevMinute);
    if (deltas.length > 0) {
      ring.addCandle(pair, prevMinute, deltas.map(d => ({
        price: d.price, buy: d.buyVol, sell: d.sellVol,
      })));
    }

    // 3. Record completed candle volume for dynamic threshold scaling
    aggregator.recordCandleCompleted(pair, prevMinute);

    // 4. Recompute baseline
    baseline.compute(pair, config.maxCandlesInBuffer);

    if (locked.length > 0) {
      console.log(`[lock] ${pair}: ${locked.length} circles locked for ${new Date(prevMinute).toISOString()}`);
    }
  }
}, 60_000);

// SSE heartbeat
setInterval(() => {
  httpServer.pushHeartbeat();
}, 20000);

wsServer.start(config.wsPort);
httpServer.start(config.httpPort);

for (const pair of config.defaultPairs) {
  binance.connect(pair);
  backfill.seedPair(pair);
}

console.log(`WS: ws://localhost:${config.wsPort}  HTTP: http://localhost:${config.httpPort}`);
