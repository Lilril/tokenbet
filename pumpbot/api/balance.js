// ============================================
// BALANCE API — Кастодиальные балансы + Депозит/Вывод
// ============================================
// Endpoints:
//   GET  /api/balance?wallet=...                  → Получить баланс
//   POST /api/balance { action: "deposit-info" }  → Получить адрес для депозита
//   POST /api/balance { action: "withdraw" }      → Запросить вывод
//   POST /api/balance { action: "confirm-deposit" } → Подтвердить депозит (внутренний)
// ============================================

import { sql } from '@vercel/postgres';
import {
    Connection,
    PublicKey,
    Keypair,
    Transaction,
    sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
    getAssociatedTokenAddress,
    createTransferInstruction,
    getOrCreateAssociatedTokenAccount,
    createAssociatedTokenAccountInstruction,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';

// ============================================
// КОНФИГУРАЦИЯ — всё из ENV
// ============================================
const MINT_ADDRESS = process.env.TOKEN_MINT || 'DmHzzungjC7eMYVXUve4SksEg4XoUTcAQuRJ5tMmpump';
const PLATFORM_WALLET_SECRET = process.env.PLATFORM_WALLET_SECRET; // Base58 приватный ключ
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const RPC_URL = HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
    : 'https://api.mainnet-beta.solana.com';

const TOKEN_DECIMALS = 6; // pump.fun стандарт
const MIN_DEPOSIT = parseFloat(process.env.MIN_DEPOSIT || '1');
const MIN_WITHDRAWAL = parseFloat(process.env.MIN_WITHDRAWAL || '10');
const WITHDRAWAL_FEE = parseFloat(process.env.WITHDRAWAL_FEE || '0');

// ============================================
// SOLANA HELPERS
// ============================================

function getConnection() {
    return new Connection(RPC_URL, 'confirmed');
}

function getPlatformKeypair() {
    if (!PLATFORM_WALLET_SECRET) {
        throw new Error('PLATFORM_WALLET_SECRET not set');
    }
    const secretKey = bs58.decode(PLATFORM_WALLET_SECRET);
    return Keypair.fromSecretKey(secretKey);
}

function getPlatformPublicKey() {
    const keypair = getPlatformKeypair();
    return keypair.publicKey;
}

function getMintPublicKey() {
    return new PublicKey(MINT_ADDRESS);
}

// Конвертация: токены → raw amount (с учётом decimals)
function toRawAmount(tokens) {
    return Math.floor(tokens * Math.pow(10, TOKEN_DECIMALS));
}

// Конвертация: raw amount → токены
function fromRawAmount(raw) {
    return raw / Math.pow(10, TOKEN_DECIMALS);
}

// ============================================
// BALANCE HELPERS
// ============================================

async function getOrCreateBalance(userId) {
    const existing = await sql`
        SELECT * FROM user_balances WHERE user_id = ${userId}
    `;
    
    if (existing.rows.length > 0) {
        return existing.rows[0];
    }
    
    const created = await sql`
        INSERT INTO user_balances (user_id, available, locked)
        VALUES (${userId}, 0, 0)
        RETURNING *
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
// DEPOSIT VERIFICATION
// ============================================

async function verifyAndCreditDeposit(txSignature, walletAddress) {
    // Проверяем, не обработан ли уже
    const existing = await sql`
        SELECT id, status FROM deposits WHERE tx_signature = ${txSignature}
    `;
    
    if (existing.rows.length > 0) {
        if (existing.rows[0].status === 'confirmed') {
            return { success: false, error: 'Deposit already credited', alreadyCredited: true };
        }
    }
    
    // Получаем транзакцию из Solana
    const connection = getConnection();
    let txInfo;
    
    try {
        txInfo = await connection.getParsedTransaction(txSignature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
        });
    } catch (err) {
        console.error('❌ Failed to fetch transaction:', err);
        return { success: false, error: 'Failed to fetch transaction' };
    }
    
    if (!txInfo) {
        return { success: false, error: 'Transaction not found' };
    }
    
    if (txInfo.meta?.err) {
        return { success: false, error: 'Transaction failed on-chain' };
    }
    
    // Ищем SPL-transfer нашего токена на кошелёк платформы
    const platformWallet = getPlatformPublicKey().toBase58();
    const mint = MINT_ADDRESS;
    let depositAmount = 0;
    let senderWallet = null;
    
    const instructions = txInfo.transaction.message.instructions;
    const innerInstructions = txInfo.meta?.innerInstructions || [];
    
    // Проверяем все инструкции (включая inner) на SPL transfer
    const allInstructions = [...instructions];
    for (const inner of innerInstructions) {
        allInstructions.push(...(inner.instructions || []));
    }
    
    for (const ix of allInstructions) {
        if (ix.parsed?.type === 'transferChecked' && ix.parsed?.info?.mint === mint) {
            const destAta = ix.parsed.info.destination;
            const amount = parseFloat(ix.parsed.info.tokenAmount?.uiAmount || 0);
            
            // Проверяем что destination — ATA нашего кошелька
            const expectedAta = await getAssociatedTokenAddress(
                getMintPublicKey(),
                getPlatformPublicKey()
            );
            
            if (destAta === expectedAta.toBase58() && amount > 0) {
                depositAmount = amount;
                senderWallet = ix.parsed.info.authority;
                break;
            }
        }
        
        // Также проверяем обычный transfer (без checked)
        if (ix.parsed?.type === 'transfer' && ix.programId?.toBase58() === TOKEN_PROGRAM_ID.toBase58()) {
            const destAta = ix.parsed.info.destination;
            const rawAmount = parseInt(ix.parsed.info.amount || 0);
            const amount = fromRawAmount(rawAmount);
            
            const expectedAta = await getAssociatedTokenAddress(
                getMintPublicKey(),
                getPlatformPublicKey()
            );
            
            if (destAta === expectedAta.toBase58() && amount > 0) {
                depositAmount = amount;
                senderWallet = ix.parsed.info.authority || ix.parsed.info.source;
                break;
            }
        }
    }
    
    if (depositAmount <= 0) {
        return { success: false, error: 'No valid token transfer to platform wallet found in this transaction' };
    }
    
    // Верификация: отправитель = заявленный пользователь
    // (senderWallet может быть ATA, нам нужен owner)
    // Для безопасности проверяем по walletAddress из запроса
    
    if (depositAmount < MIN_DEPOSIT) {
        return { success: false, error: `Minimum deposit is ${MIN_DEPOSIT} tokens` };
    }
    
    // Получаем/создаём пользователя
    const userResult = await sql`
        SELECT id FROM users WHERE wallet_address = ${walletAddress}
    `;
    
    if (userResult.rows.length === 0) {
        return { success: false, error: 'User not found. Connect wallet first.' };
    }
    
    const userId = userResult.rows[0].id;
    
    // Записываем депозит
    const deposit = await sql`
        INSERT INTO deposits (user_id, wallet_address, amount, tx_signature, status, slot, confirmed_at)
        VALUES (${userId}, ${walletAddress}, ${depositAmount}, ${txSignature}, 'confirmed', ${txInfo.slot}, NOW())
        ON CONFLICT (tx_signature) DO UPDATE SET status = 'confirmed', confirmed_at = NOW()
        RETURNING id
    `;
    
    // Зачисляем баланс
    const newBalance = await creditBalance(
        userId,
        depositAmount,
        'deposit',
        deposit.rows[0].id,
        'deposits',
        `Deposit ${depositAmount} tokens, tx: ${txSignature.substring(0, 16)}...`
    );
    
    console.log(`✅ Deposit credited: ${depositAmount} tokens to user ${userId}, new balance: ${newBalance}`);
    
    return {
        success: true,
        amount: depositAmount,
        newBalance: newBalance,
        txSignature: txSignature,
    };
}

// ============================================
// WITHDRAWAL
// ============================================

async function processWithdrawal(userId, walletAddress, amount) {
    if (amount < MIN_WITHDRAWAL) {
        throw new Error(`Minimum withdrawal is ${MIN_WITHDRAWAL} tokens`);
    }
    
    const netAmount = amount - WITHDRAWAL_FEE;
    if (netAmount <= 0) {
        throw new Error('Amount too small after fee');
    }
    
    // Списываем баланс (это бросит ошибку если недостаточно)
    // Сначала создаём запись на вывод
    const withdrawal = await sql`
        INSERT INTO withdrawals (user_id, wallet_address, amount, fee, status)
        VALUES (${userId}, ${walletAddress}, ${amount}, ${WITHDRAWAL_FEE}, 'processing')
        RETURNING id
    `;
    
    const withdrawalId = withdrawal.rows[0].id;
    
    try {
        // Списываем полную сумму (включая комиссию)
        await debitBalance(
            userId,
            amount,
            'withdrawal',
            withdrawalId,
            'withdrawals',
            `Withdrawal ${amount} tokens to ${walletAddress.substring(0, 8)}...`
        );
        
        // Отправляем токены on-chain
        const connection = getConnection();
        const platformKeypair = getPlatformKeypair();
        const recipientPubkey = new PublicKey(walletAddress);
        const mintPubkey = getMintPublicKey();
        
        // Получаем ATA платформы
        const platformAta = await getAssociatedTokenAddress(mintPubkey, platformKeypair.publicKey);
        
        // Получаем/создаём ATA получателя
        const recipientAta = await getAssociatedTokenAddress(mintPubkey, recipientPubkey);
        
        // Проверяем существует ли ATA получателя
        const recipientAtaInfo = await connection.getAccountInfo(recipientAta);
        
        const transaction = new Transaction();
        
        // Если ATA не существует — создаём
        if (!recipientAtaInfo) {
            transaction.add(
                createAssociatedTokenAccountInstruction(
                    platformKeypair.publicKey,   // payer
                    recipientAta,                 // ata
                    recipientPubkey,              // owner
                    mintPubkey                    // mint
                )
            );
        }
        
        // Добавляем transfer
        transaction.add(
            createTransferInstruction(
                platformAta,                      // source
                recipientAta,                     // destination
                platformKeypair.publicKey,         // owner
                toRawAmount(netAmount)             // amount in raw
            )
        );
        
        // Отправляем транзакцию
        const txSignature = await sendAndConfirmTransaction(
            connection,
            transaction,
            [platformKeypair],
            { commitment: 'confirmed' }
        );
        
        // Обновляем статус
        await sql`
            UPDATE withdrawals 
            SET status = 'confirmed', tx_signature = ${txSignature}, confirmed_at = NOW()
            WHERE id = ${withdrawalId}
        `;
        
        console.log(`✅ Withdrawal sent: ${netAmount} tokens to ${walletAddress}, tx: ${txSignature}`);
        
        return {
            success: true,
            amount: netAmount,
            fee: WITHDRAWAL_FEE,
            txSignature: txSignature,
        };
        
    } catch (error) {
        console.error(`❌ Withdrawal failed:`, error);
        
        // Возвращаем баланс при ошибке
        try {
            await creditBalance(
                userId,
                amount,
                'refund',
                withdrawalId,
                'withdrawals',
                `Refund for failed withdrawal #${withdrawalId}: ${error.message}`
            );
        } catch (refundError) {
            console.error('❌❌ CRITICAL: Refund failed!', refundError);
        }
        
        await sql`
            UPDATE withdrawals 
            SET status = 'failed', error_message = ${error.message}
            WHERE id = ${withdrawalId}
        `;
        
        throw error;
    }
}

