// ============================================
// BALANCE API — Кастодиальные балансы + Депозит/Вывод
// ============================================
// Флоу депозита:
//   1. POST { action: "deposit-info" }  → Клиент получает адрес платформы + ATA
//   2. Клиент формирует SPL-transfer в Phantom, подписывает, отправляет on-chain
//   3. POST { action: "confirm-deposit", wallet, txSignature } → Бэкенд верифицирует:
//      - Транзакция существует и подтверждена
//      - SPL-transfer идёт на ATA платформы
//      - Отправитель = wallet из запроса (ЗАЩИТА ОТ КРАЖИ)
//      - TX ещё не использовался (дубль-защита)
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
    createAssociatedTokenAccountInstruction,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';

// ============================================
// КОНФИГУРАЦИЯ
// ============================================
const MINT_ADDRESS = process.env.TOKEN_MINT || 'DmHzzungjC7eMYVXUve4SksEg4XoUTcAQuRJ5tMmpump';
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
// DEPOSIT — верификация Phantom-подписанной транзакции
// ============================================

async function verifyAndCreditDeposit(txSignature, walletAddress) {
    // 1. Дубль-защита: tx уже использовался?
    const existing = await sql`SELECT id, status FROM deposits WHERE tx_signature = ${txSignature}`;
    if (existing.rows.length > 0) {
        if (existing.rows[0].status === 'confirmed') {
            return { success: false, error: 'Этот депозит уже зачислен' };
        }
    }

    // 2. Получаем транзакцию из Solana
    const connection = getConnection();
    let txInfo;

    // Пробуем несколько раз (транзакция может еще не индексироваться)
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
        // Подождать 2 сек между попытками
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }

    if (!txInfo) {
        return { success: false, error: 'Транзакция не найдена. Подождите 30 секунд и попробуйте снова.' };
    }

    if (txInfo.meta?.err) {
        return { success: false, error: 'Транзакция завершилась с ошибкой on-chain' };
    }

    // 3. Ищем SPL-transfer нашего токена на кошелёк платформы
    const platformAta = await getAssociatedTokenAddress(getMintPublicKey(), getPlatformPublicKey());
    const platformAtaStr = platformAta.toBase58();

    let depositAmount = 0;
    let senderAuthority = null;

    // Собираем ВСЕ инструкции (top-level + inner)
    const allInstructions = [...(txInfo.transaction.message.instructions || [])];
    for (const inner of (txInfo.meta?.innerInstructions || [])) {
        allInstructions.push(...(inner.instructions || []));
    }

    for (const ix of allInstructions) {
        const parsed = ix.parsed;
        if (!parsed) continue;

        // transferChecked (стандартный SPL transfer с проверкой mint)
        if (parsed.type === 'transferChecked' && parsed.info?.mint === MINT_ADDRESS) {
            if (parsed.info.destination === platformAtaStr) {
                depositAmount = parseFloat(parsed.info.tokenAmount?.uiAmount || 0);
                senderAuthority = parsed.info.authority;
                break;
            }
        }

        // Обычный transfer (без checked) — проверяем программу
        if (parsed.type === 'transfer') {
            const programId = ix.programId?.toBase58?.() || ix.programId;
            if (programId === TOKEN_PROGRAM_ID.toBase58()) {
                if (parsed.info.destination === platformAtaStr) {
                    const rawAmount = parseInt(parsed.info.amount || 0);
                    depositAmount = fromRawAmount(rawAmount);
                    senderAuthority = parsed.info.authority || parsed.info.source;
                    break;
                }
            }
        }
    }

    if (depositAmount <= 0) {
        return { success: false, error: 'В этой транзакции не найден перевод токенов на кошелёк платформы' };
    }

    // 4. ✅ ГЛАВНАЯ ЗАЩИТА: отправитель = заявленный кошелёк
    // senderAuthority — это owner ATA отправителя (т.е. публичный ключ кошелька)
    if (senderAuthority !== walletAddress) {
        console.error(`🚫 Sender mismatch! Authority: ${senderAuthority}, Claimed: ${walletAddress}`);
        return { success: false, error: 'Отправитель транзакции не совпадает с вашим кошельком' };
    }

    // 5. Минимум
    if (depositAmount < MIN_DEPOSIT) {
        return { success: false, error: `Минимальный депозит: ${MIN_DEPOSIT} токенов` };
    }

    // 6. Получаем пользователя
    const userResult = await sql`SELECT id FROM users WHERE wallet_address = ${walletAddress}`;
    if (userResult.rows.length === 0) {
        return { success: false, error: 'Сначала подключите кошелёк' };
    }
    const userId = userResult.rows[0].id;

    // 7. Записываем депозит + зачисляем
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

    console.log(`✅ Deposit: +${depositAmount} tokens → user ${userId}, balance: ${newBalance}`);

    return {
        success: true,
        amount: depositAmount,
        newBalance: newBalance,
        txSignature: txSignature,
    };
}

