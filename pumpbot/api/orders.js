// ============================================
// ORDERS API - PRODUCTION VERSION WITH AUTO ROUND GENERATION
// ============================================

import { sql } from '@vercel/postgres';

// ============================================ 
// ROUND TIMESTAMP CALCULATION & AUTO-GENERATION
// ============================================

function calculateRoundCloseTime(intervalMinutes) {
    const now = new Date();
    
    if (intervalMinutes === 15) {
        const currentMinute = now.getUTCMinutes();
        const nextCloseMinute = Math.ceil((currentMinute + 1) / 15) * 15;
        const closeTime = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
            now.getUTCHours(), nextCloseMinute, 0, 0
        ));
        return Math.floor(closeTime.getTime() / 1000);
    }
    
    if (intervalMinutes === 60) {
        const closeTime = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
            now.getUTCHours() + (now.getUTCMinutes() > 0 ? 1 : 0), 0, 0, 0
        ));
        return Math.floor(closeTime.getTime() / 1000);
    }
    
    if (intervalMinutes === 240) {
        const currentHour = now.getUTCHours();
        const nextCloseHour = Math.ceil((currentHour + 1) / 4) * 4;
        const closeTime = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
            nextCloseHour, 0, 0, 0
        ));
        return Math.floor(closeTime.getTime() / 1000);
    }
    
    throw new Error(`Unsupported interval: ${intervalMinutes}`);
}

function generateRoundSlug(intervalMinutes, closeTimestamp) {
    const intervalStr = intervalMinutes === 60 ? '1h' : 
                       intervalMinutes === 240 ? '4h' : `${intervalMinutes}m`;
    return `sol-updown-${intervalStr}-${closeTimestamp}`;
}

async function getOrCreateCurrentRound(intervalMinutes) {
    try {
        const closeTimestamp = calculateRoundCloseTime(intervalMinutes);
        const slug = generateRoundSlug(intervalMinutes, closeTimestamp);
        
        const existing = await sql`SELECT * FROM rounds WHERE slug = ${slug}`;
        
        if (existing.rows.length > 0) {
            console.log(`✅ Found round: ${slug}`);
            return existing.rows[0];
        }
        
        console.log(`🔨 Creating round: ${slug}`);
        const endTime = new Date(closeTimestamp * 1000);
        const startTime = new Date(endTime.getTime() - intervalMinutes * 60 * 1000);
        
        const newRound = await sql`
            INSERT INTO rounds (
                slug, round_number, interval_minutes,
                start_time, end_time, target_market_cap, status
            ) VALUES (
                ${slug}, ${closeTimestamp}, ${intervalMinutes},
                ${startTime.toISOString()}, ${endTime.toISOString()}, 0, 'active'
            ) RETURNING *
        `;
        
        const round = newRound.rows[0];
        
        await sql`
            INSERT INTO pool_snapshots (round_id, higher_reserve, lower_reserve, k_constant)
            VALUES (${round.id}, 10000, 10000, 100000000)
        `;
        
        console.log(`✅ Created round ${slug} (ID: ${round.id})`);
        return round;
    } catch (error) {
        console.error('❌ getOrCreateCurrentRound error:', error);
        throw error;
    }
}

async function getRoundById(roundId) {
    try {
        const result = await sql`SELECT * FROM rounds WHERE id = ${roundId}`;
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ getRoundById error:', error);
        throw error;
    }
}

// ============================================
// DATABASE HELPERS
// ============================================

async function getOrCreateUser(walletAddress) {
    try {
        const result = await sql`
            SELECT id, wallet_address, total_volume, total_trades
            FROM users
            WHERE wallet_address = ${walletAddress}
        `;
        
        if (result.rows.length > 0) {
            await sql`
                UPDATE users SET last_seen = NOW()
                WHERE wallet_address = ${walletAddress}
            `;
            return result.rows[0];
        }
        
        const newUser = await sql`
            INSERT INTO users (wallet_address)
            VALUES (${walletAddress})
            RETURNING id, wallet_address, total_volume, total_trades
        `;
        
        return newUser.rows[0];
    } catch (error) {
        console.error('❌ getOrCreateUser error:', error);
        throw error;
    }
}

// FIXED: Now accepts intervalMinutes parameter instead of hardcoded 15
async function getActiveRound(intervalMinutes = 15) {
    return await getOrCreateCurrentRound(intervalMinutes);
}

async function getLatestPoolSnapshot(roundId) {
    try {
        const result = await sql`
            SELECT higher_reserve, lower_reserve, k_constant, snapshot_at
            FROM pool_snapshots
            WHERE round_id = ${roundId}
            ORDER BY snapshot_at DESC
            LIMIT 1
        `;
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ getLatestPoolSnapshot error:', error);
        throw error;
    }
}