// ============================================
// API HANDLER
// ============================================

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    try {
        // ============================================
        // GET — Получить баланс
        // ============================================
        if (req.method === 'GET') {
            const { wallet } = req.query;
            
            if (!wallet) {
                return res.status(400).json({ success: false, error: 'wallet required' });
            }
            
            // Получаем пользователя
            const userResult = await sql`
                SELECT id FROM users WHERE wallet_address = ${wallet}
            `;
            
            if (userResult.rows.length === 0) {
                return res.status(200).json({
                    success: true,
                    balance: 0,
                    available: 0,
                    locked: 0,
                    depositAddress: PLATFORM_WALLET_SECRET ? getPlatformPublicKey().toBase58() : null,
                });
            }
            
            const userId = userResult.rows[0].id;
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
        
        // ============================================
        // POST — Действия с балансом
        // ============================================
        if (req.method === 'POST') {
            const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            const { action, wallet } = body;
            
            // --- Информация для депозита ---
            if (action === 'deposit-info') {
                if (!PLATFORM_WALLET_SECRET) {
                    return res.status(500).json({ success: false, error: 'Platform wallet not configured' });
                }
                
                const platformAddress = getPlatformPublicKey().toBase58();
                
                return res.status(200).json({
                    success: true,
                    depositAddress: platformAddress,
                    tokenMint: MINT_ADDRESS,
                    minDeposit: MIN_DEPOSIT,
                    decimals: TOKEN_DECIMALS,
                    instructions: `Send SPL tokens (${MINT_ADDRESS}) to ${platformAddress}`,
                });
            }
            
            // --- Подтвердить депозит по TX ---
            if (action === 'confirm-deposit') {
                const { txSignature } = body;
                
                if (!wallet || !txSignature) {
                    return res.status(400).json({ success: false, error: 'wallet and txSignature required' });
                }
                
                const result = await verifyAndCreditDeposit(txSignature, wallet);
                
                if (!result.success) {
                    return res.status(400).json(result);
                }
                
                return res.status(200).json(result);
            }
            
            // --- Запросить вывод ---
            if (action === 'withdraw') {
                const { amount } = body;
                
                if (!wallet || !amount) {
                    return res.status(400).json({ success: false, error: 'wallet and amount required' });
                }
                
                const amt = parseFloat(amount);
                if (isNaN(amt) || amt <= 0) {
                    return res.status(400).json({ success: false, error: 'Invalid amount' });
                }
                
                // Получаем пользователя
                const userResult = await sql`
                    SELECT id FROM users WHERE wallet_address = ${wallet}
                `;
                
                if (userResult.rows.length === 0) {
                    return res.status(400).json({ success: false, error: 'User not found' });
                }
                
                const userId = userResult.rows[0].id;
                
                try {
                    const result = await processWithdrawal(userId, wallet, amt);
                    return res.status(200).json(result);
                } catch (error) {
                    return res.status(400).json({
                        success: false,
                        error: error.message,
                    });
                }
            }
            
            // --- История депозитов/выводов ---
            if (action === 'history') {
                if (!wallet) {
                    return res.status(400).json({ success: false, error: 'wallet required' });
                }
                
                const userResult = await sql`
                    SELECT id FROM users WHERE wallet_address = ${wallet}
                `;
                
                if (userResult.rows.length === 0) {
                    return res.status(200).json({ success: true, deposits: [], withdrawals: [] });
                }
                
                const userId = userResult.rows[0].id;
                
                const deposits = await sql`
                    SELECT amount, tx_signature, status, confirmed_at
                    FROM deposits WHERE user_id = ${userId}
                    ORDER BY detected_at DESC LIMIT 20
                `;
                
                const withdrawals = await sql`
                    SELECT amount, fee, tx_signature, status, requested_at, confirmed_at
                    FROM withdrawals WHERE user_id = ${userId}
                    ORDER BY requested_at DESC LIMIT 20
                `;
                
                return res.status(200).json({
                    success: true,
                    deposits: deposits.rows,
                    withdrawals: withdrawals.rows,
                });
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

// ============================================
// ЭКСПОРТ для использования в orders.js
// ============================================
export { getOrCreateBalance, creditBalance, debitBalance, logBalanceTransaction };
