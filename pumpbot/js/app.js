// ============================================
// КОНФИГУРАЦИЯ
// ============================================
const TOKEN_ADDRESS = 'DmHzzungjC7eMYVXUve4SksEg4XoUTcAQuRJ5tMmpump';
const API_BASE = '';

// ============================================
// HELPER FUNCTIONS FOR SAFE API CALLS
// ============================================

// Safe JSON parse with content-type check
async function safeJsonParse(response) {
    const contentType = response.headers.get('content-type');
    
    if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        console.error('❌ Server returned non-JSON response:', text.substring(0, 200));
        throw new Error('Server error - received HTML instead of JSON. Check server logs.');
    }
    
    try {
        return await response.json();
    } catch (error) {
        console.error('❌ JSON parse error:', error);
        throw new Error('Invalid JSON response from server');
    }
}

// API call with error handling
async function apiCall(url, options = {}) {
    try {
        const response = await fetch(url, options);
        
        if (!response.ok) {
            let errorMessage = `HTTP ${response.status}`;
            try {
                const errorData = await safeJsonParse(response);
                errorMessage = errorData.error || errorData.message || errorMessage;
            } catch (e) {
                // If parsing fails, use default error message
            }
            throw new Error(errorMessage);
        }
        
        return await safeJsonParse(response);
    } catch (error) {
        console.error('❌ API call failed:', url, error);
        throw error;
    }
}

// State
let wallet = null;
let selectedInterval = 15;
let currentMarketCap = 0;
let targetMarketCap = 0;
let roundEndTime = null; // FIXED: Store actual round end time from API
let tokenBalance = 0;

// FIXED: Store all round data
let allRounds = {
    15: null,
    60: null,
    240: null
};

// Round state - синхронизируется с window.currentRoundId из index.html
function getCurrentRoundId() {
    return window.currentRoundId || 1;
}

// FIXED: Get interval minutes for current round
function getCurrentInterval() {
    const roundId = getCurrentRoundId();
    if (roundId === 1) return 15;
    if (roundId === 2) return 60;
    if (roundId === 3) return 240;
    return 15;
}

// Trading state
let orderBookData = { higher: [], lower: [] };
let ammPrices = { higher: 0.5, lower: 0.5 };
let recentTrades = [];
let selectedSide = 'higher';
let selectedOrderType = 'market';
let userOrders = [];  // NEW: Track user's active orders
let userPositions = []; // NEW: Track user's positions
let userSettlements = [];
let currentSettlementTab = 'unclaimed';
// ============================================
// КОШЕЛЬКИ
// ============================================
const WALLETS = {
    phantom: {
        name: 'Phantom',
        icon: '👻',
        color: '#AB9FF2',
        get: () => {
            if (window.phantom?.solana?.isPhantom) {
                return window.phantom.solana;
            }
            if (window.solana?.isPhantom) {
                return window.solana;
            }
            return null;
        }
    },
    solflare: {
        name: 'Solflare',
        icon: '🔥',
        color: '#FC6C2C',
        get: () => window.solflare || (window.solana?.isSolflare ? window.solana : null)
    },
    coinbase: {
        name: 'Coinbase',
        icon: '💼',
        color: '#0052FF',
        get: () => window.coinbaseSolana || (window.solana?.isCoinbaseWallet ? window.solana : null)
    }
};

function renderWallets() {
    const container = document.getElementById('walletsList');
    
    container.innerHTML = Object.entries(WALLETS).map(([key, info]) => `
        <div class="wallet-option" onclick="connectWallet('${key}')" style="border-left: 3px solid ${info.color}">
            <span style="font-size: 2em; margin-right: 15px;">${info.icon}</span>
            <div>
                <div style="font-weight: 600; font-size: 1.1em;">${info.name}</div>
                <div style="font-size: 0.85em; color: var(--text-dim);">
                    ${info.get() ? 'Обнаружен' : 'Не установлен'}
                </div>
            </div>
        </div>
    `).join('');
}

async function connectWallet(walletType) {
    try {
        const walletInfo = WALLETS[walletType];
        const provider = walletInfo.get();
        
        if (!provider) {
            alert(`${walletInfo.name} не установлен!\n\nУстанови расширение браузера или приложение.`);
            return;
        }
        
        const response = await provider.connect();
        wallet = response.publicKey.toString();
        
        console.log('✅ Подключен:', wallet);
        
        closeModal();
        updateUI(true);
        await fetchTokenBalance();
        
        provider.on('disconnect', () => {
            console.log('🔌 Кошелек отключен');
            disconnect();
        });
        
    } catch (error) {
        console.error('❌ Ошибка подключения:', error);
        alert('Ошибка подключения кошелька');
    }
}

async function disconnect() {
    try {
        for (const info of Object.values(WALLETS)) {
            const provider = info.get();
            if (provider?.isConnected) {
                await provider.disconnect();
            }
        }
    } catch (error) {
        console.error('❌ Ошибка отключения:', error);
    }
    
    wallet = null;
    updateUI(false);
}

// ============================================
// TOKEN BALANCE (кастодиальная модель — из БД)
// ============================================
let balanceAvailable = 0;
let balanceLocked = 0;
let depositAddress = '';

async function fetchTokenBalance() {
    if (!wallet) {
        tokenBalance = 0;
        balanceAvailable = 0;
        balanceLocked = 0;
        updateBalanceDisplay();
        return;
    }

    try {
        const apiResponse = await fetch(`${API_BASE}/api/balance?wallet=${wallet}`);
        
        if (apiResponse.ok) {
            const data = await apiResponse.json();
            
            if (data.success) {
                balanceAvailable = data.available || 0;
                balanceLocked = data.locked || 0;
                tokenBalance = balanceAvailable;
                depositAddress = data.depositAddress || '';
                console.log(`✅ Баланс: ${balanceAvailable} доступно, ${balanceLocked} заблокировано`);
                updateBalanceDisplay();
                return;
            }
        }
        
        tokenBalance = 0;
        balanceAvailable = 0;
        balanceLocked = 0;
        updateBalanceDisplay();

    } catch (error) {
        console.error('❌ Ошибка получения баланса:', error);
        tokenBalance = 0;
        balanceAvailable = 0;
        balanceLocked = 0;
        updateBalanceDisplay();
    }
}

function updateBalanceDisplay() {
    const formatted = balanceAvailable.toLocaleString('en-US', { 
        minimumFractionDigits: 0,
        maximumFractionDigits: 2 
    });
    
    document.getElementById('tokenBalance').textContent = formatted;
    
    const lockedEl = document.getElementById('lockedBalance');
    if (lockedEl) {
        if (balanceLocked > 0) {
            lockedEl.textContent = `🔒 ${balanceLocked.toLocaleString('en-US', { maximumFractionDigits: 2 })} в ордерах`;
        } else {
            lockedEl.textContent = '';
        }
    }
}

// ============================================
// DEPOSIT — через Phantom подпись SPL-transfer
// ============================================

let platformDepositInfo = null; // { depositAddress, depositAta, tokenMint, minDeposit, decimals }
let walletOnChainBalance = 0;   // On-chain баланс для MAX кнопки

function openDepositModal() {
    if (!wallet) {
        alert('Сначала подключите кошелёк!');
        return;
    }
    
    document.getElementById('depositModal').style.display = 'flex';
    document.getElementById('depositStep1').style.display = 'block';
    document.getElementById('depositResult').style.display = 'none';
    document.getElementById('depositAmount').value = '';
    
    // Запросить инфо о депозитном адресе + on-chain баланс
    loadDepositInfo();
}

function closeDepositModal() {
    document.getElementById('depositModal').style.display = 'none';
}

async function loadDepositInfo() {
    try {
        // Всегда запрашиваем свежие данные (blockhash устаревает быстро)
        const infoResp = await fetch(`${API_BASE}/api/balance`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'deposit-info' })
        });
        const info = await infoResp.json();
        if (info.success) {
            platformDepositInfo = info;
            if (info.minDeposit) {
                const el = document.getElementById('minDepositAmount');
                if (el) el.textContent = info.minDeposit;
            }
            console.log('✅ Deposit info loaded, blockhash:', info.blockhash ? 'yes' : 'no');
        }
        
        // Получаем on-chain баланс токена (для MAX)
        await fetchOnChainTokenBalance();
    } catch (e) {
        console.error('❌ loadDepositInfo:', e);
    }
}

async function fetchOnChainTokenBalance() {
    if (!wallet || !platformDepositInfo) return;
    
    try {
        const provider = window.phantom?.solana || window.solana;
        if (!provider) { walletOnChainBalance = 0; return; }
        
        // Используем Phantom для RPC запроса через его встроенное соединение
        const { PublicKey } = solanaWeb3;
        const tokenMint = platformDepositInfo.tokenMint || TOKEN_ADDRESS;
        
        // Пробуем через несколько RPC (Phantom часто проксирует)
        const rpcUrls = [
            'https://rpc.ankr.com/solana',
            'https://solana-mainnet.g.alchemy.com/v2/demo',
        ];
        
        for (const rpcUrl of rpcUrls) {
            try {
                const resp = await fetch(rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0', id: 1,
                        method: 'getTokenAccountsByOwner',
                        params: [
                            wallet,
                            { mint: tokenMint },
                            { encoding: 'jsonParsed' }
                        ]
                    })
                });
                
                const data = await resp.json();
                if (data.result?.value?.length > 0) {
                    walletOnChainBalance = data.result.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
                    return;
                } else if (data.result) {
                    walletOnChainBalance = 0;
                    return;
                }
            } catch (e) {
                continue;
            }
        }
        
        walletOnChainBalance = 0;
    } catch (e) {
        console.error('❌ fetchOnChainTokenBalance:', e);
        walletOnChainBalance = 0;
    }
}

