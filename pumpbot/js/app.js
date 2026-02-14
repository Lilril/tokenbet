const TOKEN_ADDRESS = 'G4zkF9g6XFGm7mTYFEqEgWhr9zZgMYaCqfua9cJkpump';
const API_BASE = '';
const PLATFORM_PAUSED = !TOKEN_ADDRESS || TOKEN_ADDRESS === 'AWAITING_TOKEN' || TOKEN_ADDRESS.length < 30;
// HELPER FUNCTIONS FOR SAFE API CALLS
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
let orderBookData = { higher: [], lower: [], higherSells: [], lowerSells: [] };
let userOrderPrices = { higher: [], lower: [], higherSells: [], lowerSells: [] };
let ammPrices = { higher: 0.5, lower: 0.5 };
let recentTrades = [];
let selectedSide = 'higher';
let selectedOrderType = 'market';
let userOrders = [];  // NEW: Track user's active orders
let userPositions = []; // NEW: Track user's positions
let userSettlements = [];
let currentSettlementTab = 'unclaimed';
// WALLETS
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
let walletStandardWallets = [];
function discoverWalletStandard() {}
let activeProvider = null;
let activeWalletType = null;
function getActiveProvider() {
    if (activeProvider?.isConnected) return activeProvider;
    for (const info of Object.values(WALLETS)) {
        const p = info.get();
        if (p?.isConnected) {
            activeProvider = p;
            return p;
        }
    }
    return null;
}
function saveWalletChoice(walletType) {
    try { localStorage.setItem('tokenbet_wallet', walletType); } catch(e) {}
}
function getSavedWalletChoice() {
    try { return localStorage.getItem('tokenbet_wallet'); } catch(e) { return null; }
}
function clearWalletChoice() {
    try { localStorage.removeItem('tokenbet_wallet'); } catch(e) {}
}
function renderWallets() {
    const container = document.getElementById('walletsList');
    // Standard wallets (Phantom, Solflare, Coinbase)
    let html = Object.entries(WALLETS).map(([key, info]) => {
        const detected = info.get();
        return '<div class="wallet-option" onclick="connectWallet(\'' + key + '\')" style="border-left: 3px solid ' + info.color + '">' +
            '<span style="font-size: 2em; margin-right: 15px;">' + info.icon + '</span>' +
            '<div>' +
                '<div style="font-weight: 600; font-size: 1.1em;">' + info.name + '</div>' +
                '<div style="font-size: 0.85em; color: var(--text-dim);">' + (detected ? 'Detected' : 'Not installed') + '</div>' +
            '</div>' +
        '</div>';
    }).join('');
    // Wallet Standard wallets (Jupiter, etc.)
    discoverWalletStandard();
    for (let i = 0; i < walletStandardWallets.length; i++) {
        const w = walletStandardWallets[i];
        // Skip if already in standard list
        const name = w.name || 'Unknown';
        const nameLower = name.toLowerCase();
        if (nameLower.includes('phantom') || nameLower.includes('solflare') || nameLower.includes('coinbase')) continue;
        const icon = w.icon || '🔗';
        const iconHtml = icon.startsWith('data:') ? '<img src="' + icon + '" style="width:32px;height:32px;margin-right:15px;border-radius:6px;">' : '<span style="font-size:2em;margin-right:15px;">' + icon + '</span>';
        html += '<div class="wallet-option" onclick="connectWalletStandard(' + i + ')" style="border-left: 3px solid #C7F284">' +
            iconHtml +
            '<div>' +
                '<div style="font-weight: 600; font-size: 1.1em;">' + name + '</div>' +
                '<div style="font-size: 0.85em; color: var(--text-dim);">Detected</div>' +
            '</div>' +
        '</div>';
    }
    container.innerHTML = html;
}
async function connectWallet(walletType) {
    const walletInfo = WALLETS[walletType];
    if (!walletInfo) return;
    try {
        const provider = walletInfo.get();
        if (!provider) {
            showNotification(walletInfo.name + ' not installed. Install browser extension.', 'error');
            return;
        }
        const response = await provider.connect();
        const pubKey = response?.publicKey || provider.publicKey;
        if (!pubKey) {
            showNotification(walletInfo.name + ': failed to get wallet address', 'error');
            return;
        }
        wallet = pubKey.toString();
        activeProvider = provider;
        activeWalletType = walletType;
        saveWalletChoice(walletType);
        // connected;
        closeModal();
        updateUI(true);
        await fetchTokenBalance();
        try {
            provider.on('disconnect', () => {
                // disconnected;
                disconnect();
            });
        } catch(e) {} 
    } catch (error) {
        console.error('❌ Connection error:', error);
        const msg = error.message || '';
        if (msg.includes('User rejected') || msg.includes('rejected')) {
            showNotification('Connection cancelled', 'error');
        } else {
            showNotification(walletInfo.name + ': ' + (msg || 'connection error'), 'error');
        }
    }
}
async function connectWalletStandard(index) {
    try {
        const w = walletStandardWallets[index];
        if (!w) {
            showNotification('Wallet not found', 'error');
            return;
        }
        // Wallet Standard connect
        const connectFeature = w.features?.['standard:connect'];
        if (!connectFeature?.connect) {
            showNotification('Wallet does not support connect', 'error');
            return;
        }
        const result = await connectFeature.connect();
        const account = result.accounts?.[0];
        if (!account) {
            showNotification('Failed to get account', 'error');
            return;
        }
        wallet = account.address;
        activeWalletType = 'ws:' + index;
        activeProvider = window.solana || null;
        saveWalletChoice('ws:' + w.name);
        closeModal();
        updateUI(true);
        await fetchTokenBalance();
    } catch (error) {
        console.error('❌ WS connection error:', error);
        showNotification('Wallet connection error', 'error');
    }
}
function showNotification(message, type) {
    const existing = document.getElementById('app-notification');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.id = 'app-notification';
    div.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:10000;padding:12px 24px;border-radius:8px;font-family:inherit;font-size:0.95em;font-weight:600;animation:fadeIn 0.3s;max-width:90vw;text-align:center;';
    div.style.background = type === 'error' ? '#FF4444' : type === 'success' ? '#00C851' : '#333';
    div.style.color = '#fff';
    div.textContent = message;
    document.body.appendChild(div);
    setTimeout(() => { div.style.opacity = '0'; div.style.transition = 'opacity 0.5s'; setTimeout(() => div.remove(), 500); }, 3000);
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
        console.error('❌ Disconnect error:', error);
    }
    wallet = null;
    activeProvider = null;
    activeWalletType = null;
    clearWalletChoice();
    updateUI(false);
}
// TOKEN BALANCE
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
                ;
                updateBalanceDisplay();
                return;
            }
        }
        tokenBalance = 0;
        balanceAvailable = 0;
        balanceLocked = 0;
        updateBalanceDisplay();
    } catch (error) {
        console.error('❌ Balance fetch error:', error);
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
            lockedEl.textContent = `⌂ ${balanceLocked.toLocaleString('en-US', { maximumFractionDigits: 2 })} in orders`;
        } else {
            lockedEl.textContent = '';
        }
    }
}
// DEPOSIT
let platformDepositInfo = null; // { depositAddress, depositAta, tokenMint, minDeposit, decimals }
let walletOnChainBalance = 0;   
function openDepositModal() {
    if (!wallet) {
        showNotification('Connect wallet first!', 'error');
        return;
    }
    document.getElementById('depositModal').style.display = 'flex';
    document.getElementById('depositStep1').style.display = 'block';
    document.getElementById('depositResult').style.display = 'none';
    document.getElementById('depositAmount').value = '';
    loadDepositInfo();
}
function closeDepositModal() {
    document.getElementById('depositModal').style.display = 'none';
}
async function loadDepositInfo() {
    try {
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
        }
        await fetchOnChainTokenBalance();
    } catch (e) {
        console.error('❌ loadDepositInfo:', e);
    }
}
async function fetchOnChainTokenBalance() {
    if (!wallet || !platformDepositInfo) return;
    try {
        const provider = getActiveProvider();
        if (!provider) { walletOnChainBalance = 0; return; }
        const { PublicKey } = solanaWeb3;
        const tokenMint = platformDepositInfo.tokenMint || TOKEN_ADDRESS;
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
    const minDeposit = platformDepositInfo?.minDeposit || 1000;
    if (!amount || amount <= 0) {
        showNotification('Enter amount!', 'error');
        return;
    }
    if (amount < minDeposit) {
        showNotification(`Min deposit: ${minDeposit} tokens`, 'error');
        return;
    }
    if (!platformDepositInfo) {
        showNotification('Error: failed to load deposit info. Try closing and reopening.', 'error');
        return;
    }
    const btn = document.getElementById('executeDepositBtn');
    btn.disabled = true;
    btn.textContent = 'Preparing...';
    try {
        const provider = getActiveProvider();
        if (!provider) {
            throw new Error('Wallet not connected');
        }
        const { PublicKey, Transaction, TransactionInstruction } = solanaWeb3;
        const mintPubkey = new PublicKey(platformDepositInfo.tokenMint);
        const senderPubkey = new PublicKey(wallet);
        const recipientAta = new PublicKey(platformDepositInfo.depositAta);
        const tokenProgramId = platformDepositInfo.tokenProgramId || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
        const tokenProgramPubkey = new PublicKey(tokenProgramId);
        const senderAta = await getAssociatedTokenAddressJS(mintPubkey, senderPubkey, tokenProgramId);
        const rawAmount = Math.floor(amount * Math.pow(10, platformDepositInfo.decimals || 6));

        const transaction = new Transaction();

        // Create destination ATA if it doesn't exist (idempotent — won't fail if exists)
        const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
        const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
        const createAtaIx = new TransactionInstruction({
            keys: [
                { pubkey: senderPubkey, isSigner: true, isWritable: true },       // payer
                { pubkey: recipientAta, isSigner: false, isWritable: true },      // ATA to create
                { pubkey: new PublicKey(platformDepositInfo.depositAddress), isSigner: false, isWritable: false }, // wallet owner
                { pubkey: mintPubkey, isSigner: false, isWritable: false },       // mint
                { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },   // system program
                { pubkey: tokenProgramPubkey, isSigner: false, isWritable: false }, // token program
            ],
            programId: ATA_PROGRAM,
            data: new Uint8Array([1]), // 1 = CreateIdempotent instruction
        });
        transaction.add(createAtaIx);

        // TransferChecked — works for both Token Program and Token 2022
        const transferData = new Uint8Array(10);
        transferData[0] = 12; // TransferChecked instruction index
        let amt = BigInt(rawAmount);
        for (let i = 1; i < 9; i++) {
            transferData[i] = Number(amt & 0xFFn);
            amt >>= 8n;
        }
        transferData[9] = platformDepositInfo.decimals || 6;

        const transferIx = new TransactionInstruction({
            keys: [
                { pubkey: senderAta, isSigner: false, isWritable: true },        // source
                { pubkey: mintPubkey, isSigner: false, isWritable: false },       // mint
                { pubkey: recipientAta, isSigner: false, isWritable: true },     // destination
                { pubkey: senderPubkey, isSigner: true, isWritable: false },     // authority
            ],
            programId: tokenProgramPubkey,
            data: transferData,
        });
        transaction.add(transferIx);
        btn.textContent = 'Preparing transaction...';
        let blockhash = platformDepositInfo.blockhash;
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
            const debugInfo = platformDepositInfo._debug ? JSON.stringify(platformDepositInfo._debug) : 'no debug';
            throw new Error(`Failed to get blockhash. Debug: ${debugInfo}`);
        }
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = senderPubkey;
        btn.textContent = 'Confirm in wallet...';
        const { signature } = await provider.signAndSendTransaction(transaction);
        btn.textContent = 'Awaiting confirmation...';
        await new Promise(r => setTimeout(r, 6000));
        btn.textContent = 'Crediting balance...';
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
                <div style="font-size: 3em; margin-bottom: 15px;">✓</div>
                <div style="font-size: 1.3em; font-weight: 700; color: var(--accent-green); margin-bottom: 10px;">
                    Deposit confirmed!
                </div>
                <div style="font-size: 1.5em; font-weight: 700; margin-bottom: 10px;">
                    +${data.amount} tokens
                </div>
                <div style="margin-bottom: 15px;">
                    <a href="https://solscan.io/tx/${signature}" target="_blank" style="color: var(--accent-yellow); text-decoration: underline; font-size: 0.85em;">
                        View on Solscan →
                    </a>
                </div>
                <button onclick="closeDepositModal()" style="padding: 12px 30px; background: var(--accent-green); color: #000; border: none; font-weight: 700; cursor: pointer; font-family: inherit; border-radius: 6px; font-size: 1em;">
                    DONE
                </button>
            `;
            await fetchTokenBalance();
        } else {
            resultEl.innerHTML = `
                <div style="font-size: 3em; margin-bottom: 15px;">!</div>
                <div style="font-size: 1.1em; font-weight: 700; color: var(--accent-yellow); margin-bottom: 10px;">
                    Tokens sent!
                </div>
                <div style="color: var(--text-dim); margin-bottom: 10px; font-size: 0.9em;">
                    Processing may take 1-2 minutes.
                    ${data?.error ? `<br><span style="font-size:0.85em">(${data.error})</span>` : ''}
                </div>
                <div style="margin-bottom: 20px;">
                    <a href="https://solscan.io/tx/${signature}" target="_blank" style="color: var(--accent-yellow); text-decoration: underline; font-size: 0.85em;">
                        View on Solscan →
                    </a>
                </div>
                <button onclick="closeDepositModal()" style="padding: 12px 30px; background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); font-weight: 700; cursor: pointer; font-family: inherit; border-radius: 6px;">
                    CLOSE
                </button>
            `;
            setTimeout(() => fetchTokenBalance(), 15000);
        }
    } catch (error) {
        console.error('❌ Deposit error:', error);
        if (error.message?.includes('User rejected') || error.message?.includes('rejected')) {
            btn.disabled = false;
            btn.textContent = 'DEPOSIT VIA PHANTOM';
            return;
        }
        const resultEl = document.getElementById('depositResult');
        document.getElementById('depositStep1').style.display = 'none';
        resultEl.style.display = 'block';
        resultEl.innerHTML = `
            <div style="font-size: 3em; margin-bottom: 15px;">✗</div>
            <div style="font-size: 1.1em; font-weight: 700; color: var(--accent-red); margin-bottom: 10px;">
                Error
            </div>
            <div style="color: var(--text-dim); margin-bottom: 20px; font-size: 0.9em;">
                ${error.message || 'Unknown error'}
            </div>
            <button onclick="document.getElementById('depositStep1').style.display='block'; document.getElementById('depositResult').style.display='none';" style="padding: 12px 30px; background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); font-weight: 700; cursor: pointer; font-family: inherit; border-radius: 6px;">
                TRY AGAIN
            </button>
        `;
    } finally {
        btn.disabled = false;
        btn.textContent = 'DEPOSIT VIA PHANTOM';
    }
}
// SPL HELPERS
async function getAssociatedTokenAddressJS(mint, owner, tokenProgramId) {
    const { PublicKey } = solanaWeb3;
    const SPL_TOKEN_DEFAULT = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const tokenProgram = new PublicKey(tokenProgramId || SPL_TOKEN_DEFAULT);
    const SPL_ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const [address] = await PublicKey.findProgramAddress(
        [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
        SPL_ATA
    );
    return address;
}
function createTransferInstructionJS(source, destination, owner, amount, tokenProgramId) {
    const { PublicKey, TransactionInstruction } = solanaWeb3;
    const SPL_TOKEN_DEFAULT = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const tokenProgram = new PublicKey(tokenProgramId || SPL_TOKEN_DEFAULT);
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
        programId: tokenProgram,
        data,
    });
}
// WITHDRAW
function openWithdrawModal() {
    if (!wallet) {
        showNotification('Connect wallet first!', 'error');
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
        showNotification('Enter amount!', 'error');
        return;
    }
    if (amount > balanceAvailable) {
        showNotification(`Insufficient funds! Available: ${balanceAvailable}`, 'error');
        return;
    }
    const btn = document.getElementById('processWithdrawBtn');
    btn.disabled = true;
    btn.textContent = 'Sending tokens...';
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
                <div style="font-size: 3em; margin-bottom: 15px;">✓</div>
                <div style="font-size: 1.3em; font-weight: 700; color: var(--accent-green); margin-bottom: 10px;">
                    Withdrawal complete!
                </div>
                <div style="font-size: 1.5em; font-weight: 700; margin-bottom: 10px;">
                    -${data.amount} tokens
                </div>
                ${data.fee > 0 ? `<div style="color: var(--text-dim); font-size: 0.85em; margin-bottom: 5px;">Fee: ${data.fee}</div>` : ''}
                <div style="margin-bottom: 20px;">
                    <a href="https://solscan.io/tx/${data.txSignature}" target="_blank" style="color: var(--accent-yellow); text-decoration: underline; font-size: 0.85em;">
                        View on Solscan →
                    </a>
                </div>
                <button onclick="closeWithdrawModal()" style="padding: 12px 30px; background: var(--accent-green); color: #000; border: none; font-weight: 700; cursor: pointer; font-family: inherit; border-radius: 6px; font-size: 1em;">
                    DONE
                </button>
            `;
            await fetchTokenBalance();
        } else {
            resultEl.innerHTML = `
                <div style="font-size: 3em; margin-bottom: 15px;">✗</div>
                <div style="font-size: 1.1em; font-weight: 700; color: var(--accent-red); margin-bottom: 10px;">
                    Withdrawal error
                </div>
                <div style="color: var(--text-dim); margin-bottom: 20px; font-size: 0.9em;">
                    ${data.error || 'Unknown error'}
                </div>
                <button onclick="document.getElementById('withdrawStep1').style.display='block'; document.getElementById('withdrawResult').style.display='none';" style="padding: 12px 30px; background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); font-weight: 700; cursor: pointer; font-family: inherit; border-radius: 6px; font-size: 1em;">
                    TRY AGAIN
                </button>
            `;
        }
    } catch (error) {
        console.error('❌ Withdraw error:', error);
        showNotification('Network error. Try again.', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'WITHDRAW';
    }
}
// UI
function updateUI(connected) {
    const dot = document.getElementById('statusDot');
    const status = document.getElementById('walletStatus');
    const btn = document.getElementById('connectBtn');
    if (connected && wallet) {
        dot.className = 'status-dot status-connected';
        status.textContent = wallet.slice(0, 4) + '...' + wallet.slice(-4);
        btn.textContent = 'DISCONNECT';
        btn.onclick = disconnect;
    } else {
        dot.className = 'status-dot status-disconnected';
        status.textContent = 'NOT CONNECTED';
        btn.textContent = 'CONNECT';
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
// MARKET DATA
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
// FETCH ALL ROUNDS
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
            ;
        }
    } catch (error) {
        console.error('❌ Failed to fetch all rounds:', error);
    }
}
// ORDER BOOK // ORDER BOOK & TRADING TRADING
async function fetchOrderBook() {
    try {
        const intervalMinutes = getCurrentInterval();
        const walletParam = wallet ? `&wallet=${wallet}` : '';
        const response = await fetch(`${API_BASE}/api/orders?action=orderbook&intervalMinutes=${intervalMinutes}${walletParam}`);
        const data = await response.json();
        if (data.success) {
            orderBookData = data.orderBook;
            ammPrices = data.ammPrice;
            userOrderPrices = data.userOrderPrices || { higher: [], lower: [], higherSells: [], lowerSells: [] };
            if (data.startMarketCap && parseFloat(data.startMarketCap) > 0) {
                targetMarketCap = parseFloat(data.startMarketCap);
                ;
            }
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
    }
}
function renderOrderBook() {
    const higherEl = document.getElementById('orderBookHigher');
    const lowerEl = document.getElementById('orderBookLower');
    const side = (typeof currentTradeSide !== 'undefined') ? currentTradeSide : 'higher';
    // Polymarket-style orderbook:
    // Asks = sell orders on current side + complement buy orders on opposite side
    // Bids = buy orders on current side
    let complementAsks, directSells, bidsRaw;
    let asksSide, bidsSide;
    if (side === 'higher') {
        complementAsks = orderBookData.lower || [];   // LOWER buy orders = complement asks
        directSells = orderBookData.higherSells || []; // Direct HIGHER sell orders
        bidsRaw = orderBookData.higher || [];          // HIGHER buy orders = bids
        asksSide = 'lower';
        bidsSide = 'higher';
    } else {
        complementAsks = orderBookData.higher || [];   // HIGHER buy orders = complement asks
        directSells = orderBookData.lowerSells || [];  // Direct LOWER sell orders
        bidsRaw = orderBookData.lower || [];           // LOWER buy orders = bids
        asksSide = 'higher';
        bidsSide = 'lower';
    }
    // Convert complement asks to complementary prices (1 - price) + merge with direct sell orders
    const complementData = complementAsks.map(o => ({
        ...o,
        displayPrice: Math.round((1 - o.price) * 100) / 100,
        rawPrice: o.price,
        source: 'complement'
    }));
    const directSellData = directSells.map(o => ({
        ...o,
        displayPrice: Math.round(o.price * 100) / 100,
        rawPrice: o.price,
        source: 'sell'
    }));
    // Merge and deduplicate by displayPrice
    const allAsksMap = new Map();
    for (const a of [...complementData, ...directSellData]) {
        const key = a.displayPrice.toFixed(2);
        if (allAsksMap.has(key)) {
            const existing = allAsksMap.get(key);
            existing.amount += a.amount;
            existing.orders = (existing.orders || 1) + (a.orders || 1);
        } else {
            allAsksMap.set(key, { ...a });
        }
    }
    const asksData = Array.from(allAsksMap.values()).sort((a, b) => a.displayPrice - b.displayPrice);
    
    // Bids keep original prices
    const bidsData = bidsRaw.map(o => ({
        ...o,
        displayPrice: Math.round(o.price * 100) / 100,
        rawPrice: o.price
    })).sort((a, b) => b.displayPrice - a.displayPrice); // highest bid first
    // Reverse asks so highest is at top, lowest near spread
    const asksReversed = [...asksData].reverse();
    // Helper: check if this price level has user's order
    // For complement asks: check buy orders on the complement side
    // For direct sell asks: check sell orders on the current side
    // For bids: check buy orders on the current side
    function isUserBuyOrder(orderSide, rawPrice) {
        const prices = userOrderPrices[orderSide] || [];
        return prices.some(p => Math.abs(p - rawPrice) < 0.0001);
    }
    function isUserSellOrder(orderSide, rawPrice) {
        const key = orderSide + 'Sells'; // e.g., 'higherSells'
        const prices = userOrderPrices[key] || [];
        return prices.some(p => Math.abs(p - rawPrice) < 0.0001);
    }
    function isUserAsk(order) {
        if (order.source === 'complement') {
            return isUserBuyOrder(asksSide, order.rawPrice);
        } else {
            // Direct sell order: check sell orders on current (bid) side
            return isUserSellOrder(bidsSide, order.rawPrice);
        }
    }
    if (asksReversed.length === 0) {
        higherEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-dim);">No orders</div>';
    } else {
        const maxAmount = Math.max(...asksReversed.map(o => o.amount));
        higherEl.innerHTML = asksReversed.map(order => {
            const pct = (order.amount / maxAmount) * 100;
            const isUser = isUserAsk(order);
            const userStyle = isUser ? 'border-left: 3px solid var(--accent-yellow); background: rgba(255, 204, 0, 0.08);' : '';
            const userMarker = isUser ? '<span style="color: var(--accent-yellow); font-size: 0.75em; margin-left: 4px;" title="Your order">★</span>' : '';
            return `
                <div class="order-book-row" onclick="fillFromOrderBook(${order.displayPrice}, ${order.amount})" style="cursor: pointer; ${userStyle}" title="${isUser ? '★ Your order — ' : ''}Click to fill">
                    <div class="order-bar" style="width: ${pct}%; background: linear-gradient(90deg, transparent, rgba(255, 71, 87, 0.2));"></div>
                    <div style="display: flex; justify-content: space-between; position: relative; z-index: 1;">
                        <span class="text-red">${order.displayPrice.toFixed(2)}${userMarker}</span>
                        <span>${order.amount.toFixed(0)}</span>
                    </div>
                </div>
            `;
        }).join('');
    }
    if (bidsData.length === 0) {
        lowerEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-dim);">No orders</div>';
    } else {
        const maxAmount = Math.max(...bidsData.map(o => o.amount));
        lowerEl.innerHTML = bidsData.map(order => {
            const pct = (order.amount / maxAmount) * 100;
            const isUser = isUserBuyOrder(bidsSide, order.rawPrice);
            const userStyle = isUser ? 'border-left: 3px solid var(--accent-yellow); background: rgba(255, 204, 0, 0.08);' : '';
            const userMarker = isUser ? '<span style="color: var(--accent-yellow); font-size: 0.75em; margin-left: 4px;" title="Your order">★</span>' : '';
            return `
                <div class="order-book-row" onclick="fillFromOrderBook(${order.displayPrice}, ${order.amount})" style="cursor: pointer; ${userStyle}" title="${isUser ? '★ Your order — ' : ''}Click to fill">
                    <div class="order-bar" style="width: ${pct}%; background: linear-gradient(90deg, transparent, rgba(0, 255, 159, 0.2));"></div>
                    <div style="display: flex; justify-content: space-between; position: relative; z-index: 1;">
                        <span class="text-green">${order.displayPrice.toFixed(2)}${userMarker}</span>
                        <span>${order.amount.toFixed(0)}</span>
                    </div>
                </div>
            `;
        }).join('');
    }
    // Calculate and show spread
    const bestBid = bidsData.length > 0 ? bidsData[0].displayPrice : null;
    const bestAsk = asksData.length > 0 ? asksData[0].displayPrice : null;
    const spreadEl = document.getElementById('spreadDisplay');
    if (spreadEl && bestBid !== null && bestAsk !== null) {
        const spread = ((bestAsk - bestBid) * 100).toFixed(2);
        spreadEl.textContent = spread + '%';
        spreadEl.style.color = '';
    } else if (spreadEl) {
        spreadEl.textContent = '0.00%';
        spreadEl.style.color = '';
    }
}
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
// TRADE HISTORY
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
        container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-dim);">No trades</div>';
        return;
    }
    container.innerHTML = recentTrades.map(trade => {
        const time = new Date(trade.time).toLocaleTimeString('en-US');
        const sideClass = trade.side === 'higher' ? 'buy' : 'sell';
        const sideText = trade.side === 'higher' ? '↑ HIGHER' : '↓ LOWER';
        return `
            <div class="trade-item ${sideClass}">
                <div>
                    <div style="font-weight: 600;">${sideText}</div>
                    <div class="trade-time">${time}</div>
                </div>
                <div style="text-align: right;">
                    <div>${trade.amount.toFixed(0)} pcs</div>
                    <div class="trade-time">@ ${trade.price.toFixed(3)}</div>
                </div>
            </div>
        `;
    }).join('');
}
// USER ORDERS & POSITIONS
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
        showNotification('Connect wallet', 'error');
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/api/orders?orderId=${orderId}&wallet=${wallet}`, {
            method: 'DELETE'
        });
        const result = await response.json();
        if (result.success) {
            showNotification('Order cancelled!', 'success');
            // Refresh data
            await Promise.all([
                fetchUserOrders(),
                fetchOrderBook(),
                fetchTokenBalance()
            ]);
        } else {
            showNotification(`Error: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('❌ Failed to cancel order:', error);
        showNotification('Order cancel error', 'error');
    }
}
// MODAL FUNCTIONS FOR MY ORDERS AND MY TRADES
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
                Connect wallet to view orders
            </div>
        `;
        return;
    }
    if (userOrders.length === 0) {
        list.innerHTML = `
            <div style="padding: 20px; text-align: center; color: var(--text-dim);">
                No active orders
            </div>
        `;
        return;
    }
    const currentInterval = getCurrentInterval();
    list.innerHTML = userOrders.map(order => {
        let roundName = 'undefined';
        if (order.interval_minutes) {
            if (order.interval_minutes === 15) roundName = '15m';
            else if (order.interval_minutes === 60) roundName = '1h';
            else if (order.interval_minutes === 240) roundName = '4h';
        } else {
            if (currentInterval === 15) roundName = '15m';
            else if (currentInterval === 60) roundName = '1h';
            else if (currentInterval === 240) roundName = '4h';
        }
        const filled = order.filled || 0;
        const remaining = order.amount - filled;
        const showRemaining = filled > 0;
        const isSell = order.order_type === 'sell';
        const orderType = isSell ? 'Sell Limit' : (order.price === 0 ? 'Market' : 'Limit');
        return `
            <div class="trade-item" style="background: var(--bg-tertiary); padding: 15px; margin-bottom: 10px; border: 1px solid var(--border); border-radius: 4px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                    <div>
                        <span class="${order.side === 'higher' ? 'text-green' : 'text-red'}" style="font-weight: 600;">
                            ${isSell ? '⤵ SELL' : ''} ${order.side === 'higher' ? '↑ HIGHER' : '↓ LOWER'}
                        </span>
                        <span style="color: var(--text-dim); margin-left: 10px; font-size: 0.85em;">
                            ${orderType}
                        </span>
                    </div>
                    <div style="color: var(--text-dim); font-size: 0.85em;">
                        Round ${roundName}
                    </div>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-size: 0.85em; color: var(--text-secondary);">
                            Qty: <span style="color: var(--text-primary); font-weight: 600;">
                                ${showRemaining ? `${remaining.toFixed(0)} / ${order.amount.toFixed(0)}` : `${order.amount}`} tokens
                            </span>
                            ${showRemaining ? `<span style="color: var(--accent-yellow); font-size: 0.75em; margin-left: 5px;">(${((filled / order.amount) * 100).toFixed(1)}% filled)</span>` : ''}
                        </div>
                        <div style="font-size: 0.85em; color: var(--text-secondary);">
                            Price: <span style="color: var(--accent-yellow); font-weight: 600;">${order.price.toFixed(3)}</span>
                        </div>
                    </div>
                    <button 
                        onclick="cancelOrder(${order.id})" 
                        style="padding: 8px 16px; background: var(--accent-red); color: #000; border: none; cursor: pointer; font-weight: 600; border-radius: 4px; font-size: 0.85em;"
                    >
                        Cancel
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
                Connect wallet to view trades
            </div>
        `;
        return;
    }
    // Show loading
    list.innerHTML = `
        <div style="padding: 20px; text-align: center; color: var(--text-dim);">
            Loading...
        </div>
    `;
    try {
        const intervalMinutes = getCurrentInterval();
        const response = await fetch(`${API_BASE}/api/orders?action=user-trades&wallet=${wallet}&intervalMinutes=${intervalMinutes}`);
        const data = await response.json();
        if (data.success && data.trades && data.trades.length > 0) {
            list.innerHTML = data.trades.map(trade => {
                const timestamp = new Date(trade.timestamp).toLocaleString('en-US', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                });
                let roundName = 'undefined';
                if (trade.interval_minutes === 15) roundName = '15m';
                else if (trade.interval_minutes === 60) roundName = '1h';
                else if (trade.interval_minutes === 240) roundName = '4h';
                return `
                    <div class="trade-item" style="background: var(--bg-tertiary); padding: 15px; margin-bottom: 10px; border: 1px solid var(--border); border-radius: 4px;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                            <div>
                                <span class="${trade.side === 'higher' ? 'text-green' : 'text-red'}" style="font-weight: 600;">
                                    ${trade.side === 'higher' ? '↑ HIGHER' : '↓ LOWER'}
                                </span>
                                <span style="color: var(--text-dim); margin-left: 10px; font-size: 0.85em;">
                                    ${trade.order_type === 'market' ? 'Market' : 'Limit'}
                                </span>
                            </div>
                            <div style="color: var(--text-dim); font-size: 0.85em;">
                                ${timestamp}
                            </div>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <div>
                                <div style="font-size: 0.85em; color: var(--text-secondary);">
                                    Qty: <span style="color: var(--text-primary); font-weight: 600;">${trade.amount} tokens</span>
                                </div>
                                <div style="font-size: 0.85em; color: var(--text-secondary);">
                                    Price: <span style="color: var(--accent-yellow); font-weight: 600;">${trade.price.toFixed(3)}</span>
                                </div>
                            </div>
                            <div style="text-align: right;">
                                <div style="font-size: 0.85em; color: var(--text-secondary);">
                                    Round: <span style="color: var(--text-primary);">${roundName}</span>
                                </div>
                                ${trade.profit !== undefined ? `
                                    <div style="font-size: 0.85em; color: var(--text-secondary);">
                                        P&L: <span style="color: ${trade.profit >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}; font-weight: 600;">
                                            ${trade.profit >= 0 ? '+' : ''}${trade.profit.toFixed(2)} tokens
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
                    No completed trades
                </div>
            `;
        }
    } catch (error) {
        console.error('❌ Failed to fetch user trades:', error);
        list.innerHTML = `
            <div style="padding: 20px; text-align: center; color: var(--accent-red);">
                Error loading trades
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
// TRADING INTERFACE
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
        container.innerHTML = '<div style="color: var(--text-dim);">Enter amount</div>';
        return;
    }
    const oppositeSide = side === 'higher' ? 'lower' : 'higher';
    const cost = data[`${oppositeSide}Needed`] || (data.avgPrice * parseFloat(
        document.getElementById(`amount${side === 'higher' ? 'Higher' : 'Lower'}`).value
    ));
    container.innerHTML = `
        <div class="estimate-row">
            <span>Avg price:</span>
            <span>${data.avgPrice.toFixed(4)}</span>
        </div>
        <div class="estimate-row">
            <span>Price Impact:</span>
            <span class="${data.priceImpact > 5 ? 'text-red' : 'text-green'}">
                ${data.priceImpact?.toFixed(2) || '0.00'}%
            </span>
        </div>
        <div class="estimate-row">
            <span>Total:</span>
            <span class="text-yellow">${cost.toFixed(0)} tokens</span>
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
        showNotification('Enter valid amount', 'error');
        return;
    }
    if (amount > tokenBalance) {
        showNotification('Insufficient tokens', 'error');
        return;
    }
    // OPTIONAL: Uncomment to disable market orders when orderbook is empty
    // if (selectedOrderType === 'market') {
    //     const hasOrders = orderBookData.higher.length > 0 || orderBookData.lower.length > 0;
    //     if (!hasOrders) {
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
            if (!price || price < 0.01 || price > 0.99) {
                showNotification('Price must be 0.01 to 0.99', 'error');
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
        if (result.success) {
            const sideText = side === 'higher' ? 'HIGHER' : 'LOWER';
            const typeText = selectedOrderType === 'market' ? 'Market' : 'Limit';
            if (selectedOrderType === 'market' && result.trade) {
                let message = `${typeText} order for ${sideText} filled!\n\n`;
                message += `Qty: ${amount} tokens\n`;
                message += `Avg price: ${result.trade.price.toFixed(4)}\n`;
                if (result.trade.source === 'orderbook') {
                    message += `\n• Filled from order book`;
                } else if (result.trade.source === 'mixed') {
                    message += `\n• From order book: ${result.trade.orderbookFilled} tokens`;
                    message += `\n• From AMM pool: ${result.trade.ammFilled} tokens`;
                } else if (result.trade.source === 'amm') {
                    message += `\n• Filled from AMM pool`;
                }
                showNotification(message, 'error');
            } else if (selectedOrderType === 'limit' && result.order) {
                const matched = result.matched || 0;
                const remaining = result.order.amount - matched;
                if (matched > 0 && remaining > 0) {
                    showNotification(`${typeText} order for ${sideText} placed!\n\n` +
                          `Filled immediately: ${matched} tokens\n` +
                          `Remaining in book: ${remaining} tokens`);
                } else if (matched > 0) {
                    showNotification(`${typeText} order for ${sideText} fully filled!\n\n` +
                          `Qty: ${matched} tokens`);
                } else {
                    showNotification(`${typeText} order for ${sideText} placed!\n\nQty: ${amount} tokens`, 'success');
                }
            } else {
                showNotification(`${typeText} order for ${sideText} placed!\n\nQty: ${amount} tokens`, 'success');
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
            showNotification(`Error: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('❌ Trade execution error:', error);
        showNotification('Order placement error', 'error');
    }
}
// POLYMARKET-STYLE UNIFIED TRADING
let currentTradeSide = 'higher';
let currentTradeAction = 'buy'; // 'buy' or 'sell'
function switchTradeAction(action) {
    currentTradeAction = action;
    const buyBtn = document.getElementById('tradeBuyBtn');
    const sellBtn = document.getElementById('tradeSellBtn');
    const posInfo = document.getElementById('sellPositionInfo');
    if (action === 'buy') {
        buyBtn.style.background = 'var(--accent-green)';
        buyBtn.style.color = '#000';
        buyBtn.style.border = 'none';
        sellBtn.style.background = 'var(--bg-tertiary)';
        sellBtn.style.color = 'var(--text-secondary)';
        sellBtn.style.border = '1px solid var(--border)';
        posInfo.style.display = 'none';
    } else {
        sellBtn.style.background = 'var(--accent-red)';
        sellBtn.style.color = '#fff';
        sellBtn.style.border = 'none';
        buyBtn.style.background = 'var(--bg-tertiary)';
        buyBtn.style.color = 'var(--text-secondary)';
        buyBtn.style.border = '1px solid var(--border)';
        posInfo.style.display = 'block';
        updateSellPositionInfo();
    }
    updateTradeButton();
    calculateUnifiedEstimate();
}
function updateSellPositionInfo() {
    const side = currentTradeSide;
    const amountEl = document.getElementById('sellPositionAmount');
    const priceEl = document.getElementById('sellPositionPrice');
    // Find position for current side from userPositions (fetch from API)
    fetchCurrentPosition(side).then(pos => {
        if (pos) {
            amountEl.textContent = pos.amount.toFixed(2) + ' tokens';
            priceEl.textContent = pos.avgPrice.toFixed(4);
        } else {
            amountEl.textContent = '0 tokens';
            priceEl.textContent = '—';
        }
    });
}
async function fetchCurrentPosition(side) {
    if (!wallet) return null;
    try {
        const intervalMinutes = getCurrentInterval();
        const resp = await fetch(`${API_BASE}/api/orders?action=positions&wallet=${wallet}&intervalMinutes=${intervalMinutes}`);
        const data = await resp.json();
        if (data.success && data.positions) {
            return data.positions.find(p => p.side === side) || null;
        }
    } catch(e) {}
    return null;
}
function updateTradeButton() {
    const btn = document.getElementById('tradeExecuteBtn');
    const sideText = currentTradeSide === 'higher' ? 'HIGHER' : 'LOWER';
    if (currentTradeAction === 'buy') {
        btn.textContent = 'BUY ' + sideText;
        btn.style.background = currentTradeSide === 'higher' ? 'var(--accent-green)' : 'var(--accent-red)';
        btn.style.color = currentTradeSide === 'higher' ? '#000' : '#fff';
    } else {
        btn.textContent = 'SELL ' + sideText;
        btn.style.background = '#FF6B35';
        btn.style.color = '#fff';
    }
}
function switchTradeSide(side) {
    currentTradeSide = side;
    const higherBtn = document.getElementById('sideHigherBtn');
    const lowerBtn = document.getElementById('sideLowerBtn');
    if (side === 'higher') {
        higherBtn.style.background = currentTradeAction === 'buy' ? 'var(--accent-green)' : '#FF6B35';
        higherBtn.style.color = currentTradeAction === 'buy' ? '#000' : '#fff';
        higherBtn.style.border = 'none';
        lowerBtn.style.background = 'var(--bg-tertiary)';
        lowerBtn.style.color = 'var(--text-secondary)';
        lowerBtn.style.border = '1px solid var(--border)';
    } else {
        lowerBtn.style.background = currentTradeAction === 'buy' ? 'var(--accent-red)' : '#FF6B35';
        lowerBtn.style.color = '#fff';
        lowerBtn.style.border = 'none';
        higherBtn.style.background = 'var(--bg-tertiary)';
        higherBtn.style.color = 'var(--text-secondary)';
        higherBtn.style.border = '1px solid var(--border)';
    }
    updateTradeButton();
    if (currentTradeAction === 'sell') updateSellPositionInfo();
    // Recalculate estimate
    calculateUnifiedEstimate();
    // Re-render orderbook flipped for new side
    renderOrderBook();
}
async function calculateUnifiedEstimate() {
    const amount = parseFloat(document.getElementById('tradeAmount').value) || 0;
    const estimateEl = document.getElementById('tradeEstimate');
    if (amount <= 0) {
        estimateEl.innerHTML = '<div style="color: var(--text-dim);">Enter amount</div>';
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
                        <span>Avg price:</span>
                        <span>${data.avgPrice.toFixed(4)}</span>
                    </div>
                    <div class="estimate-row">
                        <span>Price Impact:</span>
                        <span class="${data.priceImpact > 5 ? 'text-red' : 'text-green'}">
                            ${data.priceImpact?.toFixed(2) || '0.00'}%
                        </span>
                    </div>
                    <div class="estimate-row">
                        <span>Total:</span>
                        <span class="text-yellow">${cost.toFixed(0)} tokens</span>
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
                <span>Price:</span>
                <span>${price.toFixed(4)}</span>
            </div>
            <div class="estimate-row">
                <span>Total:</span>
                <span class="text-yellow">${(amount * price).toFixed(0)} tokens</span>
            </div>
        `;
    }
}
async function executeUnifiedTrade() {
    if (!wallet) {
        openModal();
        return;
    }
    const amount = parseFloat(document.getElementById('tradeAmount').value) || 0;
    const side = currentTradeSide;
    if (amount <= 0) {
        showNotification('Enter valid amount', 'error');
        return;
    }
    if (currentTradeAction !== 'sell' && amount < 500) {
        showNotification('Minimum: 500 tokens', 'error');
        return;
    }
    // SELL mode
    if (currentTradeAction === 'sell') {
        try {
            const intervalMinutes = getCurrentInterval();
            const orderData = {
                wallet,
                side,
                amount,
                type: selectedOrderType,
                action: 'sell',
                intervalMinutes
            };
            if (selectedOrderType === 'limit') {
                const price = parseFloat(document.getElementById('tradePrice').value);
                if (!price || price < 0.01 || price > 0.99) {
                    showNotification('Price must be 0.01 to 0.99', 'error');
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
            if (result.success && result.sell) {
                const sideText = side === 'higher' ? 'HIGHER' : 'LOWER';
                let message;
                if (result.sell.limitOrderPlaced && result.sell.amount <= 0) {
                    message = `Sell limit order placed for ${result.sell.limitOrderPlaced.toFixed(0)} ${sideText}`;
                } else if (result.sell.limitOrderPlaced) {
                    const profit = result.sell.profit;
                    const profitText = profit >= 0 ? `+${profit.toFixed(2)}` : profit.toFixed(2);
                    message = `Sold ${result.sell.amount.toFixed(0)} ${sideText} @ ${result.sell.avgPrice.toFixed(2)}\nSell limit order placed for remaining ${result.sell.limitOrderPlaced.toFixed(0)}`;
                } else {
                    const profit = result.sell.profit;
                    const profitText = profit >= 0 ? `+${profit.toFixed(2)}` : profit.toFixed(2);
                    message = `Sold ${result.sell.amount.toFixed(0)} ${sideText} @ ${result.sell.avgPrice.toFixed(2)}\nProceeds: ${result.sell.proceeds.toFixed(2)} | P&L: ${profitText}`;
                }
                showNotification(message, 'success');
                document.getElementById('tradeAmount').value = '';
                document.getElementById('tradeEstimate').innerHTML = '<div style="color: var(--text-dim);">Enter amount</div>';
                updateSellPositionInfo();
                await Promise.all([
                    fetchOrderBook(),
                    fetchRecentTrades(),
                    fetchTokenBalance(),
                    fetchUserOrders(),
                    fetchUserPositions()
                ]);
            } else {
                showNotification(result.error || 'Sell error', 'error');
            }
        } catch (error) {
            console.error('❌ Sell error:', error);
            showNotification('Sell error', 'error');
        }
        return;
    }
    // BUY mode (existing logic)
    if (amount > tokenBalance) {
        showNotification('Insufficient tokens', 'error');
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
            if (!price || price < 0.01 || price > 0.99) {
                showNotification('Price must be 0.01 to 0.99', 'error');
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
        if (result.success) {
            const sideText = side === 'higher' ? 'HIGHER' : 'LOWER';
            const typeText = selectedOrderType === 'market' ? 'Market' : 'Limit';
            if (selectedOrderType === 'market' && result.trade) {
                let message = `${typeText} order for ${sideText} filled!\n\n`;
                message += `Qty: ${amount} tokens\n`;
                message += `Avg price: ${result.trade.price.toFixed(4)}\n`;
                if (result.trade.source === 'orderbook') {
                    message += `\n• Filled from order book`;
                } else if (result.trade.source === 'mixed') {
                    message += `\n• From order book: ${result.trade.orderbookFilled} tokens`;
                    message += `\n• From AMM pool: ${result.trade.ammFilled} tokens`;
                } else if (result.trade.source === 'amm') {
                    message += `\n• Filled from AMM pool`;
                }
                showNotification(message, 'error');
            } else {
                showNotification(`${typeText} order for ${sideText} placed!\n\nQty: ${amount} tokens`, 'success');
            }
            // Reset
            document.getElementById('tradeAmount').value = '';
            document.getElementById('tradeEstimate').innerHTML = '<div style="color: var(--text-dim);">Enter amount</div>';
            // Refresh data
            await Promise.all([
                fetchOrderBook(),
                fetchRecentTrades(),
                fetchTokenBalance(),
                fetchUserOrders(),
                fetchUserPositions()
            ]);
        } else {
            showNotification(`Error: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('❌ Trade execution error:', error);
        showNotification('Order placement error', 'error');
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
window.switchTradeAction = switchTradeAction;
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
async function loadRoundData() {
    await fetchAllRounds();
}
// Make this function available globally for index.html to call
window.loadMarketData = async function() {
    const intervalMinutes = getCurrentInterval();
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
        // Fetch settlements after short delay to let backend settle
        if (wallet) {
            setTimeout(() => fetchUnclaimedSettlements(), 2000);
            setTimeout(() => fetchUnclaimedSettlements(), 6000);
        }
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
                tabElement.textContent = `Closes in ${minutes}:${String(seconds).padStart(2, '0')}`;
            } else {
                tabElement.textContent = 'Closed';
            }
        } else {
            tabElement.textContent = 'Loading...';
        }
    });
}
// EVENT LISTENERS
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
async function waitForWallets(maxWait = 3000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        if (window.phantom || window.jupiter || window.solflare || window.coinbaseSolana || window.solana) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
}
window.addEventListener('load', async () => {
    // Set contract address in header from TOKEN_ADDRESS
    const contractEl = document.getElementById('contractAddr');
    if (contractEl) {
        contractEl.textContent = PLATFORM_PAUSED ? 'Awaiting token launch...' : TOKEN_ADDRESS;
    }

    // If paused — show waiting state, don't start anything
    if (PLATFORM_PAUSED) {
        document.getElementById('currentCap').textContent = '—';
        document.getElementById('targetCap').textContent = '—';
        document.getElementById('countdown').textContent = '--:--';
        document.getElementById('statHigherPrice').textContent = '—';
        document.getElementById('statLowerPrice').textContent = '—';
        [1, 2, 3].forEach(i => {
            const el = document.getElementById(`round-${i}-time`);
            if (el) el.textContent = 'Paused';
        });
        document.getElementById('tradeHistory').innerHTML =
            '<div style="padding: 20px; text-align: center; color: var(--text-dim);">Awaiting token launch...</div>';
        return;
    }

    await waitForWallets(3000);
    discoverWalletStandard();
    const savedWallet = getSavedWalletChoice();
    let autoConnected = false;
    if (savedWallet) {
        try {
            if (savedWallet.startsWith('ws:')) {
                // Wallet Standard
                const wsName = savedWallet.slice(3);
                const w = walletStandardWallets.find(w => w.name === wsName);
                if (w) {
                    const connectFeature = w.features?.['standard:connect'];
                    if (connectFeature?.connect) {
                        const result = await connectFeature.connect({ silent: true });
                        const account = result.accounts?.[0];
                        if (account) {
                            wallet = account.address;
                            activeProvider = window.solana || null;
                            activeWalletType = savedWallet;
                            autoConnected = true;
                        }
                    }
                }
            } else if (WALLETS[savedWallet]) {
                const provider = WALLETS[savedWallet].get();
                if (provider) {
                    try {
                        const resp = await provider.connect({ onlyIfTrusted: true });
                        wallet = resp.publicKey.toString();
                        activeProvider = provider;
                        activeWalletType = savedWallet;
                        autoConnected = true;
                    } catch(e) {
                        if (provider.isConnected && provider.publicKey) {
                            wallet = provider.publicKey.toString();
                            activeProvider = provider;
                            activeWalletType = savedWallet;
                            autoConnected = true;
                        }
                    }
                }
            }
        } catch(e) {
        }
    }
    if (!autoConnected) {
        for (const [key, info] of Object.entries(WALLETS)) {
            const provider = info.get();
            if (provider?.isConnected && provider?.publicKey) {
                wallet = provider.publicKey.toString();
                activeProvider = provider;
                activeWalletType = key;
                autoConnected = true;
                saveWalletChoice(key);
                break;
            }
        }
    }
    if (autoConnected) {
        updateUI(true);
        await fetchTokenBalance();
    } else {
        updateUI(false);
    }
    // Set contract address in header from TOKEN_ADDRESS
    document.getElementById('contractAddr').textContent = TOKEN_ADDRESS;
    
    await Promise.all([
        loadRoundData(),
        updateMarketCap()
    ]).catch(e => console.error('Init error:', e));
    Promise.all([
        fetchOrderBook(),
        fetchRecentTrades(),
        fetchUserOrders(),
        fetchUserPositions(),
        fetchUnclaimedSettlements() 
    ]).catch(e => console.error('Init bg error:', e));
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
    }, 10000);
    // SETTLEMENTS FUNCTIONALITY
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
            showNotification('Connect wallet', 'error');
            return;
        }
        try {
            const settlement = userSettlements.find(s => s.roundId === roundId);
            if (!settlement) {
                showNotification('Settlement not found', 'error');
                return;
            }
            const btn = document.getElementById(`claim-btn-${roundId}`);
            if (btn) {
                btn.disabled = true;
                btn.textContent = 'Processing...';
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
                showNotification(`Winnings claimed!\n\nReceived: ${result.payout.toFixed(2)} tokens\nP&L: ${result.profitLoss.toFixed(2)} tokens`, 'success');
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
                showNotification(`Error: ${result.error}`, 'error');
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = 'Claim';
                }
            }
        } catch (error) {
            console.error('❌ Claim settlement error:', error);
            showNotification('Claim error', 'error');
        }
    }
    function updateSettlementsAlert() {
        const countEl = document.getElementById('settlementsCount');
        if (!countEl) return;
        if (userSettlements.length > 0) {
            // Show badge with unclaimed count
            countEl.innerHTML = `<span style="color: var(--accent-yellow);">● ${userSettlements.length}</span>`;
        } else {
            countEl.innerHTML = `<span style="color: var(--text-dim);">→</span>`;
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
            // Show unclaimed tab if there are unclaimed, otherwise show history
            if (userSettlements.length > 0) {
                switchSettlementTab('unclaimed');
            } else {
                switchSettlementTab('history');
            }
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
        const txContainer = document.getElementById('settlementsTransactions');
        if (txContainer) txContainer.style.display = tab === 'transactions' ? 'block' : 'none';
        if (tab === 'unclaimed') {
            await renderUnclaimedSettlements();
        } else if (tab === 'history') {
            await renderSettlementHistory();
        } else if (tab === 'transactions') {
            await renderTransactions();
        }
    }
    async function renderUnclaimedSettlements() {
        const container = document.getElementById('settlementsUnclaimed');
        if (!wallet) {
            container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: var(--text-dim);">
                    Connect wallet to view
                </div>
            `;
            return;
        }
        if (userSettlements.length === 0) {
            container.innerHTML = `
                <div style="padding: 20px; text-align: center; color: var(--text-dim);">
                    Loading...
                </div>
            `;
            try {
                const response = await fetch(`${API_BASE}/api/settlement?action=unclaimed&wallet=${wallet}`);
                const data = await response.json();
                if (data.success) {
                    userSettlements = data.settlements || [];
                    updateSettlementsAlert();
                }
            } catch(e) {
                console.error('Fetch unclaimed error:', e);
            }
        }
        if (userSettlements.length === 0) {
            container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: var(--text-dim);">
                    <div style="font-size: 3em; margin-bottom: 15px;">◎</div>
                    <div style="font-size: 1.2em; margin-bottom: 10px;">No unclaimed winnings</div>
                    <div style="font-size: 0.9em;">Participate in rounds to earn payouts!</div>
                </div>
            `;
            return;
        }
        try {
            container.innerHTML = userSettlements.map(s => renderSettlementCard(s, false)).join('');
        } catch(e) {
            console.error('Render settlement cards error:', e);
            container.innerHTML = `
                <div style="padding: 20px; text-align: center; color: var(--accent-red);">
                    Display error: ${e.message}
                </div>
            `;
        }
    }
    async function renderSettlementHistory() {
    const container = document.getElementById('settlementsHistory');
    if (!wallet) {
        container.innerHTML = `
            <div style="padding: 40px; text-align: center; color: var(--text-dim);">
                Connect wallet to view
            </div>
        `;
        return;
    }
    container.innerHTML = `
        <div style="padding: 20px; text-align: center; color: var(--text-dim);">
            Loading history...
        </div>
    `;
    try {
        const response = await fetch(`${API_BASE}/api/settlement?action=history&wallet=${wallet}`);
        const data = await response.json();
        if (!data.success || !data.settlements || data.settlements.length === 0) {
            container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: var(--text-dim);">
                    <div style="font-size: 3em; margin-bottom: 15px;">≡</div>
                    <div style="font-size: 1.2em;">History is empty</div>
                </div>
            `;
            return;
        }
        container.innerHTML = data.settlements.map(s => renderSettlementCard(s, true)).join('');
    } catch (error) {
        console.error('❌ Error loading history:', error);
        container.innerHTML = `
            <div style="padding: 40px; text-align: center; color: var(--accent-red);">
                Error loading history
            </div>
        `;
    }
}
    function buildTransactionRow(t) {
        const typeMap = {
            'deposit': { label: '↓ Deposit', color: 'var(--accent-green)' },
            'withdrawal': { label: '↑ Withdrawal', color: 'var(--accent-red)' },
            'trade_credit': { label: '$ Payout', color: 'var(--accent-green)' },
            'trade_debit': { label: '○ Trade debit', color: 'var(--accent-red)' },
            'order_lock': { label: '⌂ Order lock', color: 'var(--text-dim)' },
            'order_unlock': { label: '⌂ Order unlock', color: 'var(--text-dim)' },
            'refund': { label: '↔ Refund', color: 'var(--accent-yellow)' }
        };
        const info = typeMap[t.type] || { label: t.type, color: 'var(--text-dim)' };
        const isPositive = t.amount > 0 && (t.type === 'deposit' || t.type === 'trade_credit' || t.type === 'refund' || t.type === 'order_unlock');
        const amtColor = isPositive ? 'var(--accent-green)' : 'var(--accent-red)';
        const sign = isPositive ? '+' : (t.type === 'withdrawal' || t.type === 'trade_debit' || t.type === 'order_lock') ? '-' : '';
        const date = new Date(t.createdAt).toLocaleString('en-US', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        const amt = Math.abs(t.amount).toFixed(2);
        const bal = t.balanceAfter.toFixed(2);
        return '<tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">' +
            '<td style="padding: 10px; color: var(--text-dim);">' + date + '</td>' +
            '<td style="padding: 10px; color: ' + info.color + ';">' + info.label + '</td>' +
            '<td style="padding: 10px; text-align: right; color: ' + amtColor + '; font-weight: 600;">' + sign + amt + '</td>' +
            '<td style="padding: 10px; text-align: right; color: var(--text-primary);">' + bal + '</td>' +
            '</tr>';
    }
    function buildTransactionsTable(transactions) {
        const header = '<div style="max-height: 500px; overflow-y: auto;">' +
            '<table style="width: 100%; border-collapse: collapse; font-size: 0.9em;">' +
            '<thead><tr style="border-bottom: 1px solid var(--border); color: var(--text-dim); font-size: 0.85em;">' +
            '<th style="padding: 10px; text-align: left;">Date</th>' +
            '<th style="padding: 10px; text-align: left;">Type</th>' +
            '<th style="padding: 10px; text-align: right;">Amount</th>' +
            '<th style="padding: 10px; text-align: right;">Balance</th>' +
            '</tr></thead><tbody>';
        const rows = transactions.map(t => buildTransactionRow(t)).join('');
        return header + rows + '</tbody></table></div>';
    }
    async function renderTransactions() {
        const container = document.getElementById('settlementsTransactions');
        if (!container) return;
        if (!wallet) {
            container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: var(--text-dim);">
                    Connect wallet to view
                </div>
            `;
            return;
        }
        container.innerHTML = `
            <div style="padding: 20px; text-align: center; color: var(--text-dim);">
                Loading transactions...
            </div>
        `;
        try {
            const response = await fetch(`${API_BASE}/api/settlement?action=transactions&wallet=${wallet}`);
            const data = await response.json();
            if (!data.success || !data.transactions || data.transactions.length === 0) {
                container.innerHTML = `
                    <div style="padding: 40px; text-align: center; color: var(--text-dim);">
                        <div style="font-size: 3em; margin-bottom: 15px;">⊞</div>
                        <div style="font-size: 1.2em;">No transactions</div>
                    </div>
                `;
                return;
            }
            container.innerHTML = buildTransactionsTable(data.transactions);
        } catch (error) {
            console.error('❌ Error loading transactions:', error);
            container.innerHTML = `
                <div style="padding: 40px; text-align: center; color: var(--accent-red);">
                    Error loading transactions
                </div>
            `;
        }
    }
    function renderSettlementCard(settlement, showClaimed) {
        const {
            roundId, roundSlug, intervalMinutes, side, amount, totalCost,
            won, payout, profitLoss, claimed, claimedAt, claimTxHash
        } = settlement;
        const startMarketCap = parseFloat(settlement.startMarketCap) || 0;
        const finalMarketCap = parseFloat(settlement.finalMarketCap) || 0;
        const intervalName = intervalMinutes === 15 ? '15m' : 
                            intervalMinutes === 60 ? '1h' : '4h';
        const sideName = side === 'higher' ? '↑ HIGHER' : '↓ LOWER';
        const sideColor = side === 'higher' ? 'text-green' : 'text-red';
        const isTie = Math.abs(profitLoss) < 0.01 && won && payout > 0;
        const statusClass = isTie ? 'refund' : (won ? 'won' : 'lost');
        const statusText = isTie ? '↔ TIE' : (won ? '▲ WIN' : '▼ LOSS');
        const capChange = startMarketCap > 0 
            ? ((finalMarketCap - startMarketCap) / startMarketCap * 100).toFixed(2)
            : '0.00';
        const capArrow = finalMarketCap > startMarketCap ? '↗' : (finalMarketCap < startMarketCap ? '↘' : '→');
        return `
            <div class="settlement-card ${statusClass}">
                <div class="settlement-header">
                    <div class="settlement-round-info">
                        <div class="settlement-round-badge">${intervalName}</div>
                        <div>
                            <div style="font-weight: 600; color: var(--text-primary);">${roundSlug}</div>
                            <div style="font-size: 0.85em; color: var(--text-dim);">
                                ${new Date(settlement.endTime).toLocaleString('en-US')}
                            </div>
                        </div>
                    </div>
                    <div class="settlement-status ${statusClass}">
                        ${statusText}
                    </div>
                </div>
                <div class="market-cap-comparison">
                    <div>
                        <div style="font-size: 0.8em; color: var(--text-dim);">Start cap</div>
                        <div class="market-cap-value">$${startMarketCap > 0 ? startMarketCap.toLocaleString() : '—'}</div>
                    </div>
                    <div class="market-cap-arrow">${capArrow}</div>
                    <div>
                        <div style="font-size: 0.8em; color: var(--text-dim);">Final cap</div>
                        <div class="market-cap-value">$${finalMarketCap > 0 ? finalMarketCap.toLocaleString() : '—'}</div>
                    </div>
                    <div style="padding: 8px 15px; background: var(--bg-tertiary); border-radius: 8px; font-weight: 600;">
                        ${capChange > 0 ? '+' : ''}${capChange}%
                    </div>
                </div>
                <div class="settlement-details">
                    <div class="settlement-detail">
                        <div class="settlement-detail-label">Your position</div>
                        <div class="settlement-detail-value ${sideColor}">${sideName}</div>
                    </div>
                    <div class="settlement-detail">
                        <div class="settlement-detail-label">Quantity</div>
                        <div class="settlement-detail-value">${amount.toFixed(2)}</div>
                    </div>
                    <div class="settlement-detail">
                        <div class="settlement-detail-label">Invested</div>
                        <div class="settlement-detail-value">${totalCost.toFixed(2)}</div>
                    </div>
                    <div class="settlement-detail">
                        <div class="settlement-detail-label">${won ? 'Payout' : 'Loss'}</div>
                        <div class="settlement-detail-value ${won ? 'settlement-payout' : 'settlement-loss'}">
                            ${won ? '+' : ''}${(won ? profitLoss : totalCost).toFixed(2)}
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
                    This round is settled. Payout unavailable.
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
                    Claim ${payout.toFixed(2)} tokens
                </button>
            </div>
        `;
    }
    function renderClaimedStatus(claimed, claimedAt, claimTxHash) {
        if (!claimed) {
            return '<div class="settlement-claimed">Pending claim</div>';
        }
        const claimDate = new Date(claimedAt).toLocaleString('en-US');
        return `
            <div class="settlement-claimed">
                <strong>✓ Claimed</strong>
                ${claimDate}
                ${claimTxHash ? `
                    <br>
                    <a href="https://solscan.io/tx/${claimTxHash}" 
                       target="_blank" 
                       class="settlement-tx-link">
                        View transaction →
                    </a>
                ` : ''}
            </div>
        `;
    }
    window.claimSettlement = claimSettlement;
    window.openSettlementsModal = openSettlementsModal;
    window.closeSettlementsModal = closeSettlementsModal;
    window.switchSettlementTab = switchSettlementTab;
});
