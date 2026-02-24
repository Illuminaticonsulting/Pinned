import type { Exchange } from './market';

export interface HeatmapCell {
  priceIndex: number;
  timeIndex: number;
  intensity: number;
  maxSize: number;
}

export interface HeatmapUpdate {
  type: 'full' | 'diff';
  cells: HeatmapCell[];
  priceMin: number;
  priceMax: number;
  timeStart: number;
  timeEnd: number;
  tickSize: number;
  timeStep: number;
}

export interface PatternEvent {
  type: 'iceberg' | 'spoof' | 'absorption';
  time: number;
  price: number;
  exchange: Exchange;
  symbol: string;
  confidence: number;
  estimatedSize?: number;
  direction: 'bid' | 'ask';
  duration?: number;
}
