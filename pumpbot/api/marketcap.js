export default async function handler(req, res) {
  // Разрешаем CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  const tokenAddress = req.query.token || '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';
  
  // Адрес bonding curve для pump.fun токенов
  const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  
  try {
    // 1. Получаем supply токена
    const supplyResponse = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenSupply',
        params: [tokenAddress]
      })
    });
    
    const supplyData = await supplyResponse.json();
    
    if (!supplyData.result || !supplyData.result.value) {
      throw new Error('Failed to get token supply');
    }
    
    const totalSupply = supplyData.result.value.uiAmount;
    console.log('Total supply:', totalSupply);
    
    // 2. Получаем цену через Raydium API (более надежный)
    try {
      const raydiumResponse = await fetch(`https://api-v3.raydium.io/mint/price?mints=${tokenAddress}`);
      
      if (raydiumResponse.ok) {
        const raydiumData = await raydiumResponse.json();
        
        if (raydiumData.data && raydiumData.data[tokenAddress]) {
          const price = raydiumData.data[tokenAddress];
          const marketCap = price * totalSupply;
          
          console.log('Price from Raydium:', price);
          console.log('Market cap:', marketCap);
          
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            price: price,
            totalSupply: totalSupply,
            token: tokenAddress,
            method: 'raydium',
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (e) {
      console.log('Raydium failed:', e.message);
    }
    
    // 3. Пробуем Jupiter
    try {
      const jupiterResponse = await fetch(`https://price.jup.ag/v6/price?ids=${tokenAddress}`);
      
      if (jupiterResponse.ok) {
        const jupiterData = await jupiterResponse.json();
        
        if (jupiterData.data && jupiterData.data[tokenAddress]) {
          const price = jupiterData.data[tokenAddress].price;
          const marketCap = price * totalSupply;
          
          console.log('Price from Jupiter:', price);
          console.log('Market cap:', marketCap);
          
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            price: price,
            totalSupply: totalSupply,
            token: tokenAddress,
            method: 'jupiter',
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (e) {
      console.log('Jupiter failed:', e.message);
    }
    
    // 4. Последний шанс - DexScreener
    try {
      const dexResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
      
      if (dexResponse.ok) {
        const dexData = await dexResponse.json();
        
        if (dexData.pairs && dexData.pairs.length > 0) {
          const pair = dexData.pairs[0];
          const marketCap = pair.marketCap || pair.fdv || 0;
          
          if (marketCap > 0) {
            console.log('Market cap from DexScreener:', marketCap);
            
            return res.status(200).json({
              success: true,
              marketCap: marketCap,
              token: tokenAddress,
              method: 'dexscreener',
              timestamp: new Date().toISOString()
            });
          }
        }
      }
    } catch (e) {
      console.log('DexScreener failed:', e.message);
    }
    
    // Если ничего не сработало
    return res.status(200).json({
      success: false,
      marketCap: 0,
      token: tokenAddress,
      message: 'No price data available from any source',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      token: tokenAddress
    });
  }
}
