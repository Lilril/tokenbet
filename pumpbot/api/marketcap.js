// В памяти храним последнее успешное значение
let cachedPrice = null;
let lastFetchTime = 0;
const CACHE_DURATION = 5000; // 5 секунд кеш

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const tokenAddress = req.query.token || '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';
  const TOTAL_SUPPLY = 1000000000;
  
  console.log('🔍 Getting price for:', tokenAddress);
  
  // Возвращаем кешированное значение если оно свежее
  const now = Date.now();
  if (cachedPrice && (now - lastFetchTime) < CACHE_DURATION) {
    console.log('📦 Returning cached price:', cachedPrice);
    return res.status(200).json({
      success: true,
      marketCap: cachedPrice * TOTAL_SUPPLY,
      price: cachedPrice,
      supply: TOTAL_SUPPLY,
      token: tokenAddress,
      method: 'cached',
      cached: true,
      timestamp: new Date().toISOString()
    });
  }
  
  // МЕТОД 1: DexScreener (самый надежный для новых токенов)
  try {
    console.log('Trying DexScreener...');
    const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    
    const dexResponse = await fetch(dexUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    });
    
    if (dexResponse.ok) {
      const dexData = await dexResponse.json();
      
      if (dexData.pairs && dexData.pairs.length > 0) {
        // Сортируем пары по ликвидности и берем самую ликвидную
        const sortedPairs = dexData.pairs.sort((a, b) => 
          (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
        );
        
        const bestPair = sortedPairs[0];
        const price = parseFloat(bestPair.priceUsd);
        
        if (price > 0) {
          const marketCap = price * TOTAL_SUPPLY;
          
          // Кешируем успешный результат
          cachedPrice = price;
          lastFetchTime = now;
          
          console.log(`✅ DexScreener: $${price} (liquidity: $${bestPair.liquidity?.usd || 0})`);
          
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            price: price,
            supply: TOTAL_SUPPLY,
            token: tokenAddress,
            pairAddress: bestPair.pairAddress,
            liquidity: bestPair.liquidity?.usd || 0,
            dex: bestPair.dexId,
            method: 'dexscreener',
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  } catch (error) {
    console.log('DexScreener failed:', error.message);
  }
  
  // МЕТОД 2: Jupiter Price API
  try {
    console.log('Trying Jupiter...');
    const jupiterUrl = `https://price.jup.ag/v6/price?ids=${tokenAddress}`;
    
    const jupResponse = await fetch(jupiterUrl, {
      headers: { 'Accept': 'application/json' }
    });
    
    if (jupResponse.ok) {
      const jupData = await jupResponse.json();
      
      if (jupData.data && jupData.data[tokenAddress]) {
        const price = parseFloat(jupData.data[tokenAddress].price);
        
        if (price > 0) {
          const marketCap = price * TOTAL_SUPPLY;
          
          cachedPrice = price;
          lastFetchTime = now;
          
          console.log(`✅ Jupiter: $${price}`);
          
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
    console.log('Jupiter failed:', error.message);
  }
  
  // МЕТОД 3: Получаем цену через Raydium swap quote
  try {
    console.log('Trying Raydium swap quote...');
    
    // USDC mint address
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const AMOUNT = 1000000; // 1 USDC (6 decimals)
    
    const swapUrl = `https://api-v3.raydium.io/swap/compute-swap?inputMint=${USDC_MINT}&outputMint=${tokenAddress}&amount=${AMOUNT}&slippage=1`;
    
    const swapResponse = await fetch(swapUrl, {
      headers: { 'Accept': 'application/json' }
    });
    
    if (swapResponse.ok) {
      const swapData = await swapResponse.json();
      
      if (swapData.data && swapData.data.outputAmount) {
        const outputAmount = parseFloat(swapData.data.outputAmount);
        
        // Рассчитываем цену: 1 USDC / полученное количество токенов
        const price = 1 / (outputAmount / Math.pow(10, 9)); // assuming 9 decimals
        
        if (price > 0) {
          const marketCap = price * TOTAL_SUPPLY;
          
          cachedPrice = price;
          lastFetchTime = now;
          
          console.log(`✅ Raydium swap: $${price}`);
          
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            price: price,
            supply: TOTAL_SUPPLY,
            token: tokenAddress,
            method: 'raydium-swap',
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  } catch (error) {
    console.log('Raydium swap failed:', error.message);
  }
  
  // МЕТОД 4: Birdeye (публичный endpoint, может быть rate limited)
  try {
    console.log('Trying Birdeye...');
    const birdeyeUrl = `https://public-api.birdeye.so/public/price?address=${tokenAddress}`;
    
    const birdeyeResponse = await fetch(birdeyeUrl, {
      headers: { 'Accept': 'application/json' }
    });
    
    if (birdeyeResponse.ok) {
      const birdeyeData = await birdeyeResponse.json();
      
      if (birdeyeData.data && birdeyeData.data.value) {
        const price = parseFloat(birdeyeData.data.value);
        
        if (price > 0) {
          const marketCap = price * TOTAL_SUPPLY;
          
          cachedPrice = price;
          lastFetchTime = now;
          
          console.log(`✅ Birdeye: $${price}`);
          
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
    console.log('Birdeye failed:', error.message);
  }
  
  // Если есть старое кешированное значение - вернем его с предупреждением
  if (cachedPrice) {
    console.log('⚠️ All APIs failed, returning stale cache:', cachedPrice);
    return res.status(200).json({
      success: true,
      marketCap: cachedPrice * TOTAL_SUPPLY,
      price: cachedPrice,
      supply: TOTAL_SUPPLY,
      token: tokenAddress,
      method: 'stale-cache',
      warning: 'Using cached price, APIs temporarily unavailable',
      cacheAge: Math.floor((now - lastFetchTime) / 1000) + 's',
      timestamp: new Date().toISOString()
    });
  }
  
  // Все провалилось
  console.error('❌ All methods failed and no cache available');
  
  return res.status(503).json({
    success: false,
    marketCap: 0,
    error: 'Unable to fetch token price from any source',
    token: tokenAddress,
    timestamp: new Date().toISOString()
  });
}
