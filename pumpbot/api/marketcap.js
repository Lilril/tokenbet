export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const tokenAddress = req.query.token || '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';
  
  // Для pump.fun токенов supply всегда 1 миллиард
  const TOTAL_SUPPLY = 1000000000;
  
  console.log('🔍 Getting price for token:', tokenAddress);
  
  // МЕТОД 1: Jupiter Price API (самый быстрый и надежный)
  try {
    console.log('Trying Jupiter Price API...');
    const jupiterUrl = `https://price.jup.ag/v6/price?ids=${tokenAddress}`;
    console.log('URL:', jupiterUrl);
    
    const jupResponse = await fetch(jupiterUrl, {
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (jupResponse.ok) {
      const jupData = await jupResponse.json();
      console.log('Jupiter response:', jupData);
      
      if (jupData.data && jupData.data[tokenAddress]) {
        const price = parseFloat(jupData.data[tokenAddress].price);
        
        if (price > 0) {
          const marketCap = price * TOTAL_SUPPLY;
          
          console.log(`✅ Jupiter: Price $${price}, Market Cap $${marketCap}`);
          
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            price: price,
            supply: TOTAL_SUPPLY,
            token: tokenAddress,
            method: 'jupiter-price',
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  } catch (error) {
    console.log('Jupiter failed:', error.message);
  }
  
  // МЕТОД 2: DexScreener (получаем цену из пары)
  try {
    console.log('Trying DexScreener...');
    const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    
    const dexResponse = await fetch(dexUrl, {
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (dexResponse.ok) {
      const dexData = await dexResponse.json();
      console.log('DexScreener response:', dexData);
      
      if (dexData.pairs && dexData.pairs.length > 0) {
        // Берем первую пару (самая ликвидная)
        const pair = dexData.pairs[0];
        const price = parseFloat(pair.priceUsd);
        
        if (price > 0) {
          const marketCap = price * TOTAL_SUPPLY;
          
          console.log(`✅ DexScreener: Price $${price}, Market Cap $${marketCap}`);
          
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            price: price,
            supply: TOTAL_SUPPLY,
            token: tokenAddress,
            pairAddress: pair.pairAddress,
            dex: pair.dexId,
            method: 'dexscreener-price',
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  } catch (error) {
    console.log('DexScreener failed:', error.message);
  }
  
  // МЕТОД 3: Birdeye API (публичный endpoint)
  try {
    console.log('Trying Birdeye...');
    const birdeyeUrl = `https://public-api.birdeye.so/public/price?address=${tokenAddress}`;
    
    const birdeyeResponse = await fetch(birdeyeUrl, {
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (birdeyeResponse.ok) {
      const birdeyeData = await birdeyeResponse.json();
      console.log('Birdeye response:', birdeyeData);
      
      if (birdeyeData.data && birdeyeData.data.value) {
        const price = parseFloat(birdeyeData.data.value);
        
        if (price > 0) {
          const marketCap = price * TOTAL_SUPPLY;
          
          console.log(`✅ Birdeye: Price $${price}, Market Cap $${marketCap}`);
          
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            price: price,
            supply: TOTAL_SUPPLY,
            token: tokenAddress,
            method: 'birdeye-price',
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  } catch (error) {
    console.log('Birdeye failed:', error.message);
  }
  
  // МЕТОД 4: Raydium API
  try {
    console.log('Trying Raydium...');
    const raydiumUrl = `https://api-v3.raydium.io/mint/price?mints=${tokenAddress}`;
    
    const raydiumResponse = await fetch(raydiumUrl, {
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (raydiumResponse.ok) {
      const raydiumData = await raydiumResponse.json();
      console.log('Raydium response:', raydiumData);
      
      if (raydiumData.data && raydiumData.data[tokenAddress]) {
        const price = parseFloat(raydiumData.data[tokenAddress]);
        
        if (price > 0) {
          const marketCap = price * TOTAL_SUPPLY;
          
          console.log(`✅ Raydium: Price $${price}, Market Cap $${marketCap}`);
          
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            price: price,
            supply: TOTAL_SUPPLY,
            token: tokenAddress,
            method: 'raydium-price',
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  } catch (error) {
    console.log('Raydium failed:', error.message);
  }
  
  // МЕТОД 5: CoinGecko (если токен есть в их базе)
  try {
    console.log('Trying CoinGecko...');
    // Сначала ищем ID токена
    const searchResponse = await fetch(`https://api.coingecko.com/api/v3/search?query=${tokenAddress}`);
    
    if (searchResponse.ok) {
      const searchData = await searchResponse.json();
      
      if (searchData.coins && searchData.coins.length > 0) {
        const coinId = searchData.coins[0].id;
        
        const priceResponse = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`);
        const priceData = await priceResponse.json();
        
        if (priceData[coinId] && priceData[coinId].usd) {
          const price = parseFloat(priceData[coinId].usd);
          const marketCap = price * TOTAL_SUPPLY;
          
          console.log(`✅ CoinGecko: Price $${price}, Market Cap $${marketCap}`);
          
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            price: price,
            supply: TOTAL_SUPPLY,
            token: tokenAddress,
            method: 'coingecko-price',
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  } catch (error) {
    console.log('CoinGecko failed:', error.message);
  }
  
  // Все методы не сработали
  console.error('❌ All price APIs failed');
  
  return res.status(503).json({
    success: false,
    marketCap: 0,
    error: 'Unable to fetch token price from any source',
    token: tokenAddress,
    timestamp: new Date().toISOString()
  });
}