async function savePoolSnapshot(roundId, higherReserve, lowerReserve, kConstant) {
    try {
        await sql`
            INSERT INTO pool_snapshots (round_id, higher_reserve, lower_reserve, k_constant)
            VALUES (${roundId}, ${higherReserve}, ${lowerReserve}, ${kConstant})
        `;
    } catch (error) {
        console.error('❌ savePoolSnapshot error:', error);
        throw error;
    }
}

async function getAggregatedOrderBook(roundId) {
    try {
        const result = await sql`
            SELECT side, price, SUM(amount - filled) as total_amount, COUNT(*) as order_count
            FROM limit_orders
            WHERE round_id = ${roundId} AND status = 'active' AND amount > filled
            GROUP BY side, price
            ORDER BY 
                CASE WHEN side = 'higher' THEN price END DESC,
                CASE WHEN side = 'lower' THEN price END ASC
            LIMIT 50
        `;
        
        const orderBook = { higher: [], lower: [] };
        result.rows.forEach(row => {
            orderBook[row.side].push({
                price: parseFloat(row.price),
                amount: parseFloat(row.total_amount),
                orders: parseInt(row.order_count)
            });
        });
        
        return orderBook;
    } catch (error) {
        console.error('❌ getAggregatedOrderBook error:', error);
        throw error;
    }
}

async function placeLimitOrder(userId, roundId, side, amount, price) {
    try {
        const result = await sql`
            INSERT INTO limit_orders (user_id, round_id, side, amount, price, status)
            VALUES (${userId}, ${roundId}, ${side}, ${amount}, ${price}, 'active')
            RETURNING *
        `;
        return result.rows[0];
    } catch (error) {
        console.error('❌ placeLimitOrder error:', error);
        throw error;
    }
}

async function recordTrade(tradeData) {
    try {
        const { roundId, buyerId, sellerId, buyOrderId, sellOrderId, side, amount, price, totalCost, tradeType } = tradeData;
        
        const result = await sql`
            INSERT INTO trades (round_id, buyer_id, seller_id, buy_order_id, sell_order_id, side, amount, price, total_cost, trade_type)
            VALUES (${roundId}, ${buyerId}, ${sellerId || null}, ${buyOrderId || null}, ${sellOrderId || null}, ${side}, ${amount}, ${price}, ${totalCost}, ${tradeType})
            RETURNING *
        `;
        return result.rows[0];
    } catch (error) {
        console.error('❌ recordTrade error:', error);
        throw error;
    }
}

async function getRecentTrades(roundId, limit = 20) {
    try {
        const result = await sql`
            SELECT t.*, u.wallet_address as buyer_wallet
            FROM trades t
            JOIN users u ON t.buyer_id = u.id
            WHERE t.round_id = ${roundId}
            ORDER BY t.created_at DESC
            LIMIT ${limit}
        `;
        return result.rows;
    } catch (error) {
        console.error('❌ getRecentTrades error:', error);
        throw error;
    }
}

async function upsertUserPosition(userId, roundId, side, amount, avgPrice, totalCost) {
    try {
        const result = await sql`
            INSERT INTO user_positions (user_id, round_id, side, amount, avg_price, total_cost)
            VALUES (${userId}, ${roundId}, ${side}, ${amount}, ${avgPrice}, ${totalCost})
            ON CONFLICT (user_id, round_id, side)
            DO UPDATE SET
                amount = user_positions.amount + ${amount},
                avg_price = (user_positions.total_cost + ${totalCost}) / (user_positions.amount + ${amount}),
                total_cost = user_positions.total_cost + ${totalCost}
            RETURNING *
        `;
        return result.rows[0];
    } catch (error) {
        console.error('❌ upsertUserPosition error:', error);
        throw error;
    }
}

async function getUserPositions(userId, roundId) {
    try {
        const result = await sql`
            SELECT * FROM user_positions
            WHERE user_id = ${userId} AND round_id = ${roundId}
        `;
        return result.rows;
    } catch (error) {
        console.error('❌ getUserPositions error:', error);
        throw error;
    }
}

async function getMatchableOrders(roundId, side, price) {
    try {
        const oppositeSide = side === 'higher' ? 'lower' : 'higher';
        
        const result = await sql`
            SELECT id, user_id, side, amount, filled, price
            FROM limit_orders
            WHERE round_id = ${roundId} AND side = ${oppositeSide}
            AND status = 'active' AND amount > filled
            AND ${price} + price >= 1
            ORDER BY 
                CASE WHEN side = 'higher' THEN price END DESC,
                CASE WHEN side = 'lower' THEN price END ASC,
                created_at ASC
            LIMIT 10
        `;
        return result.rows;
    } catch (error) {
        console.error('❌ getMatchableOrders error:', error);
        throw error;
    }
}

