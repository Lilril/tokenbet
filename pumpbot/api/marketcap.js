export default async function handler(req, res) {
  // Разрешаем CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const tokenAddress = req.query.token || '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';
  
  try {
    // 1. Пробуем Jupiter API (самый надежный)
    try {
      const jupiterResponse = await fetch(`https://api.jup.ag/price/v2?ids=${tokenAddress}`);
      
      if (jupiterResponse.ok) {
        const jupiterData = await jupiterResponse.json();
        console.log('Jupiter API response:', jupiterData);
        
        if (jupiterData.data && jupiterData.data[tokenAddress]) {
          const tokenData = jupiterData.data[tokenAddress];
          
          // Jupiter возвращает price, нужен supply для расчета market cap
          const price = tokenData.price;
          
          // Получаем supply из Solana RPC
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
            
            console.log(`Price: ${price}, Supply: ${totalSupply}, Market Cap: ${marketCap}`);
            
            return res.status(200).json({
              success: true,
              marketCap: marketCap,
              price: price,
              supply: totalSupply,
              token: tokenAddress,
              method: 'jupiter',
              timestamp: new Date().toISOString()
            });
          }
        }
      }
    } catch (e) {
      console.log('Jupiter failed:', e.message);
    }
    
    // 2. Пробуем Birdeye API (альтернатива)
    try {
      const birdeyeResponse = await fetch(`https://public-api.birdeye.so/defi/token_overview?address=${tokenAddress}`, {
        headers: {
          'X-API-KEY': 'public'
        }
      });
      
      if (birdeyeResponse.ok) {
        const birdeyeData = await birdeyeResponse.json();
        
        if (birdeyeData.data && birdeyeData.data.mc) {
          const marketCap = birdeyeData.data.mc;
          
          console.log('Market cap from Birdeye:', marketCap);
          
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            token: tokenAddress,
            method: 'birdeye',
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (e) {
      console.log('Birdeye failed:', e.message);
    }
    
    // 3. Пробуем DexScreener
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
    
    // 4. Последняя попытка - pump.fun
    try {
      const pumpResponse = await fetch(`https://frontend-api.pump.fun/coins/${tokenAddress}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json',
        }
      });
      
      if (pumpResponse.ok) {
        const pumpData = await pumpResponse.json();
        
        const marketCap = 
          parseFloat(pumpData.usd_market_cap) ||
          parseFloat(pumpData.market_cap) || 
          parseFloat(pumpData.marketCap) ||
          (pumpData.virtual_sol_reserves ? pumpData.virtual_sol_reserves * 120 : 0) ||
          0;
        
        if (marketCap > 0) {
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            token: tokenAddress,
            method: 'pumpfun',
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (e) {
      console.log('Pump.fun failed:', e.message);
    }
    
    // Если все упало
    console.log('All APIs failed');
    return res.status(200).json({
      success: false,
      marketCap: 0,
      token: tokenAddress,
      error: 'All APIs failed',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Fatal error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      token: tokenAddress
    });
  }
}
