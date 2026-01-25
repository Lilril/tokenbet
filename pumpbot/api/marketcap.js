// API endpoint для получения market cap с pump.fun
// Обходит CORS проблему

export default async function handler(req, res) {
  // Разрешаем CORS для всех доменов
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  const tokenAddress = req.query.token || '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';
  
  try {
    // Запрашиваем данные с pump.fun
    const response = await fetch(`https://frontend-api.pump.fun/coins/${tokenAddress}`);
    
    if (!response.ok) {
      throw new Error(`Pump.fun API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Извлекаем market cap из разных возможных полей
    const marketCap = 
      parseFloat(data.usd_market_cap) ||
      parseFloat(data.market_cap) ||
      parseFloat(data.marketCap) ||
      (data.price && data.total_supply ? data.price * data.total_supply : 0) ||
      0;
    
    // Возвращаем результат
    res.status(200).json({
      success: true,
      marketCap: marketCap,
      token: tokenAddress,
      timestamp: new Date().toISOString(),
      rawData: data // На всякий случай все данные
    });
    
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      token: tokenAddress
    });
  }
}
