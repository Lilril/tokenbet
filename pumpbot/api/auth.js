// ============================================
// AUTH: Solana wallet signature verification + HMAC session tokens
// Stateless — works across Vercel serverless functions
// ============================================

import { sql } from '@vercel/postgres';
import { createHmac } from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const TOKEN_SECRET = process.env.AUTH_SECRET || 'dev-secret-change-in-production';
const TOKEN_TTL_SEC = 86400; // 24 hours

// ============================================
// VERIFY SOLANA SIGNATURE
// ============================================
function verifySolanaSignature(walletAddress, signature, message) {
    try {
        const publicKeyBytes = bs58.decode(walletAddress);
        const signatureBytes = typeof signature === 'string' 
            ? bs58.decode(signature) 
            : new Uint8Array(signature);
        const messageBytes = new TextEncoder().encode(message);
        return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
    } catch (error) {
        console.error('Signature verification error:', error.message);
        return false;
    }
}

// ============================================
// CREATE SIGNED TOKEN (HMAC, stateless)
// ============================================
export function createToken(wallet) {
    const expiry = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
    const payload = `${wallet}:${expiry}`;
    const hmac = createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
    return { 
        token: Buffer.from(payload).toString('base64') + '.' + hmac, 
        expiresIn: TOKEN_TTL_SEC 
    };
}

// ============================================
// VERIFY TOKEN — import this in orders.js, settlement.js, etc.
// Returns { wallet, expiry } or null
// ============================================
export function verifyToken(authHeader) {
    try {
        if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
        const token = authHeader.slice(7);
        const dotIndex = token.lastIndexOf('.');
        if (dotIndex === -1) return null;
        
        const payloadB64 = token.slice(0, dotIndex);
        const receivedHmac = token.slice(dotIndex + 1);
        const payload = Buffer.from(payloadB64, 'base64').toString();
        
        const expectedHmac = createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
        if (receivedHmac !== expectedHmac) return null;
        
        const colonIndex = payload.lastIndexOf(':');
        const wallet = payload.slice(0, colonIndex);
        const expiry = parseInt(payload.slice(colonIndex + 1));
        
        if (!wallet || !expiry || isNaN(expiry)) return null;
        if (Math.floor(Date.now() / 1000) > expiry) return null;
        
        return { wallet, expiry };
    } catch (error) {
        return null;
    }
}

// ============================================
// API HANDLER: POST /api/auth
// ============================================
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    
    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { wallet, signature, message } = body;
        
        if (!wallet || !signature || !message) {
            return res.status(400).json({ success: false, error: 'Missing: wallet, signature, message' });
        }
        
        // Validate message format
        const match = message.match(/^Login to PumpBot: (\d+)$/);
        if (!match) {
            return res.status(400).json({ success: false, error: 'Invalid message format' });
        }
        
        // Check message freshness (5 min)
        const age = Date.now() - parseInt(match[1]);
        if (age > 5 * 60 * 1000 || age < -30000) {
            return res.status(400).json({ success: false, error: 'Message expired. Try again.' });
        }
        
        // Verify Solana signature
        if (!verifySolanaSignature(wallet, signature, message)) {
            return res.status(401).json({ success: false, error: 'Invalid signature' });
        }
        
        // Get or create user
        let userResult = await sql`SELECT id FROM users WHERE wallet_address = ${wallet}`;
        if (userResult.rows.length === 0) {
            userResult = await sql`
                INSERT INTO users (wallet_address) VALUES (${wallet})
                ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = ${wallet}
                RETURNING id
            `;
        }
        
        const { token, expiresIn } = createToken(wallet);
        
        return res.status(200).json({ success: true, token, wallet, expiresIn });
        
    } catch (error) {
        console.error('❌ Auth error:', error);
        return res.status(500).json({ success: false, error: 'Authentication failed' });
    }
}
