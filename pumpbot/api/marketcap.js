export default async function handler(req, res) {
  // Разрешаем CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Обрабатываем preflight запрос
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const tokenAddress = req.query.token || '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';
  
  try {
    // Используем обычный fetch с User-Agent
    const pumpResponse = await fetch(`https://frontend-api.pump.fun/coins/${tokenAddress}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    });
    
    if (!pumpResponse.ok) {
      console.log('Pump.fun failed with status:', pumpResponse.status);
      
      // Fallback на DexScreener
      const dexResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
      
      if (dexResponse.ok) {
        const dexData = await dexResponse.json();
        
        if (dexData.pairs && dexData.pairs.length > 0) {
          const pair = dexData.pairs[0];
          const marketCap = pair.marketCap || pair.fdv || 0;
          
          return res.status(200).json({
            success: true,
            marketCap: marketCap,
            token: tokenAddress,
            method: 'dexscreener',
            timestamp: new Date().toISOString()
          });
        }
      }
      
      throw new Error('All APIs failed');
    }
    
    const data = await pumpResponse.json();
    console.log('Pump.fun data:', data);
    
    // Извлекаем market cap
    let marketCap = 0;
    
    if (data.usd_market_cap) {
      marketCap = parseFloat(data.usd_market_cap);
    } else if (data.market_cap) {
      marketCap = parseFloat(data.market_cap);
    } else if (data.marketCap) {
      marketCap = parseFloat(data.marketCap);
    } else if (data.price && data.total_supply) {
      marketCap = data.price * data.total_supply;
    }
    
    return res.status(200).json({
      success: true,
      marketCap: marketCap,
      token: tokenAddress,
      method: 'pumpfun',
      rawData: data,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('API Error:', error);
    
    // Последний fallback - возвращаем 0 но success: true
    return res.status(200).json({
      success: true,
      marketCap: 0,
      token: tokenAddress,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}
