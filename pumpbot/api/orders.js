// ============================================
// ORDER BOOK & TRADING ENGINE
// ============================================

// In-memory order book (в продакшене - база данных)
let orderBook = {
  higher: [], // Ордера на "ВЫШЕ"
  lower: []   // Ордера на "НИЖЕ"
};

let trades = [];
let roundId = Math.floor(Date.now() / (15 * 60 * 1000)); // Меняется каждые 15 минут

// AMM Pool (автоматический маркет-мейкер)
let liquidityPool = {
  higher: 10000,  // Начальная ликвидность
  lower: 10000,
  k: 100000000    // Константа x * y = k
};

// Получить текущую цену из AMM (Constant Product Formula)
function getAMMPrice(side) {
  const { higher, lower } = liquidityPool;
  
  if (side === 'higher') {
    // Цена = сколько Lower нужно отдать за 1 Higher
    return lower / higher;
  } else {
    // Цена = сколько Higher нужно отдать за 1 Lower
    return higher / lower;
  }
}

// Рассчитать цену с учетом объема (для предварительного просмотра)
function calculatePriceImpact(side, amount) {
  const { higher, lower } = liquidityPool;
  
  if (side === 'higher') {
    // Покупаем Higher за Lower
    const newHigher = higher - amount;
    const newLower = liquidityPool.k / newHigher;
    const lowerNeeded = newLower - lower;
    const avgPrice = lowerNeeded / amount;
    const priceImpact = ((avgPrice / getAMMPrice('higher')) - 1) * 100;
    
    return {
      avgPrice,
      priceImpact,
      lowerNeeded,
      newHigher,
      newLower
    };
  } else {
    // Покупаем Lower за Higher
    const newLower = lower - amount;
    const newHigher = liquidityPool.k / newLower;
    const higherNeeded = newHigher - higher;
    const avgPrice = higherNeeded / amount;
    const priceImpact = ((avgPrice / getAMMPrice('lower')) - 1) * 100;
    
    return {
      avgPrice,
      priceImpact,
      higherNeeded,
      newHigher,
      newLower
    };
  }
}

// Выполнить маркет ордер через AMM
function executeMarketOrder(wallet, side, amount) {
  if (amount <= 0) {
    throw new Error('Amount must be positive');
  }
  
  const { higher, lower } = liquidityPool;
  
  if (side === 'higher') {
    if (amount > higher * 0.5) {
      throw new Error('Order too large - max 50% of pool');
    }
    
    const newHigher = higher - amount;
    const newLower = liquidityPool.k / newHigher;
    const lowerPaid = newLower - lower;
    const avgPrice = lowerPaid / amount;
    
    liquidityPool.higher = newHigher;
    liquidityPool.lower = newLower;
    
    const trade = {
      id: Date.now() + Math.random(),
      wallet,
      side,
      amount,
      price: avgPrice,
      cost: lowerPaid,
      timestamp: Date.now(),
      roundId,
      type: 'market'
    };
    
    trades.unshift(trade);
    if (trades.length > 100) trades.pop();
    
    return trade;
    
  } else {
    if (amount > lower * 0.5) {
      throw new Error('Order too large - max 50% of pool');
    }
    
    const newLower = lower - amount;
    const newHigher = liquidityPool.k / newLower;
    const higherPaid = newHigher - higher;
    const avgPrice = higherPaid / amount;
    
    liquidityPool.higher = newHigher;
    liquidityPool.lower = newLower;
    
    const trade = {
      id: Date.now() + Math.random(),
      wallet,
      side,
      amount,
      price: avgPrice,
      cost: higherPaid,
      timestamp: Date.now(),
      roundId,
      type: 'market'
    };
    
    trades.unshift(trade);
    if (trades.length > 100) trades.pop();
    
    return trade;
  }
}

// Добавить лимит ордер в стакан
function placeLimitOrder(wallet, side, amount, price) {
  if (amount <= 0 || price <= 0 || price >= 1) {
    throw new Error('Invalid amount or price');
  }
  
  const order = {
    id: Date.now() + Math.random(),
    wallet,
    side,
    amount,
    price,
    filled: 0,
    timestamp: Date.now(),
    roundId,
    type: 'limit'
  };
  
  orderBook[side].push(order);
  
  // Сортируем: для higher - от высокой цены к низкой, для lower - от низкой к высокой
  if (side === 'higher') {
    orderBook[side].sort((a, b) => b.price - a.price);
  } else {
    orderBook[side].sort((a, b) => a.price - b.price);
  }
  
  // Пытаемся матчить с противоположными ордерами
  tryMatchOrders();
  
  return order;
}

