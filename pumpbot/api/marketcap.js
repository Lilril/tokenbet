// Кеш в памяти
let priceCache = {
  price: null,
  timestamp: 0,
  duration: 8000 // 8 секунд кеш
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const tokenAddress = req.query.token || '7chpRdN9x95obVpdVa2xziaEc7CmRtoEtfuvY7LzBAGS';
  const TOTAL_SUPPLY = 1000000000;
  
  console.log('🔍 Price request for:', tokenAddress);
  
  // Возвращаем кеш если свежий
  const now = Date.now();
  if (priceCache.price && (now - priceCache.timestamp) < priceCache.duration) {
    const marketCap = priceCache.price * TOTAL_SUPPLY;
    console.log('📦 Cache hit:', priceCache.price);
    
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
  
  // МЕТОД 1: DexScreener (самый надежный для pump.fun)
  try {
    console.log('→ DexScreener...');
    
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
        // Берем пару с наибольшей ликвидностью
        const bestPair = data.pairs.sort((a, b) => 
          (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
        )[0];
        
        const price = parseFloat(bestPair.priceUsd);
        
        if (price > 0 && !isNaN(price)) {
          priceCache = { price, timestamp: now };
          const marketCap = price * TOTAL_SUPPLY;
          
          console.log(`✅ DexScreener: $${price.toFixed(8)}`);
          
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
    
    console.log('⚠️ DexScreener: no data');
  } catch (error) {
    console.log('❌ DexScreener:', error.message);
  }
  
  // МЕТОД 2: Jupiter Price API v6
  try {
    console.log('→ Jupiter...');
    
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
          
          console.log(`✅ Jupiter: $${price.toFixed(8)}`);
          
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
    
    console.log('⚠️ Jupiter: no data');
  } catch (error) {
    console.log('❌ Jupiter:', error.message);
  }
  
  // МЕТОД 3: GeckoTerminal (новый агрегатор)
  try {
    console.log('→ GeckoTerminal...');
    
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
          
          console.log(`✅ GeckoTerminal: $${price.toFixed(8)}`);
          
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
    
    console.log('⚠️ GeckoTerminal: no data');
  } catch (error) {
    console.log('❌ GeckoTerminal:', error.message);
  }
  
  // МЕТОД 4: Birdeye Public API
  try {
    console.log('→ Birdeye...');
    
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
          
          console.log(`✅ Birdeye: $${price.toFixed(8)}`);
          
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
    
    console.log('⚠️ Birdeye: no data');
  } catch (error) {
    console.log('❌ Birdeye:', error.message);
  }
  
  // Если есть старый кеш - отдаем его с предупреждением
  if (priceCache.price) {
    const age = Math.floor((now - priceCache.timestamp) / 1000);
    const marketCap = priceCache.price * TOTAL_SUPPLY;
    
    console.log(`⚠️ Returning stale cache (${age}s old)`);
    
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
  
  // Совсем ничего не получилось
  console.error('❌ All methods failed, no cache available');
  
  return res.status(503).json({
    success: false,
    error: 'Unable to fetch price from any source',
    token: tokenAddress,
    timestamp: new Date().toISOString()
  });
}

