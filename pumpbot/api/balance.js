import { sql } from '@vercel/postgres';
import {
    Connection,
    PublicKey,
    Keypair,
    Transaction,
    TransactionInstruction,
    sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';

// ============================================

// ============================================
const MINT_ADDRESS = process.env.TOKEN_MINT || '5aoYikfdb7ed33JqFeJUeCYPPLWcoqV7fDt4CoRGpump';
const PLATFORM_WALLET_SECRET = process.env.PLATFORM_WALLET_SECRET;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const RPC_URL = HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
    : 'https://api.mainnet-beta.solana.com';

const TOKEN_DECIMALS = 6;
const MIN_DEPOSIT = parseFloat(process.env.MIN_DEPOSIT || '1');
const MIN_WITHDRAWAL = parseFloat(process.env.MIN_WITHDRAWAL || '10');
const WITHDRAWAL_FEE = parseFloat(process.env.WITHDRAWAL_FEE || '0');

// ============================================
// SOLANA HELPERS
// ============================================

function getConnection() {
    return new Connection(RPC_URL, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 30000,
    });
}

function getPlatformKeypair() {
    if (!PLATFORM_WALLET_SECRET) throw new Error('PLATFORM_WALLET_SECRET not set');
    return Keypair.fromSecretKey(bs58.decode(PLATFORM_WALLET_SECRET));
}

function getPlatformPublicKey() {
    return getPlatformKeypair().publicKey;
}

function getMintPublicKey() {
    return new PublicKey(MINT_ADDRESS);
}

function toRawAmount(tokens) {
    return Math.floor(tokens * Math.pow(10, TOKEN_DECIMALS));
}

function fromRawAmount(raw) {
    return raw / Math.pow(10, TOKEN_DECIMALS);
}

// ============================================
// BALANCE DB HELPERS
// ============================================

async function getOrCreateBalance(userId) {
    const existing = await sql`SELECT * FROM user_balances WHERE user_id = ${userId}`;
    if (existing.rows.length > 0) return existing.rows[0];

    const created = await sql`
        INSERT INTO user_balances (user_id, available, locked)
        VALUES (${userId}, 0, 0) RETURNING *
    `;
    return created.rows[0];
}

async function logBalanceTransaction(userId, type, amount, balanceBefore, balanceAfter, referenceId, referenceType, description) {
    await sql`
        INSERT INTO balance_transactions (user_id, type, amount, balance_before, balance_after, reference_id, reference_type, description)
        VALUES (${userId}, ${type}, ${amount}, ${balanceBefore}, ${balanceAfter}, ${referenceId}, ${referenceType}, ${description})
    `;
}

async function creditBalance(userId, amount, type, referenceId, referenceType, description) {
    const balance = await getOrCreateBalance(userId);
    const before = parseFloat(balance.available);
    const after = before + amount;

    await sql`
        UPDATE user_balances 
        SET available = available + ${amount},
            total_deposited = CASE WHEN ${type} = 'deposit' THEN total_deposited + ${amount} ELSE total_deposited END,
            updated_at = NOW()
        WHERE user_id = ${userId}
    `;

    await logBalanceTransaction(userId, type, amount, before, after, referenceId, referenceType, description);
    return after;
}

async function debitBalance(userId, amount, type, referenceId, referenceType, description) {
    const balance = await getOrCreateBalance(userId);
    const available = parseFloat(balance.available);

    if (available < amount) {
        throw new Error(`Insufficient balance: have ${available}, need ${amount}`);
    }

    const after = available - amount;

    await sql`
        UPDATE user_balances 
        SET available = available - ${amount},
            total_withdrawn = CASE WHEN ${type} = 'withdrawal' THEN total_withdrawn + ${amount} ELSE total_withdrawn END,
            updated_at = NOW()
        WHERE user_id = ${userId}
    `;

    await logBalanceTransaction(userId, type, -amount, available, after, referenceId, referenceType, description);
    return after;
}

// ============================================

// ============================================