function setMaxDeposit() {
    document.getElementById('depositAmount').value = Math.floor(walletOnChainBalance);
}

async function executeDeposit() {
    const amount = parseFloat(document.getElementById('depositAmount').value);
    
    if (!amount || amount <= 0) {
        alert('Введите сумму!');
        return;
    }
    
    if (!platformDepositInfo) {
        alert('Ошибка: не удалось загрузить информацию о депозите. Попробуйте закрыть и открыть окно.');
        return;
    }
    
    const btn = document.getElementById('executeDepositBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Подготовка...';
    
    try {
        // Получаем провайдер Phantom
        const provider = window.phantom?.solana || window.solana;
        if (!provider?.isPhantom) {
            throw new Error('Phantom не найден');
        }
        
        const { PublicKey, Transaction, TransactionInstruction } = solanaWeb3;
        
        const mintPubkey = new PublicKey(platformDepositInfo.tokenMint);
        const senderPubkey = new PublicKey(wallet);
        const recipientAta = new PublicKey(platformDepositInfo.depositAta);
        
        // Получаем ATA отправителя
        const senderAta = await getAssociatedTokenAddressJS(mintPubkey, senderPubkey);
        
        // Формируем SPL transfer instruction
        const rawAmount = Math.floor(amount * Math.pow(10, platformDepositInfo.decimals || 6));
        
        const transferIx = createTransferInstructionJS(
            senderAta,       // source ATA
            recipientAta,    // destination ATA (платформа)
            senderPubkey,    // owner (подписант)
            rawAmount
        );
        
        const transaction = new Transaction();
        transaction.add(transferIx);
        
        // Blockhash уже получен от бэкенда (через Helius RPC на сервере)
        btn.textContent = '⏳ Подготовка транзакции...';
        
        let blockhash = platformDepositInfo.blockhash;
        
        // Если blockhash устарел или отсутствует — запросить свежий от бэкенда
        if (!blockhash) {
            try {
                const freshInfo = await fetch(`${API_BASE}/api/balance`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'deposit-info' })
                });
                const freshData = await freshInfo.json();
                if (freshData.success && freshData.blockhash) {
                    blockhash = freshData.blockhash;
                    platformDepositInfo = freshData;
                }
            } catch (e) {
                console.error('Failed to refresh blockhash:', e);
            }
        }
        
        if (!blockhash) {
            throw new Error('Не удалось получить blockhash. Проверьте подключение.');
        }
        
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = senderPubkey;
        
        btn.textContent = '⏳ Подтвердите в Phantom...';
        
        // signAndSendTransaction — Phantom сам получит blockhash, подпишет и отправит
        const { signature } = await provider.signAndSendTransaction(transaction);
        
        btn.textContent = '⏳ Ожидаем подтверждение...';
        
        // Ждём подтверждения — поллим через бэкенд или просто ждём
        // Phantom уже отправил, ждём 5-10 сек для индексации
        await new Promise(r => setTimeout(r, 6000));
        
        btn.textContent = '⏳ Зачисляем баланс...';
        
        // Подтверждаем на бэкенде (с ретраем)
        let data = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const confirmResp = await fetch(`${API_BASE}/api/balance`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'confirm-deposit',
                        wallet: wallet,
                        txSignature: signature
                    })
                });
                data = await confirmResp.json();
                if (data.success) break;
            } catch (e) {
                console.error(`Attempt ${attempt + 1} confirm:`, e);
            }
            if (attempt < 2) await new Promise(r => setTimeout(r, 4000));
        }
        
        const resultEl = document.getElementById('depositResult');
        document.getElementById('depositStep1').style.display = 'none';
        resultEl.style.display = 'block';
        
        if (data && data.success) {
            resultEl.innerHTML = `
                <div style="font-size: 3em; margin-bottom: 15px;">✅</div>
                <div style="font-size: 1.3em; font-weight: 700; color: var(--accent-green); margin-bottom: 10px;">
                    Депозит зачислен!
                </div>
                <div style="font-size: 1.5em; font-weight: 700; margin-bottom: 10px;">
                    +${data.amount} токенов
                </div>
                <div style="margin-bottom: 15px;">
                    <a href="https://solscan.io/tx/${signature}" target="_blank" style="color: var(--accent-yellow); text-decoration: underline; font-size: 0.85em;">
                        Транзакция в Solscan →
                    </a>
                </div>
                <button onclick="closeDepositModal()" style="padding: 12px 30px; background: var(--accent-green); color: #000; border: none; font-weight: 700; cursor: pointer; font-family: inherit; border-radius: 6px; font-size: 1em;">
                    ГОТОВО
                </button>
            `;
            await fetchTokenBalance();
        } else {
            resultEl.innerHTML = `
                <div style="font-size: 3em; margin-bottom: 15px;">⚠️</div>
                <div style="font-size: 1.1em; font-weight: 700; color: var(--accent-yellow); margin-bottom: 10px;">
                    Токены отправлены!
                </div>
                <div style="color: var(--text-dim); margin-bottom: 10px; font-size: 0.9em;">
                    Зачисление может занять до 1-2 минут.
                    ${data?.error ? `<br><span style="font-size:0.85em">(${data.error})</span>` : ''}
                </div>
                <div style="margin-bottom: 20px;">
                    <a href="https://solscan.io/tx/${signature}" target="_blank" style="color: var(--accent-yellow); text-decoration: underline; font-size: 0.85em;">
                        Транзакция в Solscan →
                    </a>
                </div>
                <button onclick="closeDepositModal()" style="padding: 12px 30px; background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); font-weight: 700; cursor: pointer; font-family: inherit; border-radius: 6px;">
                    ЗАКРЫТЬ
                </button>
            `;
            setTimeout(() => fetchTokenBalance(), 15000);
        }
        
    } catch (error) {
        console.error('❌ Deposit error:', error);
        
        if (error.message?.includes('User rejected') || error.message?.includes('rejected')) {
            btn.disabled = false;
            btn.textContent = '✅ ПОПОЛНИТЬ ЧЕРЕЗ PHANTOM';
            return;
        }
        
        const resultEl = document.getElementById('depositResult');
        document.getElementById('depositStep1').style.display = 'none';
        resultEl.style.display = 'block';
        resultEl.innerHTML = `
            <div style="font-size: 3em; margin-bottom: 15px;">❌</div>
            <div style="font-size: 1.1em; font-weight: 700; color: var(--accent-red); margin-bottom: 10px;">
                Ошибка
            </div>
            <div style="color: var(--text-dim); margin-bottom: 20px; font-size: 0.9em;">
                ${error.message || 'Неизвестная ошибка'}
            </div>
            <button onclick="document.getElementById('depositStep1').style.display='block'; document.getElementById('depositResult').style.display='none';" style="padding: 12px 30px; background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); font-weight: 700; cursor: pointer; font-family: inherit; border-radius: 6px;">
                ПОПРОБОВАТЬ СНОВА
            </button>
        `;
    } finally {
        btn.disabled = false;
        btn.textContent = '✅ ПОПОЛНИТЬ ЧЕРЕЗ PHANTOM';
    }
}

// ============================================
// SPL HELPERS (чистый JS, без импорта @solana/spl-token)
// ============================================

// Вычисляет Associated Token Address
async function getAssociatedTokenAddressJS(mint, owner) {
    const { PublicKey } = solanaWeb3;
    const SPL_TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const SPL_ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    
    const [address] = await PublicKey.findProgramAddress(
        [owner.toBuffer(), SPL_TOKEN.toBuffer(), mint.toBuffer()],
        SPL_ATA
    );
    return address;
}

// Создаёт SPL Transfer Instruction
function createTransferInstructionJS(source, destination, owner, amount) {
    const { PublicKey, TransactionInstruction } = solanaWeb3;
    const SPL_TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    
    // SPL Token Transfer instruction layout:
    // byte 0: instruction index (3 = Transfer)
    // bytes 1-8: amount (u64 little-endian)
    const data = new Uint8Array(9);
    data[0] = 3; // Transfer instruction
    
    // Write u64 little-endian
    let amt = BigInt(amount);
    for (let i = 1; i < 9; i++) {
        data[i] = Number(amt & 0xFFn);
        amt >>= 8n;
    }
    
    return new TransactionInstruction({
        keys: [
            { pubkey: source, isSigner: false, isWritable: true },
            { pubkey: destination, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: true, isWritable: false },
        ],
        programId: SPL_TOKEN,
        data,
    });
}

// ============================================
// WITHDRAW
// ============================================

