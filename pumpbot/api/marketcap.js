import { sql } from '@vercel/postgres';


let tableCreated = false;
async function ensureTable() {
  if (tableCreated) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS market_cap_history (
      id SERIAL PRIMARY KEY,
      market_cap NUMERIC NOT NULL,
      price NUMERIC,
      source TEXT,
      recorded_at TIMESTAMP DEFAULT NOW()
    )`;
    tableCreated = true;
  } catch(e) { tableCreated = true; } // Ignore if already exists
}


function saveMarketCap(marketCap, price, source) {
  ensureTable().then(() => {
    sql`INSERT INTO market_cap_history (market_cap, price, source) VALUES (${marketCap}, ${price}, ${source})`
  });
}

let priceCache = {
  price: null,
  timestamp: 0,
  duration: 3000 
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const tokenAddress = req.query.token || 'F1CjqLUTM3B4b7LreJKMZmLV3p5mDnfs1vpQSFJL4E8e';
  const TOTAL_SUPPLY = 1000000000;
  
  const now = Date.now();
  if (priceCache.price && (now - priceCache.timestamp) < priceCache.duration) {
    return res.status(200).json({
      success: true,
      marketCap: priceCache.price * TOTAL_SUPPLY,
      price: priceCache.price,
      supply: TOTAL_SUPPLY,
      token: tokenAddress,
      method: 'cached',
      timestamp: new Date().toISOString()
    });
  }
  
  // Helper: fetch with timeout
  async function fetchWithTimeout(url, headers, timeoutMs = 3000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json', ...headers } });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch(e) {
      clearTimeout(timer);
      throw e;
    }
  }
  
  // All sources in parallel — first valid price wins
  const sources = [
    // DexScreener
    fetchWithTimeout(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { 'User-Agent': 'Mozilla/5.0' })
      .then(data => {
        const pair = data.pairs?.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        const p = parseFloat(pair?.priceUsd);
        if (p > 0) return { price: p, method: 'dexscreener' };
        throw new Error('no price');
      }),
    // Jupiter
    fetchWithTimeout(`https://api.jup.ag/price/v2?ids=${tokenAddress}`, {})
      .then(data => {
        const p = parseFloat(data.data?.[tokenAddress]?.price);
        if (p > 0) return { price: p, method: 'jupiter' };
        throw new Error('no price');
      }),
    // GeckoTerminal
    fetchWithTimeout(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${tokenAddress}`, {})
      .then(data => {
        const p = parseFloat(data.data?.attributes?.price_usd);
        if (p > 0) return { price: p, method: 'geckoterminal' };
        throw new Error('no price');
      }),
    // Birdeye
    fetchWithTimeout(`https://public-api.birdeye.so/defi/price?address=${tokenAddress}`, {})
      .then(data => {
        const p = parseFloat(data.data?.value);
        if (p > 0) return { price: p, method: 'birdeye' };
        throw new Error('no price');
      }),
  ];
  
  try {
    // Promise.any — resolves with first successful result
    const result = await Promise.any(sources);
    
    priceCache = { price: result.price, timestamp: Date.now(), duration: 3000 };
    const marketCap = result.price * TOTAL_SUPPLY;
    saveMarketCap(marketCap, result.price, result.method);
    
    return res.status(200).json({
      success: true,
      marketCap,
      price: result.price,
      supply: TOTAL_SUPPLY,
      token: tokenAddress,
      method: result.method,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    // All failed — use stale cache
    if (priceCache.price) {
      return res.status(200).json({
        success: true,
        marketCap: priceCache.price * TOTAL_SUPPLY,
        price: priceCache.price,
        supply: TOTAL_SUPPLY,
        token: tokenAddress,
        method: 'stale-cache',
        timestamp: new Date().toISOString()
      });
    }
    
    return res.status(503).json({
      success: false,
      error: 'All price sources unavailable',
      token: tokenAddress,
      timestamp: new Date().toISOString()
    });
  }
}