async function verifyAndCreditDeposit(txSignature, walletAddress) {
    
    const existing = await sql`SELECT id, status FROM deposits WHERE tx_signature = ${txSignature}`;
    if (existing.rows.length > 0) {
        if (existing.rows[0].status === 'confirmed') {
            return { success: false, error: 'This deposit has already been credited' };
        }
    }

    
    const connection = getConnection();
    let txInfo;

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            txInfo = await connection.getParsedTransaction(txSignature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0,
            });
            if (txInfo) break;
        } catch (err) {
            console.error(`❌ Attempt ${attempt + 1} fetch tx:`, err.message);
        }
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }

    if (!txInfo) {
        return { success: false, error: 'Transaction not found. Please wait 30 seconds and try again.' };
    }

    if (txInfo.meta?.err) {
        return { success: false, error: 'Transaction failed on-chain' };
    }

    
    let tokenProgramId;
    try {
        const mintInfo = await connection.getParsedAccountInfo(getMintPublicKey());
        tokenProgramId = mintInfo.value?.owner?.toBase58() || TOKEN_PROGRAM_ID.toBase58();
    } catch (e) {
        tokenProgramId = TOKEN_PROGRAM_ID.toBase58();
    }
    
    const TOKEN_2022_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    const tokenProgramPubkey = new PublicKey(tokenProgramId);
    const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    
    
    const [platformAta] = PublicKey.findProgramAddressSync(
        [getPlatformPublicKey().toBuffer(), tokenProgramPubkey.toBuffer(), getMintPublicKey().toBuffer()],
        ATA_PROGRAM
    );
    const platformAtaStr = platformAta.toBase58();
    

    let depositAmount = 0;
    let senderAuthority = null;

    
    const allInstructions = [...(txInfo.transaction.message.instructions || [])];
    for (const inner of (txInfo.meta?.innerInstructions || [])) {
        allInstructions.push(...(inner.instructions || []));
    }

    for (const ix of allInstructions) {
        const parsed = ix.parsed;
        if (!parsed) continue;
        
        const programId = ix.programId?.toBase58?.() || ix.programId || '';

        
        if (parsed.type === 'transferChecked' && parsed.info?.mint === MINT_ADDRESS) {
            if (parsed.info.destination === platformAtaStr) {
                depositAmount = parseFloat(parsed.info.tokenAmount?.uiAmount || 0);
                senderAuthority = parsed.info.authority;
                break;
            }
        }

        
        if (parsed.type === 'transfer' && 
            (programId === TOKEN_PROGRAM_ID.toBase58() || programId === TOKEN_2022_ID)) {
            if (parsed.info.destination === platformAtaStr) {
                const rawAmount = parseInt(parsed.info.amount || 0);
                depositAmount = fromRawAmount(rawAmount);
                senderAuthority = parsed.info.authority || parsed.info.source;
                break;
            }
        }
    }
    
    
    if (depositAmount <= 0 && txInfo.meta) {
        const preBalances = txInfo.meta.preTokenBalances || [];
        const postBalances = txInfo.meta.postTokenBalances || [];
        
        
        for (const post of postBalances) {
            if (post.mint !== MINT_ADDRESS) continue;
            if (post.owner !== getPlatformPublicKey().toBase58()) continue;
            
            const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
            const preAmount = parseFloat(pre?.uiTokenAmount?.uiAmount || 0);
            const postAmount = parseFloat(post.uiTokenAmount?.uiAmount || 0);
            
            if (postAmount > preAmount) {
                depositAmount = postAmount - preAmount;
                
                
                for (const preBal of preBalances) {
                    if (preBal.mint !== MINT_ADDRESS) continue;
                    if (preBal.owner === getPlatformPublicKey().toBase58()) continue;
                    const postBal = postBalances.find(p => p.accountIndex === preBal.accountIndex);
                    const preAmt = parseFloat(preBal.uiTokenAmount?.uiAmount || 0);
                    const postAmt = parseFloat(postBal?.uiTokenAmount?.uiAmount || 0);
                    if (preAmt > postAmt) {
                        senderAuthority = preBal.owner;
                        break;
                    }
                }
                break;
            }
        }
    }

    if (depositAmount <= 0) {
        return { success: false, error: 'No token transfer to platform wallet found in this transaction' };
    }

    
    if (senderAuthority !== walletAddress) {
        console.error(`🚫 Sender mismatch! Authority: ${senderAuthority}, Claimed: ${walletAddress}`);
        return { success: false, error: 'Transaction sender does not match your wallet' };
    }

    
    if (depositAmount < MIN_DEPOSIT) {
        return { success: false, error: `Minimum deposit: ${MIN_DEPOSIT} tokens` };
    }

    
    const userResult = await sql`SELECT id FROM users WHERE wallet_address = ${walletAddress}`;
    if (userResult.rows.length === 0) {
        return { success: false, error: 'Please connect your wallet first' };
    }
    const userId = userResult.rows[0].id;

    
    const deposit = await sql`
        INSERT INTO deposits (user_id, wallet_address, amount, tx_signature, status, slot, confirmed_at)
        VALUES (${userId}, ${walletAddress}, ${depositAmount}, ${txSignature}, 'confirmed', ${txInfo.slot || 0}, NOW())
        ON CONFLICT (tx_signature) DO UPDATE SET status = 'confirmed', confirmed_at = NOW()
        RETURNING id
    `;

    const newBalance = await creditBalance(
        userId, depositAmount, 'deposit',
        deposit.rows[0].id, 'deposits',
        `Deposit ${depositAmount} tokens, tx: ${txSignature.substring(0, 16)}...`
    );


    return {
        success: true,
        amount: depositAmount,
        newBalance: newBalance,
        txSignature: txSignature,
    };
}

