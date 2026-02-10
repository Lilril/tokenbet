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
  duration: 8000 
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const tokenAddress = req.query.token || '8KvoBfxiPiVp9b9mxSFZHpJdX9NUtbmNFhAGggLDpump';
  const TOTAL_SUPPLY = 1000000000;
  
  
  
  const now = Date.now();
  if (priceCache.price && (now - priceCache.timestamp) < priceCache.duration) {
    const marketCap = priceCache.price * TOTAL_SUPPLY;
    
    return res.status(200).json({
      success: true,
      marketCap: marketCap,
      price: priceCache.price,
      supply: TOTAL_SUPPLY,
      token: tokenAddress,
      method: 'cached',
      timestamp: new Date().toISOString()
    });
  }
  
  
  try {
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { 
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        }
      }
    );
    
    clearTimeout(timeout);
    
    if (response.ok) {
      const data = await response.json();
      
      if (data.pairs && data.pairs.length > 0) {
        
        const bestPair = data.pairs.sort((a, b) => 
          (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
        )[0];
        
        const price = parseFloat(bestPair.priceUsd);
        
        if (price > 0 && !isNaN(price)) {
          priceCache = { price, timestamp: now };
          const marketCap = price * TOTAL_SUPPLY;
          saveMarketCap(marketCap, price, 'auto');
          
          
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            price: price,
            supply: TOTAL_SUPPLY,
            token: tokenAddress,
            pairAddress: bestPair.pairAddress,
            liquidity: bestPair.liquidity?.usd || 0,
            method: 'dexscreener',
            timestamp: new Date().toISOString()
          });
        }
      }
    }
    
  } catch (error) {
  }
  
  
  try {
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(
      `https://api.jup.ag/price/v2?ids=${tokenAddress}`,
      { 
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      }
    );
    
    clearTimeout(timeout);
    
    if (response.ok) {
      const data = await response.json();
      
      if (data.data?.[tokenAddress]?.price) {
        const price = parseFloat(data.data[tokenAddress].price);
        
        if (price > 0 && !isNaN(price)) {
          priceCache = { price, timestamp: now };
          const marketCap = price * TOTAL_SUPPLY;
          saveMarketCap(marketCap, price, 'auto');
          
          
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            price: price,
            supply: TOTAL_SUPPLY,
            token: tokenAddress,
            method: 'jupiter',
            timestamp: new Date().toISOString()
          });
        }
      }
    }
    
  } catch (error) {
  }
  
  
  try {
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${tokenAddress}`,
      { 
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      }
    );
    
    clearTimeout(timeout);
    
    if (response.ok) {
      const data = await response.json();
      
      if (data.data?.attributes?.price_usd) {
        const price = parseFloat(data.data.attributes.price_usd);
        
        if (price > 0 && !isNaN(price)) {
          priceCache = { price, timestamp: now };
          const marketCap = price * TOTAL_SUPPLY;
          saveMarketCap(marketCap, price, 'auto');
          
          
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            price: price,
            supply: TOTAL_SUPPLY,
            token: tokenAddress,
            method: 'geckoterminal',
            timestamp: new Date().toISOString()
          });
        }
      }
    }
    
  } catch (error) {
  }
  
  
  try {
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(
      `https://public-api.birdeye.so/defi/price?address=${tokenAddress}`,
      { 
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      }
    );
    
    clearTimeout(timeout);
    
    if (response.ok) {
      const data = await response.json();
      
      if (data.data?.value) {
        const price = parseFloat(data.data.value);
        
        if (price > 0 && !isNaN(price)) {
          priceCache = { price, timestamp: now };
          const marketCap = price * TOTAL_SUPPLY;
          saveMarketCap(marketCap, price, 'auto');
          
          
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            price: price,
            supply: TOTAL_SUPPLY,
            token: tokenAddress,
            method: 'birdeye',
            timestamp: new Date().toISOString()
          });
        }
      }
    }
    
  } catch (error) {
  }
  
  
  if (priceCache.price) {
    const age = Math.floor((now - priceCache.timestamp) / 1000);
    const marketCap = priceCache.price * TOTAL_SUPPLY;
    
    
    return res.status(200).json({
      success: true,
      marketCap: marketCap,
      price: priceCache.price,
      supply: TOTAL_SUPPLY,
      token: tokenAddress,
      method: 'stale-cache',
      cacheAge: age + 's',
      warning: 'Using cached data, all APIs temporarily unavailable',
      timestamp: new Date().toISOString()
    });
  }
  
  
  console.error('❌ All methods failed, no cache available');
  
  return res.status(503).json({
    success: false,
    error: 'Unable to fetch price from any source',
    token: tokenAddress,
    timestamp: new Date().toISOString()
  });
}

