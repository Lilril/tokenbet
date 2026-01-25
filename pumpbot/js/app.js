// ============================================
// КОНФИГУРАЦИЯ
// ============================================
const TOKEN_ADDRESS = '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';

let wallet = null;
let selectedInterval = 15;
let currentMarketCap = 0;
let targetMarketCap = 0;
let roundStartTime = null;

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
        get: () => window.coinbaseSolana
    }
};

function renderWallets() {
    const html = Object.entries(WALLETS).map(([key, w]) => {
        const provider = w.get();
        const available = provider ? '✓' : '✗';
        const opacity = provider ? '1' : '0.5';
        
        return `
            <div class="wallet-option" onclick="connect('${key}')" style="opacity: ${opacity}">
                <div class="wallet-icon" style="background:${w.color}">${w.icon}</div>
                <div style="flex:1">${w.name}</div>
                <div>${available}</div>
            </div>
        `;
    }).join('');
    document.getElementById('walletsList').innerHTML = html;
}

async function connect(key) {
    const walletConfig = WALLETS[key];
    const provider = walletConfig.get();

    if (!provider) {
        const urls = {
            phantom: "https://phantom.app/",
            solflare: "https://solflare.com/",
            coinbase: "https://www.coinbase.com/wallet"
        };
        if(confirm(`${walletConfig.name} не найден. Перейти на сайт установки?`)) {
            window.open(urls[key], '_blank');
        }
        return;
    }

    try {
        if (provider.isConnected && provider.publicKey) {
            wallet = provider.publicKey.toString();
            finishConnection();
            return;
        }

        try {
           if (key === 'phantom') {
               await provider.connect({ onlyIfTrusted: false });
           } else {
               await provider.connect();
           }
        } catch (err) {
            throw new Error('User rejected');
        }

        if (provider.publicKey) {
            wallet = provider.publicKey.toString();
            finishConnection();
        } else {
            throw new Error('Public key not found after connect');
        }

    } catch (error) {
        console.error('Connection error:', error);
        
        if (error.message === 'User rejected' || error.message?.includes('rejected')) {
            console.log('Пользователь отменил подключение');
        } else {
            alert(`Ошибка: ${error.message}`);
        }
    }
}

function finishConnection() {
    console.log('✅ Connected:', wallet);
    updateUI(true);
    fetchTokenBalance();
    closeModal();
}

function disconnect() {
    const currentProvider = Object.values(WALLETS).find(w => w.get()?.publicKey?.toString() === wallet)?.get();
    if (currentProvider && currentProvider.disconnect) {
        currentProvider.disconnect().catch(console.error);
    }
    
    wallet = null;
    updateUI(false);
}

// ============================================
// БАЛАНС ТОКЕНОВ (через Vercel API прокси)
// ============================================
async function fetchTokenBalance() {
    if (!wallet) {
        document.getElementById('tokenBalance').textContent = '0 $TOKEN';
        return;
    }

    try {
        console.log('Получаю баланс для:', wallet);
        
        // Используем свой Vercel API endpoint как прокси
        const apiResponse = await fetch(`/api/balance?wallet=${wallet}&token=${TOKEN_ADDRESS}`);
        
        if (apiResponse.ok) {
            const data = await apiResponse.json();
            console.log('Balance API response:', data);
            
            if (data.success && data.balance !== undefined) {
                const balance = data.balance;
                console.log('✅ Баланс токена:', balance);
                
                const formattedBalance = balance.toLocaleString('en-US', { 
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 2 
                });
                
                document.getElementById('tokenBalance').textContent = formattedBalance + ' $TOKEN';
                document.getElementById('betHigher').disabled = balance === 0;
                document.getElementById('betLower').disabled = balance === 0;
                return;
            }
        }
        
        // Fallback: стандартный SPL token
        console.log('⚠️ Пробую SPL fallback...');
        const response = await fetch('https://api.mainnet-beta.solana.com', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getTokenAccountsByOwner',
                params: [
                    wallet,
                    {
                        mint: TOKEN_ADDRESS
                    },
                    {
                        encoding: 'jsonParsed'
                    }
                ]
            })
        });

        const data = await response.json();
        console.log('RPC Response:', data);

        if (data.result && data.result.value && data.result.value.length > 0) {
            const balance = data.result.value[0].account.data.parsed.info.tokenAmount.uiAmount;
            console.log('✅ Баланс токена (SPL):', balance);
            
            const formattedBalance = balance ? balance.toLocaleString('en-US', { 
                minimumFractionDigits: 0,
                maximumFractionDigits: 2 
            }) : '0';
            
            document.getElementById('tokenBalance').textContent = formattedBalance + ' $TOKEN';
            document.getElementById('betHigher').disabled = !balance || balance === 0;
            document.getElementById('betLower').disabled = !balance || balance === 0;
        } else {
            console.log('⚠️ Токен не найден');
            document.getElementById('tokenBalance').textContent = '0 $TOKEN';
            document.getElementById('betHigher').disabled = true;
            document.getElementById('betLower').disabled = true;
        }

    } catch (error) {
        console.error('❌ Ошибка получения баланса:', error);
        document.getElementById('tokenBalance').textContent = 'Ошибка';
        document.getElementById('betHigher').disabled = true;
        document.getElementById('betLower').disabled = true;
    }
}