// ============================================

// ============================================

async function processWithdrawal(userId, walletAddress, amount) {
    if (amount < MIN_WITHDRAWAL) {
        throw new Error(`Minimum withdrawal: ${MIN_WITHDRAWAL} tokens`);
    }

    const netAmount = amount - WITHDRAWAL_FEE;
    if (netAmount <= 0) throw new Error('Amount too small after fee');

    const withdrawal = await sql`
        INSERT INTO withdrawals (user_id, wallet_address, amount, fee, status)
        VALUES (${userId}, ${walletAddress}, ${amount}, ${WITHDRAWAL_FEE}, 'processing')
        RETURNING id
    `;
    const withdrawalId = withdrawal.rows[0].id;

    try {
        
        await debitBalance(userId, amount, 'withdrawal', withdrawalId, 'withdrawals',
            `Withdrawal ${amount} tokens to ${walletAddress.substring(0, 8)}...`);

        
        const connection = getConnection();
        const platformKeypair = getPlatformKeypair();
        const recipientPubkey = new PublicKey(walletAddress);
        const mintPubkey = getMintPublicKey();
        
        
        let tokenProgramPubkey = TOKEN_PROGRAM_ID;
        try {
            const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
            if (mintInfo.value?.owner) {
                tokenProgramPubkey = mintInfo.value.owner;
            }
        } catch (e) {
            console.error('⚠️ Failed to detect token program for withdrawal, using default');
        }
        
        
        const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
        const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
        
        
        const [platformAtaAddr] = PublicKey.findProgramAddressSync(
            [platformKeypair.publicKey.toBuffer(), tokenProgramPubkey.toBuffer(), mintPubkey.toBuffer()],
            ATA_PROGRAM_ID
        );
        const [recipientAtaAddr] = PublicKey.findProgramAddressSync(
            [recipientPubkey.toBuffer(), tokenProgramPubkey.toBuffer(), mintPubkey.toBuffer()],
            ATA_PROGRAM_ID
        );

        const recipientAtaInfo = await connection.getAccountInfo(recipientAtaAddr);

        const transaction = new Transaction();

        
        if (!recipientAtaInfo) {
            const createAtaIx = new TransactionInstruction({
                keys: [
                    { pubkey: platformKeypair.publicKey, isSigner: true, isWritable: true },  // payer
                    { pubkey: recipientAtaAddr, isSigner: false, isWritable: true },           // ata
                    { pubkey: recipientPubkey, isSigner: false, isWritable: false },            // owner
                    { pubkey: mintPubkey, isSigner: false, isWritable: false },                 // mint
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },          // system
                    { pubkey: tokenProgramPubkey, isSigner: false, isWritable: false },          // token program
                ],
                programId: ATA_PROGRAM_ID,
                data: Buffer.alloc(0),
            });
            transaction.add(createAtaIx);
        }

        
        const transferData = Buffer.alloc(9);
        transferData.writeUInt8(3, 0); // Transfer instruction index
        transferData.writeBigUInt64LE(BigInt(toRawAmount(netAmount)), 1);
        
        const transferIx = new TransactionInstruction({
            keys: [
                { pubkey: platformAtaAddr, isSigner: false, isWritable: true },     // source
                { pubkey: recipientAtaAddr, isSigner: false, isWritable: true },    // destination
                { pubkey: platformKeypair.publicKey, isSigner: true, isWritable: false }, // owner
            ],
            programId: tokenProgramPubkey,
            data: transferData,
        });
        transaction.add(transferIx);

        const txSignature = await sendAndConfirmTransaction(
            connection, transaction, [platformKeypair], { commitment: 'confirmed' }
        );

        await sql`
            UPDATE withdrawals SET status = 'confirmed', tx_signature = ${txSignature}, confirmed_at = NOW()
            WHERE id = ${withdrawalId}
        `;

        return { success: true, amount: netAmount, fee: WITHDRAWAL_FEE, txSignature };

    } catch (error) {
        console.error(`❌ Withdrawal failed:`, error);

        
        try {
            await creditBalance(userId, amount, 'refund', withdrawalId, 'withdrawals',
                `Refund failed withdrawal #${withdrawalId}: ${error.message}`);
        } catch (refundErr) {
            console.error('❌❌ CRITICAL: Refund also failed!', refundErr);
        }

        await sql`
            UPDATE withdrawals SET status = 'failed', error_message = ${error.message}
            WHERE id = ${withdrawalId}
        `;
        throw error;
    }
}

