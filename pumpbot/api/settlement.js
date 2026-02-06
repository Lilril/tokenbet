// ============================================
// SETTLEMENT API - для расчетов завершенных раундов
// ============================================

import { sql } from '@vercel/postgres';

// ============================================
// HELPER FUNCTIONS
// ============================================

async function getOrCreateUser(walletAddress) {
    try {
        const result = await sql`
            SELECT id, wallet_address FROM users WHERE wallet_address = ${walletAddress}
        `;
        
        if (result.rows.length > 0) {
            return result.rows[0];
        }
        
        const newUser = await sql`
            INSERT INTO users (wallet_address) VALUES (${walletAddress}) RETURNING id, wallet_address
        `;
        
        return newUser.rows[0];
    } catch (error) {
        console.error('❌ getOrCreateUser error:', error);
        throw error;
    }
}

async function settleRound(roundId) {
    try {
        // 1. Получаем раунд
        const roundResult = await sql`
            SELECT * FROM rounds WHERE id = ${roundId} AND status = 'closed'
        `;
        
        if (roundResult.rows.length === 0) {
            throw new Error('Round not found or not closed');
        }
        
        const round = roundResult.rows[0];
        
        // 2. Определяем финальную капитализацию (это должно приходить из внешнего источника)
        // Для примера берем target_market_cap или можно добавить поле final_market_cap
        const finalMarketCap = parseFloat(round.final_market_cap || round.target_market_cap);
        const initialMarketCap = parseFloat(round.start_market_cap || 0);
        
        // 3. Определяем кто выиграл
        // Ничья — капитализация не изменилась → рефанд
        if (finalMarketCap === initialMarketCap || initialMarketCap <= 0) {
            console.log(`🎯 Round ${roundId}: TIE or no start cap, refunding all`);
            
            const positions = await sql`
                SELECT user_id, side, amount, avg_price, total_cost
                FROM user_positions WHERE round_id = ${roundId}
            `;
            
            for (const pos of positions.rows) {
                const totalCost = parseFloat(pos.total_cost);
                await sql`
                    INSERT INTO user_settlements (
                        user_id, round_id, side, amount, avg_price, total_cost,
                        won, payout, profit_loss, claimed
                    ) VALUES (
                        ${pos.user_id}, ${roundId}, ${pos.side}, ${parseFloat(pos.amount)}, 
                        ${pos.avg_price}, ${totalCost}, true, ${totalCost}, 0, false
                    )
                    ON CONFLICT (user_id, round_id, side)
                    DO UPDATE SET won = true, payout = ${totalCost}, profit_loss = 0
                `;
            }
            
            await sql`
                UPDATE rounds 
                SET settlement_status = 'settled', settled_at = NOW(), winning_side = 'tie'
                WHERE id = ${roundId}
            `;
            
            return {
                success: true, roundId, winningSide: 'tie',
                settlementsCreated: positions.rows.length
            };
        }
        
        const winningSide = finalMarketCap > initialMarketCap ? 'higher' : 'lower';
        
        console.log(`🎯 Round ${roundId}: Initial=${initialMarketCap}, Final=${finalMarketCap}, Winner=${winningSide}`);
        
        // 4. Получаем все позиции пользователей
        const positions = await sql`
            SELECT 
                user_id,
                side,
                amount,
                avg_price,
                total_cost
            FROM user_positions
            WHERE round_id = ${roundId}
        `;
        
        // 5. Рассчитываем выплаты
        let totalWinningAmount = 0;
        let totalLosingCost = 0;
        
        // Подсчитываем общие суммы
        for (const pos of positions.rows) {
            if (pos.side === winningSide) {
                totalWinningAmount += parseFloat(pos.amount);
            } else {
                totalLosingCost += parseFloat(pos.total_cost);
            }
        }
        
        // 6. Создаем расчеты для каждого пользователя
        for (const pos of positions.rows) {
            const won = pos.side === winningSide;
            const amount = parseFloat(pos.amount);
            const totalCost = parseFloat(pos.total_cost);
            
            let payout = 0;
            let profitLoss = 0;
            
            if (won) {
                // Выигравшие получают свои токены обратно + пропорциональную долю из пула проигравших
                const returnAmount = totalCost; // Возврат вложенных средств
                const winShare = totalWinningAmount > 0 ? (amount / totalWinningAmount) : 0;
                const winnings = totalLosingCost * winShare;
                
                payout = returnAmount + winnings;
                profitLoss = payout - totalCost;
            } else {
                // Проигравшие теряют все
                payout = 0;
                profitLoss = -totalCost;
            }
            
            // Сохраняем расчет
            await sql`
                INSERT INTO user_settlements (
                    user_id, round_id, side, amount, avg_price, total_cost,
                    won, payout, profit_loss, claimed
                ) VALUES (
                    ${pos.user_id}, ${roundId}, ${pos.side}, ${amount}, 
                    ${pos.avg_price}, ${totalCost}, ${won}, ${payout}, ${profitLoss}, false
                )
                ON CONFLICT (user_id, round_id, side) 
                DO UPDATE SET
                    won = ${won},
                    payout = ${payout},
                    profit_loss = ${profitLoss}
            `;
        }
        
        // 7. Обновляем статус раунда
        await sql`
            UPDATE rounds 
            SET settlement_status = 'settled', settled_at = NOW()
            WHERE id = ${roundId}
        `;
        
        console.log(`✅ Round ${roundId} settled successfully`);
        
        return {
            success: true,
            roundId,
            winningSide,
            totalWinningAmount,
            totalLosingCost,
            settlementsCreated: positions.rows.length
        };
        
    } catch (error) {
        console.error('❌ settleRound error:', error);
        throw error;
    }
}

