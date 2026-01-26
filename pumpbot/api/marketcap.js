export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const tokenAddress = req.query.token || '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';
  
  try {
    // Делаем запрос напрямую с сервера Vercel (без CORS проблем)
    const response = await fetch(`https://frontend-api.pump.fun/coins/${tokenAddress}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://pump.fun/',
        'Origin': 'https://pump.fun'
      }
    });
    
    if (!response.ok) {
      console.log('Pump.fun returned:', response.status);
      
      // Если pump.fun не работает, возвращаем данные которые точно есть на их сайте
      // Парсим HTML страницу токена
      try {
        const htmlResponse = await fetch(`https://pump.fun/coin/${tokenAddress}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        
        if (htmlResponse.ok) {
          const html = await htmlResponse.text();
          
          // Ищем market cap в HTML (обычно в meta тегах или JSON в скрипте)
          const marketCapMatch = html.match(/marketCap['":\s]+(\d+\.?\d*)/i) || 
                                html.match(/market.cap['":\s]+(\d+\.?\d*)/i) ||
                                html.match(/\$(\d+\.?\d*[KMB])/);
          
          if (marketCapMatch) {
            let marketCap = parseFloat(marketCapMatch[1]);
            
            // Конвертируем K/M/B в числа
            const rawValue = marketCapMatch[0];
            if (rawValue.includes('K')) marketCap *= 1000;
            if (rawValue.includes('M')) marketCap *= 1000000;
            if (rawValue.includes('B')) marketCap *= 1000000000;
            
            console.log('Parsed from HTML:', marketCap);
            
            return res.status(200).json({
              success: true,
              marketCap: marketCap,
              token: tokenAddress,
              method: 'html-parsing',
              timestamp: new Date().toISOString()
            });
          }
        }
      } catch (e) {
        console.log('HTML parsing failed:', e.message);
      }
      
      throw new Error(`API returned ${response.status}`);
    }
    
    const data = await response.json();
    console.log('Pump.fun API data:', data);
    
    // Извлекаем market cap из разных полей
    let marketCap = 
      parseFloat(data.usd_market_cap) ||
      parseFloat(data.market_cap) ||
      parseFloat(data.marketCap) ||
      parseFloat(data.fdv) ||
      0;
    
    // Если не нашли, считаем из bonding curve
    if (marketCap === 0 && data.virtual_sol_reserves) {
      // Получаем актуальную цену SOL
      try {
        const solPriceResponse = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        const solPriceData = await solPriceResponse.json();
        const solPrice = solPriceData.solana?.usd || 120;
        
        marketCap = data.virtual_sol_reserves * solPrice;
        console.log(`Calculated from bonding curve: ${data.virtual_sol_reserves} SOL × $${solPrice} = $${marketCap}`);
      } catch (e) {
        // Fallback SOL price
        marketCap = data.virtual_sol_reserves * 120;
      }
    }
    
    // Если всё еще 0, считаем через цену и supply
    if (marketCap === 0 && data.price && data.total_supply) {
      marketCap = data.price * data.total_supply;
      console.log(`Calculated from price × supply: ${data.price} × ${data.total_supply} = ${marketCap}`);
    }
    
    return res.status(200).json({
      success: true,
      marketCap: marketCap,
      token: tokenAddress,
      method: 'pumpfun-api',
      rawData: data,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('All methods failed:', error.message);
    
    // Последний fallback - возвращаем хоть что-то
    return res.status(200).json({
      success: false,
      marketCap: 0,
      token: tokenAddress,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}
