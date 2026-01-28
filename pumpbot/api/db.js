// ============================================
// DATABASE CONNECTION & HELPERS
// Для Vercel Postgres
// ============================================

import { sql } from '@vercel/postgres';

// ============================================
// USER MANAGEMENT
// ============================================

export async function getOrCreateUser(walletAddress) {
    try {
        const result = await sql`
            SELECT id, wallet_address, total_volume, total_trades
            FROM users
            WHERE wallet_address = ${walletAddress}
        `;
        
        if (result.rows.length > 0) {
            await sql`
                UPDATE users
                SET last_seen = NOW()
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

// ============================================
// ROUND MANAGEMENT
// ============================================

export async function getActiveRound() {
    try {
        const result = await sql`
            SELECT 
                id,
                round_number,
                interval_minutes,
                start_time,
                end_time,
                target_market_cap,
                status
            FROM rounds
            WHERE status = 'active'
            AND NOW() BETWEEN start_time AND end_time
            ORDER BY start_time DESC
            LIMIT 1
        `;
        
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ getActiveRound error:', error);
        throw error;
    }
}

export async function getLatestPoolSnapshot(roundId) {
    try {
        const result = await sql`
            SELECT 
                higher_reserve,
                lower_reserve,
                k_constant,
                snapshot_at
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

export async function savePoolSnapshot(roundId, higherReserve, lowerReserve, kConstant) {
    try {
        await sql`
            INSERT INTO pool_snapshots (
                round_id,
                higher_reserve,
                lower_reserve,
                k_constant
            ) VALUES (
                ${roundId},
                ${higherReserve},
                ${lowerReserve},
                ${kConstant}
            )
        `;
    } catch (error) {
        console.error('❌ savePoolSnapshot error:', error);
        throw error;
    }
}

// ============================================
// ORDER BOOK
// ============================================

export async function getAggregatedOrderBook(roundId) {
    try {
        const result = await sql`
            SELECT 
                side,
                price,
                SUM(amount - filled) as total_amount,
                COUNT(*) as order_count
            FROM limit_orders
            WHERE round_id = ${roundId}
            AND status = 'active'
            AND amount > filled
            GROUP BY side, price
            ORDER BY 
                CASE WHEN side = 'higher' THEN price END DESC,
                CASE WHEN side = 'lower' THEN price END ASC
            LIMIT 50
        `;
        
        const orderBook = {
            higher: [],
            lower: []
        };
        
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

export async function placeLimitOrder(userId, roundId, side, amount, price) {
    try {
        const result = await sql`
            INSERT INTO limit_orders (
                user_id,
                round_id,
                side,
                amount,
                price,
                status
            ) VALUES (
                ${userId},
                ${roundId},
                ${side},
                ${amount},
                ${price},
                'active'
            )
            RETURNING *
        `;
        
        return result.rows[0];
    } catch (error) {
        console.error('❌ placeLimitOrder error:', error);
        throw error;
    }
}

// ============================================
// TRADES
// ============================================

export async function recordTrade(tradeData) {
    try {
        const {
            roundId,
            buyerId,
            sellerId,
            buyOrderId,
            sellOrderId,
            side,
            amount,
            price,
            totalCost,
            tradeType
        } = tradeData;
        
        const result = await sql`
            INSERT INTO trades (
                round_id,
                buyer_id,
                seller_id,
                buy_order_id,
                sell_order_id,
                side,
                amount,
                price,
                total_cost,
                trade_type
            ) VALUES (
                ${roundId},
                ${buyerId},
                ${sellerId || null},
                ${buyOrderId || null},
                ${sellOrderId || null},
                ${side},
                ${amount},
                ${price},
                ${totalCost},
                ${tradeType}
            )
            RETURNING *
        `;
        
        return result.rows[0];
    } catch (error) {
        console.error('❌ recordTrade error:', error);
        throw error;
    }
}

export async function getRecentTrades(roundId, limit = 20) {
    try {
        const result = await sql`
            SELECT 
                t.*,
                u.wallet_address as buyer_wallet
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

// ============================================
// USER POSITIONS
// ============================================

export async function upsertUserPosition(userId, roundId, side, amount, avgPrice, totalCost) {
    try {
        const result = await sql`
            INSERT INTO user_positions (
                user_id,
                round_id,
                side,
                amount,
                avg_price,
                total_cost
            ) VALUES (
                ${userId},
                ${roundId},
                ${side},
                ${amount},
                ${avgPrice},
                ${totalCost}
            )
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

export async function getUserPositions(userId, roundId) {
    try {
        const result = await sql`
            SELECT *
            FROM user_positions
            WHERE user_id = ${userId}
            AND round_id = ${roundId}
        `;
        
        return result.rows;
    } catch (error) {
        console.error('❌ getUserPositions error:', error);
        throw error;
    }
}

// ============================================
// ORDER MATCHING
// ============================================

export async function getMatchableOrders(roundId, side, price) {
    try {
        // Найти противоположные ордера которые можно сматчить
        const oppositeSide = side === 'higher' ? 'lower' : 'higher';
        
        // Для higher ищем lower где (higher_price + lower_price >= 1)
        // Для lower ищем higher где (higher_price + lower_price >= 1)
        const result = await sql`
            SELECT 
                id,
                user_id,
                side,
                amount,
                filled,
                price
            FROM limit_orders
            WHERE round_id = ${roundId}
            AND side = ${oppositeSide}
            AND status = 'active'
            AND amount > filled
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

export async function updateOrderFilled(orderId, additionalFilled) {
    try {
        const result = await sql`
            UPDATE limit_orders
            SET 
                filled = filled + ${additionalFilled},
                status = CASE 
                    WHEN filled + ${additionalFilled} >= amount THEN 'filled'
                    ELSE 'active'
                END,
                filled_at = CASE 
                    WHEN filled + ${additionalFilled} >= amount THEN NOW()
                    ELSE filled_at
                END
            WHERE id = ${orderId}
            RETURNING *
        `;
        
        return result.rows[0];
    } catch (error) {
        console.error('❌ updateOrderFilled error:', error);
        throw error;
    }
}

export async function cancelOrder(orderId, userId) {
    try {
        const result = await sql`
            UPDATE limit_orders
            SET 
                status = 'cancelled',
                cancelled_at = NOW()
            WHERE id = ${orderId}
            AND user_id = ${userId}
            AND status = 'active'
            RETURNING *
        `;
        
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ cancelOrder error:', error);
        throw error;
    }
}

// ============================================
// RATE LIMITING
// ============================================

export async function checkRateLimit(identifier, endpoint, maxRequests = 100, windowMinutes = 1) {
    try {
        const windowStart = new Date();
        windowStart.setMinutes(windowStart.getMinutes() - windowMinutes);
        
        const result = await sql`
            SELECT COALESCE(SUM(request_count), 0) as total
            FROM rate_limits
            WHERE identifier = ${identifier}
            AND endpoint = ${endpoint}
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
        
        return {
            allowed: true,
            remaining: maxRequests - currentCount - 1
        };
    } catch (error) {
        console.error('❌ checkRateLimit error:', error);
        return { allowed: true, remaining: 999 };
    }
}

// ============================================
// AUDIT LOG
// ============================================

export async function logAction(userId, action, details, ipAddress, userAgent) {
    try {
        await sql`
            INSERT INTO audit_log (
                user_id,
                action,
                details,
                ip_address,
                user_agent
            ) VALUES (
                ${userId || null},
                ${action},
                ${JSON.stringify(details)},
                ${ipAddress || null},
                ${userAgent || null}
            )
        `;
    } catch (error) {
        console.error('❌ logAction error:', error);
    }
}

export default {
    getOrCreateUser,
    getActiveRound,
    getLatestPoolSnapshot,
    savePoolSnapshot,
    getAggregatedOrderBook,
    placeLimitOrder,
    recordTrade,
    getRecentTrades,
    upsertUserPosition,
    getUserPositions,
    getMatchableOrders,
    updateOrderFilled,
    cancelOrder,
    checkRateLimit,
    logAction,
    sql
};
