export default async function handler(req, res) {
  // Разрешаем CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  const tokenAddress = req.query.token || '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';
  
  try {
    // 1. Пробуем pump.fun API (лучший источник для pump.fun токенов)
    try {
      const pumpResponse = await fetch(`https://frontend-api.pump.fun/coins/${tokenAddress}`);
      
      if (pumpResponse.ok) {
        const pumpData = await pumpResponse.json();
        console.log('Pump.fun response:', pumpData);
        
        // Pump.fun возвращает market_cap в разных форматах
        const marketCap = 
          parseFloat(pumpData.usd_market_cap) ||
          parseFloat(pumpData.market_cap) ||
          parseFloat(pumpData.marketCap) ||
          (pumpData.virtual_sol_reserves && pumpData.virtual_token_reserves 
            ? (pumpData.virtual_sol_reserves / pumpData.virtual_token_reserves) * pumpData.total_supply 
            : 0) ||
          0;
        
        if (marketCap > 0) {
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            token: tokenAddress,
            method: 'pumpfun',
            rawData: pumpData,
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (pumpError) {
      console.log('Pump.fun API failed:', pumpError.message);
    }
    
    // 2. Пробуем DexScreener API
    try {
      const dexResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
      
      if (dexResponse.ok) {
        const dexData = await dexResponse.json();
        console.log('DexScreener response:', dexData);
        
        if (dexData.pairs && dexData.pairs.length > 0) {
          // Ищем пару с наибольшей ликвидностью
          const bestPair = dexData.pairs.reduce((prev, current) => 
            (current.liquidity?.usd || 0) > (prev.liquidity?.usd || 0) ? current : prev
          );
          
          const marketCap = bestPair.marketCap || bestPair.fdv || 0;
          
          if (marketCap > 0) {
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
    } catch (dexError) {
      console.log('DexScreener API failed:', dexError.message);
    }
    
    // 3. Пробуем Jupiter Price API
    try {
      const jupiterResponse = await fetch(`https://price.jup.ag/v4/price?ids=${tokenAddress}`);
      
      if (jupiterResponse.ok) {
        const jupiterData = await jupiterResponse.json();
        console.log('Jupiter response:', jupiterData);
        
        if (jupiterData.data && jupiterData.data[tokenAddress]) {
          const price = jupiterData.data[tokenAddress].price;
          
          // Для расчета market cap нужно знать total supply
          // Получаем через Solana RPC
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
          
          if (supplyData.result && supplyData.result.value) {
            const totalSupply = supplyData.result.value.uiAmount;
            const marketCap = price * totalSupply;
            
            if (marketCap > 0) {
              return res.status(200).json({
                success: true,
                marketCap: marketCap,
                token: tokenAddress,
                method: 'jupiter',
                timestamp: new Date().toISOString()
              });
            }
          }
        }
      }
    } catch (jupiterError) {
      console.log('Jupiter API failed:', jupiterError.message);
    }
    
    // Если все источники не сработали
    return res.status(200).json({
      success: false,
      marketCap: 0,
      token: tokenAddress,
      message: 'No market data available from any source',
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
