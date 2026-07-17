import WebSocket from "ws";

export interface Tick {
  symbol: string;
  price: number;
  time: number;
  changePct24h?: number; // 24h % change from the @ticker stream, if available
}

export type AlertCondition = "above" | "below";

export interface Alert {
  id: number;
  symbol: string;
  condition: AlertCondition;
  threshold: number;
  triggered: boolean;
  triggeredAt: number | null;
  triggeredPrice: number | null;
}

const STREAM_BASE = "wss://stream.binance.com:9443/ws";
const FUTURES_STREAM_BASE = "wss://fstream.binance.com/ws";
const LIQUIDATIONS_STREAM = "!forceOrder@arr";
const MAX_LIQUIDATIONS_BUFFERED = 200;

export interface Liquidation {
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  quantity: number;
  time: number;
}

export interface ClosedKline {
  symbol: string;
  interval: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ponytail: one manager, in-memory only — no persistence across restarts,
// add a store if alerts need to survive a process crash.
export class BinanceStreamManager {
  private sockets = new Map<string, WebSocket>();
  private latest = new Map<string, Tick>();
  private alerts: Alert[] = [];
  private nextAlertId = 1;
  private liquidations: Liquidation[] = [];
  private closedKlines = new Map<string, ClosedKline>();

  subscribe(symbol: string): Promise<void> {
    const sym = symbol.toUpperCase();
    const stream = `${sym.toLowerCase()}@ticker`;
    if (this.sockets.has(stream)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${STREAM_BASE}/${stream}`);
      const onError = (err: Error) => {
        this.sockets.delete(stream);
        reject(err);
      };
      ws.once("error", onError);
      ws.once("open", () => {
        ws.off("error", onError);
        resolve();
      });
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        const tick: Tick = { symbol: sym, price: Number(msg.c), time: Date.now(), changePct24h: Number(msg.P) };
        this.latest.set(sym, tick);
        this.checkAlerts(tick);
      });
      ws.on("error", () => {
        // swallow post-open errors; getLatest()/isSubscribed() reflect staleness naturally
      });
      this.sockets.set(stream, ws);
    });
  }

  unsubscribe(symbol: string): boolean {
    const sym = symbol.toUpperCase();
    const stream = `${sym.toLowerCase()}@ticker`;
    const ws = this.sockets.get(stream);
    if (!ws) return false;
    ws.terminate();
    this.sockets.delete(stream);
    this.latest.delete(sym);
    return true;
  }

  isSubscribed(symbol: string): boolean {
    return this.sockets.has(`${symbol.toLowerCase()}@ticker`);
  }

  getLatest(symbol: string): Tick | undefined {
    return this.latest.get(symbol.toUpperCase());
  }

  listSubscriptions(): string[] {
    return [...this.latest.keys()];
  }

  addAlert(symbol: string, condition: AlertCondition, threshold: number): Alert {
    const alert: Alert = {
      id: this.nextAlertId++,
      symbol: symbol.toUpperCase(),
      condition,
      threshold,
      triggered: false,
      triggeredAt: null,
      triggeredPrice: null,
    };
    this.alerts.push(alert);
    return alert;
  }

  removeAlert(id: number): boolean {
    const before = this.alerts.length;
    this.alerts = this.alerts.filter((a) => a.id !== id);
    return this.alerts.length < before;
  }

  listAlerts(): Alert[] {
    return [...this.alerts];
  }

  private checkAlerts(tick: Tick): void {
    for (const alert of this.alerts) {
      if (alert.triggered || alert.symbol !== tick.symbol) continue;
      const hit = alert.condition === "above" ? tick.price >= alert.threshold : tick.price <= alert.threshold;
      if (hit) {
        alert.triggered = true;
        alert.triggeredAt = tick.time;
        alert.triggeredPrice = tick.price;
      }
    }
  }

  subscribeKline(symbol: string, interval: string, onClose?: (k: ClosedKline) => void): Promise<void> {
    const sym = symbol.toUpperCase();
    const stream = `${sym.toLowerCase()}@kline_${interval}`;
    if (this.sockets.has(stream)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${STREAM_BASE}/${stream}`);
      const onError = (err: Error) => {
        this.sockets.delete(stream);
        reject(err);
      };
      ws.once("error", onError);
      ws.once("open", () => {
        ws.off("error", onError);
        resolve();
      });
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        const k = msg.k;
        if (!k || !k.x) return; // only store closed candles
        const key = `${sym}:${interval}`;
        const closed: ClosedKline = {
          symbol: sym, interval,
          openTime: Number(k.t), closeTime: Number(k.T),
          open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c),
          volume: Number(k.v),
        };
        this.closedKlines.set(key, closed);
        onClose?.(closed);
      });
      ws.on("error", () => {});
      this.sockets.set(stream, ws);
    });
  }

  unsubscribeKline(symbol: string, interval: string): boolean {
    const sym = symbol.toUpperCase();
    const stream = `${sym.toLowerCase()}@kline_${interval}`;
    const ws = this.sockets.get(stream);
    if (!ws) return false;
    ws.terminate();
    this.sockets.delete(stream);
    this.closedKlines.delete(`${sym}:${interval}`);
    return true;
  }

  isSubscribedToKline(symbol: string, interval: string): boolean {
    return this.sockets.has(`${symbol.toLowerCase()}@kline_${interval}`);
  }

  getLatestClosedKline(symbol: string, interval: string): ClosedKline | undefined {
    return this.closedKlines.get(`${symbol.toUpperCase()}:${interval}`);
  }

  subscribeLiquidations(): Promise<void> {
    if (this.sockets.has(LIQUIDATIONS_STREAM)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${FUTURES_STREAM_BASE}/${LIQUIDATIONS_STREAM}`);
      const onError = (err: Error) => {
        this.sockets.delete(LIQUIDATIONS_STREAM);
        reject(err);
      };
      ws.once("error", onError);
      ws.once("open", () => {
        ws.off("error", onError);
        resolve();
      });
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        const o = msg.o;
        if (!o) return;
        this.liquidations.push({ symbol: o.s, side: o.S, price: Number(o.ap), quantity: Number(o.q), time: Number(o.T) });
        if (this.liquidations.length > MAX_LIQUIDATIONS_BUFFERED) this.liquidations.shift();
      });
      ws.on("error", () => {});
      this.sockets.set(LIQUIDATIONS_STREAM, ws);
    });
  }

  unsubscribeLiquidations(): boolean {
    const ws = this.sockets.get(LIQUIDATIONS_STREAM);
    if (!ws) return false;
    ws.terminate();
    this.sockets.delete(LIQUIDATIONS_STREAM);
    return true;
  }

  isSubscribedToLiquidations(): boolean {
    return this.sockets.has(LIQUIDATIONS_STREAM);
  }

  getLiquidations(symbol?: string): Liquidation[] {
    const list = symbol ? this.liquidations.filter((l) => l.symbol === symbol.toUpperCase()) : this.liquidations;
    return [...list];
  }

  closeAll(): void {
    for (const ws of this.sockets.values()) ws.terminate();
    this.sockets.clear();
    this.latest.clear();
    this.liquidations = [];
    this.closedKlines.clear();
  }
}
