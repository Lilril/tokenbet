// ============================================
// BACKUP API: GET /api/backup-balances?secret=YOUR_AUTH_SECRET
// Returns JSON snapshot of all balances for refund purposes
// ============================================

import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'GET only' });
    }
    
    // Protect with AUTH_SECRET
    const secret = req.query.secret;
    const expected = process.env.AUTH_SECRET || 'dev-secret-change-in-production';
    if (!secret || secret !== expected) {
        return res.status(403).json({ error: 'Invalid secret' });
    }
    
    try {
        const balances = await sql`
            SELECT ub.user_id, u.wallet_address, ub.available, ub.locked,
                   (ub.available + ub.locked) as total
            FROM user_balances ub
            JOIN users u ON u.id = ub.user_id
            ORDER BY (ub.available + ub.locked) DESC
        `;
        
        const positions = await sql`
            SELECT up.user_id, u.wallet_address, up.round_id, up.side,
                   up.amount, up.total_cost, up.avg_price
            FROM user_positions up
            JOIN users u ON u.id = up.user_id
            WHERE up.amount > 0
        `;
        
        const unclaimed = await sql`
            SELECT us.user_id, u.wallet_address, us.round_id, us.side,
                   us.payout, us.won
            FROM user_settlements us
            JOIN users u ON u.id = us.user_id
            WHERE us.claimed = false AND us.payout > 0
        `;
        
        // Calculate refund per wallet
        const wallets = {};
        for (const r of balances.rows) {
            const w = r.wallet_address;
            if (!wallets[w]) wallets[w] = { wallet: w, balance: 0, unclaimed: 0, total: 0 };
            wallets[w].balance = parseFloat(r.total);
        }
        for (const r of unclaimed.rows) {
            const w = r.wallet_address;
            if (!wallets[w]) wallets[w] = { wallet: w, balance: 0, unclaimed: 0, total: 0 };
            wallets[w].unclaimed += parseFloat(r.payout);
        }
        for (const w of Object.values(wallets)) {
            w.total = w.balance + w.unclaimed;
        }
        
        const backup = {
            timestamp: new Date().toISOString(),
            summary: {
                totalUsers: balances.rows.length,
                totalBalance: balances.rows.reduce((s, r) => s + parseFloat(r.total), 0),
                totalUnclaimed: unclaimed.rows.reduce((s, r) => s + parseFloat(r.payout), 0),
            },
            refundPerWallet: Object.values(wallets).filter(w => w.total > 0).sort((a, b) => b.total - a.total),
            rawBalances: balances.rows,
            rawPositions: positions.rows,
            rawUnclaimed: unclaimed.rows
        };
        
        return res.status(200).json(backup);
        
    } catch (error) {
        console.error('Backup error:', error);
        return res.status(500).json({ error: error.message });
    }
}