async function getUserSettlements(userId, includeUnclaimed = false) {
    try {
        const result = includeUnclaimed 
            ? await sql`
                SELECT 
                    s.*,
                    r.slug as round_slug,
                    r.interval_minutes,
                    r.start_time,
                    r.end_time,
                    r.final_market_cap,
                    r.start_market_cap
                FROM user_settlements s
                JOIN rounds r ON s.round_id = r.id
                WHERE s.user_id = ${userId} AND s.claimed = false AND s.payout > 0
                ORDER BY r.end_time DESC
            `
            : await sql`
                SELECT 
                    s.*,
                    r.slug as round_slug,
                    r.interval_minutes,
                    r.start_time,
                    r.end_time,
                    r.final_market_cap,
                    r.start_market_cap
                FROM user_settlements s
                JOIN rounds r ON s.round_id = r.id
                WHERE s.user_id = ${userId}
                ORDER BY r.end_time DESC
                LIMIT 50
            `;
        
        return result.rows;
    } catch (error) {
        console.error('❌ getUserSettlements error:', error);
        throw error;
    }
}

async function claimSettlement(userId, roundId, txHash = null) {
    try {
        // Проверяем что settlement существует и не забран
        const settlement = await sql`
            SELECT * FROM user_settlements
            WHERE user_id = ${userId} AND round_id = ${roundId} AND claimed = false
        `;
        
        if (settlement.rows.length === 0) {
            throw new Error('Settlement not found or already claimed');
        }
        
        const s = settlement.rows[0];
        const payout = parseFloat(s.payout);
        
        if (payout <= 0) {
            throw new Error('No payout available to claim');
        }
        
        // ✅ Атомарно помечаем claimed=true и зачисляем баланс
        // Сначала помечаем claimed чтобы избежать двойного зачисления
        const claimResult = await sql`
            UPDATE user_settlements
            SET claimed = true, claimed_at = NOW(), claim_tx_hash = ${txHash}
            WHERE user_id = ${userId} AND round_id = ${roundId} AND claimed = false
            RETURNING id
        `;
        
        // Если ничего не обновилось — значит уже забрано (race condition protection)
        if (claimResult.rows.length === 0) {
            throw new Error('Settlement already claimed (concurrent request)');
        }
        
        // Зачисляем на баланс
        await sql`
            UPDATE user_balances 
            SET available = available + ${payout}, updated_at = NOW()
            WHERE user_id = ${userId}
        `;
        
        // Логируем транзакцию
        const balResult = await sql`SELECT available FROM user_balances WHERE user_id = ${userId}`;
        const balAfter = balResult.rows.length > 0 ? parseFloat(balResult.rows[0].available) : payout;
        
        await sql`
            INSERT INTO balance_transactions (user_id, type, amount, balance_before, balance_after, description)
            VALUES (${userId}, 'trade_credit', ${payout}, ${balAfter - payout}, ${balAfter}, ${'Claim round #' + roundId + ', payout ' + payout.toFixed(2)})
        `;
        
        console.log(`✅ Credited ${payout} to user ${userId} for round ${roundId}`);
        
        // Логируем действие
        await sql`
            INSERT INTO audit_log (user_id, action, details)
            VALUES (${userId}, 'claim_settlement', ${JSON.stringify({
                roundId,
                payout: payout,
                txHash
            })})
        `;
        
        return {
            success: true,
            payout: payout,
            profitLoss: parseFloat(s.profit_loss),
            txHash
        };
        
    } catch (error) {
        console.error('❌ claimSettlement error:', error);
        throw error;
    }
}