function openWithdrawModal() {
    if (!wallet) {
        alert('Сначала подключите кошелёк!');
        return;
    }
    
    document.getElementById('withdrawModal').style.display = 'flex';
    document.getElementById('withdrawStep1').style.display = 'block';
    document.getElementById('withdrawResult').style.display = 'none';
    document.getElementById('withdrawAmount').value = '';
    document.getElementById('withdrawAvailable').textContent = balanceAvailable.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function closeWithdrawModal() {
    document.getElementById('withdrawModal').style.display = 'none';
}

function setMaxWithdraw() {
    document.getElementById('withdrawAmount').value = Math.floor(balanceAvailable);
}

async function processWithdraw() {
    const amount = parseFloat(document.getElementById('withdrawAmount').value);
    
    if (!amount || amount <= 0) {
        alert('Введите сумму!');
        return;
    }
    
    if (amount > balanceAvailable) {
        alert(`Недостаточно средств! Доступно: ${balanceAvailable}`);
        return;
    }
    
    const btn = document.getElementById('processWithdrawBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Отправляем токены...';
    
    try {
        const response = await fetch(`${API_BASE}/api/balance`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'withdraw',
                wallet: wallet,
                amount: amount
            })
        });
        
        const data = await response.json();
        
        const resultEl = document.getElementById('withdrawResult');
        document.getElementById('withdrawStep1').style.display = 'none';
        resultEl.style.display = 'block';
        
        if (data.success) {
            resultEl.innerHTML = `
                <div style="font-size: 3em; margin-bottom: 15px;">✅</div>
                <div style="font-size: 1.3em; font-weight: 700; color: var(--accent-green); margin-bottom: 10px;">
                    Вывод выполнен!
                </div>
                <div style="font-size: 1.5em; font-weight: 700; margin-bottom: 10px;">
                    -${data.amount} токенов
                </div>
                ${data.fee > 0 ? `<div style="color: var(--text-dim); font-size: 0.85em; margin-bottom: 5px;">Комиссия: ${data.fee}</div>` : ''}
                <div style="margin-bottom: 20px;">
                    <a href="https://solscan.io/tx/${data.txSignature}" target="_blank" style="color: var(--accent-yellow); text-decoration: underline; font-size: 0.85em;">
                        Транзакция в Solscan →
                    </a>
                </div>
                <button onclick="closeWithdrawModal()" style="padding: 12px 30px; background: var(--accent-green); color: #000; border: none; font-weight: 700; cursor: pointer; font-family: inherit; border-radius: 6px; font-size: 1em;">
                    ГОТОВО
                </button>
            `;
            
            await fetchTokenBalance();
        } else {
            resultEl.innerHTML = `
                <div style="font-size: 3em; margin-bottom: 15px;">❌</div>
                <div style="font-size: 1.1em; font-weight: 700; color: var(--accent-red); margin-bottom: 10px;">
                    Ошибка вывода
                </div>
                <div style="color: var(--text-dim); margin-bottom: 20px; font-size: 0.9em;">
                    ${data.error || 'Неизвестная ошибка'}
                </div>
                <button onclick="document.getElementById('withdrawStep1').style.display='block'; document.getElementById('withdrawResult').style.display='none';" style="padding: 12px 30px; background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); font-weight: 700; cursor: pointer; font-family: inherit; border-radius: 6px; font-size: 1em;">
                    ПОПРОБОВАТЬ СНОВА
                </button>
            `;
        }
    } catch (error) {
        console.error('❌ Withdraw error:', error);
        alert('Ошибка сети. Попробуйте ещё раз.');
    } finally {
        btn.disabled = false;
        btn.textContent = '📤 ВЫВЕСТИ';
    }
}

// ============================================
// UI UPDATES
// ============================================
function updateUI(connected) {
    const dot = document.getElementById('statusDot');
    const status = document.getElementById('walletStatus');
    const btn = document.getElementById('connectBtn');

    if (connected && wallet) {
        dot.className = 'status-dot status-connected';
        status.textContent = wallet.slice(0, 4) + '...' + wallet.slice(-4);
        btn.textContent = 'ОТКЛЮЧИТЬ';
        btn.onclick = disconnect;
    } else {
        dot.className = 'status-dot status-disconnected';
        status.textContent = 'НЕ ПОДКЛЮЧЕН';
        btn.textContent = 'ПОДКЛЮЧИТЬ';
        btn.onclick = openModal;
        tokenBalance = 0;
        updateBalanceDisplay();
    }
}

function openModal() {
    renderWallets();
    document.getElementById('walletModal').classList.add('active');
}

function closeModal() {
    document.getElementById('walletModal').classList.remove('active');
}

// ============================================
// MARKET DATA
// ============================================
async function fetchMarketCap() {
    try {
        const response = await fetch(`${API_BASE}/api/marketcap?token=${TOKEN_ADDRESS}&t=${Date.now()}`);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.success && data.marketCap > 0) {
            return data.marketCap;
        } else {
            throw new Error(data.error || 'No data');
        }
        
    } catch (error) {
        console.error('❌ Market cap fetch error:', error.message);
        return currentMarketCap || 0;
    }
}

async function updateMarketCap() {
    const newCap = await fetchMarketCap();
    
    if (newCap > 0) {
        currentMarketCap = newCap;
        
        const formatted = currentMarketCap >= 1000000 
            ? `$${(currentMarketCap / 1000000).toFixed(2)}M`
            : currentMarketCap >= 1000
            ? `$${(currentMarketCap / 1000).toFixed(1)}K`
            : `$${currentMarketCap.toFixed(2)}`;
        
        document.getElementById('currentCap').textContent = formatted;
    }
}

// ============================================
// FIXED: FETCH ALL ROUNDS DATA
// ============================================
async function fetchAllRounds() {
    try {
        const response = await fetch(`${API_BASE}/api/orders?action=all-rounds`);
        const data = await response.json();
        
        if (data.success && data.rounds) {
            data.rounds.forEach(round => {
                allRounds[round.interval_minutes] = {
                    id: round.id,
                    slug: round.slug,
                    interval_minutes: round.interval_minutes,
                    start_time: new Date(round.start_time),
                    end_time: new Date(round.end_time),
                    status: round.status
                };
            });
            
            // Update tab times
            updateAllRoundTabs();
            
            // Update countdown for current round
            const currentInterval = getCurrentInterval();
            if (allRounds[currentInterval]) {
                roundEndTime = allRounds[currentInterval].end_time;
            }
            
            console.log('✅ Loaded all rounds:', allRounds);
        }
    } catch (error) {
        console.error('❌ Failed to fetch all rounds:', error);
    }
}

// ============================================
// ORDER BOOK & TRADING
// ============================================
async function fetchOrderBook() {
    try {
        const intervalMinutes = getCurrentInterval();
        const response = await fetch(`${API_BASE}/api/orders?action=orderbook&intervalMinutes=${intervalMinutes}`);
        //                            ↑ ДОБАВИЛ (
        const data = await response.json();
        
        if (data.success) {
            orderBookData = data.orderBook;
            ammPrices = data.ammPrice;
            
            // ✅ ДОБАВЬ ЭТО: Установи targetMarketCap ОДИН РАЗ из данных раунда
            if (data.startMarketCap && parseFloat(data.startMarketCap) > 0) {
                targetMarketCap = parseFloat(data.startMarketCap);
                console.log(`🎯 Target market cap set: $${targetMarketCap}`);
                //          ↑ ДОБАВИЛ (
            }
            
            // DEBUG: Log orderbook data
            console.log('📖 OrderBook loaded:', {
                higher: orderBookData.higher.length,
                lower: orderBookData.lower.length,
                higherOrders: orderBookData.higher,
                lowerOrders: orderBookData.lower
            });
            
            // FIXED: Update round end time from API
            if (data.endTime) {
                roundEndTime = new Date(data.endTime);
            }
            
            // Update round info if available
            if (data.roundId) {
                updateRoundInfo(data);
            }
            
            renderOrderBook();
            updatePriceStats();
        }
    } catch (error) {
        console.error('❌ Order book fetch error:', error);
    }
}

function updateRoundInfo(data) {
    // This will be called from fetchOrderBook when we get round data
    // For now, just log it
    if (data.roundNumber) {
        console.log(`📊 Round #${data.roundNumber}`);
    }
}

