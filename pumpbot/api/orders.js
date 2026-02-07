// ============================================
// ORDERS API - PRODUCTION VERSION WITH AUTO ROUND GENERATION
// ============================================

import { sql } from '@vercel/postgres';

// Ensure unique constraint on slug (idempotent)
let indexCreated = false;
async function ensureIndexes() {
    if (indexCreated) return;
    indexCreated = true;
    try {
        await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_rounds_slug ON rounds(slug)`;
    } catch(e) {} // Already exists
}

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
        await ensureIndexes();
        const closeTimestamp = calculateRoundCloseTime(intervalMinutes);
        const slug = generateRoundSlug(intervalMinutes, closeTimestamp);
        
        const existing = await sql`SELECT * FROM rounds WHERE slug = ${slug}`;
        
        if (existing.rows.length > 0) {
            const round = existing.rows[0];
            
            // Если target_market_cap = 0 — попробуем заполнить из market_cap_history
            if (parseFloat(round.target_market_cap || 0) <= 0) {
                try {
                    const capResult = await sql`
                        SELECT market_cap FROM market_cap_history 
                        WHERE market_cap > 0 
                        ORDER BY recorded_at DESC LIMIT 1
                    `;
                    if (capResult.rows.length > 0 && parseFloat(capResult.rows[0].market_cap) > 0) {
                        const cap = parseFloat(capResult.rows[0].market_cap);
                        await sql`UPDATE rounds SET target_market_cap = ${cap} WHERE id = ${round.id} AND (target_market_cap IS NULL OR target_market_cap = 0)`;
                        round.target_market_cap = cap;
                        console.log(`✅ Updated target_market_cap for ${slug}: $${cap}`);
                    }
                } catch(e) {
                    console.log('Cap backfill error:', e.message);
                }
            }
            
            console.log(`✅ Found round: ${slug}`);
            return round;
        }
        
        console.log(`🔨 Creating round: ${slug}`);
        const endTime = new Date(closeTimestamp * 1000);
        const startTime = new Date(endTime.getTime() - intervalMinutes * 60 * 1000);
        
        // Получаем market cap из GeckoTerminal (лоукап токен)
        let startMarketCap = 0;
        const TOTAL_SUPPLY = 1000000000;
        const TOKEN_ADDR = 'DmHzzungjC7eMYVXUve4SksEg4XoUTcAQuRJ5tMmpump';
        
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            
            const geckResponse = await fetch(
                `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${TOKEN_ADDR}`,
                { 
                    signal: controller.signal,
                    headers: { 'Accept': 'application/json' }
                }
            );
            clearTimeout(timeout);
            
            if (geckResponse.ok) {
                const geckData = await geckResponse.json();
                const price = parseFloat(geckData?.data?.attributes?.price_usd);
                if (price > 0 && !isNaN(price)) {
                    startMarketCap = price * TOTAL_SUPPLY;
                    console.log(`✅ Got start market cap from GeckoTerminal: $${startMarketCap.toFixed(2)}`);
                }
            }
        } catch (error) {
            console.error('⚠️ Failed to fetch start market cap from GeckoTerminal:', error.message);
        }
        
        // Fallback: из market_cap_history (записывается marketcap.js)
        if (startMarketCap <= 0) {
            try {
                const capResult = await sql`
                    SELECT market_cap FROM market_cap_history 
                    WHERE market_cap > 0 
                    ORDER BY recorded_at DESC LIMIT 1
                `;
                if (capResult.rows.length > 0) {
                    startMarketCap = parseFloat(capResult.rows[0].market_cap);
                    console.log(`✅ Got start market cap from DB history: $${startMarketCap}`);
                }
            } catch(e) {
                console.log('Cap history fallback error:', e.message);
            }
        }
        
        const newRound = await sql`
            INSERT INTO rounds (
                slug, round_number, interval_minutes,
                start_time, end_time, target_market_cap, status
            ) VALUES (
                ${slug}, ${closeTimestamp}, ${intervalMinutes},
                ${startTime.toISOString()}, ${endTime.toISOString()}, ${startMarketCap}, 'active'
            ) 
            ON CONFLICT (slug) DO NOTHING
            RETURNING *
        `;
        
        // Если ON CONFLICT сработал — значит другой запрос уже создал раунд
        if (!newRound.rows.length) {
            const retry = await sql`SELECT * FROM rounds WHERE slug = ${slug}`;
            return retry.rows[0];
        }
        
        const round = newRound.rows[0];
        
        await sql`
            INSERT INTO pool_snapshots (round_id, higher_reserve, lower_reserve, k_constant)
            VALUES (${round.id}, 10000, 10000, 100000000)
        `;
        
        console.log(`✅ Created round ${slug} (ID: ${round.id}, Start Cap: $${startMarketCap})`);
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
        // Get HIGHER orders (sorted by price DESC - highest first)
        const higherResult = await sql`
            SELECT side, price, SUM(amount - filled) as total_amount, COUNT(*) as order_count
            FROM limit_orders
            WHERE round_id = ${roundId} 
            AND side = 'higher'
            AND status = 'active' 
            AND amount > filled
            GROUP BY side, price
            ORDER BY price DESC
            LIMIT 25
        `;
        
        // Get LOWER orders (sorted by price ASC - lowest first)
        const lowerResult = await sql`
            SELECT side, price, SUM(amount - filled) as total_amount, COUNT(*) as order_count
            FROM limit_orders
            WHERE round_id = ${roundId} 
            AND side = 'lower'
            AND status = 'active' 
            AND amount > filled
            GROUP BY side, price
            ORDER BY price ASC
            LIMIT 25
        `;
        
        const orderBook = { higher: [], lower: [] };
        
        higherResult.rows.forEach(row => {
            orderBook.higher.push({
                price: parseFloat(row.price),
                amount: parseFloat(row.total_amount),
                orders: parseInt(row.order_count)
            });
        });
        
        lowerResult.rows.forEach(row => {
            orderBook.lower.push({
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

async function getUserOrders(userId, roundId) {
    try {
        const result = await sql`
            SELECT * FROM limit_orders
            WHERE user_id = ${userId} 
            AND round_id = ${roundId}
            AND status = 'active'
            AND amount > filled
            ORDER BY created_at DESC
        `;
        return result.rows;
    } catch (error) {
        console.error('❌ getUserOrders error:', error);
        throw error;
    }
}

async function getMatchableOrders(roundId, side, price) {
    try {
        const oppositeSide = side === 'higher' ? 'lower' : 'higher';
        
        let result;
        
        if (price === null || price === undefined || (side === 'higher' && price >= 1.0) || (side === 'lower' && price <= 0.0)) {
            result = await sql`
                SELECT id, user_id, side, amount, filled, price
                FROM limit_orders
                WHERE round_id = ${roundId} 
                AND side = ${oppositeSide}
                AND status = 'active' 
                AND amount > filled
                ORDER BY 
                    CASE WHEN side = 'higher' THEN price END DESC,
                    CASE WHEN side = 'lower' THEN price END ASC,
                    created_at ASC
                LIMIT 50
            `;
        } else {
            result = await sql`
                SELECT id, user_id, side, amount, filled, price
                FROM limit_orders
                WHERE round_id = ${roundId} 
                AND side = ${oppositeSide}
                AND status = 'active' 
                AND amount > filled
                AND price <= ${price}
                ORDER BY 
                    CASE WHEN side = 'higher' THEN price END DESC,
                    CASE WHEN side = 'lower' THEN price END ASC,
                    created_at ASC
                LIMIT 50
            `;
        }
        
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
    getUserPositions, getUserOrders, getMatchableOrders, updateOrderFilled, cancelOrder,
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
// BALANCE HELPERS (кастодиальная модель)
// ============================================

async function getOrCreateBalance(userId) {
    const existing = await sql`
        SELECT * FROM user_balances WHERE user_id = ${userId}
    `;
    if (existing.rows.length > 0) return existing.rows[0];
    
    const created = await sql`
        INSERT INTO user_balances (user_id, available, locked)
        VALUES (${userId}, 0, 0)
        RETURNING *
    `;
    return created.rows[0];
}

async function lockBalance(userId, amount) {
    // Переводит средства из available в locked
    const balance = await getOrCreateBalance(userId);
    const available = parseFloat(balance.available);
    
    if (available < amount) {
        throw new Error(`Недостаточно средств. Доступно: ${available.toFixed(2)}, нужно: ${amount.toFixed(2)}. Пополните баланс.`);
    }
    
    await sql`
        UPDATE user_balances 
        SET available = available - ${amount},
            locked = locked + ${amount},
            updated_at = NOW()
        WHERE user_id = ${userId}
    `;
    
    // Лог
    await sql`
        INSERT INTO balance_transactions (user_id, type, amount, balance_before, balance_after, description)
        VALUES (${userId}, 'order_lock', ${-amount}, ${available}, ${available - amount}, ${'Lock for order'})
    `;
}

async function unlockBalance(userId, amount) {
    // Возвращает средства из locked в available (отмена ордера, переплата)
    await sql`
        UPDATE user_balances 
        SET available = available + ${amount},
            locked = locked - ${amount},
            updated_at = NOW()
        WHERE user_id = ${userId}
    `;
    
    const balance = await getOrCreateBalance(userId);
    await sql`
        INSERT INTO balance_transactions (user_id, type, amount, balance_before, balance_after, description)
        VALUES (${userId}, 'order_unlock', ${amount}, ${parseFloat(balance.available) - amount}, ${parseFloat(balance.available)}, ${'Unlock from order'})
    `;
}

async function deductLocked(userId, amount) {
    // Списывает из locked (исполнение ордера — деньги ушли)
    await sql`
        UPDATE user_balances 
        SET locked = locked - ${amount},
            updated_at = NOW()
        WHERE user_id = ${userId}
    `;
}

async function creditBalance(userId, amount, description) {
    // Зачисляет в available (выигрыш, продажа)
    const balance = await getOrCreateBalance(userId);
    const before = parseFloat(balance.available);
    
    await sql`
        UPDATE user_balances 
        SET available = available + ${amount},
            updated_at = NOW()
        WHERE user_id = ${userId}
    `;
    
    await sql`
        INSERT INTO balance_transactions (user_id, type, amount, balance_before, balance_after, description)
        VALUES (${userId}, 'trade_credit', ${amount}, ${before}, ${before + amount}, ${description})
    `;
}

// ============================================
// INLINE SETTLEMENT
// ============================================
let lastSettleCheck = 0;
let lastHeavyCheck = 0;

async function inlineSettlementCheck() {
    try {
        // ============================================
        // БЫСТРАЯ ЧАСТЬ (раз в 5 сек):
        // ============================================
        const now = Date.now();
        if (now - lastSettleCheck < 5000) return;
        lastSettleCheck = now;
        
        // 1. Закрыть истекшие раунды
        await sql`UPDATE rounds SET status = 'closed' WHERE status = 'active' AND end_time < NOW()`;
        
        // 2. Отменить ордера в закрытых раундах
        await cancelExpiredOrders();
        
        // 3. Settle раунды с позициями
        const toSettle = await sql`
            SELECT r.id FROM rounds r
            WHERE r.status = 'closed'
            AND (r.settlement_status IS NULL OR r.settlement_status = 'pending')
            AND r.end_time < NOW()
            AND EXISTS (SELECT 1 FROM user_positions WHERE round_id = r.id)
            ORDER BY r.end_time ASC LIMIT 3
        `;
        
        for (const r of toSettle.rows) {
            await inlineSettleRound(r.id);
        }
        
        // ============================================
        // ТЯЖЁЛАЯ ЧАСТЬ (раз в 60 сек):
        // ============================================
        if (now - lastHeavyCheck < 60000) return;
        lastHeavyCheck = now;
        
        // Пустые раунды без позиций — просто пометить settled
        await sql`
            UPDATE rounds SET settlement_status = 'settled', settled_at = NOW()
            WHERE status = 'closed'
            AND (settlement_status IS NULL OR settlement_status = 'pending')
            AND end_time < NOW()
            AND NOT EXISTS (SELECT 1 FROM user_positions WHERE round_id = rounds.id)
            AND NOT EXISTS (SELECT 1 FROM limit_orders WHERE round_id = rounds.id AND status = 'active')
            AND id IN (SELECT id FROM rounds WHERE status = 'closed' AND (settlement_status IS NULL OR settlement_status = 'pending') AND end_time < NOW() LIMIT 50)
        `;
        
        // Safety net: orphaned locks
        await fixOrphanedLocks();
    } catch (e) {
        console.error('Settlement error:', e.message);
    }
}

// Отменяет все ордера в закрытых раундах и возвращает locked средства
async function cancelExpiredOrders() {
    try {
        // Атомарно: помечаем expired и получаем только те что РЕАЛЬНО обновились
        const expired = await sql`
            UPDATE limit_orders lo
            SET status = 'expired', cancelled_at = NOW()
            FROM rounds r
            WHERE lo.round_id = r.id
            AND lo.status = 'active'
            AND r.status = 'closed'
            RETURNING lo.id, lo.user_id, lo.amount, lo.filled, lo.price
        `;
        
        if (expired.rows.length === 0) return;
        console.log('Expired ' + expired.rows.length + ' orders from closed rounds');
        
        for (const order of expired.rows) {
            const unfilled = parseFloat(order.amount) - parseFloat(order.filled);
            const cost = unfilled * parseFloat(order.price);
            
            if (cost > 0.001) {
                await unlockBalance(order.user_id, cost);
                console.log('  Refund order #' + order.id + ': ' + cost.toFixed(2) + ' to user ' + order.user_id);
            }
        }
    } catch (e) {
        console.error('cancelExpiredOrders error:', e.message);
    }
}

// Safety net: ТОЛЬКО логирует, не дублирует unlock
// (unlock уже делает cancelExpiredOrders)
async function fixOrphanedLocks() {
    try {
        // Проверяем: есть ли locked > 0 без живых ордеров?
        const orphaned = await sql`
            SELECT ub.user_id, ub.locked
            FROM user_balances ub
            WHERE ub.locked > 0
            AND NOT EXISTS (
                SELECT 1 FROM limit_orders lo
                INNER JOIN rounds r ON r.id = lo.round_id
                WHERE lo.user_id = ub.user_id 
                AND lo.status = 'active'
                AND r.status = 'active'
            )
        `;
        
        if (orphaned.rows.length === 0) return;
        
        // Есть orphaned locks — значит cancelExpiredOrders пропустил. Фиксим.
        for (const row of orphaned.rows) {
            const amt = parseFloat(row.locked);
            if (amt > 0.001) {
                // Атомарно: SET locked=0 только если locked > 0 (предотвращает двойной unlock)
                const result = await sql`
                    UPDATE user_balances 
                    SET available = available + locked, locked = 0, updated_at = NOW()
                    WHERE user_id = ${row.user_id} AND locked > 0
                    RETURNING user_id, available
                `;
                if (result.rows.length > 0) {
                    console.log('Orphan fix: +' + amt.toFixed(2) + ' to user ' + row.user_id);
                }
            }
        }
    } catch (e) {
        console.error('fixOrphanedLocks error:', e.message);
    }
}

async function inlineSettleRound(roundId) {
    try {
        const rr = await sql`SELECT * FROM rounds WHERE id = ${roundId} AND status = 'closed'`;
        if (rr.rows.length === 0) return;
        const round = rr.rows[0];
        
        const startMC = parseFloat(round.target_market_cap) || 0;
        const positions = await sql`SELECT user_id, side, amount, avg_price, total_cost FROM user_positions WHERE round_id = ${roundId}`;
        if (positions.rows.length === 0) {
            await sql`UPDATE rounds SET settlement_status = 'settled', settled_at = NOW() WHERE id = ${roundId}`;
            return;
        }
        
        // ============================================
        // CASE 1: target_market_cap = 0 → рефанд всем (не нужен finalMC!)
        // ============================================
        if (startMC <= 0) {
            for (const pos of positions.rows) {
                const tc = parseFloat(pos.total_cost);
                await sql`INSERT INTO user_settlements (user_id,round_id,side,amount,avg_price,total_cost,won,payout,profit_loss,claimed)
                    VALUES (${pos.user_id},${roundId},${pos.side},${parseFloat(pos.amount)},${pos.avg_price},${tc},true,${tc},0,false)
                    ON CONFLICT (user_id,round_id,side) DO UPDATE SET won=true,payout=${tc},profit_loss=0`;
            }
            await sql`UPDATE rounds SET settlement_status='settled',settled_at=NOW(),winning_side='tie' WHERE id=${roundId}`;
            console.log(`✅ Settled round ${roundId}: refund (no start cap)`);
            return;
        }
        
        // ============================================
        // Получаем finalMC (нужен только если startMC > 0)
        // ============================================
        let finalMC = parseFloat(round.final_market_cap) || 0;
        if (finalMC <= 0) {
            const TOKEN = 'DmHzzungjC7eMYVXUve4SksEg4XoUTcAQuRJ5tMmpump';
            
            // GeckoTerminal (лоукап)
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 5000);
                const resp = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${TOKEN}`, {
                    signal: ctrl.signal, headers: { 'Accept': 'application/json' }
                });
                clearTimeout(t);
                if (resp.ok) {
                    const d = await resp.json();
                    const price = parseFloat(d?.data?.attributes?.price_usd);
                    if (price > 0 && !isNaN(price)) {
                        finalMC = price * 1000000000;
                        console.log(`✅ Final MC from GeckoTerminal: $${finalMC.toFixed(2)}`);
                    }
                }
            } catch(e) {
                console.log('GeckoTerminal finalMC error:', e.message);
            }
            
            // Fallback: из market_cap_history
            if (finalMC <= 0) {
                try {
                    const capResult = await sql`
                        SELECT market_cap FROM market_cap_history 
                        WHERE market_cap > 0 
                        ORDER BY recorded_at DESC LIMIT 1
                    `;
                    if (capResult.rows.length > 0) {
                        finalMC = parseFloat(capResult.rows[0].market_cap);
                        console.log(`✅ Final MC from DB history: $${finalMC}`);
                    }
                } catch(e) {}
            }
            
            if (!finalMC) return; // Cron подхватит позже
            await sql`UPDATE rounds SET final_market_cap = ${finalMC} WHERE id = ${roundId}`;
        }
        
        // ============================================
        // CASE 2: Ничья — капа не изменилась (или разница < 0.01%) → рефанд всем
        // ============================================
        const capChangePercent = startMC > 0 ? Math.abs((finalMC - startMC) / startMC * 100) : 0;
        if (finalMC === startMC || capChangePercent < 0.01) {
            for (const pos of positions.rows) {
                const tc = parseFloat(pos.total_cost);
                await sql`INSERT INTO user_settlements (user_id,round_id,side,amount,avg_price,total_cost,won,payout,profit_loss,claimed)
                    VALUES (${pos.user_id},${roundId},${pos.side},${parseFloat(pos.amount)},${pos.avg_price},${tc},true,${tc},0,false)
                    ON CONFLICT (user_id,round_id,side) DO UPDATE SET won=true,payout=${tc},profit_loss=0`;
            }
            await sql`UPDATE rounds SET settlement_status='settled',settled_at=NOW(),winning_side='tie' WHERE id=${roundId}`;
            console.log(`✅ Settled round ${roundId}: TIE (${startMC}=${finalMC}), refund all`);
            return;
        }
        
        // ============================================
        // CASE 3: Нормальный settlement — есть победитель
        // ============================================
        const winningSide = finalMC > startMC ? 'higher' : 'lower';
        let totalWinAmt = 0, totalLoseCost = 0;
        for (const p of positions.rows) {
            if (p.side === winningSide) totalWinAmt += parseFloat(p.amount);
            else totalLoseCost += parseFloat(p.total_cost);
        }
        
        for (const pos of positions.rows) {
            const won = pos.side === winningSide;
            const amt = parseFloat(pos.amount), tc = parseFloat(pos.total_cost);
            let payout = 0, pl = 0;
            if (won && totalWinAmt > 0) {
                payout = tc + totalLoseCost * (amt / totalWinAmt);
                pl = payout - tc;
                // НЕ кредитим баланс здесь! Кредит только при claim
            } else if (!won) {
                payout = 0;
                pl = -tc;
            }
            
            await sql`INSERT INTO user_settlements (user_id,round_id,side,amount,avg_price,total_cost,won,payout,profit_loss,claimed)
                VALUES (${pos.user_id},${roundId},${pos.side},${amt},${pos.avg_price},${tc},${won},${payout},${pl},false)
                ON CONFLICT (user_id,round_id,side) DO UPDATE SET won=${won},payout=${payout},profit_loss=${pl}`;
        }
        
        await sql`UPDATE rounds SET settlement_status='settled',settled_at=NOW(),winning_side=${winningSide} WHERE id=${roundId}`;
        console.log(`✅ Settled round ${roundId}: ${startMC}→${finalMC}, winner: ${winningSide}`);
    } catch (e) {
        console.error(`⚠️ Settle round ${roundId}:`, e.message);
    }
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
            
            // Фоновый settlement (не блокирует ответ)
            inlineSettlementCheck().catch(() => {});
            
            const rateLimitError = await enforceRateLimit(req, res, clientIP, `GET:${action}`);
            if (rateLimitError) return;
            
            // GET ALL CURRENT ROUNDS (для табов)
            if (action === 'rounds' || action === 'all-rounds') {
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
                            interval_minutes: interval,
                            interval: interval,
                            start_time: r.start_time,
                            end_time: r.end_time,
                            endTime: r.end_time,
                            minutesRemaining: minutesRemaining,
                            status: r.status
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
    
    // Получаем ордера текущего пользователя для подсветки в стакане
    let userOrderPrices = { higher: [], lower: [] };
    const reqWallet = req.query.wallet;
    if (reqWallet) {
        try {
            const userResult = await sql`SELECT id FROM users WHERE wallet_address = ${reqWallet}`;
            if (userResult.rows.length > 0) {
                const userId = userResult.rows[0].id;
                const userOrders = await sql`
                    SELECT side, price, (amount - filled) as remaining
                    FROM limit_orders
                    WHERE round_id = ${round.id} AND user_id = ${userId} AND status = 'active' AND amount > filled
                `;
                for (const o of userOrders.rows) {
                    const side = o.side;
                    const price = parseFloat(o.price);
                    if (!userOrderPrices[side].includes(price)) {
                        userOrderPrices[side].push(price);
                    }
                }
            }
        } catch (e) { /* ignore */ }
    }
    
    return res.status(200).json({
        success: true,
        orderBook,
        ammPrice,
        userOrderPrices,
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
        endTime: round.end_time,
        startMarketCap: parseFloat(round.target_market_cap) || 0,
        roundEndTime: round.end_time,
        poolSnapshot: poolSnapshot ? {
            higher: parseFloat(poolSnapshot.higher_reserve),
            lower: parseFloat(poolSnapshot.lower_reserve),
            k: parseFloat(poolSnapshot.k_constant)
        } : null
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
                        totalCost: parseFloat(t.total_cost),
                        time: t.created_at,
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
            if (action === 'positions' || action === 'user-positions') {
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
            
            // USER ORDERS
            if (action === 'user-orders') {
                const { wallet } = query;
                
                if (!wallet) {
                    return res.status(400).json({
                        success: false,
                        error: 'Wallet address required'
                    });
                }
                
                const user = await db.getOrCreateUser(wallet);
                const orders = await db.getUserOrders(user.id, round.id);
                
                return res.status(200).json({
                    success: true,
                    orders: orders.map(o => ({
                        id: o.id,
                        side: o.side,
                        amount: parseFloat(o.amount),
                        price: parseFloat(o.price),
                        filled: parseFloat(o.filled),
                        status: o.status,
                        order_type: o.order_type || 'limit',
                        interval_minutes: round.interval_minutes,
                        round_id: round.id,
                        created: o.created_at
                    }))
                });
            }
            
            // USER TRADES
            if (action === 'user-trades') {
                const { wallet } = query;
                
                if (!wallet) {
                    return res.status(400).json({
                        success: false,
                        error: 'Wallet address required'
                    });
                }
                
                const user = await db.getOrCreateUser(wallet);
                
                const trades = await sql`
                    SELECT 
                        t.id,
                        t.side,
                        t.amount,
                        t.price,
                        t.total_cost,
                        t.trade_type,
                        t.created_at as timestamp,
                        r.interval_minutes,
                        r.id as round_id,
                        CASE 
                            WHEN t.buyer_id = ${user.id} THEN t.side
                            ELSE (CASE WHEN t.side = 'higher' THEN 'lower' ELSE 'higher' END)
                        END as user_side
                    FROM trades t
                    JOIN rounds r ON t.round_id = r.id
                    WHERE (t.buyer_id = ${user.id} OR t.seller_id = ${user.id})
                    AND t.round_id = ${round.id}
                    ORDER BY t.created_at DESC
                    LIMIT 50
                `;
                
                return res.status(200).json({
                    success: true,
                    trades: trades.rows.map(t => ({
                        id: t.id,
                        side: t.user_side,
                        amount: parseFloat(t.amount),
                        price: parseFloat(t.price),
                        total_cost: parseFloat(t.total_cost),
                        order_type: t.trade_type,
                        timestamp: t.timestamp,
                        interval_minutes: t.interval_minutes,
                        round_id: t.round_id
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
        // POST - Разместить ордер (С ПРОВЕРКОЙ БАЛАНСА)
        // ============================================
        if (method === 'POST') {
            const { wallet, side, amount, price, type, roundId, intervalMinutes, action } = 
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
                return res.status(400).json({ success: false, error: 'Round not found' });
            }
            
            // Проверка что раунд активен
            if (round.status !== 'active') {
                return res.status(400).json({ success: false, error: 'Раунд уже закрыт' });
            }
            
            const user = await db.getOrCreateUser(wallet);
            
            // ============================================
            // SELL — продажа позиции
            // ============================================
            if (action === 'sell') {
                // Проверяем позицию пользователя
                const positions = await db.getUserPositions(user.id, round.id);
                const position = positions.find(p => p.side === side);
                
                if (!position || parseFloat(position.amount) <= 0) {
                    return res.status(400).json({ success: false, error: 'У вас нет позиции для продажи' });
                }
                
                const posAmount = parseFloat(position.amount);
                const sellAmount = Math.min(amt, posAmount);
                
                if (sellAmount <= 0) {
                    return res.status(400).json({ success: false, error: 'Нечего продавать' });
                }
                
                await db.logAction(user.id, 'sell_position', { side, amount: sellAmount, type, price }, clientIP, req.headers['user-agent']);
                
                let totalProceeds = 0;
                let soldAmount = 0;
                const trades = [];
                
                // Продажа по лимитной цене
                if (type === 'limit') {
                    const sellPrice = parseFloat(price);
                    if (!sellPrice || sellPrice <= 0 || sellPrice >= 1 || isNaN(sellPrice)) {
                        return res.status(400).json({ success: false, error: 'Цена должна быть от 0 до 1' });
                    }
                    
                    // Ищем покупателей на нашей стороне (те кто ставят лимитки на BUY нашей стороны)
                    // Т.е. opposite side limit orders с price >= (1 - sellPrice)
                    const oppositeSide = side === 'higher' ? 'lower' : 'higher';
                    const buyOrders = await sql`
                        SELECT id, user_id, side, amount, filled, price
                        FROM limit_orders
                        WHERE round_id = ${round.id} 
                        AND side = ${side}
                        AND status = 'active' 
                        AND amount > filled
                        AND price >= ${sellPrice}
                        ORDER BY price DESC, created_at ASC
                        LIMIT 50
                    `;
                    
                    for (const buyOrder of buyOrders.rows) {
                        const remaining = sellAmount - soldAmount;
                        if (remaining <= 0) break;
                        
                        const orderRemaining = parseFloat(buyOrder.amount) - parseFloat(buyOrder.filled);
                        const matchAmount = Math.min(remaining, orderRemaining);
                        const matchPrice = parseFloat(buyOrder.price);
                        const proceeds = matchAmount * matchPrice;
                        
                        const trade = await db.recordTrade({
                            roundId: round.id,
                            buyerId: buyOrder.user_id,
                            sellerId: user.id,
                            buyOrderId: buyOrder.id,
                            sellOrderId: null,
                            side,
                            amount: matchAmount,
                            price: matchPrice,
                            totalCost: proceeds,
                            tradeType: 'sell'
                        });
                        trades.push(trade);
                        
                        await db.updateOrderFilled(buyOrder.id, matchAmount);
                        // Покупатель получает позицию
                        await db.upsertUserPosition(buyOrder.user_id, round.id, side, matchAmount, matchPrice, proceeds);
                        // Списываем locked покупателя
                        await deductLocked(buyOrder.user_id, proceeds);
                        
                        totalProceeds += proceeds;
                        soldAmount += matchAmount;
                    }
                    
                    // Если не всё продано — можно создать лимитный sell-ордер
                    // Пока просто возвращаем частичное исполнение
                }
                
                // Маркет продажа — продаём в существующие buy-лимитки
                if (type === 'market') {
                    const buyOrders = await sql`
                        SELECT id, user_id, side, amount, filled, price
                        FROM limit_orders
                        WHERE round_id = ${round.id} 
                        AND side = ${side}
                        AND status = 'active' 
                        AND amount > filled
                        ORDER BY price DESC, created_at ASC
                        LIMIT 50
                    `;
                    
                    for (const buyOrder of buyOrders.rows) {
                        const remaining = sellAmount - soldAmount;
                        if (remaining <= 0) break;
                        
                        const orderRemaining = parseFloat(buyOrder.amount) - parseFloat(buyOrder.filled);
                        const matchAmount = Math.min(remaining, orderRemaining);
                        const matchPrice = parseFloat(buyOrder.price);
                        const proceeds = matchAmount * matchPrice;
                        
                        const trade = await db.recordTrade({
                            roundId: round.id,
                            buyerId: buyOrder.user_id,
                            sellerId: user.id,
                            buyOrderId: buyOrder.id,
                            sellOrderId: null,
                            side,
                            amount: matchAmount,
                            price: matchPrice,
                            totalCost: proceeds,
                            tradeType: 'sell'
                        });
                        trades.push(trade);
                        
                        await db.updateOrderFilled(buyOrder.id, matchAmount);
                        await db.upsertUserPosition(buyOrder.user_id, round.id, side, matchAmount, matchPrice, proceeds);
                        await deductLocked(buyOrder.user_id, proceeds);
                        
                        totalProceeds += proceeds;
                        soldAmount += matchAmount;
                    }
                    
                    // Если стакан пуст — продаём по текущей AMM цене (0.5 для обеих сторон при равных резервах)
                    if (soldAmount < sellAmount) {
                        const remainSell = sellAmount - soldAmount;
                        // Получаем текущую AMM цену
                        const poolResult = await sql`
                            SELECT higher_reserve, lower_reserve 
                            FROM pool_snapshots WHERE round_id = ${round.id}
                            ORDER BY created_at DESC LIMIT 1
                        `;
                        if (poolResult.rows.length > 0) {
                            const pool = poolResult.rows[0];
                            const hReserve = parseFloat(pool.higher_reserve);
                            const lReserve = parseFloat(pool.lower_reserve);
                            const totalReserve = hReserve + lReserve;
                            // Цена стороны = opposing_reserve / total
                            const sellAtPrice = side === 'higher' 
                                ? lReserve / totalReserve 
                                : hReserve / totalReserve;
                            const proceeds = remainSell * sellAtPrice;
                            
                            totalProceeds += proceeds;
                            soldAmount += remainSell;
                        }
                    }
                }
                
                if (soldAmount <= 0) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Нет покупателей в стакане. Попробуйте лимитный ордер на продажу.' 
                    });
                }
                
                // Уменьшаем позицию
                const newAmount = posAmount - soldAmount;
                const costReduction = (soldAmount / posAmount) * parseFloat(position.total_cost);
                
                if (newAmount <= 0.001) {
                    // Полная продажа — удаляем позицию
                    await sql`DELETE FROM user_positions WHERE user_id = ${user.id} AND round_id = ${round.id} AND side = ${side}`;
                } else {
                    await sql`
                        UPDATE user_positions 
                        SET amount = ${newAmount}, 
                            total_cost = total_cost - ${costReduction}
                        WHERE user_id = ${user.id} AND round_id = ${round.id} AND side = ${side}
                    `;
                }
                
                // Зачисляем выручку на баланс
                await creditBalance(user.id, totalProceeds, `Продажа ${soldAmount} ${side} токенов`);
                
                const avgSellPrice = totalProceeds / soldAmount;
                const profit = totalProceeds - costReduction;
                
                const orderBook = await db.getAggregatedOrderBook(round.id);
                
                return res.status(200).json({
                    success: true,
                    sell: {
                        side,
                        amount: soldAmount,
                        requested: amt,
                        avgPrice: avgSellPrice,
                        proceeds: totalProceeds,
                        profit: profit,
                        remaining: Math.max(0, newAmount),
                        partialFill: soldAmount < amt
                    },
                    orderBook
                });
            }
            
            // ============================================
            // BUY — покупка (existing logic below)
            // ============================================
            await db.logAction(
                user.id,
                'place_order',
                { side, amount: amt, type, price },
                clientIP,
                req.headers['user-agent']
            );
            
            // ============================================
            // ПРОВЕРКА И БЛОКИРОВКА БАЛАНСА
            // ============================================
            let estimatedCost;
            if (type === 'market') {
                // Для маркета блокируем максимум = amount * 1.0
                estimatedCost = amt;
            } else {
                // Для лимитного = amount * price
                estimatedCost = amt * parseFloat(price);
            }
            
            try {
                await lockBalance(user.id, estimatedCost);
            } catch (balanceError) {
                return res.status(400).json({
                    success: false,
                    error: balanceError.message
                });
            }
            
            // MARKET ORDER
            if (type === 'market') {
                const matchableOrders = await db.getMatchableOrders(round.id, side, null);
                
                let totalMatched = 0;
                const trades = [];
                
                for (const oppositeOrder of matchableOrders) {
                    const remainingToFill = amt - totalMatched;
                    const oppositeRemaining = parseFloat(oppositeOrder.amount) - parseFloat(oppositeOrder.filled);
                    
                    if (remainingToFill <= 0) break;
                    
                    const matchAmount = Math.min(remainingToFill, oppositeRemaining);
                    const matchPrice = parseFloat(oppositeOrder.price);
                    
                    const trade = await db.recordTrade({
                        roundId: round.id,
                        buyerId: user.id,
                        sellerId: oppositeOrder.user_id,
                        buyOrderId: null,
                        sellOrderId: oppositeOrder.id,
                        side,
                        amount: matchAmount,
                        price: matchPrice,
                        totalCost: matchAmount * matchPrice,
                        tradeType: 'market'
                    });
                    
                    trades.push(trade);
                    
                    await db.updateOrderFilled(oppositeOrder.id, matchAmount);
                    await db.upsertUserPosition(user.id, round.id, side, matchAmount, matchPrice, matchAmount * matchPrice);
                    await db.upsertUserPosition(oppositeOrder.user_id, round.id, oppositeOrder.side, matchAmount, matchPrice, matchAmount * matchPrice);
                    
                    // ✅ ФИКС: Списываем locked у владельца лимитки (seller)
                    const sellerCost = matchAmount * matchPrice;
                    await deductLocked(oppositeOrder.user_id, sellerCost);
                    
                    totalMatched += matchAmount;
                }
                
                if (totalMatched >= amt) {
                    const avgPrice = trades.reduce((sum, t) => sum + parseFloat(t.price) * parseFloat(t.amount), 0) / amt;
                    const totalCost = trades.reduce((sum, t) => sum + parseFloat(t.total_cost), 0);
                    
                    // ✅ Списываем реальную стоимость, возвращаем переплату
                    await deductLocked(user.id, totalCost);
                    const refund = estimatedCost - totalCost;
                    if (refund > 0) await unlockBalance(user.id, refund);
                    
                    const orderBook = await db.getAggregatedOrderBook(round.id);
                    
                    return res.status(200).json({
                        success: true,
                        trade: {
                            id: trades[0].id,
                            side,
                            amount: amt,
                            price: avgPrice,
                            cost: totalCost,
                            source: 'orderbook'
                        },
                        orderBook
                    });
                }
                
                // Стакан пустой — разблокируем всё
                if (totalMatched === 0) {
                    await unlockBalance(user.id, estimatedCost);
                    
                    return res.status(400).json({
                        success: false,
                        error: 'Стакан пустой - используйте лимитный ордер или подождите пока появятся ордера'
                    });
                }
                
                // Частичное исполнение — списываем исполненное, возвращаем остаток
                if (totalMatched < amt) {
                    const avgPrice = trades.reduce((sum, t) => sum + parseFloat(t.price) * parseFloat(t.amount), 0) / totalMatched;
                    const totalCost = trades.reduce((sum, t) => sum + parseFloat(t.total_cost), 0);
                    
                    await deductLocked(user.id, totalCost);
                    const refund = estimatedCost - totalCost;
                    if (refund > 0) await unlockBalance(user.id, refund);
                    
                    const orderBook = await db.getAggregatedOrderBook(round.id);
                    
                    return res.status(200).json({
                        success: true,
                        trade: {
                            id: trades[0].id,
                            side,
                            amount: totalMatched,
                            requested: amt,
                            price: avgPrice,
                            cost: totalCost,
                            source: 'orderbook',
                            partialFill: true,
                            message: `Частично исполнено: ${totalMatched} из ${amt} токенов. Остаток не был куплен из AMM.`
                        },
                        orderBook
                    });
                }
                
                // Full fill from orderbook
                const avgPrice = trades.reduce((sum, t) => sum + parseFloat(t.price) * parseFloat(t.amount), 0) / amt;
                const totalCost = trades.reduce((sum, t) => sum + parseFloat(t.total_cost), 0);
                
                await deductLocked(user.id, totalCost);
                const refund = estimatedCost - totalCost;
                if (refund > 0) await unlockBalance(user.id, refund);
                
                const orderBook = await db.getAggregatedOrderBook(round.id);
                
                return res.status(200).json({
                    success: true,
                    trade: {
                        id: trades[0].id,
                        side,
                        amount: amt,
                        price: avgPrice,
                        cost: totalCost,
                        source: 'orderbook'
                    },
                    orderBook
                });
            }
            
            // LIMIT ORDER
            else {
                const prc = parseFloat(price);
                
                if (!prc || prc <= 0 || prc >= 1 || isNaN(prc)) {
                    // Разблокируем — невалидная цена
                    await unlockBalance(user.id, estimatedCost);
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
                    
                    // ✅ ФИКС: Списываем locked у владельца противоположной лимитки
                    const oppositeCost = matchAmount * parseFloat(oppositeOrder.price);
                    await deductLocked(oppositeOrder.user_id, oppositeCost);
                    
                    totalMatched += matchAmount;
                }
                
                // ✅ Для лимитного: исполненная часть списывается, остаток остаётся locked
                if (totalMatched > 0) {
                    const matchedCost = totalMatched * prc;
                    await deductLocked(user.id, matchedCost);
                }
                // Неисполненная часть остаётся в locked до отмены или исполнения
                
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
        // DELETE - Отменить ордер (С ВОЗВРАТОМ БАЛАНСА)
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
            
            // Получаем ордер ДО отмены чтобы знать сумму для разблокировки
            const orderBefore = await sql`
                SELECT * FROM limit_orders 
                WHERE id = ${parseInt(orderId)} AND user_id = ${user.id} AND status = 'active'
            `;
            
            const canceledOrder = await db.cancelOrder(parseFloat(orderId), user.id);
            
            if (!canceledOrder) {
                return res.status(404).json({
                    success: false,
                    error: 'Order not found or already filled/cancelled'
                });
            }
            
            // ✅ Возвращаем заблокированные средства за неисполненную часть
            const unfilledAmount = parseFloat(canceledOrder.amount) - parseFloat(canceledOrder.filled);
            const unfilledCost = unfilledAmount * parseFloat(canceledOrder.price);
            if (unfilledCost > 0) {
                await unlockBalance(user.id, unfilledCost);
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
                    filled: parseFloat(canceledOrder.filled),
                    refunded: unfilledCost
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
