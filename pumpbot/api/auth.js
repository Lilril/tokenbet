// ============================================
// AUTH: Solana wallet signature verification + HMAC session tokens
// Stateless — works across Vercel serverless functions
// ============================================

import { sql } from '@vercel/postgres';
import { createHmac, createPublicKey, verify } from 'crypto';

const TOKEN_SECRET = process.env.AUTH_SECRET || 'dev-secret-change-in-production';
const TOKEN_TTL_SEC = 86400; // 24 hours

// Inline base58 decoder (no external dependency)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str) {
    const bytes = [0];
    for (let i = 0; i < str.length; i++) {
        const c = BASE58_ALPHABET.indexOf(str[i]);
        if (c < 0) throw new Error('Invalid base58 character');
        for (let j = 0; j < bytes.length; j++) bytes[j] *= 58;
        bytes[0] += c;
        let carry = 0;
        for (let j = 0; j < bytes.length; j++) {
            bytes[j] += carry;
            carry = (bytes[j] >> 8);
            bytes[j] &= 0xff;
        }
        while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    // Leading zeros
    for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
    return Buffer.from(bytes.reverse());
}

// ============================================
// VERIFY SOLANA SIGNATURE (Node.js built-in crypto only)
// ============================================
function verifySolanaSignature(walletAddress, signature, message) {
    try {
        const publicKeyBytes = base58Decode(walletAddress);
        const signatureBytes = Array.isArray(signature) 
            ? Buffer.from(signature) 
            : Buffer.from(signature);
        const messageBytes = Buffer.from(message, 'utf-8');
        
        // Ed25519 DER-encoded SPKI prefix + 32-byte public key
        const derPrefix = Buffer.from('302a300506032b6570032100', 'hex');
        const derKey = Buffer.concat([derPrefix, publicKeyBytes]);
        
        const key = createPublicKey({ key: derKey, format: 'der', type: 'spki' });
        return verify(null, messageBytes, key, signatureBytes);
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
        const match = message.match(/^Login to Mercurome: (\d+)$/);
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
        return res.status(500).json({ success: false, error: 'Auth failed: ' + error.message });
    }
}