async function updateOrderFilled(orderId, additionalFilled) {
    try {
        const result = await sql`
            UPDATE limit_orders
            SET filled = filled + ${additionalFilled},
                status = CASE WHEN filled + ${additionalFilled} >= amount THEN 'filled' ELSE 'active' END,
                filled_at = CASE WHEN filled + ${additionalFilled} >= amount THEN NOW() ELSE filled_at END
            WHERE id = ${orderId}
            RETURNING *
        `;
        return result.rows[0];
    } catch (error) {
        console.error('❌ updateOrderFilled error:', error);
        throw error;
    }
}

async function cancelOrder(orderId, userId) {
    try {
        const result = await sql`
            UPDATE limit_orders
            SET status = 'cancelled', cancelled_at = NOW()
            WHERE id = ${orderId} AND user_id = ${userId} AND status = 'active'
            RETURNING *
        `;
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ cancelOrder error:', error);
        throw error;
    }
}

async function checkRateLimit(identifier, endpoint, maxRequests = 100, windowMinutes = 1) {
    try {
        const windowStart = new Date();
        windowStart.setMinutes(windowStart.getMinutes() - windowMinutes);
        
        const result = await sql`
            SELECT COALESCE(SUM(request_count), 0) as total
            FROM rate_limits
            WHERE identifier = ${identifier} AND endpoint = ${endpoint}
            AND window_start > ${windowStart.toISOString()}
        `;
        
        const currentCount = parseInt(result.rows[0].total);
        
        if (currentCount >= maxRequests) {
            return { allowed: false, remaining: 0 };
        }
        
        await sql`
            INSERT INTO rate_limits (identifier, endpoint, request_count)
            VALUES (${identifier}, ${endpoint}, 1)
            ON CONFLICT (identifier, endpoint, window_start)
            DO UPDATE SET request_count = rate_limits.request_count + 1
        `;
        
        return { allowed: true, remaining: maxRequests - currentCount - 1 };
    } catch (error) {
        console.error('❌ checkRateLimit error:', error);
        return { allowed: true, remaining: 999 };
    }
}

async function logAction(userId, action, details, ipAddress, userAgent) {
    try {
        await sql`
            INSERT INTO audit_log (user_id, action, details, ip_address, user_agent)
            VALUES (${userId || null}, ${action}, ${JSON.stringify(details)}, ${ipAddress || null}, ${userAgent || null})
        `;
    } catch (error) {
        console.error('❌ logAction error:', error);
    }
}

const db = {
    getOrCreateUser, getActiveRound, getRoundById, getOrCreateCurrentRound,
    getLatestPoolSnapshot, savePoolSnapshot, getAggregatedOrderBook,
    placeLimitOrder, recordTrade, getRecentTrades, upsertUserPosition,
    getUserPositions, getMatchableOrders, updateOrderFilled, cancelOrder,
    checkRateLimit, logAction, sql
};

