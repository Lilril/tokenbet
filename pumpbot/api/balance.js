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
    // Пробуем получить баланс через Solana RPC напрямую
    const rpcResponse = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          walletAddress,
          {
            mint: tokenMint
          },
          {
            encoding: 'jsonParsed'
          }
        ]
      })
    });

    const rpcData = await rpcResponse.json();
    
    // Проверяем есть ли токен аккаунт
    if (rpcData.result && rpcData.result.value && rpcData.result.value.length > 0) {
      const tokenAccount = rpcData.result.value[0];
      const balance = tokenAccount.account.data.parsed.info.tokenAmount.uiAmount;
      
      return res.status(200).json({
        success: true,
        balance: balance || 0,
        token: tokenMint,
        wallet: walletAddress,
        method: 'solana-rpc',
        timestamp: new Date().toISOString()
      });
    }
    
    // Если через RPC не нашли, пробуем pump.fun API
    try {
      const pumpResponse = await fetch(`https://frontend-api.pump.fun/balances/${walletAddress}`);
      
      if (pumpResponse.ok) {
        const pumpData = await pumpResponse.json();
        const tokenBalance = pumpData.balances?.find(b => b.mint === tokenMint);
        
        if (tokenBalance) {
          const balance = tokenBalance.amount / Math.pow(10, tokenBalance.decimals || 6);
          
          return res.status(200).json({
            success: true,
            balance: balance,
            token: tokenMint,
            wallet: walletAddress,
            method: 'pump-api',
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (pumpError) {
      console.log('Pump.fun API failed, using RPC result');
    }
    
    // Токен не найден нигде
    return res.status(200).json({
      success: true,
      balance: 0,
      token: tokenMint,
      wallet: walletAddress,
      message: 'Token not found in wallet',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      wallet: walletAddress
    });
  }
}
