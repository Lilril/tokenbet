// ============================================
// ORDERS API - PRODUCTION VERSION
// С PostgreSQL, rate limiting, и audit logging
// ============================================

import db from './db.js';

// Helper для получения client IP
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0] || 
           req.headers['x-real-ip'] || 
           req.connection?.remoteAddress || 
           'unknown';
}

// Helper для rate limiting
async function enforceRateLimit(req, res, identifier, endpoint) {
    const result = await db.checkRateLimit(identifier, endpoint, 100, 1);
    
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    
    if (!result.allowed) {
        return res.status(429).json({
            success: false,
            error: 'Too many requests. Please try again later.',
            retryAfter: 60
        });
    }
    
    return null; // No error
}

// ============================================
// MAIN HANDLER
// ============================================
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    const { method, query, body } = req;
    const clientIP = getClientIP(req);
    
    try {
        // ============================================
        // GET - Получить данные рынка
        // ============================================
        if (method === 'GET') {
            const action = query.action;
            
            // Rate limit: 100 запросов в минуту per IP
            const rateLimitError = await enforceRateLimit(req, res, clientIP, `GET:${action}`);
            if (rateLimitError) return;
            
            // Получить активный раунд
            const activeRound = await db.getActiveRound();
            
            if (!activeRound) {
                return res.status(404).json({
                    success: false,
                    error: 'No active round found'
                });
            }
            
            // ORDER BOOK
            if (action === 'orderbook') {
                const orderBook = await db.getAggregatedOrderBook(activeRound.id);
                const poolSnapshot = await db.getLatestPoolSnapshot(activeRound.id);
                
                // Рассчитать AMM цены из пула
                const ammPrice = poolSnapshot ? {
                    higher: parseFloat(poolSnapshot.lower_reserve) / parseFloat(poolSnapshot.higher_reserve),
                    lower: parseFloat(poolSnapshot.higher_reserve) / parseFloat(poolSnapshot.lower_reserve)
                } : { higher: 0.5, lower: 0.5 };
                
                return res.status(200).json({
                    success: true,
                    orderBook,
                    ammPrice,
                    pool: poolSnapshot ? {
                        higher: parseFloat(poolSnapshot.higher_reserve),
                        lower: parseFloat(poolSnapshot.lower_reserve),
                        k: parseFloat(poolSnapshot.k_constant)
                    } : null,
                    roundId: activeRound.id,
                    roundNumber: activeRound.round_number
                });
            }
            
            // TRADE HISTORY
            if (action === 'trades') {
                const trades = await db.getRecentTrades(activeRound.id, 20);
                
                return res.status(200).json({
                    success: true,
                    trades: trades.map(t => ({
                        id: t.id,
                        wallet: t.buyer_wallet,
                        side: t.side,
                        amount: parseFloat(t.amount),
                        price: parseFloat(t.price),
                        cost: parseFloat(t.total_cost),
                        timestamp: new Date(t.created_at).getTime(),
                        type: t.trade_type
                    }))
                });
            }
            
            // QUOTE для маркет ордера
            if (action === 'quote') {
                const { side, amount } = query;
                const amt = parseFloat(amount);
                
                if (!side || !amt || amt <= 0) {
                    return res.status(400).json({
                        success: false,
                        error: 'Invalid parameters'
                    });
                }
                
                const poolSnapshot = await db.getLatestPoolSnapshot(activeRound.id);
                
                if (!poolSnapshot) {
                    return res.status(500).json({
                        success: false,
                        error: 'Pool data not available'
                    });
                }
                
                const higher = parseFloat(poolSnapshot.higher_reserve);
                const lower = parseFloat(poolSnapshot.lower_reserve);
                const k = parseFloat(poolSnapshot.k_constant);
                
                let quote;
                
                if (side === 'higher') {
                    if (amt > higher * 0.5) {
                        return res.status(400).json({
                            success: false,
                            error: 'Order too large - max 50% of pool'
                        });
                    }
                    
                    const newHigher = higher - amt;
                    const newLower = k / newHigher;
                    const lowerNeeded = newLower - lower;
                    const avgPrice = lowerNeeded / amt;
                    const currentPrice = lower / higher;
                    const priceImpact = ((avgPrice / currentPrice) - 1) * 100;
                    
                    quote = {
                        avgPrice,
                        priceImpact,
                        lowerNeeded,
                        newHigher,
                        newLower
                    };
                } else {
                    if (amt > lower * 0.5) {
                        return res.status(400).json({
                            success: false,
                            error: 'Order too large - max 50% of pool'
                        });
                    }
                    
                    const newLower = lower - amt;
                    const newHigher = k / newLower;
                    const higherNeeded = newHigher - higher;
                    const avgPrice = higherNeeded / amt;
                    const currentPrice = higher / lower;
                    const priceImpact = ((avgPrice / currentPrice) - 1) * 100;
                    
                    quote = {
                        avgPrice,
                        priceImpact,
                        higherNeeded,
                        newHigher,
                        newLower
                    };
                }
                
                return res.status(200).json({
                    success: true,
                    side,
                    amount: amt,
                    ...quote
                });
            }
            
            // USER POSITIONS
            if (action === 'positions') {
                const { wallet } = query;
                
                if (!wallet) {
                    return res.status(400).json({
                        success: false,
                        error: 'Wallet address required'
                    });
                }
                
                const user = await db.getOrCreateUser(wallet);
                const positions = await db.getUserPositions(user.id, activeRound.id);
                
                return res.status(200).json({
                    success: true,
                    positions: positions.map(p => ({
                        side: p.side,
                        amount: parseFloat(p.amount),
                        avgPrice: parseFloat(p.avg_price),
                        totalCost: parseFloat(p.total_cost),
                        settled: p.settled,
                        payout: p.payout ? parseFloat(p.payout) : null
                    }))
                });
            }
            
            // DEFAULT: Вернуть всё
            const orderBook = await db.getAggregatedOrderBook(activeRound.id);
            const poolSnapshot = await db.getLatestPoolSnapshot(activeRound.id);
            const recentTrades = await db.getRecentTrades(activeRound.id, 10);
            
            const ammPrice = poolSnapshot ? {
                higher: parseFloat(poolSnapshot.lower_reserve) / parseFloat(poolSnapshot.higher_reserve),
                lower: parseFloat(poolSnapshot.higher_reserve) / parseFloat(poolSnapshot.lower_reserve)
            } : { higher: 0.5, lower: 0.5 };
            
            return res.status(200).json({
                success: true,
                orderBook,
                ammPrice,
                pool: poolSnapshot ? {
                    higher: parseFloat(poolSnapshot.higher_reserve),
                    lower: parseFloat(poolSnapshot.lower_reserve),
                    k: parseFloat(poolSnapshot.k_constant)
                } : null,
                recentTrades: recentTrades.map(t => ({
                    id: t.id,
                    side: t.side,
                    amount: parseFloat(t.amount),
                    price: parseFloat(t.price),
                    timestamp: new Date(t.created_at).getTime()
                })),
                roundId: activeRound.id,
                roundNumber: activeRound.round_number
            });
        }
        
        // ============================================
        // POST - Разместить ордер
        // ============================================
        if (method === 'POST') {
            const { wallet, side, amount, price, type } = 
                typeof body === 'string' ? JSON.parse(body) : body;
            
            if (!wallet || !side || !amount) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required fields: wallet, side, amount'
                });
            }
            
            // Rate limit: 20 ордеров в минуту per wallet
            const rateLimitError = await enforceRateLimit(req, res, wallet, 'POST:order');
            if (rateLimitError) return;
            
            const amt = parseFloat(amount);
            
            if (amt <= 0 || isNaN(amt)) {
                return res.status(400).json({
                    success: false,
                    error: 'Amount must be positive'
                });
            }
            
            if (!['higher', 'lower'].includes(side)) {
                return res.status(400).json({
                    success: false,
                    error: 'Side must be "higher" or "lower"'
                });
            }
            
            // Получить или создать пользователя
            const user = await db.getOrCreateUser(wallet);
            const activeRound = await db.getActiveRound();
            
            if (!activeRound) {
                return res.status(400).json({
                    success: false,
                    error: 'No active round'
                });
            }
            
            // Audit log
            await db.logAction(
                user.id,
                'place_order',
                { side, amount: amt, type, price },
                clientIP,
                req.headers['user-agent']
            );
            
            // MARKET ORDER
            if (type === 'market') {
                const poolSnapshot = await db.getLatestPoolSnapshot(activeRound.id);
                
                if (!poolSnapshot) {
                    return res.status(500).json({
                        success: false,
                        error: 'Pool not initialized'
                    });
                }
                
                let higher = parseFloat(poolSnapshot.higher_reserve);
                let lower = parseFloat(poolSnapshot.lower_reserve);
                const k = parseFloat(poolSnapshot.k_constant);
                
                let tradeCost, avgPrice;
                
                if (side === 'higher') {
                    if (amt > higher * 0.5) {
                        return res.status(400).json({
                            success: false,
                            error: 'Order too large - max 50% of pool'
                        });
                    }
                    
                    const newHigher = higher - amt;
                    const newLower = k / newHigher;
                    tradeCost = newLower - lower;
                    avgPrice = tradeCost / amt;
                    
                    higher = newHigher;
                    lower = newLower;
                } else {
                    if (amt > lower * 0.5) {
                        return res.status(400).json({
                            success: false,
                            error: 'Order too large - max 50% of pool'
                        });
                    }
                    
                    const newLower = lower - amt;
                    const newHigher = k / newLower;
                    tradeCost = newHigher - higher;
                    avgPrice = tradeCost / amt;
                    
                    higher = newHigher;
                    lower = newLower;
                }
                
                // Сохранить сделку
                const trade = await db.recordTrade({
                    roundId: activeRound.id,
                    buyerId: user.id,
                    sellerId: null,
                    buyOrderId: null,
                    sellOrderId: null,
                    side,
                    amount: amt,
                    price: avgPrice,
                    totalCost: tradeCost,
                    tradeType: 'market'
                });
                
                // Обновить пул
                await db.savePoolSnapshot(activeRound.id, higher, lower, k);
                
                // Обновить позицию пользователя
                await db.upsertUserPosition(
                    user.id,
                    activeRound.id,
                    side,
                    amt,
                    avgPrice,
                    tradeCost
                );
                
                return res.status(200).json({
                    success: true,
                    trade: {
                        id: trade.id,
                        side,
                        amount: amt,
                        price: avgPrice,
                        cost: tradeCost
                    },
                    newPool: { higher, lower, k },
                    newPrice: side === 'higher' ? lower / higher : higher / lower
                });
            }
            
            // LIMIT ORDER
            else {
                const prc = parseFloat(price);
                
                if (!prc || prc <= 0 || prc >= 1 || isNaN(prc)) {
                    return res.status(400).json({
                        success: false,
                        error: 'Invalid limit price (must be between 0 and 1)'
                    });
                }
                
                // Разместить лимит ордер
                const order = await db.placeLimitOrder(
                    user.id,
                    activeRound.id,
                    side,
                    amt,
                    prc
                );
                
                // Попытаться сматчить с противоположными ордерами
                const matchableOrders = await db.getMatchableOrders(
                    activeRound.id,
                    side,
                    prc
                );
                
                let totalMatched = 0;
                
                for (const oppositeOrder of matchableOrders) {
                    const remainingToFill = amt - totalMatched;
                    const oppositeRemaining = parseFloat(oppositeOrder.amount) - parseFloat(oppositeOrder.filled);
                    
                    if (remainingToFill <= 0) break;
                    
                    const matchAmount = Math.min(remainingToFill, oppositeRemaining);
                    const matchPrice = (prc + parseFloat(oppositeOrder.price)) / 2;
                    
                    // Записать сделку
                    await db.recordTrade({
                        roundId: activeRound.id,
                        buyerId: user.id,
                        sellerId: oppositeOrder.user_id,
                        buyOrderId: order.id,
                        sellOrderId: oppositeOrder.id,
                        side,
                        amount: matchAmount,
                        price: matchPrice,
                        totalCost: matchAmount * matchPrice,
                        tradeType: 'limit'
                    });
                    
                    // Обновить filled для обоих ордеров
                    await db.updateOrderFilled(order.id, matchAmount);
                    await db.updateOrderFilled(oppositeOrder.id, matchAmount);
                    
                    // Обновить позиции
                    await db.upsertUserPosition(
                        user.id,
                        activeRound.id,
                        side,
                        matchAmount,
                        matchPrice,
                        matchAmount * matchPrice
                    );
                    
                    await db.upsertUserPosition(
                        oppositeOrder.user_id,
                        activeRound.id,
                        oppositeOrder.side,
                        matchAmount,
                        matchPrice,
                        matchAmount * matchPrice
                    );
                    
                    totalMatched += matchAmount;
                }
                
                const orderBook = await db.getAggregatedOrderBook(activeRound.id);
                
                return res.status(200).json({
                    success: true,
                    order: {
                        id: order.id,
                        side,
                        amount: amt,
                        price: prc,
                        filled: totalMatched,
                        status: totalMatched >= amt ? 'filled' : 'active'
                    },
                    matched: totalMatched,
                    orderBook
                });
            }
        }
        
        // ============================================
        // DELETE - Отменить ордер
        // ============================================
        if (method === 'DELETE') {
            const { orderId, wallet } = query;
            
            if (!orderId || !wallet) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing orderId or wallet'
                });
            }
            
            const user = await db.getOrCreateUser(wallet);
            const canceledOrder = await db.cancelOrder(parseFloat(orderId), user.id);
            
            if (!canceledOrder) {
                return res.status(404).json({
                    success: false,
                    error: 'Order not found or already filled/cancelled'
                });
            }
            
            // Audit log
            await db.logAction(
                user.id,
                'cancel_order',
                { orderId },
                clientIP,
                req.headers['user-agent']
            );
            
            const activeRound = await db.getActiveRound();
            const orderBook = await db.getAggregatedOrderBook(activeRound.id);
            
            return res.status(200).json({
                success: true,
                canceledOrder: {
                    id: canceledOrder.id,
                    side: canceledOrder.side,
                    amount: parseFloat(canceledOrder.amount),
                    filled: parseFloat(canceledOrder.filled)
                },
                orderBook
            });
        }
        
        return res.status(405).json({
            success: false,
            error: 'Method not allowed'
        });
        
    } catch (error) {
        console.error('❌ Orders API error:', error);
        
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
}