function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0] || 
           req.headers['x-real-ip'] || 
           req.connection?.remoteAddress || 
           'unknown';
}

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
    
    return null;
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
            
            const rateLimitError = await enforceRateLimit(req, res, clientIP, `GET:${action}`);
            if (rateLimitError) return;
            
            // GET ALL CURRENT ROUNDS (для табов)
            if (action === 'rounds') {
                const rounds = [];
                
                for (const interval of [15, 60, 240]) {
                    try {
                        const r = await getOrCreateCurrentRound(interval);
                        const endTime = new Date(r.end_time);
                        const now = new Date();
                        const minutesRemaining = Math.max(0, Math.floor((endTime - now) / 60000));
                        
                        rounds.push({
                            id: r.id,
                            slug: r.slug,
                            interval: interval,
                            endTime: r.end_time,
                            minutesRemaining: minutesRemaining
                        });
                    } catch (error) {
                        console.error(`Failed to get round for ${interval}m:`, error);
                    }
                }
                
                return res.status(200).json({
                    success: true,
                    rounds
                });
            }
            
            // NEW: Get all active rounds for all intervals (simplified version)
            if (action === 'all-rounds') {
                const rounds = await Promise.all([
                    getOrCreateCurrentRound(15),
                    getOrCreateCurrentRound(60),
                    getOrCreateCurrentRound(240)
                ]);
                
                return res.status(200).json({
                    success: true,
                    rounds: rounds.map(round => ({
                        id: round.id,
                        slug: round.slug,
                        interval_minutes: round.interval_minutes,
                        start_time: round.start_time,
                        end_time: round.end_time,
                        status: round.status
                    }))
                });
            }
            
            // Получить раунд
            let round;
            
            if (query.roundId) {
                round = await getRoundById(parseInt(query.roundId));
            } else if (query.intervalMinutes) {
                round = await getOrCreateCurrentRound(parseInt(query.intervalMinutes));
            } else {
                round = await getOrCreateCurrentRound(15);
            }
            
            if (!round) {
                return res.status(404).json({
                    success: false,
                    error: 'Round not found'
                });
            }
            
            // ORDER BOOK
            if (action === 'orderbook') {
                const orderBook = await db.getAggregatedOrderBook(round.id);
                const poolSnapshot = await db.getLatestPoolSnapshot(round.id);
                
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
                    roundId: round.id,
                    roundSlug: round.slug,
                    roundNumber: round.round_number,
                    intervalMinutes: round.interval_minutes,
                    startTime: round.start_time,
                    endTime: round.end_time
                });
            }
            
            // TRADE HISTORY
            if (action === 'trades') {
                const trades = await db.getRecentTrades(round.id, 20);
                
                return res.status(200).json({
                    success: true,
                    trades: trades.map(t => ({
                        id: t.id,
                        wallet: t.buyer_wallet,
                        side: t.side,
                        amount: parseFloat(t.amount),
                        price: parseFloat(t.price),
                        cost: parseFloat(t.total_cost),
                        time: t.created_at,
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
                
                const poolSnapshot = await db.getLatestPoolSnapshot(round.id);
                
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
                const positions = await db.getUserPositions(user.id, round.id);
                
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
            const orderBook = await db.getAggregatedOrderBook(round.id);
            const poolSnapshot = await db.getLatestPoolSnapshot(round.id);
            const recentTrades = await db.getRecentTrades(round.id, 10);
            
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
                roundId: round.id,
                roundSlug: round.slug,
                roundNumber: round.round_number
            });
        }
        
        // ============================================
        // POST - Разместить ордер
        // ============================================
        if (method === 'POST') {
            const { wallet, side, amount, price, type, roundId, intervalMinutes } = 
                typeof body === 'string' ? JSON.parse(body) : body;
            
            if (!wallet || !side || !amount) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required fields: wallet, side, amount'
                });
            }
            
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
            
            // Получить раунд
            let round;
            if (roundId) {
                round = await getRoundById(roundId);
            } else if (intervalMinutes) {
                round = await getOrCreateCurrentRound(intervalMinutes);
            } else {
                round = await getOrCreateCurrentRound(15);
            }
            
            if (!round) {
                return res.status(400).json({
                    success: false,
                    error: 'Round not found'
                });
            }
            
            const user = await db.getOrCreateUser(wallet);
            
            await db.logAction(
                user.id,
                'place_order',
                { side, amount: amt, type, price },
                clientIP,
                req.headers['user-agent']
            );
            
            // MARKET ORDER
            if (type === 'market') {
                const poolSnapshot = await db.getLatestPoolSnapshot(round.id);
                
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
                
                const trade = await db.recordTrade({
                    roundId: round.id,
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
                
                await db.savePoolSnapshot(round.id, higher, lower, k);
                await db.upsertUserPosition(user.id, round.id, side, amt, avgPrice, tradeCost);
                
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
                
                const order = await db.placeLimitOrder(user.id, round.id, side, amt, prc);
                const matchableOrders = await db.getMatchableOrders(round.id, side, prc);
                
                let totalMatched = 0;
                
                for (const oppositeOrder of matchableOrders) {
                    const remainingToFill = amt - totalMatched;
                    const oppositeRemaining = parseFloat(oppositeOrder.amount) - parseFloat(oppositeOrder.filled);
                    
                    if (remainingToFill <= 0) break;
                    
                    const matchAmount = Math.min(remainingToFill, oppositeRemaining);
                    const matchPrice = (prc + parseFloat(oppositeOrder.price)) / 2;
                    
                    await db.recordTrade({
                        roundId: round.id,
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
                    
                    await db.updateOrderFilled(order.id, matchAmount);
                    await db.updateOrderFilled(oppositeOrder.id, matchAmount);
                    
                    await db.upsertUserPosition(user.id, round.id, side, matchAmount, matchPrice, matchAmount * matchPrice);
                    await db.upsertUserPosition(oppositeOrder.user_id, round.id, oppositeOrder.side, matchAmount, matchPrice, matchAmount * matchPrice);
                    
                    totalMatched += matchAmount;
                }
                
                const orderBook = await db.getAggregatedOrderBook(round.id);
                
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
            
            await db.logAction(user.id, 'cancel_order', { orderId }, clientIP, req.headers['user-agent']);
            
            const round = await db.getActiveRound();
            const orderBook = await db.getAggregatedOrderBook(round.id);
            
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
