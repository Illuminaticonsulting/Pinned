import { Candle, Trade, OrderbookSnapshot, Ticker, FundingRate, Timeframe } from '@pinned/shared-types';
import { EventEmitter } from 'events';

export interface ExchangeAdapterEvents {
  trade: (trade: Trade) => void;
  orderbook: (snapshot: OrderbookSnapshot) => void;
  candle: (candle: Candle) => void;
  ticker: (ticker: Ticker) => void;
  fundingRate: (rate: FundingRate) => void;
  connected: () => void;
  disconnected: (reason: string) => void;
  error: (error: Error) => void;
  reconnecting: (attempt: number) => void;
}

export interface ExchangeAdapter extends EventEmitter {
  readonly exchange: string;
  readonly connected: boolean;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  subscribeTrades(symbol: string): void;
  subscribeOrderbook(symbol: string): void;
  subscribeCandles(symbol: string, timeframe: Timeframe): void;

  unsubscribeTrades(symbol: string): void;
  unsubscribeOrderbook(symbol: string): void;
  unsubscribeCandles(symbol: string, timeframe: Timeframe): void;

  getHistoricalCandles(symbol: string, timeframe: Timeframe, limit?: number): Promise<Candle[]>;
  getOrderbook(symbol: string): Promise<OrderbookSnapshot>;
  getTicker(symbol: string): Promise<Ticker>;
  getFundingRate(symbol: string): Promise<FundingRate>;
  getRecentTrades(symbol: string, limit?: number): Promise<Trade[]>;
}
