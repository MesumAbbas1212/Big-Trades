import { jest } from "@jest/globals";

const mockWs = { on: jest.fn(), close: jest.fn() };
const wsMock = jest.fn(() => mockWs);

jest.unstable_mockModule("ws", () => ({ default: wsMock }));

const { BinanceWS } = await import("../src/binance-ws.js");

describe("BinanceWS", () => {
  let binance;

  beforeEach(() => {
    wsMock.mockClear();
    mockWs.on.mockClear();
    mockWs.close.mockClear();
    binance = new BinanceWS();
  });

  test("connect creates a WebSocket and registers handlers", () => {
    binance.connect("BTCUSDT");
    expect(wsMock).toHaveBeenCalledWith(
      "wss://fstream.binance.com/ws/btcusdt@trade"
    );
    expect(mockWs.on).toHaveBeenCalledWith("message", expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith("close", expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  test("emits trade event with parsed data", () => {
    binance.connect("BTCUSDT");
    const handler = mockWs.on.mock.calls.find(([e]) => e === "message")[1];
    const emitSpy = jest.spyOn(binance, "emit");

    handler(
      JSON.stringify({ s: "BTCUSDT", p: "50000", q: "0.1", m: false, T: 1718000000000 })
    );

    expect(emitSpy).toHaveBeenCalledWith("trade", {
      pair: "BTCUSDT",
      price: 50000,
      quantity: 0.1,
      isBuyerMaker: false,
      time: 1718000000000,
    });
  });

  test("disconnect removes and closes the socket", () => {
    binance.connect("BTCUSDT");
    binance.disconnect("BTCUSDT");
    expect(mockWs.close).toHaveBeenCalled();
  });
});
