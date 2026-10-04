import dotenv from 'dotenv';
import { JevClassificationService } from '../src/services/jev.js';
dotenv.config();

async function testMultiJev() {
  const jev = new JevClassificationService(process.env.TYPESAFE_API_KEY!);
  const sample1 = {
    category: 'company',
    datetime: Math.floor(Date.now() / 1000),
    headline: 'BREAKING: NVIDIA Unveils Next-Gen AI Architecture with 5x Performance Boost, Surpassing All Wall Street Forecasts',
    id: 111222,
    image: '',
    related: 'NVDA',
    source: 'Bloomberg News',
    summary: 'Nvidia Corp announced its revolutionary Blackwell Ultra platform today in a surprise keynote, raising full-year revenue outlook by $12 Billion.',
    url: 'https://example.com/nvda',
  };

  const sample2 = {
    category: 'company',
    datetime: Math.floor(Date.now() / 1000),
    headline: 'Why I Am Holding Apple In My Portfolio For Retirement',
    id: 333444,
    image: '',
    related: 'AAPL',
    source: 'The Motley Fool',
    summary: 'Here is why dividend compounding makes holding tech blue-chips an attractive long-term retirement strategy.',
    url: 'https://example.com/aapl',
  };

  console.log('Evaluating Sample 1 (Breaking Catalyst)...');
  const res1 = await jev.classifyArticleSentiment(sample1);
  console.log('Sample 1 Result:', JSON.stringify(res1, null, 2));

  console.log('\nEvaluating Sample 2 (Generic Opinion Blog)...');
  const res2 = await jev.classifyArticleSentiment(sample2);
  console.log('Sample 2 Result:', JSON.stringify(res2, null, 2));
}

testMultiJev().catch(console.error);
