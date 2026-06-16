import { EventEmitter } from "events";
import WebSocket from "ws";
import config from "./config.js";

export class BinanceWS extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map();
  }

  connect(pair) {
    if (this.connections.has(pair)) return;
    const stream = `${pair.toLowerCase()}@trade`;
    const url = `${config.binanceWsBase}/${stream}`;
    const ws = new WebSocket(url);

    ws.on("message", (raw) => {
      const trade = JSON.parse(raw);
      this.emit("trade", {
        pair: trade.s,
        price: parseFloat(trade.p),
        quantity: parseFloat(trade.q),
        isBuyerMaker: trade.m,
        time: trade.T,
      });
    });

    ws.on("close", () => {
      this.connections.delete(pair);
      this.emit("disconnected", pair);
    });

    ws.on("error", (err) => {
      this.emit("error", { pair, error: err });
    });

    this.connections.set(pair, ws);
  }

  disconnect(pair) {
    const ws = this.connections.get(pair);
    if (ws) {
      ws.close();
      this.connections.delete(pair);
    }
  }

  disconnectAll() {
    for (const [pair, ws] of this.connections) {
      ws.close();
    }
    this.connections.clear();
  }
}
