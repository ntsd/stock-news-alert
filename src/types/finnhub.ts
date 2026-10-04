export interface FinnhubNewsArticle {
  category: string;
  datetime: number; // Unix timestamp in seconds
  headline: string;
  id: number;
  image: string;
  related: string; // Ticker symbol, e.g. "AAPL"
  source: string;
  summary: string;
  url: string;
}

export interface FinnhubQuote {
  c: number; // Current price
  d: number; // Change
  dp: number; // Percent change
  h: number; // High price of the day
  l: number; // Low price of the day
  o: number; // Open price of the day
  pc: number; // Previous close price
  t: number; // Timestamp in seconds
}

export interface StockQuote {
  symbol: string;
  current: number;
  price?: number;
  change: number;
  percentChange: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  timestamp: string | number; // ISO string or timestamp
}

export interface PricePoint {
  timestamp: number; // Unix timestamp in ms
  price: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}
