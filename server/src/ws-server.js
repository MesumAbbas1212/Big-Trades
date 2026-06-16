import { WebSocketServer } from "ws";
import { EventEmitter } from "events";
import config from "./config.js";

export class LocalWSServer extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
    this.server = null;
  }

  start(port = config.wsPort) {
    this.server = new WebSocketServer({ port });
    this.server.on("connection", (ws) => {
      this.clients.add(ws);
      ws.send(JSON.stringify({ type: "connected", status: "ok" }));

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw);
          this.emit("message", msg, ws);
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "invalid JSON" }));
        }
      });

      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", () => this.clients.delete(ws));
    });
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  stop() {
    if (this.server) this.server.close();
    this.clients.clear();
  }
}
