export type SignalDirection = 'long' | 'short' | 'flat';

export type MarketRegime =
  | 'trending_up'
  | 'trending_down'
  | 'ranging'
  | 'reversing_up'
  | 'reversing_down';

export interface Signal {
  id: string;
  time: number;
  symbol: string;
  direction: SignalDirection;
  confidence: number;
  reasoning: string;
  triggers: string[];
  patternType: string;
  regime?: MarketRegime;
  metadata?: Record<string, unknown>;
}

export interface RegimeState {
  regime: MarketRegime;
  confidence: number;
  since: number;
  indicators: Record<string, number>;
}
