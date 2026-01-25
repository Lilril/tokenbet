export default async function handler(req, res) {
  // Разрешаем CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  const tokenAddress = req.query.token || '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';
  
  try {
    // Берем данные ТОЛЬКО с pump.fun
    const pumpResponse = await fetch(`https://frontend-api.pump.fun/coins/${tokenAddress}`);
    
    if (!pumpResponse.ok) {
      throw new Error(`Pump.fun API returned ${pumpResponse.status}`);
    }
    
    const data = await pumpResponse.json();
    console.log('Pump.fun raw data:', data);
    
    // Извлекаем market cap из данных pump.fun
    // Обычно это usd_market_cap или market_cap
    let marketCap = 0;
    
    if (data.usd_market_cap) {
      marketCap = parseFloat(data.usd_market_cap);
    } else if (data.market_cap) {
      marketCap = parseFloat(data.market_cap);
    } else if (data.marketCap) {
      marketCap = parseFloat(data.marketCap);
    }
    
    console.log('Extracted market cap:', marketCap);
    
    return res.status(200).json({
      success: true,
      marketCap: marketCap,
      token: tokenAddress,
      method: 'pumpfun',
      rawData: data, // Для отладки
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Pump.fun API Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      token: tokenAddress
    });
  }
}
