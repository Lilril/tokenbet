import { sql } from '@vercel/postgres';

async function settleRound(roundId) {
    try {
        // 1. Get round
        const roundResult = await sql`
            SELECT * FROM rounds WHERE id = ${roundId} AND status = 'closed'
        `;
        
        if (roundResult.rows.length === 0) {
            return { success: false, error: 'Round not found or not closed' };
        }
        
        const round = roundResult.rows[0];
        const initialMarketCap = parseFloat(round.start_market_cap) || 0;
        
        // ============================================
        // CASE 1: start_market_cap = 0 -> refund (no finalMC needed!)
        // ============================================
        if (initialMarketCap <= 0) {
            console.log(`⚠️ Round ${roundId}: start_market_cap is 0, refunding all positions`);
            
            const positions = await sql`
                SELECT user_id, side, amount, avg_price, total_cost
                FROM user_positions
                WHERE round_id = ${roundId}
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
            
            return { success: true, roundId, winningSide: 'tie (refund)', settlementsCreated: positions.rows.length };
        }
        
        // ============================================
        // 2. Get finalMC (only needed if startMC > 0)
        // ============================================
        let finalMarketCap = parseFloat(round.final_market_cap);
        
        if (!finalMarketCap || finalMarketCap <= 0) {
            console.log(`📡 Fetching market cap from external API for round ${roundId}...`);
            finalMarketCap = await fetchFinalMarketCap(round);
            
            if (!finalMarketCap) {
                console.error(`❌ Could not fetch final market cap for round ${roundId}`);
                return { success: false, error: 'Market cap data unavailable' };
            }
            
            await sql`
                UPDATE rounds 
                SET final_market_cap = ${finalMarketCap}
                WHERE id = ${roundId}
            `;
        } else {
            console.log(`✅ Using existing final_market_cap from DB: ${finalMarketCap}`);
        }
        
        // ============================================
        // CASE 2: Tie - price unchanged -> refund
        // ============================================
        if (finalMarketCap === initialMarketCap) {
            console.log(`⚠️ Round ${roundId}: price unchanged (${initialMarketCap} === ${finalMarketCap}), refunding all`);
            
            const positions = await sql`
                SELECT user_id, side, amount, avg_price, total_cost
                FROM user_positions
                WHERE round_id = ${roundId}
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
            
            return { success: true, roundId, winningSide: 'tie (refund)', settlementsCreated: positions.rows.length };
        }
        
        const winningSide = finalMarketCap > initialMarketCap ? 'higher' : 'lower';
        
        console.log(`🎯 Settling Round ${roundId}: ${initialMarketCap} → ${finalMarketCap} (Winner: ${winningSide})`);
        
        // 3. Get all positions
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
        
        // 4. Calculate pools
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
        
        // 5. Create settlements
        for (const pos of positions.rows) {
            const won = pos.side === winningSide;
            const amount = parseFloat(pos.amount);
            const totalCost = parseFloat(pos.total_cost);
            
            let payout = 0;
            let profitLoss = 0;
            
            if (won && totalWinningAmount > 0) {
                // Winners get refund + share of losers
                const returnAmount = totalCost;
                const winShare = amount / totalWinningAmount;
                const winnings = totalLosingCost * winShare;
                
                payout = returnAmount + winnings;
                profitLoss = payout - totalCost;
            } else if (!won) {
                // Losers lose everything
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
        
        // 6. Update status
        await sql`
            UPDATE rounds 
            SET settlement_status = 'settled', settled_at = NOW(), winning_side = ${winningSide}
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
    const TOKEN_ADDRESS = process.env.TOKEN_MINT || 'F1CjqLUTM3B4b7LreJKMZmLV3p5mDnfs1vpQSFJL4E8e';
    const TOTAL_SUPPLY = 1000000000;
    
    // Method 1: DexScreener
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(
            `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_ADDRESS}`,
            { 
                signal: controller.signal,
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
            }
        );
        clearTimeout(timeout);
        
        if (response.ok) {
            const data = await response.json();
            if (data.pairs && data.pairs.length > 0) {
                const bestPair = data.pairs.sort((a, b) => 
                    (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
                )[0];
                const price = parseFloat(bestPair.priceUsd);
                if (price > 0 && !isNaN(price)) {
                    const marketCap = price * TOTAL_SUPPLY;
                    console.log(`✅ Final market cap from DexScreener: $${marketCap.toFixed(2)}`);
                    return marketCap;
                }
            }
        }
    } catch (error) {
        console.error('❌ DexScreener error:', error.message);
    }
    
    // Method 2: Jupiter
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(
            `https://api.jup.ag/price/v2?ids=${TOKEN_ADDRESS}`,
            { signal: controller.signal, headers: { 'Accept': 'application/json' } }
        );
        clearTimeout(timeout);
        
        if (response.ok) {
            const data = await response.json();
            if (data.data?.[TOKEN_ADDRESS]?.price) {
                const price = parseFloat(data.data[TOKEN_ADDRESS].price);
                if (price > 0 && !isNaN(price)) {
                    const marketCap = price * TOTAL_SUPPLY;
                    console.log(`✅ Final market cap from Jupiter: $${marketCap.toFixed(2)}`);
                    return marketCap;
                }
            }
        }
    } catch (error) {
        console.error('❌ Jupiter error:', error.message);
    }
    
    console.error('❌ All price sources failed for final market cap');
    return null;
}

// ============================================
// CRON HANDLER
// ============================================
export default async function handler(req, res) {
    // Protection: only Vercel Cron can call this endpoint
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        console.log('🕐 CRON: Starting round settlement check...');
        
        // ============================================
        // STEP 1: Close all expired active rounds
        // ============================================
        const closedResult = await sql`
            UPDATE rounds 
            SET status = 'closed'
            WHERE status = 'active' 
            AND end_time < NOW()
            RETURNING id, slug
        `;
        
        if (closedResult.rows.length > 0) {
            console.log(`🔒 Closed ${closedResult.rows.length} expired rounds: ${closedResult.rows.map(r => r.slug).join(', ')}`);
        }
        
        // ============================================
        // STEP 2: Settle closed rounds with positions
        // ============================================
        // Find all closed rounds that haven't been settled yet
        // Priority: rounds with positions first, then empty ones
        const roundsToSettle = await sql`
            SELECT r.id, r.slug, r.end_time, r.settlement_status,
                   (SELECT COUNT(*) FROM user_positions WHERE round_id = r.id) as position_count
            FROM rounds r
            WHERE r.status = 'closed' 
            AND (r.settlement_status IS NULL OR r.settlement_status = 'pending')
            AND r.end_time < NOW()
            ORDER BY 
                CASE WHEN (SELECT COUNT(*) FROM user_positions WHERE round_id = r.id) > 0 THEN 0 ELSE 1 END,
                r.end_time ASC
            LIMIT 20
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
