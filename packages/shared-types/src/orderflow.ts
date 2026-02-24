import type { Exchange, Side } from './market';

export interface FootprintLevel {
  price: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  tradeCount: number;
}

export interface FootprintCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  levels: Map<number, FootprintLevel> | Record<string, FootprintLevel>;
  totalDelta: number;
  totalVolume: number;
}

export interface DeltaChange {
  price: number;
  sizeDelta: number;
  type: 'addition' | 'cancellation' | 'fill';
  time: number;
}

export interface BigTrade {
  time: number;
  price: number;
  totalSize: number;
  side: Side;
  tradeCount: number;
  exchange: Exchange;
  symbol: string;
}

export interface ImbalanceCell {
  priceLevel: number;
  ratio: number;
  side: Side;
  buyVolume: number;
  sellVolume: number;
}

export interface VolumeProfileLevel {
  price: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
}

export interface VolumeProfile {
  levels: VolumeProfileLevel[];
  poc: number;
  vah: number;
  val: number;
  valueAreaVolume: number;
  totalVolume: number;
}
