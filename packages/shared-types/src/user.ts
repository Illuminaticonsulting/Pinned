import type { Exchange, Timeframe } from './market';

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatar?: string;
  createdAt: number;
  preferences: UserPreferences;
}

export interface UserPreferences {
  defaultSymbol: string;
  defaultTimeframe: Timeframe;
  theme: 'dark' | 'darker';
  defaultExchange: Exchange;
}

export interface Alert {
  id: string;
  userId: string;
  symbol: string;
  condition: AlertCondition;
  delivery: AlertDelivery[];
  active: boolean;
  createdAt: number;
  lastTriggered?: number;
  expiresAt?: number;
}

export interface AlertCondition {
  type:
    | 'price_cross'
    | 'delta_divergence'
    | 'ofi_threshold'
    | 'absorption'
    | 'funding_spike'
    | 'pattern';
  value: number;
  operator: 'gt' | 'lt' | 'cross_above' | 'cross_below';
}

export type AlertDelivery = 'in_app' | 'browser_push' | 'telegram' | 'email';

export interface Drawing {
  id: string;
  userId: string;
  symbol: string;
  timeframe: Timeframe;
  type: DrawingType;
  points: DrawingPoint[];
  properties: DrawingProperties;
  createdAt: number;
  updatedAt: number;
}

export type DrawingType =
  | 'hline'
  | 'trendline'
  | 'rectangle'
  | 'fibonacci'
  | 'anchored_vwap';

export interface DrawingPoint {
  time: number;
  price: number;
}

export interface DrawingProperties {
  color: string;
  lineWidth: number;
  lineStyle: 'solid' | 'dashed' | 'dotted';
  fillColor?: string;
  fillOpacity?: number;
  extended?: boolean;
  levels?: number[];
  label?: string;
}