function renderOrderBook() {
    const higherEl = document.getElementById('orderBookHigher');
    const lowerEl = document.getElementById('orderBookLower');
    
    // Determine which side is "asks" and which is "bids" based on currentTradeSide
    // When trading HIGHER: higher orders are asks (sell side), lower are bids (buy side)  
    // When trading LOWER: lower orders are asks, higher are bids — FLIP the book
    const side = (typeof currentTradeSide !== 'undefined') ? currentTradeSide : 'higher';
    
    let asksData, bidsData, asksColor, bidsColor, asksBarColor, bidsBarColor;
    
    if (side === 'higher') {
        // Normal: higher = asks (top, green), lower = bids (bottom, red)
        asksData = orderBookData.higher;
        bidsData = orderBookData.lower;
        asksColor = 'text-green';
        bidsColor = 'text-red';
        asksBarColor = 'rgba(0, 255, 159, 0.2)';
        bidsBarColor = 'rgba(255, 71, 87, 0.2)';
    } else {
        // Flipped: lower = asks (top, red), higher = bids (bottom, green)
        asksData = orderBookData.lower;
        bidsData = orderBookData.higher;
        asksColor = 'text-red';
        bidsColor = 'text-green';
        asksBarColor = 'rgba(255, 71, 87, 0.2)';
        bidsBarColor = 'rgba(0, 255, 159, 0.2)';
    }
    
    // Render ASKS (top section)
    if (asksData.length === 0) {
        higherEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-dim);">Нет ордеров</div>';
    } else {
        const maxAmount = Math.max(...asksData.map(o => o.amount));
        higherEl.innerHTML = asksData.map(order => {
            const pct = (order.amount / maxAmount) * 100;
            return `
                <div class="order-book-row" onclick="fillFromOrderBook(${order.price}, ${order.amount})" style="cursor: pointer;" title="Нажмите чтобы подставить">
                    <div class="order-bar" style="width: ${pct}%; background: linear-gradient(90deg, transparent, ${asksBarColor});"></div>
                    <div style="display: flex; justify-content: space-between; position: relative; z-index: 1;">
                        <span class="${asksColor}">${order.price.toFixed(4)}</span>
                        <span>${order.amount.toFixed(0)}</span>
                    </div>
                </div>
            `;
        }).join('');
    }
    
    // Render BIDS (bottom section)
    if (bidsData.length === 0) {
        lowerEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-dim);">Нет ордеров</div>';
    } else {
        const maxAmount = Math.max(...bidsData.map(o => o.amount));
        lowerEl.innerHTML = bidsData.map(order => {
            const pct = (order.amount / maxAmount) * 100;
            return `
                <div class="order-book-row" onclick="fillFromOrderBook(${order.price}, ${order.amount})" style="cursor: pointer;" title="Нажмите чтобы подставить">
                    <div class="order-bar" style="width: ${pct}%; background: linear-gradient(90deg, transparent, ${bidsBarColor});"></div>
                    <div style="display: flex; justify-content: space-between; position: relative; z-index: 1;">
                        <span class="${bidsColor}">${order.price.toFixed(4)}</span>
                        <span>${order.amount.toFixed(0)}</span>
                    </div>
                </div>
            `;
        }).join('');
    }
}

// Click orderbook row → fill price & amount into trade form, switch to limit
function fillFromOrderBook(price, amount) {
    // Switch to limit mode
    switchOrderType('limit');
    
    // Fill price and amount
    const priceInput = document.getElementById('tradePrice');
    const amountInput = document.getElementById('tradeAmount');
    
    if (priceInput) priceInput.value = price;
    if (amountInput) amountInput.value = Math.floor(amount);
    
    // Recalculate estimate
    if (typeof calculateUnifiedEstimate === 'function') {
        calculateUnifiedEstimate();
    }
}

window.fillFromOrderBook = fillFromOrderBook;

function updatePriceStats() {
    document.getElementById('statHigherPrice').textContent = ammPrices.higher.toFixed(3);
    document.getElementById('statLowerPrice').textContent = ammPrices.lower.toFixed(3);
    
    // Update Polymarket-style side buttons
    if (typeof updateSideOdds === 'function') updateSideOdds();
    
    // Целевая капа: берём start_market_cap раунда, если он есть
    const capToShow = targetMarketCap > 0 ? targetMarketCap : currentMarketCap;
    
    if (capToShow > 0) {
        const formatted = capToShow >= 1000000 
            ? `$${(capToShow / 1000000).toFixed(2)}M`
            : capToShow >= 1000
            ? `$${(capToShow / 1000).toFixed(1)}K`
            : `$${capToShow.toFixed(2)}`;
        
        document.getElementById('targetCap').textContent = formatted;
    } else {
        document.getElementById('targetCap').textContent = '$---';
    }
}

// ============================================
// TRADE HISTORY
// ============================================
async function fetchRecentTrades() {
    try {
        const intervalMinutes = getCurrentInterval();
        const response = await fetch(`${API_BASE}/api/orders?action=trades&intervalMinutes=${intervalMinutes}`);
        const data = await response.json();
        
        if (data.success) {
            recentTrades = data.trades;
            renderTradeHistory();
        }
    } catch (error) {
        console.error('❌ Trade history fetch error:', error);
    }
}

function renderTradeHistory() {
    const container = document.getElementById('tradeHistory');
    
    if (recentTrades.length === 0) {
        container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-dim);">Нет сделок</div>';
        return;
    }
    
    container.innerHTML = recentTrades.map(trade => {
        const time = new Date(trade.time).toLocaleTimeString('ru-RU');
        const sideClass = trade.side === 'higher' ? 'buy' : 'sell';
        const sideText = trade.side === 'higher' ? '⬆ ВЫШЕ' : '⬇ НИЖЕ';
        
        return `
            <div class="trade-item ${sideClass}">
                <div>
                    <div style="font-weight: 600;">${sideText}</div>
                    <div class="trade-time">${time}</div>
                </div>
                <div style="text-align: right;">
                    <div>${trade.amount.toFixed(0)} шт</div>
                    <div class="trade-time">@ ${trade.price.toFixed(3)}</div>
                </div>
            </div>
        `;
    }).join('');
}

// ============================================
// USER ORDERS & POSITIONS
// ============================================
async function fetchUserOrders() {
    if (!wallet) {
        userOrders = [];
        updateOrdersDisplay();
        return;
    }

    try {
        const intervalMinutes = getCurrentInterval();
        const response = await fetch(`${API_BASE}/api/orders?action=user-orders&wallet=${wallet}&intervalMinutes=${intervalMinutes}`);
        const data = await response.json();
        
        if (data.success) {
            userOrders = data.orders || [];
            updateOrdersDisplay();
        }
    } catch (error) {
        console.error('❌ Failed to fetch user orders:', error);
    }
}

async function fetchUserPositions() {
    if (!wallet) {
        userPositions = [];
        updatePositionsDisplay();
        return;
    }

    try {
        const intervalMinutes = getCurrentInterval();
        // FIXED: Get user trades instead of positions for counting
        const response = await fetch(`${API_BASE}/api/orders?action=user-trades&wallet=${wallet}&intervalMinutes=${intervalMinutes}`);
        const data = await response.json();
        
        if (data.success) {
            userPositions = data.trades || []; // Store trades for counting
            updatePositionsDisplay();
        }
    } catch (error) {
        console.error('❌ Failed to fetch user positions:', error);
    }
}

function updateOrdersDisplay() {
    // Update counter
    document.getElementById('activeOrdersCount').textContent = userOrders.length;
    
    // Update modal list if modal is open
    const modal = document.getElementById('myOrdersModal');
    if (modal && modal.classList.contains('active')) {
        updateMyOrdersModalList();
    }
}

function updatePositionsDisplay() {
    // FIXED: Display actual count of trades/positions
    document.getElementById('openPositionsCount').textContent = userPositions.length;
}

async function cancelOrder(orderId) {
    if (!wallet) {
        alert('Подключите кошелек');
        return;
    }
    
    if (!confirm('Отменить этот ордер?')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/orders?orderId=${orderId}&wallet=${wallet}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            alert('✅ Ордер отменен!');
            
            // Refresh data
            await Promise.all([
                fetchUserOrders(),
                fetchOrderBook(),
                fetchTokenBalance()
            ]);
        } else {
            alert(`Ошибка: ${result.error}`);
        }
    } catch (error) {
        console.error('❌ Failed to cancel order:', error);
        alert('Ошибка при отмене ордера');
    }
}

// ============================================
// MODAL FUNCTIONS FOR MY ORDERS AND MY TRADES
// ============================================
function openMyOrdersModal() {
    const modal = document.getElementById('myOrdersModal');
    modal.classList.add('active');
    fetchUserOrders(); // Load user orders
    // Update the modal list
    updateMyOrdersModalList();
}

function closeMyOrdersModal() {
    const modal = document.getElementById('myOrdersModal');
    modal.classList.remove('active');
}

function openMyTradesModal() {
    const modal = document.getElementById('myTradesModal');
    modal.classList.add('active');
    fetchUserTrades(); // Load user completed trades
}

function closeMyTradesModal() {
    const modal = document.getElementById('myTradesModal');
    modal.classList.remove('active');
}

