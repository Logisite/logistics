export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export interface Money {
  cents: number;
  currency: Currency;
}