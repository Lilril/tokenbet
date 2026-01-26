export default async function handler(req, res) {
  // Разрешаем CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  const walletAddress = req.query.wallet;
  const tokenMint = req.query.token || '7MDApufGNAKDDTcM3hrUpUfZ8jcaXdaoSZy1sQdRpump';
  
  if (!walletAddress) {
    return res.status(400).json({
      success: false,
      error: 'Wallet address required'
    });
  }
  
  // Используем несколько RPC endpoints
  const RPC_ENDPOINTS = [
    'https://api.mainnet-beta.solana.com',
    'https://solana-api.projectserum.com',
    'https://rpc.ankr.com/solana'
  ];
  
  // Пробуем каждый RPC endpoint
  for (const rpcUrl of RPC_ENDPOINTS) {
    try {
      const rpcResponse = await fetch(rpcUrl, {
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
            { mint: tokenMint },
            { encoding: 'jsonParsed' }
          ]
        })
      });

      const rpcData = await rpcResponse.json();
      
      // Проверяем есть ли ошибка в ответе
      if (rpcData.error) {
        console.log(`RPC error from ${rpcUrl}:`, rpcData.error);
        continue; // Пробуем следующий endpoint
      }
      
      // Проверяем есть ли токен аккаунт
      if (rpcData.result && rpcData.result.value && rpcData.result.value.length > 0) {
        const tokenAccount = rpcData.result.value[0];
        const balance = tokenAccount.account.data.parsed.info.tokenAmount.uiAmount || 0;
        
        return res.status(200).json({
          success: true,
          balance: balance,
          token: tokenMint,
          wallet: walletAddress,
          method: 'solana-rpc',
          rpcUsed: rpcUrl,
          timestamp: new Date().toISOString()
        });
      }
      
      // Токен не найден, но запрос успешен
      return res.status(200).json({
        success: true,
        balance: 0,
        token: tokenMint,
        wallet: walletAddress,
        message: 'Token account not found',
        method: 'solana-rpc',
        rpcUsed: rpcUrl,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.log(`Failed to fetch from ${rpcUrl}:`, error.message);
      // Продолжаем к следующему endpoint
      continue;
    }
  }
  
  // Если все RPC endpoints не сработали, возвращаем 0
  return res.status(200).json({
    success: true,
    balance: 0,
    token: tokenMint,
    wallet: walletAddress,
    message: 'All RPC endpoints failed, returning 0 balance',
    timestamp: new Date().toISOString()
  });
}