// ============================================
// QUICK INLINE SETTLEMENT (для конкретного юзера)
// Settle ТОЛЬКО то что можно settle МГНОВЕННО (без внешних API)
// ============================================
async function quickSettleForUser(userId) {
    try {
        // 1. Закрыть истекшие раунды (быстрый SQL)
        await sql`UPDATE rounds SET status = 'closed' WHERE status = 'active' AND end_time < NOW()`;
        
        // 2. Найти unsettled раунды именно этого юзера
        const unsettled = await sql`
            SELECT DISTINCT r.id, r.start_market_cap, r.final_market_cap
            FROM rounds r
            INNER JOIN user_positions up ON up.round_id = r.id AND up.user_id = ${userId}
            WHERE r.status = 'closed'
            AND (r.settlement_status IS NULL OR r.settlement_status = 'pending')
            AND r.end_time < NOW()
            ORDER BY r.id ASC
            LIMIT 5
        `;
        
        if (unsettled.rows.length === 0) return;
        
        console.log(`⚡ Quick settle: ${unsettled.rows.length} rounds for user ${userId}`);
        
        for (const round of unsettled.rows) {
            const startMC = parseFloat(round.start_market_cap) || 0;
            const finalMC = parseFloat(round.final_market_cap) || 0;
            
            // CASE 1: startMC = 0 → мгновенный refund (НЕ нужен finalMC)
            if (startMC <= 0) {
                const positions = await sql`
                    SELECT user_id, side, amount, avg_price, total_cost 
                    FROM user_positions WHERE round_id = ${round.id}
                `;
                for (const pos of positions.rows) {
                    const tc = parseFloat(pos.total_cost);
                    await sql`INSERT INTO user_settlements (user_id,round_id,side,amount,avg_price,total_cost,won,payout,profit_loss,claimed)
                        VALUES (${pos.user_id},${round.id},${pos.side},${parseFloat(pos.amount)},${pos.avg_price},${tc},true,${tc},0,false)
                        ON CONFLICT (user_id,round_id,side) DO UPDATE SET won=true,payout=${tc},profit_loss=0`;
                }
                await sql`UPDATE rounds SET settlement_status='settled',settled_at=NOW(),winning_side='tie' WHERE id=${round.id}`;
                console.log(`  ✅ Round ${round.id}: refund (startMC=0)`);
                continue;
            }
            
            // CASE 2: Есть finalMC → можем settle
            if (finalMC > 0) {
                // Ничья
                if (finalMC === startMC) {
                    const positions = await sql`SELECT user_id,side,amount,avg_price,total_cost FROM user_positions WHERE round_id=${round.id}`;
                    for (const pos of positions.rows) {
                        const tc = parseFloat(pos.total_cost);
                        await sql`INSERT INTO user_settlements (user_id,round_id,side,amount,avg_price,total_cost,won,payout,profit_loss,claimed)
                            VALUES (${pos.user_id},${round.id},${pos.side},${parseFloat(pos.amount)},${pos.avg_price},${tc},true,${tc},0,false)
                            ON CONFLICT (user_id,round_id,side) DO UPDATE SET won=true,payout=${tc},profit_loss=0`;
                    }
                    await sql`UPDATE rounds SET settlement_status='settled',settled_at=NOW(),winning_side='tie' WHERE id=${round.id}`;
                    console.log(`  ✅ Round ${round.id}: TIE`);
                    continue;
                }
                
                // Нормальный settlement
                const winningSide = finalMC > startMC ? 'higher' : 'lower';
                const positions = await sql`SELECT user_id,side,amount,avg_price,total_cost FROM user_positions WHERE round_id=${round.id}`;
                let totalWinAmt = 0, totalLoseCost = 0;
                for (const p of positions.rows) {
                    if (p.side === winningSide) totalWinAmt += parseFloat(p.amount);
                    else totalLoseCost += parseFloat(p.total_cost);
                }
                for (const pos of positions.rows) {
                    const won = pos.side === winningSide;
                    const amt = parseFloat(pos.amount), tc = parseFloat(pos.total_cost);
                    let payout = 0, pl = 0;
                    if (won && totalWinAmt > 0) { payout = tc + totalLoseCost * (amt / totalWinAmt); pl = payout - tc; }
                    else if (!won) { payout = 0; pl = -tc; }
                    await sql`INSERT INTO user_settlements (user_id,round_id,side,amount,avg_price,total_cost,won,payout,profit_loss,claimed)
                        VALUES (${pos.user_id},${round.id},${pos.side},${amt},${pos.avg_price},${tc},${won},${payout},${pl},false)
                        ON CONFLICT (user_id,round_id,side) DO UPDATE SET won=${won},payout=${payout},profit_loss=${pl}`;
                }
                await sql`UPDATE rounds SET settlement_status='settled',settled_at=NOW(),winning_side=${winningSide} WHERE id=${round.id}`;
                console.log(`  ✅ Round ${round.id}: ${winningSide}`);
                continue;
            }
            
            // CASE 3: Нет finalMC и startMC > 0 → пропускаем, orders.js inlineSettlement подхватит
            console.log(`  ⏳ Round ${round.id}: waiting for finalMC (startMC=${startMC})`);
        }
    } catch (e) {
        console.error('quickSettleForUser error:', e.message);
        // НЕ бросаем ошибку — пусть unclaimed вернётся хотя бы с тем что есть
    }
}