function updateMyOrdersModalList() {
    const list = document.getElementById('myOrdersModalList');
    
    if (!wallet) {
        list.innerHTML = `
            <div style="padding: 20px; text-align: center; color: var(--text-dim);">
                Подключите кошелек для просмотра ордеров
            </div>
        `;
        return;
    }
    
    if (userOrders.length === 0) {
        list.innerHTML = `
            <div style="padding: 20px; text-align: center; color: var(--text-dim);">
                Нет активных ордеров
            </div>
        `;
        return;
    }
    
    // Получаем текущий интервал из выбранного раунда
    const currentInterval = getCurrentInterval();
    
    list.innerHTML = userOrders.map(order => {
        // Определяем название раунда
        let roundName = 'undefined';
        if (order.interval_minutes) {
            // Если API вернул interval_minutes - используем его
            if (order.interval_minutes === 15) roundName = '15m';
            else if (order.interval_minutes === 60) roundName = '1h';
            else if (order.interval_minutes === 240) roundName = '4h';
        } else {
            // Иначе используем текущий выбранный интервал
            if (currentInterval === 15) roundName = '15m';
            else if (currentInterval === 60) roundName = '1h';
            else if (currentInterval === 240) roundName = '4h';
        }
        
        // Считаем остаток токенов (если есть filled)
        const filled = order.filled || 0;
        const remaining = order.amount - filled;
        const showRemaining = filled > 0;
        
        // Определяем тип ордера
        const orderType = order.order_type || (order.price === 0 ? 'Маркет' : 'Лимит');
        
        return `
            <div class="trade-item" style="background: var(--bg-tertiary); padding: 15px; margin-bottom: 10px; border: 1px solid var(--border); border-radius: 4px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                    <div>
                        <span class="${order.side === 'higher' ? 'text-green' : 'text-red'}" style="font-weight: 600;">
                            ${order.side === 'higher' ? '⬆ ВЫШЕ' : '⬇ НИЖЕ'}
                        </span>
                        <span style="color: var(--text-dim); margin-left: 10px; font-size: 0.85em;">
                            ${orderType}
                        </span>
                    </div>
                    <div style="color: var(--text-dim); font-size: 0.85em;">
                        Раунд ${roundName}
                    </div>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-size: 0.85em; color: var(--text-secondary);">
                            Кол-во: <span style="color: var(--text-primary); font-weight: 600;">
                                ${showRemaining ? `${remaining.toFixed(0)} / ${order.amount.toFixed(0)}` : `${order.amount}`} токенов
                            </span>
                            ${showRemaining ? `<span style="color: var(--accent-yellow); font-size: 0.75em; margin-left: 5px;">(${((filled / order.amount) * 100).toFixed(1)}% исполнено)</span>` : ''}
                        </div>
                        <div style="font-size: 0.85em; color: var(--text-secondary);">
                            Цена: <span style="color: var(--accent-yellow); font-weight: 600;">${order.price.toFixed(3)}</span>
                        </div>
                    </div>
                    <button 
                        onclick="cancelOrder(${order.id})" 
                        style="padding: 8px 16px; background: var(--accent-red); color: #000; border: none; cursor: pointer; font-weight: 600; border-radius: 4px; font-size: 0.85em;"
                    >
                        Отменить
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function fetchUserTrades() {
    const list = document.getElementById('myTradesModalList');
    
    if (!wallet) {
        list.innerHTML = `
            <div style="padding: 20px; text-align: center; color: var(--text-dim);">
                Подключите кошелек для просмотра сделок
            </div>
        `;
        return;
    }
    
    // Show loading
    list.innerHTML = `
        <div style="padding: 20px; text-align: center; color: var(--text-dim);">
            Загрузка...
        </div>
    `;
    
    try {
        const intervalMinutes = getCurrentInterval();
        const response = await fetch(`${API_BASE}/api/orders?action=user-trades&wallet=${wallet}&intervalMinutes=${intervalMinutes}`);
        const data = await response.json();
        
        if (data.success && data.trades && data.trades.length > 0) {
            list.innerHTML = data.trades.map(trade => {
                const timestamp = new Date(trade.timestamp).toLocaleString('ru-RU', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                });
                
                // Определяем название раунда
                let roundName = 'undefined';
                if (trade.interval_minutes === 15) roundName = '15m';
                else if (trade.interval_minutes === 60) roundName = '1h';
                else if (trade.interval_minutes === 240) roundName = '4h';
                
                return `
                    <div class="trade-item" style="background: var(--bg-tertiary); padding: 15px; margin-bottom: 10px; border: 1px solid var(--border); border-radius: 4px;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                            <div>
                                <span class="${trade.side === 'higher' ? 'text-green' : 'text-red'}" style="font-weight: 600;">
                                    ${trade.side === 'higher' ? '⬆ ВЫШЕ' : '⬇ НИЖЕ'}
                                </span>
                                <span style="color: var(--text-dim); margin-left: 10px; font-size: 0.85em;">
                                    ${trade.order_type === 'market' ? 'Маркет' : 'Лимит'}
                                </span>
                            </div>
                            <div style="color: var(--text-dim); font-size: 0.85em;">
                                ${timestamp}
                            </div>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <div>
                                <div style="font-size: 0.85em; color: var(--text-secondary);">
                                    Кол-во: <span style="color: var(--text-primary); font-weight: 600;">${trade.amount} токенов</span>
                                </div>
                                <div style="font-size: 0.85em; color: var(--text-secondary);">
                                    Цена: <span style="color: var(--accent-yellow); font-weight: 600;">${trade.price.toFixed(3)}</span>
                                </div>
                            </div>
                            <div style="text-align: right;">
                                <div style="font-size: 0.85em; color: var(--text-secondary);">
                                    Раунд: <span style="color: var(--text-primary);">${roundName}</span>
                                </div>
                                ${trade.profit !== undefined ? `
                                    <div style="font-size: 0.85em; color: var(--text-secondary);">
                                        Прибыль: <span style="color: ${trade.profit >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}; font-weight: 600;">
                                            ${trade.profit >= 0 ? '+' : ''}${trade.profit.toFixed(2)} токенов
                                        </span>
                                    </div>
                                ` : ''}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            list.innerHTML = `
                <div style="padding: 20px; text-align: center; color: var(--text-dim);">
                    Нет завершенных сделок
                </div>
            `;
        }
    } catch (error) {
        console.error('❌ Failed to fetch user trades:', error);
        list.innerHTML = `
            <div style="padding: 20px; text-align: center; color: var(--accent-red);">
                Ошибка при загрузке сделок
            </div>
        `;
    }
}

// Close modals when clicking outside
window.onclick = function(event) {
    const ordersModal = document.getElementById('myOrdersModal');
    const tradesModal = document.getElementById('myTradesModal');
    
    if (event.target === ordersModal) {
        closeMyOrdersModal();
    }
    if (event.target === tradesModal) {
        closeMyTradesModal();
    }
}

// Make functions globally available
window.cancelOrder = cancelOrder;
window.openMyOrdersModal = openMyOrdersModal;
window.closeMyOrdersModal = closeMyOrdersModal;
window.openMyTradesModal = openMyTradesModal;
window.closeMyTradesModal = closeMyTradesModal;
window.updateMyOrdersModalList = updateMyOrdersModalList;

// ============================================
// TRADING INTERFACE
// ============================================
function switchOrderType(type) {
    selectedOrderType = type;
    
    document.querySelectorAll('.order-type-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    document.querySelectorAll(`.order-type-btn[data-type="${type}"]`).forEach(btn => {
        btn.classList.add('active');
    });
    
    // Show/hide price input for limit orders
    document.querySelectorAll('.limit-price-group').forEach(el => {
        el.style.display = type === 'limit' ? 'block' : 'none';
    });
}

async function calculateEstimate(side) {
    const amountInput = document.getElementById(`amount${side === 'higher' ? 'Higher' : 'Lower'}`);
    const amount = parseFloat(amountInput.value) || 0;
    
    if (amount <= 0) {
        updateEstimateDisplay(side, null);
        return;
    }
    
    if (selectedOrderType === 'market') {
        try {
            const intervalMinutes = getCurrentInterval();
            const response = await fetch(
                `${API_BASE}/api/orders?action=quote&side=${side}&amount=${amount}&intervalMinutes=${intervalMinutes}`
            );
            const data = await response.json();
            
            if (data.success) {
                updateEstimateDisplay(side, data);
            }
        } catch (error) {
            console.error('❌ Quote error:', error);
        }
    } else {
        // For limit orders, just show the specified price
        const priceInput = document.getElementById(`price${side === 'higher' ? 'Higher' : 'Lower'}`);
        const price = parseFloat(priceInput.value) || ammPrices[side];
        
        updateEstimateDisplay(side, {
            avgPrice: price,
            priceImpact: 0,
            [side === 'higher' ? 'lowerNeeded' : 'higherNeeded']: amount * price
        });
    }
}

function updateEstimateDisplay(side, data) {
    const container = document.getElementById(`estimate${side === 'higher' ? 'Higher' : 'Lower'}`);
    
    if (!data) {
        container.innerHTML = '<div style="color: var(--text-dim);">Введите сумму</div>';
        return;
    }
    
    const oppositeSide = side === 'higher' ? 'lower' : 'higher';
    const cost = data[`${oppositeSide}Needed`] || (data.avgPrice * parseFloat(
        document.getElementById(`amount${side === 'higher' ? 'Higher' : 'Lower'}`).value
    ));
    
    container.innerHTML = `
        <div class="estimate-row">
            <span>Средняя цена:</span>
            <span>${data.avgPrice.toFixed(4)}</span>
        </div>
        <div class="estimate-row">
            <span>Price Impact:</span>
            <span class="${data.priceImpact > 5 ? 'text-red' : 'text-green'}">
                ${data.priceImpact?.toFixed(2) || '0.00'}%
            </span>
        </div>
        <div class="estimate-row">
            <span>Итого:</span>
            <span class="text-yellow">${cost.toFixed(0)} токенов</span>
        </div>
    `;
}

