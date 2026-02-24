export type WSMessageType =
  | 'subscribe'
  | 'unsubscribe'
  | 'candle'
  | 'trade'
  | 'orderbook'
  | 'heatmap_full'
  | 'heatmap_diff'
  | 'signal'
  | 'alert'
  | 'big_trade'
  | 'pattern_event'
  | 'ofi'
  | 'funding'
  | 'sync_mutation'
  | 'error'
  | 'pong';

export interface WSMessage {
  type: WSMessageType;
  channel?: string;
  data: unknown;
  timestamp: number;
}

export interface WSSubscribeMessage {
  type: 'subscribe';
  channels: string[];
}

export interface WSUnsubscribeMessage {
  type: 'unsubscribe';
  channels: string[];
}

/** Channel format: "type:exchange:symbol:timeframe?" e.g. "candles:blofin:BTC-USDT:1m" */
export type WSChannel = string;

export interface SyncMutation {
  type:
    | 'pan'
    | 'zoom'
    | 'draw'
    | 'delete_draw'
    | 'indicator_toggle'
    | 'symbol_change'
    | 'timeframe_change'
    | 'crosshair'
    | 'annotation';
  data: unknown;
  userId: string;
  timestamp: number;
}
