export interface Trade {
  num: number;
  date: string;
  name: string;
  ticker: string;
  market: string;
  sector: string;
  direction: string;
  amountKRW: number;
  entryStr: string;
  entryPrice: number;
  entryIsUSD: boolean;
  stopStr: string;
  stopPrice: number;
  stopIsUSD: boolean;
  exitStr: string;
  result: string;
  holdDays: string;
  rrRatio: number | null;
  profitKRW: number;
  isOpen: boolean;
  isPaper: boolean;
  currentStr?: string;
  pnlKRW?: number;
  pnlPct?: number;
}

export interface Prices {
  USDKRW: number | null;
  [name: string]: number | null;
}
