import type { Candle } from "./types";

export type ConnState = "connecting" | "open" | "closed";

export interface DerivCallbacks {
  onTick: (price: number, epoch: number) => void;
  onM1: (candles: Candle[]) => void;
  onM5: (candles: Candle[]) => void;
  onM15: (candles: Candle[]) => void;
  onState: (s: ConnState) => void;
}

const PUBLIC_FEED = "wss://api.derivws.com/trading/v1/options/ws/public";

export class DerivClient {
  private ws?: WebSocket;
  private reconnectMs = 1000;
  private closed = false;
  private cbs: DerivCallbacks;
  private m1: Candle[] = [];
  private m5: Candle[] = [];
  private m15: Candle[] = [];

  constructor(cbs: DerivCallbacks) {
    this.cbs = cbs;
  }

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    this.ws?.close();
  }

  private send(o: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(o));
    }
  }

  private connect() {
    this.cbs.onState("connecting");
    this.ws = new WebSocket(PUBLIC_FEED);

    this.ws.onopen = () => {
      this.cbs.onState("open");
      this.reconnectMs = 1000;
      this.send({ ticks: "R_75", subscribe: 1, req_id: 1 });
      this.send({ ticks_history: "R_75", adjust_start_time: 1, count: 1000, end: "latest", granularity: 60, start: 1, style: "candles", subscribe: 1, req_id: 2 });
      this.send({ ticks_history: "R_75", adjust_start_time: 1, count: 500, end: "latest", granularity: 300, start: 1, style: "candles", subscribe: 1, req_id: 3 });
      this.send({ ticks_history: "R_75", adjust_start_time: 1, count: 200, end: "latest", granularity: 900, start: 1, style: "candles", subscribe: 1, req_id: 6 });
    };

    this.ws.onmessage = (ev) => this.handle(JSON.parse(ev.data));

    this.ws.onclose = () => {
      this.cbs.onState("closed");
      if (!this.closed) {
        setTimeout(() => this.connect(), this.reconnectMs);
        this.reconnectMs = Math.min(this.reconnectMs * 2, 8000);
      }
    };

    this.ws.onerror = () => this.ws?.close();
  }

  private handle(d: any) {
    if (d.msg_type === "tick" && d.tick) {
      this.cbs.onTick(d.tick.quote, d.tick.epoch);
      return;
    }

    if (d.msg_type === "candles" && d.candles) {
      const cs: Candle[] = d.candles.map((c: any) => ({
        time: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close,
      }));
      if (d.req_id === 2) { this.m1 = cs; this.cbs.onM1(cs); }
      else if (d.req_id === 3) { this.m5 = cs; this.cbs.onM5(cs); }
      else if (d.req_id === 6) { this.m15 = cs; this.cbs.onM15(cs); }
      return;
    }

    if (d.msg_type === "ohlc" && d.ohlc) {
      const c: Candle = {
        time: d.ohlc.open_time, open: +d.ohlc.open, high: +d.ohlc.high,
        low: +d.ohlc.low, close: +d.ohlc.close,
      };
      const gran = d.ohlc.granularity;
      const arr = gran === 60 ? this.m1 : gran === 300 ? this.m5 : gran === 900 ? this.m15 : null;
      if (!arr) return;
      const last = arr[arr.length - 1];
      if (last && last.time === c.time) arr[arr.length - 1] = c;
      else arr.push(c);
      if (arr.length > 1500) arr.shift();
      if (gran === 60) this.cbs.onM1([...arr]);
      else if (gran === 300) this.cbs.onM5([...arr]);
      else this.cbs.onM15([...arr]);
    }
  }
}