// ============================================
// UI
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
        document.getElementById('tokenBalance').textContent = '---';
        document.getElementById('betHigher').disabled = true;
        document.getElementById('betLower').disabled = true;
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
// КАПИТАЛИЗАЦИЯ через Vercel API (обходит CORS)
// ============================================
async function fetchMarketCap() {
    try {
        console.log('📡 Запрашиваю market cap через API...');
        
        const response = await fetch(`/api/marketcap?token=${TOKEN_ADDRESS}`);
        const data = await response.json();
        
        console.log('API response:', data);
        
        if (data.success && data.marketCap > 0) {
            console.log('✅ Market cap:', data.marketCap, 'via', data.method);
            return data.marketCap;
        }
        
        // Если API вернул 0, пробуем DexScreener напрямую
        console.log('⚠️ API вернул 0, пробую DexScreener...');
        
        const dexResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_ADDRESS}`);
        
        if (dexResponse.ok) {
            const dexData = await dexResponse.json();
            
            if (dexData.pairs && dexData.pairs.length > 0) {
                const pair = dexData.pairs[0];
                const marketCap = pair.marketCap || pair.fdv || 0;
                
                if (marketCap > 0) {
                    console.log('✅ Market cap from DexScreener:', marketCap);
                    return marketCap;
                }
            }
        }
        
        console.error('❌ No market cap found anywhere');
        return 0;
        
    } catch (error) {
        console.error('❌ Fetch error:', error);
        return 0;
    }
}

async function updateMarketCap() {
    currentMarketCap = await fetchMarketCap();
    
    const formatted = currentMarketCap >= 1000000 
        ? `$${(currentMarketCap / 1000000).toFixed(2)}M`
        : `$${(currentMarketCap / 1000).toFixed(1)}K`;
    
    document.getElementById('currentCap').textContent = formatted;
}

// ============================================
// ЛОГИКА РАУНДОВ
// ============================================
function initializeRound() {
    const now = Date.now();
    const intervalMs = selectedInterval * 60 * 1000;
    
    if (!roundStartTime) {
        roundStartTime = now;
        targetMarketCap = currentMarketCap;
    }
    
    const elapsed = now - roundStartTime;
    if (elapsed >= intervalMs) {
        console.log('🎯 Раунд завершен! Новая целевая капа:', currentMarketCap);
        targetMarketCap = currentMarketCap;
        roundStartTime = now;
    }
    
    const targetFormatted = targetMarketCap >= 1000000 
        ? `$${(targetMarketCap / 1000000).toFixed(2)}M`
        : `$${(targetMarketCap / 1000).toFixed(1)}K`;
    
    document.getElementById('targetCap').textContent = targetFormatted;
}

function updateCountdown() {
    if (!roundStartTime) return;
    
    const now = Date.now();
    const intervalMs = selectedInterval * 60 * 1000;
    const elapsed = now - roundStartTime;
    const remaining = intervalMs - elapsed;
    
    if (remaining <= 0) {
        initializeRound();
        document.getElementById('countdown').textContent = '00:00';
        return;
    }
    
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    
    document.getElementById('countdown').textContent = 
        `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// ============================================
// СОБЫТИЯ
// ============================================
document.getElementById('closeModal').onclick = closeModal;
document.getElementById('walletModal').onclick = (e) => {
    if (e.target.id === 'walletModal') closeModal();
};

document.getElementById('betHigher').onclick = () => {
    if (!wallet) return openModal();
    alert(`✅ Ставка ВЫШЕ принята!\nЦелевая капа: $${targetMarketCap.toFixed(0)}`);
};

document.getElementById('betLower').onclick = () => {
    if (!wallet) return openModal();
    alert(`✅ Ставка НИЖЕ принята!\nЦелевая капа: $${targetMarketCap.toFixed(0)}`);
};

document.querySelectorAll('.interval-btn').forEach(btn => {
    btn.onclick = function() {
        document.querySelectorAll('.interval-btn').forEach(b => 
            b.classList.remove('active'));
        this.classList.add('active');
        selectedInterval = parseInt(this.dataset.interval);
        roundStartTime = null;
        initializeRound();
    };
});

// ============================================
// ИНИЦИАЛИЗАЦИЯ С ОЖИДАНИЕМ КОШЕЛЬКОВ
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
    console.log('🔄 Ждем инициализацию кошельков...');
    await waitForWallets(3000);
    console.log('✅ Кошельки готовы');
    
    // Проверяем автоподключение
    const phantom = window.phantom?.solana || window.solana;
    if (phantom?.isConnected && phantom?.publicKey) {
        wallet = phantom.publicKey.toString();
        updateUI(true);
        await fetchTokenBalance();
    } else {
        updateUI(false);
    }
    
    await updateMarketCap();
    initializeRound();
    
    setInterval(updateCountdown, 1000);
    setInterval(async () => {
        await updateMarketCap();
        initializeRound();
    }, 5000);
    
    // Обновляем баланс каждые 10 секунд если подключен
    setInterval(() => {
        if (wallet) {
            fetchTokenBalance();
        }
    }, 10000);
});
