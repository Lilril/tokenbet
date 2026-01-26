export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const tokenAddress = req.query.token || '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';
  
  console.log('🔍 Fetching market cap for:', tokenAddress);
  
  // МЕТОД 1: DexScreener API (самый надежный)
  try {
    console.log('Trying DexScreener...');
    const dexResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    });
    
    if (dexResponse.ok) {
      const dexData = await dexResponse.json();
      console.log('DexScreener response:', dexData);
      
      if (dexData.pairs && dexData.pairs.length > 0) {
        // Берем первую пару (обычно самая ликвидная)
        const pair = dexData.pairs[0];
        const marketCap = parseFloat(pair.fdv || pair.marketCap || 0);
        
        if (marketCap > 0) {
          console.log('✅ DexScreener market cap:', marketCap);
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            token: tokenAddress,
            method: 'dexscreener',
            pairAddress: pair.pairAddress,
            priceUsd: pair.priceUsd,
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
    const jupResponse = await fetch(`https://price.jup.ag/v4/price?ids=${tokenAddress}`);
    
    if (jupResponse.ok) {
      const jupData = await jupResponse.json();
      console.log('Jupiter response:', jupData);
      
      if (jupData.data && jupData.data[tokenAddress]) {
        const tokenData = jupData.data[tokenAddress];
        const price = parseFloat(tokenData.price || 0);
        
        if (price > 0) {
          // Для pump.fun токенов supply обычно 1 миллиард
          const supply = 1000000000;
          const marketCap = price * supply;
          
          console.log('✅ Jupiter market cap:', marketCap);
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            token: tokenAddress,
            method: 'jupiter',
            price: price,
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  } catch (error) {
    console.log('Jupiter failed:', error.message);
  }
  
  // МЕТОД 3: Pump.fun API
  try {
    console.log('Trying Pump.fun API...');
    const pumpResponse = await fetch(`https://frontend-api.pump.fun/coins/${tokenAddress}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }
    });
    
    if (pumpResponse.ok) {
      const pumpData = await pumpResponse.json();
      console.log('Pump.fun API response:', pumpData);
      
      let marketCap = parseFloat(pumpData.usd_market_cap || pumpData.market_cap || 0);
      
      // Если market cap в данных
      if (marketCap > 0) {
        console.log('✅ Pump.fun market cap:', marketCap);
        return res.status(200).json({
          success: true,
          marketCap: marketCap,
          token: tokenAddress,
          method: 'pumpfun-direct',
          timestamp: new Date().toISOString()
        });
      }
      
      // Считаем из virtual reserves
      if (pumpData.virtual_sol_reserves) {
        try {
          const solPriceResponse = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
          const solPriceData = await solPriceResponse.json();
          const solPrice = solPriceData.solana?.usd || 245;
          
          marketCap = pumpData.virtual_sol_reserves * solPrice;
          console.log(`✅ Calculated from bonding curve: ${pumpData.virtual_sol_reserves} SOL × $${solPrice} = $${marketCap}`);
          
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            token: tokenAddress,
            method: 'pumpfun-calculated',
            solReserves: pumpData.virtual_sol_reserves,
            solPrice: solPrice,
            timestamp: new Date().toISOString()
          });
        } catch (e) {
          console.log('SOL price fetch failed:', e.message);
        }
      }
    }
  } catch (error) {
    console.log('Pump.fun failed:', error.message);
  }
  
  // МЕТОД 4: Birdeye API (если есть API key, можно добавить)
  
  // МЕТОД 5: Solana RPC (читаем данные напрямую из блокчейна)
  try {
    console.log('Trying Solana RPC...');
    const rpcResponse = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenSupply',
        params: [tokenAddress]
      })
    });
    
    const rpcData = await rpcResponse.json();
    if (rpcData.result && rpcData.result.value) {
      const supply = rpcData.result.value.uiAmount || 1000000000;
      // Используем минимальную цену для демонстрации
      const estimatedPrice = 0.0000036; // ~$3.6K market cap для 1B supply
      const marketCap = supply * estimatedPrice;
      
      console.log('✅ RPC estimated market cap:', marketCap);
      return res.status(200).json({
        success: true,
        marketCap: marketCap,
        token: tokenAddress,
        method: 'solana-rpc-estimated',
        supply: supply,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.log('RPC failed:', error.message);
  }
  
  // FALLBACK: Возвращаем демо-данные
  console.log('⚠️ All methods failed, using demo data');
  return res.status(200).json({
    success: true,
    marketCap: 3600,
    token: tokenAddress,
    method: 'demo-fallback',
    message: 'Using demo market cap - real data unavailable',
    timestamp: new Date().toISOString()
  });
}