// Попытка сматчить ордера
function tryMatchOrders() {
  const higherOrders = orderBook.higher;
  const lowerOrders = orderBook.lower;
  
  while (higherOrders.length > 0 && lowerOrders.length > 0) {
    const highestHigher = higherOrders[0];
    const lowestLower = lowerOrders[0];
    
    // Проверяем, можно ли сматчить (сумма цен >= 1)
    if (highestHigher.price + lowestLower.price >= 1) {
      const matchAmount = Math.min(
        highestHigher.amount - highestHigher.filled,
        lowestLower.amount - lowestLower.filled
      );
      
      const matchPrice = (highestHigher.price + lowestLower.price) / 2;
      
      highestHigher.filled += matchAmount;
      lowestLower.filled += matchAmount;
      
      // Записываем трейд
      const trade = {
        id: Date.now() + Math.random(),
        buyerWallet: highestHigher.wallet,
        sellerWallet: lowestLower.wallet,
        amount: matchAmount,
        price: matchPrice,
        timestamp: Date.now(),
        roundId,
        type: 'limit-match'
      };
      
      trades.unshift(trade);
      
      // Удаляем полностью исполненные ордера
      if (highestHigher.filled >= highestHigher.amount) {
        higherOrders.shift();
      }
      if (lowestLower.filled >= lowestLower.amount) {
        lowerOrders.shift();
      }
    } else {
      break;
    }
  }
}

// Отменить ордер
function cancelOrder(orderId, wallet) {
  for (const side of ['higher', 'lower']) {
    const index = orderBook[side].findIndex(
      o => o.id === orderId && o.wallet === wallet
    );
    
    if (index !== -1) {
      const order = orderBook[side][index];
      orderBook[side].splice(index, 1);
      return order;
    }
  }
  
  throw new Error('Order not found');
}

// Получить агрегированный стакан (для отображения)
function getAggregatedOrderBook() {
  const aggregate = (orders) => {
    const priceMap = {};
    
    orders.forEach(order => {
      const remaining = order.amount - order.filled;
      const key = order.price.toFixed(3);
      
      if (!priceMap[key]) {
        priceMap[key] = { price: order.price, amount: 0, orders: 0 };
      }
      
      priceMap[key].amount += remaining;
      priceMap[key].orders += 1;
    });
    
    return Object.values(priceMap);
  };
  
  return {
    higher: aggregate(orderBook.higher).slice(0, 15),
    lower: aggregate(orderBook.lower).slice(0, 15)
  };
}

// ============================================
// API HANDLER
// ============================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const { method, query, body } = req;
  
  try {
    // GET - Получить данные о рынке
    if (method === 'GET') {
      const action = query.action;
      
      if (action === 'orderbook') {
        return res.status(200).json({
          success: true,
          orderBook: getAggregatedOrderBook(),
          ammPrice: {
            higher: getAMMPrice('higher'),
            lower: getAMMPrice('lower')
          },
          pool: liquidityPool,
          roundId
        });
      }
      
      if (action === 'trades') {
        return res.status(200).json({
          success: true,
          trades: trades.slice(0, 20)
        });
      }
      
      if (action === 'quote') {
        const { side, amount } = query;
        const amt = parseFloat(amount);
        
        if (!side || !amt || amt <= 0) {
          return res.status(400).json({
            success: false,
            error: 'Invalid parameters'
          });
        }
        
        const quote = calculatePriceImpact(side, amt);
        
        return res.status(200).json({
          success: true,
          side,
          amount: amt,
          ...quote
        });
      }
      
      // По умолчанию возвращаем всё
      return res.status(200).json({
        success: true,
        orderBook: getAggregatedOrderBook(),
        ammPrice: {
          higher: getAMMPrice('higher'),
          lower: getAMMPrice('lower')
        },
        pool: liquidityPool,
        recentTrades: trades.slice(0, 10),
        roundId
      });
    }
    
    // POST - Разместить ордер
    if (method === 'POST') {
      const { wallet, side, amount, price, type } = 
        typeof body === 'string' ? JSON.parse(body) : body;
      
      if (!wallet || !side || !amount) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields'
        });
      }
      
      const amt = parseFloat(amount);
      
      if (amt <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Amount must be positive'
        });
      }
      
      if (type === 'market') {
        const trade = executeMarketOrder(wallet, side, amt);
        
        return res.status(200).json({
          success: true,
          trade,
          newPool: liquidityPool,
          newPrice: getAMMPrice(side)
        });
      } else {
        const prc = parseFloat(price);
        
        if (!prc || prc <= 0 || prc >= 1) {
          return res.status(400).json({
            success: false,
            error: 'Invalid limit price (must be between 0 and 1)'
          });
        }
        
        const order = placeLimitOrder(wallet, side, amt, prc);
        
        return res.status(200).json({
          success: true,
          order,
          orderBook: getAggregatedOrderBook()
        });
      }
    }
    
    // DELETE - Отменить ордер
    if (method === 'DELETE') {
      const { orderId, wallet } = query;
      
      if (!orderId || !wallet) {
        return res.status(400).json({
          success: false,
          error: 'Missing orderId or wallet'
        });
      }
      
      const order = cancelOrder(parseFloat(orderId), wallet);
      
      return res.status(200).json({
        success: true,
        canceledOrder: order,
        orderBook: getAggregatedOrderBook()
      });
    }
    
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
    
  } catch (error) {
    console.error('Orders API error:', error);
    
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
