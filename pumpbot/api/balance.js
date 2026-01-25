export default async function handler(req, res) {
  // Разрешаем CORS для всех доменов
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  const walletAddress = req.query.wallet;
  const tokenMint = req.query.token || '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';
  
  if (!walletAddress) {
    return res.status(400).json({
      success: false,
      error: 'Wallet address required'
    });
  }
  
  try {
    // ИСПРАВЛЕНО: используем круглые скобки () вместо обратных апострофов
    const response = await fetch(`https://frontend-api.pump.fun/balances/${walletAddress}`);
    
    if (!response.ok) {
      throw new Error(`Pump.fun API error: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('Pump.fun API response:', data);
    
    // Ищем нужный токен
    const tokenBalance = data.balances?.find(b => b.mint === tokenMint);
    
    if (tokenBalance) {
      const balance = tokenBalance.amount / Math.pow(10, tokenBalance.decimals || 6);
      
      return res.status(200).json({
        success: true,
        balance: balance,
        token: tokenMint,
        wallet: walletAddress,
        timestamp: new Date().toISOString()
      });
    } else {
      // Токен не найден
      return res.status(200).json({
        success: true,
        balance: 0,
        token: tokenMint,
        wallet: walletAddress,
        message: 'Token not found in wallet'
      });
    }
    
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      wallet: walletAddress
    });
  }
}