// ============================================
// WITHDRAWAL — платформа отправляет SPL-токены пользователю
// ============================================

async function processWithdrawal(userId, walletAddress, amount) {
    if (amount < MIN_WITHDRAWAL) {
        throw new Error(`Минимальный вывод: ${MIN_WITHDRAWAL} токенов`);
    }

    const netAmount = amount - WITHDRAWAL_FEE;
    if (netAmount <= 0) throw new Error('Сумма слишком мала после комиссии');

    const withdrawal = await sql`
        INSERT INTO withdrawals (user_id, wallet_address, amount, fee, status)
        VALUES (${userId}, ${walletAddress}, ${amount}, ${WITHDRAWAL_FEE}, 'processing')
        RETURNING id
    `;
    const withdrawalId = withdrawal.rows[0].id;

    try {
        // Списываем баланс
        await debitBalance(userId, amount, 'withdrawal', withdrawalId, 'withdrawals',
            `Withdrawal ${amount} tokens to ${walletAddress.substring(0, 8)}...`);

        // Отправляем on-chain
        const connection = getConnection();
        const platformKeypair = getPlatformKeypair();
        const recipientPubkey = new PublicKey(walletAddress);
        const mintPubkey = getMintPublicKey();

        const platformAtaAddr = await getAssociatedTokenAddress(mintPubkey, platformKeypair.publicKey);
        const recipientAtaAddr = await getAssociatedTokenAddress(mintPubkey, recipientPubkey);

        const recipientAtaInfo = await connection.getAccountInfo(recipientAtaAddr);

        const transaction = new Transaction();

        // Создаём ATA получателя если не существует
        if (!recipientAtaInfo) {
            transaction.add(
                createAssociatedTokenAccountInstruction(
                    platformKeypair.publicKey, recipientAtaAddr, recipientPubkey, mintPubkey
                )
            );
        }

        transaction.add(
            createTransferInstruction(
                platformAtaAddr, recipientAtaAddr, platformKeypair.publicKey, toRawAmount(netAmount)
            )
        );

        const txSignature = await sendAndConfirmTransaction(
            connection, transaction, [platformKeypair], { commitment: 'confirmed' }
        );

        await sql`
            UPDATE withdrawals SET status = 'confirmed', tx_signature = ${txSignature}, confirmed_at = NOW()
            WHERE id = ${withdrawalId}
        `;

        console.log(`✅ Withdrawal: -${netAmount} tokens → ${walletAddress}, tx: ${txSignature}`);
        return { success: true, amount: netAmount, fee: WITHDRAWAL_FEE, txSignature };

    } catch (error) {
        console.error(`❌ Withdrawal failed:`, error);

        // Возвращаем баланс
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
        // GET — Баланс
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

        // POST — Действия
        if (req.method === 'POST') {
            const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            const { action, wallet } = body;

            // --- Deposit info (адрес + ATA для фронта) ---
            if (action === 'deposit-info') {
                if (!PLATFORM_WALLET_SECRET) {
                    return res.status(500).json({ success: false, error: 'Platform wallet not configured' });
                }

                const platformAddress = getPlatformPublicKey().toBase58();
                const platformAta = await getAssociatedTokenAddress(getMintPublicKey(), getPlatformPublicKey());

                // Получаем blockhash через серверный Helius RPC
                let blockhash = null;
                let rpcDebug = null;
                try {
                    const connection = getConnection();
                    const bh = await connection.getLatestBlockhash('finalized');
                    blockhash = bh.blockhash;
                } catch (e) {
                    console.error('⚠️ Failed to get blockhash:', e.message);
                    rpcDebug = {
                        error: e.message,
                        rpcUrl: RPC_URL ? RPC_URL.replace(/api-key=.*/, 'api-key=***') : 'not set',
                        heliusKeySet: !!HELIUS_API_KEY,
                    };
                }

                return res.status(200).json({
                    success: true,
                    depositAddress: platformAddress,
                    depositAta: platformAta.toBase58(),
                    tokenMint: MINT_ADDRESS,
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