async function executeTrade(side) {
    if (!wallet) {
        openModal();
        return;
    }
    
    const amountInput = document.getElementById(`amount${side === 'higher' ? 'Higher' : 'Lower'}`);
    const amount = parseFloat(amountInput.value) || 0;
    
    if (amount <= 0) {
        alert('Введите корректную сумму');
        return;
    }
    
    if (amount > tokenBalance) {
        alert('Недостаточно токенов');
        return;
    }
    
    // OPTIONAL: Uncomment to disable market orders when orderbook is empty
    // if (selectedOrderType === 'market') {
    //     const hasOrders = orderBookData.higher.length > 0 || orderBookData.lower.length > 0;
    //     if (!hasOrders) {
    //         alert('Невозможно разместить маркет ордер - стакан пуст. Используйте лимитный ордер.');
    //         return;
    //     }
    // }
    
    try {
        const intervalMinutes = getCurrentInterval();
        
        const orderData = {
            wallet,
            side,
            amount,
            type: selectedOrderType,
            intervalMinutes  // FIXED: Include interval instead of roundId
        };
        
        if (selectedOrderType === 'limit') {
            const priceInput = document.getElementById(`price${side === 'higher' ? 'Higher' : 'Lower'}`);
            const price = parseFloat(priceInput.value);
            
            if (!price || price <= 0 || price >= 1) {
                alert('Введите корректную цену (от 0 до 1)');
                return;
            }
            
            orderData.price = price;
        }
        
        const response = await fetch(`${API_BASE}/api/orders`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        const result = await response.json();
        
        console.log('📝 Order result:', result);
        
        if (result.success) {
            const sideText = side === 'higher' ? 'ВЫШЕ' : 'НИЖЕ';
            const typeText = selectedOrderType === 'market' ? 'Маркет' : 'Лимит';
            
            if (selectedOrderType === 'market' && result.trade) {
                let message = `✅ ${typeText} ордер на ${sideText} исполнен!\n\n`;
                message += `Количество: ${amount} токенов\n`;
                message += `Средняя цена: ${result.trade.price.toFixed(4)}\n`;
                
                if (result.trade.source === 'orderbook') {
                    message += `\n📊 Исполнено из стакана ордеров`;
                } else if (result.trade.source === 'mixed') {
                    message += `\n📊 Из стакана: ${result.trade.orderbookFilled} токенов`;
                    message += `\n🏦 Из AMM пула: ${result.trade.ammFilled} токенов`;
                } else if (result.trade.source === 'amm') {
                    message += `\n🏦 Исполнено из AMM пула`;
                }
                
                alert(message);
            } else if (selectedOrderType === 'limit' && result.order) {
                const matched = result.matched || 0;
                const remaining = result.order.amount - matched;
                
                if (matched > 0 && remaining > 0) {
                    alert(`✅ ${typeText} ордер на ${sideText} размещен!\n\n` +
                          `Исполнено сразу: ${matched} токенов\n` +
                          `Осталось в стакане: ${remaining} токенов`);
                } else if (matched > 0) {
                    alert(`✅ ${typeText} ордер на ${sideText} полностью исполнен!\n\n` +
                          `Количество: ${matched} токенов`);
                } else {
                    alert(`✅ ${typeText} ордер на ${sideText} размещен!\n\nКоличество: ${amount} токенов`);
                }
            } else {
                alert(`✅ ${typeText} ордер на ${sideText} размещен!\n\nКоличество: ${amount} токенов`);
            }
            
            // Reset form
            amountInput.value = '';
            if (selectedOrderType === 'limit') {
                document.getElementById(`price${side === 'higher' ? 'Higher' : 'Lower'}`).value = '';
            }
            
            // Refresh data
            await Promise.all([
                fetchOrderBook(),
                fetchRecentTrades(),
                fetchTokenBalance(),
                fetchUserOrders(),      // NEW: Refresh user orders
                fetchUserPositions()    // NEW: Refresh positions
            ]);
        } else {
            alert(`Ошибка: ${result.error}`);
        }
        
    } catch (error) {
        console.error('❌ Trade execution error:', error);
        alert('Ошибка при размещении ордера');
    }
}

// ============================================
// POLYMARKET-STYLE UNIFIED TRADING
// ============================================
let currentTradeSide = 'higher';

function switchTradeSide(side) {
    currentTradeSide = side;
    
    const higherBtn = document.getElementById('sideHigherBtn');
    const lowerBtn = document.getElementById('sideLowerBtn');
    const executeBtn = document.getElementById('tradeExecuteBtn');
    
    if (side === 'higher') {
        higherBtn.style.background = 'var(--accent-green)';
        higherBtn.style.color = '#000';
        higherBtn.style.border = 'none';
        lowerBtn.style.background = 'var(--bg-tertiary)';
        lowerBtn.style.color = 'var(--text-secondary)';
        lowerBtn.style.border = '1px solid var(--border)';
        executeBtn.style.background = 'var(--accent-green)';
        executeBtn.style.color = '#000';
        executeBtn.textContent = 'КУПИТЬ ВЫШЕ';
    } else {
        lowerBtn.style.background = 'var(--accent-red)';
        lowerBtn.style.color = '#fff';
        lowerBtn.style.border = 'none';
        higherBtn.style.background = 'var(--bg-tertiary)';
        higherBtn.style.color = 'var(--text-secondary)';
        higherBtn.style.border = '1px solid var(--border)';
        executeBtn.style.background = 'var(--accent-red)';
        executeBtn.style.color = '#fff';
        executeBtn.textContent = 'КУПИТЬ НИЖЕ';
    }
    
    // Recalculate estimate
    calculateUnifiedEstimate();
    
    // Re-render orderbook flipped for new side
    renderOrderBook();
}

async function calculateUnifiedEstimate() {
    const amount = parseFloat(document.getElementById('tradeAmount').value) || 0;
    const estimateEl = document.getElementById('tradeEstimate');
    
    if (amount <= 0) {
        estimateEl.innerHTML = '<div style="color: var(--text-dim);">Введите сумму</div>';
        return;
    }
    
    const side = currentTradeSide;
    
    if (selectedOrderType === 'market') {
        try {
            const intervalMinutes = getCurrentInterval();
            const response = await fetch(
                `${API_BASE}/api/orders?action=quote&side=${side}&amount=${amount}&intervalMinutes=${intervalMinutes}`
            );
            const data = await response.json();
            
            if (data.success) {
                const oppositeSide = side === 'higher' ? 'lower' : 'higher';
                const cost = data[`${oppositeSide}Needed`] || (data.avgPrice * amount);
                
                estimateEl.innerHTML = `
                    <div class="estimate-row">
                        <span>Средняя цена:</span>
                        <span>${data.avgPrice.toFixed(4)}</span>
                    </div>
                    <div class="estimate-row">
                        <span>Price Impact:</span>
                        <span class="${data.priceImpact > 5 ? 'text-red' : 'text-green'}">
                            ${data.priceImpact?.toFixed(2) || '0.00'}%
                        </span>
                    </div>
                    <div class="estimate-row">
                        <span>Итого:</span>
                        <span class="text-yellow">${cost.toFixed(0)} токенов</span>
                    </div>
                `;
            }
        } catch (error) {
            console.error('❌ Quote error:', error);
        }
    } else {
        const price = parseFloat(document.getElementById('tradePrice').value) || ammPrices[side];
        
        estimateEl.innerHTML = `
            <div class="estimate-row">
                <span>Цена:</span>
                <span>${price.toFixed(4)}</span>
            </div>
            <div class="estimate-row">
                <span>Итого:</span>
                <span class="text-yellow">${(amount * price).toFixed(0)} токенов</span>
            </div>
        `;
    }
}

async function executeUnifiedTrade() {
    // Delegate to existing executeTrade with current side
    // But use unified inputs
    if (!wallet) {
        openModal();
        return;
    }
    
    const amount = parseFloat(document.getElementById('tradeAmount').value) || 0;
    const side = currentTradeSide;
    
    if (amount <= 0) {
        alert('Введите корректную сумму');
        return;
    }
    
    if (amount > tokenBalance) {
        alert('Недостаточно токенов');
        return;
    }
    
    try {
        const intervalMinutes = getCurrentInterval();
        
        const orderData = {
            wallet,
            side,
            amount,
            type: selectedOrderType,
            intervalMinutes
        };
        
        if (selectedOrderType === 'limit') {
            const price = parseFloat(document.getElementById('tradePrice').value);
            
            if (!price || price <= 0 || price >= 1) {
                alert('Введите корректную цену (от 0 до 1)');
                return;
            }
            
            orderData.price = price;
        }
        
        const response = await fetch(`${API_BASE}/api/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderData)
        });
        
        const result = await response.json();
        console.log('📝 Order result:', result);
        
        if (result.success) {
            const sideText = side === 'higher' ? 'ВЫШЕ' : 'НИЖЕ';
            const typeText = selectedOrderType === 'market' ? 'Маркет' : 'Лимит';
            
            if (selectedOrderType === 'market' && result.trade) {
                let message = `✅ ${typeText} ордер на ${sideText} исполнен!\n\n`;
                message += `Количество: ${amount} токенов\n`;
                message += `Средняя цена: ${result.trade.price.toFixed(4)}\n`;
                
                if (result.trade.source === 'orderbook') {
                    message += `\n📊 Исполнено из стакана ордеров`;
                } else if (result.trade.source === 'mixed') {
                    message += `\n📊 Из стакана: ${result.trade.orderbookFilled} токенов`;
                    message += `\n🏦 Из AMM пула: ${result.trade.ammFilled} токенов`;
                } else if (result.trade.source === 'amm') {
                    message += `\n🏦 Исполнено из AMM пула`;
                }
                
                alert(message);
            } else {
                alert(`✅ ${typeText} ордер на ${sideText} размещен!\n\nКоличество: ${amount} токенов`);
            }
            
            // Reset
            document.getElementById('tradeAmount').value = '';
            document.getElementById('tradeEstimate').innerHTML = '<div style="color: var(--text-dim);">Введите сумму</div>';
            
            // Refresh data
            await Promise.all([
                fetchOrderBook(),
                fetchRecentTrades(),
                fetchTokenBalance(),
                fetchUserOrders(),
                fetchUserPositions()
            ]);
        } else {
            alert(`Ошибка: ${result.error}`);
        }
    } catch (error) {
        console.error('❌ Trade execution error:', error);
        alert('Ошибка при размещении ордера');
    }
}

// Update side odds when prices update
function updateSideOdds() {
    const ho = document.getElementById('sideHigherOdds');
    const lo = document.getElementById('sideLowerOdds');
    if (ho) ho.textContent = ammPrices.higher.toFixed(3);
    if (lo) lo.textContent = ammPrices.lower.toFixed(3);
}

// Attach input listener for unified trade
document.addEventListener('DOMContentLoaded', function() {
    const tradeAmountInput = document.getElementById('tradeAmount');
    const tradePriceInput = document.getElementById('tradePrice');
    
    if (tradeAmountInput) {
        let debounceTimer;
        tradeAmountInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(calculateUnifiedEstimate, 300);
        });
    }
    if (tradePriceInput) {
        tradePriceInput.addEventListener('input', () => {
            calculateUnifiedEstimate();
        });
    }
});

// Make new functions globally available
window.switchTradeSide = switchTradeSide;
window.executeUnifiedTrade = executeUnifiedTrade;
window.openDepositModal = openDepositModal;
window.closeDepositModal = closeDepositModal;
window.setMaxDeposit = setMaxDeposit;
window.executeDeposit = executeDeposit;
window.openWithdrawModal = openWithdrawModal;
window.closeWithdrawModal = closeWithdrawModal;
window.setMaxWithdraw = setMaxWithdraw;
window.processWithdraw = processWithdraw;
window.calculateUnifiedEstimate = calculateUnifiedEstimate;

// ============================================
// РАУНДЫ
// ============================================
async function loadRoundData() {
    await fetchAllRounds();
}

// Make this function available globally for index.html to call
window.loadMarketData = async function() {
    const intervalMinutes = getCurrentInterval();
    console.log(`📊 Loading data for ${intervalMinutes}m round`);
    // Сбрасываем целевую капу при смене раунда — fetchOrderBook() установит новую
    targetMarketCap = 0;
    await Promise.all([
        fetchOrderBook(),
        fetchRecentTrades(),
        fetchUserOrders(),      // NEW: Load user orders
        fetchUserPositions()    // NEW: Load positions
    ]);
};

// FIXED: Update countdown with real round end time
function updateCountdown() {
    if (!roundEndTime) {
        document.getElementById('countdown').textContent = '--:--';
        return;
    }
    
    const now = Date.now();
    const remaining = roundEndTime.getTime() - now;
    
    if (remaining <= 0) {
        document.getElementById('countdown').textContent = '00:00';
        // Reload round data when time expires
        fetchAllRounds();
        return;
    }
    
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    
    document.getElementById('countdown').textContent = 
        `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// FIXED: Update all round tabs with proper time display
function updateAllRoundTabs() {
    [15, 60, 240].forEach((interval, index) => {
        const roundData = allRounds[interval];
        const tabElement = document.getElementById(`round-${index + 1}-time`);
        
        if (!tabElement) return;
        
        if (roundData && roundData.end_time) {
            const now = Date.now();
            const remaining = roundData.end_time.getTime() - now;
            
            if (remaining > 0) {
                const minutes = Math.floor(remaining / 60000);
                const seconds = Math.floor((remaining % 60000) / 1000);
                tabElement.textContent = `Закрывается через ${minutes}:${String(seconds).padStart(2, '0')}`;
            } else {
                tabElement.textContent = 'Закрыт';
            }
        } else {
            tabElement.textContent = 'Загрузка...';
        }
    });
}

// ============================================
// EVENT LISTENERS
// ============================================
document.getElementById('closeModal').onclick = closeModal;
document.getElementById('walletModal').onclick = (e) => {
    if (e.target.id === 'walletModal') closeModal();
};

// Input listeners for real-time estimates
['Higher', 'Lower'].forEach(side => {
    const amountInput = document.getElementById(`amount${side}`);
    const priceInput = document.getElementById(`price${side}`);
    
    if (amountInput) {
        amountInput.addEventListener('input', () => {
            calculateEstimate(side.toLowerCase());
        });
    }
    
    if (priceInput) {
        priceInput.addEventListener('input', () => {
            calculateEstimate(side.toLowerCase());
        });
    }
});

// ============================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================
async function waitForWallets(maxWait = 3000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        if (window.phantom || window.solflare || window.coinbaseSolana || window.solana) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
}

window.addEventListener('load', async () => {
    console.log('🚀 $TOKEN Prediction Market загружается...');
    
    await waitForWallets(3000);
    
    const phantom = window.phantom?.solana || window.solana;
    if (phantom?.isConnected && phantom?.publicKey) {
        wallet = phantom.publicKey.toString();
        console.log('✅ Кошелек автоматически подключен');
        updateUI(true);
        await fetchTokenBalance();
    } else {
        updateUI(false);
    }
    
    console.log('📊 Загрузка данных рынка...');
    
    // FIXED: Load all rounds data first
    await loadRoundData();
    
    await Promise.all([
        updateMarketCap(),
        fetchOrderBook(),
        fetchRecentTrades(),
        fetchUserOrders(),
        fetchUserPositions(),
        fetchUnclaimedSettlements() 
    ]);
    
    console.log('✅ Раунд инициализирован');
    
    // Intervals
    setInterval(updateCountdown, 1000);
    setInterval(updateAllRoundTabs, 1000);
    setInterval(updateMarketCap, 15000);
    setInterval(fetchOrderBook, 5000);
    setInterval(fetchRecentTrades, 10000);
    setInterval(fetchAllRounds, 30000);
    setInterval(() => {
        if (wallet) {
            fetchTokenBalance();
            fetchUserOrders();
            fetchUserPositions();
            fetchUnclaimedSettlements();
        }
    }, 20000);
    
    console.log('✅ Приложение готово к работе');
    
    // ============================================
    // SETTLEMENTS FUNCTIONALITY
    // ============================================

    async function fetchUnclaimedSettlements() {
        if (!wallet) {
            userSettlements = [];
            updateSettlementsDisplay();
            return;
        }

        try {
            const response = await fetch(`${API_BASE}/api/settlement?action=unclaimed&wallet=${wallet}`);
            const data = await response.json();
            
            if (data.success) {
                userSettlements = data.settlements || [];
                updateSettlementsDisplay();
                updateSettlementsAlert();
            }
        } catch (error) {
            console.error('❌ Failed to fetch unclaimed settlements:', error);
        }
    }

    async function fetchSettlementHistory() {
        if (!wallet) {
            return [];
        }

        try {
            const response = await fetch(`${API_BASE}/api/settlement?action=history&wallet=${wallet}`);
            const data = await response.json();
            
            if (data.success) {
                return data.settlements || [];
            }
        } catch (error) {
            console.error('❌ Failed to fetch settlement history:', error);
        }
        
        return [];
    }

    async function claimSettlement(roundId) {
        if (!wallet) {
            alert('Подключите кошелек');
            return;
        }
        
        try {
            const settlement = userSettlements.find(s => s.roundId === roundId);
            if (!settlement) {
                alert('Settlement не найден');
                return;
            }
            
            const confirmMsg = `Вы собираетесь забрать выигрыш:\n\n` +
                             `Раунд: ${settlement.roundSlug}\n` +
                             `Сторона: ${settlement.side === 'higher' ? '⬆ ВЫШЕ' : '⬇ НИЖЕ'}\n` +
                             `Выплата: ${settlement.payout.toFixed(2)} токенов\n` +
                             `Прибыль: ${settlement.profitLoss.toFixed(2)} токенов`;
            
            if (!confirm(confirmMsg)) {
                return;
            }
            
            const btn = document.getElementById(`claim-btn-${roundId}`);
            if (btn) {
                btn.disabled = true;
                btn.textContent = 'Обработка...';
            }
            
            const response = await fetch(`${API_BASE}/api/settlement`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    wallet,
                    roundId,
                    txHash: null
                })
            });
            
            const result = await response.json();
            
            if (result.success) {
                alert(`✅ Выигрыш забран!\n\nПолучено: ${result.payout.toFixed(2)} токенов\nПрибыль: ${result.profitLoss.toFixed(2)} токенов`);
                
                await Promise.all([
                    fetchUnclaimedSettlements(),
                    fetchTokenBalance()
                ]);
                
                if (currentSettlementTab === 'unclaimed') {
                    renderUnclaimedSettlements();
                } else {
                    renderSettlementHistory();
                }
            } else {
                alert(`Ошибка: ${result.error}`);
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = 'Забрать';
                }
            }
            
        } catch (error) {
            console.error('❌ Claim settlement error:', error);
            alert('Ошибка при получении выигрыша');
        }
    }

    function updateSettlementsAlert() {
        const alertEl = document.getElementById('settlementsAlert');
        const count = document.getElementById('settlementsCount');
        
        if (!alertEl || !count) return;
        
        if (userSettlements.length > 0) {
            alertEl.style.display = '';
            count.textContent = userSettlements.length;
        } else {
            alertEl.style.display = 'none';
        }
    }

    function updateSettlementsDisplay() {
        const unclaimedCount = document.getElementById('unclaimedCount');
        if (unclaimedCount) {
            unclaimedCount.textContent = userSettlements.length;
        }
    }

    function openSettlementsModal() {
        const modal = document.getElementById('settlementsModal');
        if (modal) {
            modal.classList.add('active');
            switchSettlementTab('unclaimed');
        }
    }

    function closeSettlementsModal() {
        const modal = document.getElementById('settlementsModal');
        if (modal) {
            modal.classList.remove('active');
        }
    }

    async function switchSettlementTab(tab) {
        currentSettlementTab = tab;
        
        document.querySelectorAll('.settlement-tab').forEach(t => t.classList.remove('active'));
        const activeTab = document.getElementById(`tab-${tab}`);
        if (activeTab) activeTab.classList.add('active');
        
        document.getElementById('settlementsUnclaimed').style.display = tab === 'unclaimed' ? 'block' : 'none';
        document.getElementById('settlementsHistory').style.display = tab === 'history' ? 'block' : 'none';
        
        if (tab === 'unclaimed') {
            await renderUnclaimedSettlements();
        } else {
            await renderSettlementHistory();
        }
    }

    async function renderUnclaimedSettlements() {
        const container = document.getElementById('settlementsUnclaimed');
        
        if (!wallet) {
            container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: var(--text-dim);">
                    Подключите кошелек для просмотра
                </div>
            `;
            return;
        }
        
        if (userSettlements.length === 0) {
            container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: var(--text-dim);">
                    <div style="font-size: 3em; margin-bottom: 15px;">🎯</div>
                    <div style="font-size: 1.2em; margin-bottom: 10px;">Нет незабранных выигрышей</div>
                    <div style="font-size: 0.9em;">Участвуйте в раундах чтобы получать выплаты!</div>
                </div>
            `;
            return;
        }
        
        container.innerHTML = userSettlements.map(s => renderSettlementCard(s, false)).join('');
    }

    async function renderSettlementHistory() {
    const container = document.getElementById('settlementsHistory');
    
    if (!wallet) {
        container.innerHTML = `
            <div style="padding: 40px; text-align: center; color: var(--text-dim);">
                Подключите кошелек для просмотра
            </div>
        `;
        return;
    }
    
    container.innerHTML = `
        <div style="padding: 20px; text-align: center; color: var(--text-dim);">
            Загрузка истории...
        </div>
    `;
    
    // ВРЕМЕННОЕ ИСПРАВЛЕНИЕ: прямой вызов API
    try {
        const response = await fetch(`${API_BASE}/api/settlement?action=history&wallet=${wallet}`);
        const data = await response.json();
        
        if (!data.success || !data.settlements || data.settlements.length === 0) {
            container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: var(--text-dim);">
                    <div style="font-size: 3em; margin-bottom: 15px;">📜</div>
                    <div style="font-size: 1.2em;">История пуста</div>
                </div>
            `;
            return;
        }
        
        container.innerHTML = data.settlements.map(s => renderSettlementCard(s, true)).join('');
    } catch (error) {
        console.error('❌ Error loading history:', error);
        container.innerHTML = `
            <div style="padding: 40px; text-align: center; color: var(--accent-red);">
                Ошибка загрузки истории
            </div>
        `;
    }
}

    function renderSettlementCard(settlement, showClaimed) {
        const {
            roundId, roundSlug, intervalMinutes, side, amount, totalCost,
            won, payout, profitLoss, claimed, claimedAt, claimTxHash,
            startMarketCap, finalMarketCap
        } = settlement;
        
        const intervalName = intervalMinutes === 15 ? '15m' : 
                            intervalMinutes === 60 ? '1h' : '4h';
        
        const sideName = side === 'higher' ? '⬆ ВЫШЕ' : '⬇ НИЖЕ';
        const sideColor = side === 'higher' ? 'text-green' : 'text-red';
        
        const statusClass = won ? 'won' : 'lost';
        const statusText = won ? '🎉 ВЫИГРЫШ' : '😔 ПРОИГРЫШ';
        
        const capChange = ((finalMarketCap - startMarketCap) / startMarketCap * 100).toFixed(2);
        const capArrow = finalMarketCap > startMarketCap ? '📈' : '📉';
        
        return `
            <div class="settlement-card ${statusClass}">
                <div class="settlement-header">
                    <div class="settlement-round-info">
                        <div class="settlement-round-badge">${intervalName}</div>
                        <div>
                            <div style="font-weight: 600; color: var(--text-primary);">${roundSlug}</div>
                            <div style="font-size: 0.85em; color: var(--text-dim);">
                                ${new Date(settlement.endTime).toLocaleString('ru-RU')}
                            </div>
                        </div>
                    </div>
                    <div class="settlement-status ${statusClass}">
                        ${statusText}
                    </div>
                </div>
                
                <div class="market-cap-comparison">
                    <div>
                        <div style="font-size: 0.8em; color: var(--text-dim);">Начальная кап.</div>
                        <div class="market-cap-value">$${startMarketCap.toLocaleString()}</div>
                    </div>
                    <div class="market-cap-arrow">${capArrow}</div>
                    <div>
                        <div style="font-size: 0.8em; color: var(--text-dim);">Финальная кап.</div>
                        <div class="market-cap-value">$${finalMarketCap.toLocaleString()}</div>
                    </div>
                    <div style="padding: 8px 15px; background: var(--bg-tertiary); border-radius: 8px; font-weight: 600;">
                        ${capChange > 0 ? '+' : ''}${capChange}%
                    </div>
                </div>
                
                <div class="settlement-details">
                    <div class="settlement-detail">
                        <div class="settlement-detail-label">Ваша позиция</div>
                        <div class="settlement-detail-value ${sideColor}">${sideName}</div>
                    </div>
                    <div class="settlement-detail">
                        <div class="settlement-detail-label">Количество</div>
                        <div class="settlement-detail-value">${amount.toFixed(2)}</div>
                    </div>
                    <div class="settlement-detail">
                        <div class="settlement-detail-label">Вложено</div>
                        <div class="settlement-detail-value">${totalCost.toFixed(2)}</div>
                    </div>
                    <div class="settlement-detail">
                        <div class="settlement-detail-label">${won ? 'Выплата' : 'Убыток'}</div>
                        <div class="settlement-detail-value ${won ? 'settlement-payout' : 'settlement-loss'}">
                            ${won ? '+' : ''}${profitLoss.toFixed(2)}
                        </div>
                    </div>
                </div>
                
                ${showClaimed ? renderClaimedStatus(claimed, claimedAt, claimTxHash) : renderClaimButton(roundId, won, payout)}
            </div>
        `;
    }

    function renderClaimButton(roundId, won, payout) {
        if (!won || payout <= 0) {
            return `
                <div class="settlement-claimed">
                    Этот раунд завершен. Выплата недоступна.
                </div>
            `;
        }
        
        return `
            <div class="settlement-actions">
                <button 
                    class="settlement-claim-btn" 
                    id="claim-btn-${roundId}"
                    onclick="claimSettlement(${roundId})"
                >
                    💰 Забрать ${payout.toFixed(2)} токенов
                </button>
            </div>
        `;
    }

    function renderClaimedStatus(claimed, claimedAt, claimTxHash) {
        if (!claimed) {
            return '<div class="settlement-claimed">Ожидает получения</div>';
        }
        
        const claimDate = new Date(claimedAt).toLocaleString('ru-RU');
        
        return `
            <div class="settlement-claimed">
                <strong>✅ Забрано</strong>
                ${claimDate}
                ${claimTxHash ? `
                    <br>
                    <a href="https://solscan.io/tx/${claimTxHash}" 
                       target="_blank" 
                       class="settlement-tx-link">
                        Посмотреть транзакцию →
                    </a>
                ` : ''}
            </div>
        `;
    }

    // ⭐ ВАЖНО: Сделай функции глобально доступными
    window.claimSettlement = claimSettlement;
    window.openSettlementsModal = openSettlementsModal;
    window.closeSettlementsModal = closeSettlementsModal;
    window.switchSettlementTab = switchSettlementTab;

});