// ============================================
// API HANDLER
// ============================================
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    try {
        const { method, query, body } = req;
        
        // ============================================
        // GET - Получить settlements
        // ============================================
        if (method === 'GET') {
            const { action, wallet } = query;
            
            if (!wallet) {
                return res.status(400).json({
                    success: false,
                    error: 'Wallet address required'
                });
            }
            
            const user = await getOrCreateUser(wallet);
            
            // GET UNCLAIMED SETTLEMENTS
            if (action === 'unclaimed') {
                // ✅ Быстрый settlement check: settle раунды этого юзера ПЕРЕД ответом
                try { await quickSettleForUser(user.id); } catch(e) { console.error('quickSettle err:', e.message); }
                
                const settlements = await getUserSettlements(user.id, true);
                
                return res.status(200).json({
                    success: true,
                    settlements: settlements.map(s => ({
                        id: s.id,
                        roundId: s.round_id,
                        roundSlug: s.round_slug,
                        intervalMinutes: s.interval_minutes,
                        side: s.side,
                        amount: parseFloat(s.amount),
                        totalCost: parseFloat(s.total_cost),
                        won: s.won,
                        payout: parseFloat(s.payout),
                        profitLoss: parseFloat(s.profit_loss),
                        endTime: s.end_time,
                        startMarketCap: parseFloat(s.start_market_cap) || 0,
                        finalMarketCap: parseFloat(s.final_market_cap) || 0
                    }))
                });
            }
            
            // GET ALL SETTLEMENTS (history)
            if (action === 'history') {
                const settlements = await getUserSettlements(user.id, false);
                
                return res.status(200).json({
                    success: true,
                    settlements: settlements.map(s => ({
                        id: s.id,
                        roundId: s.round_id,
                        roundSlug: s.round_slug,
                        intervalMinutes: s.interval_minutes,
                        side: s.side,
                        amount: parseFloat(s.amount),
                        totalCost: parseFloat(s.total_cost),
                        won: s.won,
                        payout: parseFloat(s.payout),
                        profitLoss: parseFloat(s.profit_loss),
                        claimed: s.claimed,
                        claimedAt: s.claimed_at,
                        claimTxHash: s.claim_tx_hash,
                        endTime: s.end_time,
                        startMarketCap: parseFloat(s.start_market_cap) || 0,
                        finalMarketCap: parseFloat(s.final_market_cap) || 0
                    }))
                });
            }
            
            // GET BALANCE TRANSACTIONS (deposits, withdrawals, claims)
            if (action === 'transactions') {
                const txns = await sql`
                    SELECT id, type, amount, balance_before, balance_after, description, created_at
                    FROM balance_transactions
                    WHERE user_id = ${user.id}
                    ORDER BY created_at DESC
                    LIMIT 100
                `;
                
                return res.status(200).json({
                    success: true,
                    transactions: txns.rows.map(t => ({
                        id: t.id,
                        type: t.type,
                        amount: parseFloat(t.amount),
                        balanceBefore: parseFloat(t.balance_before),
                        balanceAfter: parseFloat(t.balance_after),
                        description: t.description,
                        createdAt: t.created_at
                    }))
                });
            }
            
            return res.status(400).json({
                success: false,
                error: 'Invalid action'
            });
        }
        
        // ============================================
        // POST - Claim settlement
        // ============================================
        if (method === 'POST') {
            const { wallet, roundId, txHash } = typeof body === 'string' ? JSON.parse(body) : body;
            
            if (!wallet || !roundId) {
                return res.status(400).json({
                    success: false,
                    error: 'Wallet and roundId required'
                });
            }
            
            const user = await getOrCreateUser(wallet);
            const result = await claimSettlement(user.id, roundId, txHash);
            
            return res.status(200).json(result);
        }
        
        return res.status(405).json({
            success: false,
            error: 'Method not allowed'
        });
        
    } catch (error) {
        console.error('❌ Settlement API error:', error);
        
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}
