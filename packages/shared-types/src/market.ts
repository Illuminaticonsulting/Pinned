export type Exchange = 'blofin' | 'mexc';

export type Side = 'buy' | 'sell';

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  exchange: Exchange;
  symbol: string;
  timeframe: Timeframe;
}

export interface Trade {
  time: number;
  price: number;
  size: number;
  side: Side;
  tradeId: string;
  exchange: Exchange;
  symbol: string;
}

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface OrderbookSnapshot {
  time: number;
  exchange: Exchange;
  symbol: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
}

export interface FundingRate {
  time: number;
  exchange: Exchange;
  symbol: string;
  rate: number;
  nextFundingTime: number;
}

export interface Ticker {
  symbol: string;
  exchange: Exchange;
  lastPrice: number;
  bid: number;
  ask: number;
  volume24h: number;
  change24h: number;
  high24h: number;
  low24h: number;
}
