import { Exchange } from '@pinned/shared-types';
import { ExchangeAdapter } from './types';
import { BloFinAdapter } from './blofin';
import { MexcAdapter } from './mexc';

export { ExchangeAdapter, ExchangeAdapterEvents } from './types';
export { BloFinAdapter } from './blofin';
export { MexcAdapter } from './mexc';

export function createAdapter(exchange: Exchange): ExchangeAdapter {
  switch (exchange) {
    case 'blofin':
      return new BloFinAdapter();
    case 'mexc':
      return new MexcAdapter();
    default:
      throw new Error(`Unsupported exchange: ${exchange}`);
  }
}