// ============================================
// API HANDLER
// ============================================

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        
        if (req.method === 'GET') {
            const { wallet } = req.query;
            if (!wallet) return res.status(400).json({ success: false, error: 'wallet required' });

            const userResult = await sql`SELECT id FROM users WHERE wallet_address = ${wallet}`;

            if (userResult.rows.length === 0) {
                return res.status(200).json({
                    success: true,
                    balance: 0, available: 0, locked: 0,
                    depositAddress: PLATFORM_WALLET_SECRET ? getPlatformPublicKey().toBase58() : null,
                });
            }

            const userId = userResult.rows[0].id;
            
            
            try {
                const hasActiveOrders = await sql`
                    SELECT 1 FROM limit_orders lo
                    INNER JOIN rounds r ON r.id = lo.round_id
                    WHERE lo.user_id = ${userId} AND lo.status = 'active' AND r.status = 'active'
                    LIMIT 1
                `;
                if (hasActiveOrders.rows.length === 0) {
                    
                    const fixed = await sql`
                        UPDATE user_balances 
                        SET available = available + locked, locked = 0, updated_at = NOW()
                        WHERE user_id = ${userId} AND locked > 0
                        RETURNING available
                    `;
                    if (fixed.rows.length > 0) {
                    }
                }
            } catch (e) { /* ignore */ }
            
            const balance = await getOrCreateBalance(userId);

            return res.status(200).json({
                success: true,
                balance: parseFloat(balance.available) + parseFloat(balance.locked),
                available: parseFloat(balance.available),
                locked: parseFloat(balance.locked),
                totalDeposited: parseFloat(balance.total_deposited),
                totalWithdrawn: parseFloat(balance.total_withdrawn),
                depositAddress: PLATFORM_WALLET_SECRET ? getPlatformPublicKey().toBase58() : null,
            });
        }

        
        if (req.method === 'POST') {
            const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            const { action, wallet } = body;

            
            if (action === 'deposit-info') {
                if (!PLATFORM_WALLET_SECRET) {
                    return res.status(500).json({ success: false, error: 'Platform wallet not configured' });
                }

                const platformAddress = getPlatformPublicKey().toBase58();
                
                
                const connection = getConnection();
                let tokenProgramId = TOKEN_PROGRAM_ID.toBase58();
                
                try {
                    const mintInfo = await connection.getParsedAccountInfo(getMintPublicKey());
                    if (mintInfo.value?.owner) {
                        tokenProgramId = mintInfo.value.owner.toBase58();
                    }
                } catch (e) {
                    console.error('⚠️ Failed to detect token program:', e.message);
                }
                
                
                const tokenProgramPubkey = new PublicKey(tokenProgramId);
                const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
                
                const [platformAta] = PublicKey.findProgramAddressSync(
                    [getPlatformPublicKey().toBuffer(), tokenProgramPubkey.toBuffer(), getMintPublicKey().toBuffer()],
                    ATA_PROGRAM
                );

                
                let blockhash = null;
                let rpcDebug = null;
                try {
                    const bh = await connection.getLatestBlockhash('finalized');
                    blockhash = bh.blockhash;
                } catch (e) {
                    console.error('⚠️ Failed to get blockhash:', e.message);
                    rpcDebug = { error: e.message };
                }

                return res.status(200).json({
                    success: true,
                    depositAddress: platformAddress,
                    depositAta: platformAta.toBase58(),
                    tokenMint: MINT_ADDRESS,
                    tokenProgramId: tokenProgramId,
                    minDeposit: MIN_DEPOSIT,
                    decimals: TOKEN_DECIMALS,
                    blockhash: blockhash,
                    _debug: rpcDebug,
                });
            }

            // --- Confirm deposit (Phantom-signed TX) ---
            if (action === 'confirm-deposit') {
                const { txSignature } = body;
                if (!wallet || !txSignature) {
                    return res.status(400).json({ success: false, error: 'wallet and txSignature required' });
                }

                const result = await verifyAndCreditDeposit(txSignature, wallet);
                return res.status(result.success ? 200 : 400).json(result);
            }

            // --- Withdraw ---
            if (action === 'withdraw') {
                const { amount } = body;
                if (!wallet || !amount) {
                    return res.status(400).json({ success: false, error: 'wallet and amount required' });
                }

                const amt = parseFloat(amount);
                if (isNaN(amt) || amt <= 0) {
                    return res.status(400).json({ success: false, error: 'Invalid amount' });
                }

                const userResult = await sql`SELECT id FROM users WHERE wallet_address = ${wallet}`;
                if (userResult.rows.length === 0) {
                    return res.status(400).json({ success: false, error: 'User not found' });
                }

                try {
                    const result = await processWithdrawal(userResult.rows[0].id, wallet, amt);
                    return res.status(200).json(result);
                } catch (error) {
                    return res.status(400).json({ success: false, error: error.message });
                }
            }

            // --- History ---
            if (action === 'history') {
                if (!wallet) return res.status(400).json({ success: false, error: 'wallet required' });

                const userResult = await sql`SELECT id FROM users WHERE wallet_address = ${wallet}`;
                if (userResult.rows.length === 0) {
                    return res.status(200).json({ success: true, deposits: [], withdrawals: [] });
                }

                const userId = userResult.rows[0].id;
                const deposits = await sql`SELECT amount, tx_signature, status, confirmed_at FROM deposits WHERE user_id = ${userId} ORDER BY detected_at DESC LIMIT 20`;
                const withdrawals = await sql`SELECT amount, fee, tx_signature, status, requested_at, confirmed_at FROM withdrawals WHERE user_id = ${userId} ORDER BY requested_at DESC LIMIT 20`;

                return res.status(200).json({ success: true, deposits: deposits.rows, withdrawals: withdrawals.rows });
            }

            return res.status(400).json({ success: false, error: 'Unknown action' });
        }

        return res.status(405).json({ success: false, error: 'Method not allowed' });

    } catch (error) {
        console.error('❌ Balance API error:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
}

export { getOrCreateBalance, creditBalance, debitBalance, logBalanceTransaction };
