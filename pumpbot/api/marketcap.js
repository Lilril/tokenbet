export default async function handler(req, res) {
  // Разрешаем CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  const tokenAddress = req.query.token || '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';
  
  try {
    // Используем DexScreener API (более надежный)
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
    
    // Fallback: пробуем pump.fun API
    try {
      const pumpResponse = await fetch(`https://frontend-api.pump.fun/coins/${tokenAddress}`);
      
      if (pumpResponse.ok) {
        const pumpData = await pumpResponse.json();
        
        const marketCap = 
          parseFloat(pumpData.usd_market_cap) ||
          parseFloat(pumpData.market_cap) ||
          parseFloat(pumpData.marketCap) ||
          0;
        
        return res.status(200).json({
          success: true,
          marketCap: marketCap,
          token: tokenAddress,
          method: 'pumpfun',
          timestamp: new Date().toISOString()
        });
      }
    } catch (pumpError) {
      console.log('Pump.fun API failed:', pumpError.message);
    }
    
    // Если оба не сработали, возвращаем 0
    return res.status(200).json({
      success: true,
      marketCap: 0,
      token: tokenAddress,
      message: 'No market data available',
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
