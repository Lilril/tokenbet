// ============================================
// CRON JOB - Автоматический расчет завершенных раундов
// ============================================
// Vercel Cron: создай файл vercel.json в корне проекта:
// {
//   "crons": [{
//     "path": "/api/cron/settle-rounds",
//     "schedule": "*/5 * * * *"
//   }]
// }

import { sql } from '@vercel/postgres';

async function settleRound(roundId) {
    try {
        // 1. Получаем раунд
        const roundResult = await sql`
            SELECT * FROM rounds WHERE id = ${roundId} AND status = 'closed'
        `;
        
        if (roundResult.rows.length === 0) {
            return { success: false, error: 'Round not found or not closed' };
        }
        
        const round = roundResult.rows[0];
        
        // 2. Получаем финальную рыночную капитализацию
        // TODO: Здесь нужно получить реальную капитализацию из внешнего API
        // Например, из Jupiter, CoinGecko, или вашего источника данных
        const finalMarketCap = await fetchFinalMarketCap(round);
        
        if (!finalMarketCap) {
            console.error(`❌ Could not fetch final market cap for round ${roundId}`);
            return { success: false, error: 'Market cap data unavailable' };
        }
        
        // Сохраняем финальную капитализацию
        await sql`
            UPDATE rounds 
            SET final_market_cap = ${finalMarketCap}
            WHERE id = ${roundId}
        `;
        
        const initialMarketCap = parseFloat(round.start_market_cap || finalMarketCap);
        const winningSide = finalMarketCap > initialMarketCap ? 'higher' : 'lower';
        
        console.log(`🎯 Settling Round ${roundId}: ${initialMarketCap} → ${finalMarketCap} (Winner: ${winningSide})`);
        
        // 3. Получаем все позиции
        const positions = await sql`
            SELECT user_id, side, amount, avg_price, total_cost
            FROM user_positions
            WHERE round_id = ${roundId}
        `;
        
        if (positions.rows.length === 0) {
            console.log(`ℹ️ No positions for round ${roundId}`);
            await sql`UPDATE rounds SET settlement_status = 'settled', settled_at = NOW() WHERE id = ${roundId}`;
            return { success: true, message: 'No positions to settle' };
        }
        
        // 4. Подсчитываем пулы
        let totalWinningAmount = 0;
        let totalLosingCost = 0;
        
        for (const pos of positions.rows) {
            if (pos.side === winningSide) {
                totalWinningAmount += parseFloat(pos.amount);
            } else {
                totalLosingCost += parseFloat(pos.total_cost);
            }
        }
        
        console.log(`💰 Pools: Winners=${totalWinningAmount} tokens, Losers=${totalLosingCost} cost`);
        
        // 5. Создаем расчеты
        for (const pos of positions.rows) {
            const won = pos.side === winningSide;
            const amount = parseFloat(pos.amount);
            const totalCost = parseFloat(pos.total_cost);
            
            let payout = 0;
            let profitLoss = 0;
            
            if (won && totalWinningAmount > 0) {
                // Выигравшие получают возврат + долю проигравших
                const returnAmount = totalCost;
                const winShare = amount / totalWinningAmount;
                const winnings = totalLosingCost * winShare;
                
                payout = returnAmount + winnings;
                profitLoss = payout - totalCost;
            } else if (!won) {
                // Проигравшие теряют все
                payout = 0;
                profitLoss = -totalCost;
            }
            
            await sql`
                INSERT INTO user_settlements (
                    user_id, round_id, side, amount, avg_price, total_cost,
                    won, payout, profit_loss, claimed
                ) VALUES (
                    ${pos.user_id}, ${roundId}, ${pos.side}, ${amount}, 
                    ${pos.avg_price}, ${totalCost}, ${won}, ${payout}, ${profitLoss}, false
                )
                ON CONFLICT (user_id, round_id, side) 
                DO UPDATE SET won = ${won}, payout = ${payout}, profit_loss = ${profitLoss}
            `;
            
            console.log(`  User ${pos.user_id} (${pos.side}): ${won ? 'WON' : 'LOST'}, payout=${payout}`);
        }
        
        // 6. Обновляем статус
        await sql`
            UPDATE rounds 
            SET settlement_status = 'settled', settled_at = NOW()
            WHERE id = ${roundId}
        `;
        
        console.log(`✅ Round ${roundId} settled: ${positions.rows.length} settlements created`);
        
        return {
            success: true,
            roundId,
            winningSide,
            settlementsCreated: positions.rows.length
        };
        
    } catch (error) {
        console.error(`❌ Error settling round ${roundId}:`, error);
        return { success: false, error: error.message };
    }
}

async function fetchFinalMarketCap(round) {
    // TODO: Реализовать получение реальной капитализации
    // Варианты:
    // 1. Jupiter API: https://price.jup.ag/v4/price?ids=TOKEN_MINT
    // 2. CoinGecko API
    // 3. Ваш собственный источник данных
    
    try {
        const TOKEN_ADDRESS = '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';
        
        // Пример с Jupiter (нужно адаптировать под ваш токен)
        const response = await fetch(`https://price.jup.ag/v4/price?ids=${TOKEN_ADDRESS}`);
        const data = await response.json();
        
        if (data.data && data.data[TOKEN_ADDRESS]) {
            const price = data.data[TOKEN_ADDRESS].price;
            // Умножаем на total supply чтобы получить market cap
            // Здесь нужна ваша логика получения market cap
            return price * 1000000; // Примерная капитализация
        }
        
        // Fallback: используем start_market_cap если не удалось получить данные
        return parseFloat(round.start_market_cap || 0);
        
    } catch (error) {
        console.error('❌ Error fetching market cap:', error);
        return null;
    }
}

// ============================================
// CRON HANDLER
// ============================================
export default async function handler(req, res) {
    // Защита: только Vercel Cron может вызывать этот endpoint
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        console.log('🕐 CRON: Starting round settlement check...');
        
        // Находим все закрытые раунды которые еще не рассчитаны
        const roundsToSettle = await sql`
            SELECT id, slug, end_time, settlement_status
            FROM rounds
            WHERE status = 'closed' 
            AND (settlement_status IS NULL OR settlement_status = 'pending')
            AND end_time < NOW()
            ORDER BY end_time ASC
            LIMIT 10
        `;
        
        if (roundsToSettle.rows.length === 0) {
            console.log('ℹ️ No rounds to settle');
            return res.status(200).json({
                success: true,
                message: 'No rounds to settle',
                settled: 0
            });
        }
        
        console.log(`📊 Found ${roundsToSettle.rows.length} rounds to settle`);
        
        const results = [];
        
        for (const round of roundsToSettle.rows) {
            console.log(`⚙️ Settling round ${round.id} (${round.slug})...`);
            const result = await settleRound(round.id);
            results.push({
                roundId: round.id,
                slug: round.slug,
                ...result
            });
        }
        
        const successCount = results.filter(r => r.success).length;
        
        console.log(`✅ CRON: Settled ${successCount}/${roundsToSettle.rows.length} rounds`);
        
        return res.status(200).json({
            success: true,
            settled: successCount,
            total: roundsToSettle.rows.length,
            results
        });
        
    } catch (error) {
        console.error('❌ CRON error:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
}
