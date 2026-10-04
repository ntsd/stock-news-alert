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
