// ============================================// ============================================
// КОНФИГУРАЦИЯ
// ============================================
const TOKEN_ADDRESS = '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';
// Используем публичный RPC Solana (для тестов пойдет, но может быть медленным)
// Если есть свой RPC от Helius/Quicknode, вставь его сюда
const SOLANA_RPC = 'https://mainnet.helius-rpc.com/?api-key=fe6c7452-4dba-4f63-a89b-242b0d7dd886'; 

let wallet = null;
let connection = null; 
let selectedInterval = 15;
let currentMarketCap = 0;
let targetMarketCap = 0;
let roundStartTime = null;

// Инициализируем соединение правильно, используя solanaWeb3
try {
    connection = new solanaWeb3.Connection(SOLANA_RPC, 'confirmed');
    console.log('✅ Solana connection initialized');
} catch (e) {
    console.error('❌ Ошибка инициализации Solana:', e);
}

// ============================================
// КОШЕЛЬКИ
// ============================================
const WALLETS = {
    phantom: {
        name: 'Phantom',
        icon: '👻',
        color: '#AB9FF2',
        get: () => {
            if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
            if (window.solana?.isPhantom) return window.solana;
            return null;
        }
    },
    solflare: {
        name: 'Solflare',
        icon: '🔥',
        color: '#FC6C2C',
        get: () => window.solflare || (window.solana?.isSolflare ? window.solana : null)
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

// Делаем функцию доступной глобально для HTML onclick
window.connect = async function(key) {
    const walletConfig = WALLETS[key];
    const provider = walletConfig.get();

    if (!provider) {
        alert(`${walletConfig.name} не найден.`);
        return;
    }

    try {
        // Если уже подключен, не вызываем connect снова, чтобы избежать ошибок
        if (!provider.isConnected) {
             await provider.connect();
        }
        
        // Получаем публичный ключ по-разному для разных кошельков
        const publicKey = provider.publicKey;
        
        if (publicKey) {
            wallet = publicKey.toString();
            finishConnection();
        } else {
            console.error('Публичный ключ не найден');
        }
    } catch (error) {
        console.error('Connection error:', error);
    }
};

function finishConnection() {
    console.log('✅ Connected:', wallet);
    updateUI(true);
    fetchTokenBalance(); 
    closeModal();
}

window.disconnect = function() {
    const provider = window.solana || window.phantom?.solana;
    if (provider && provider.disconnect) {
        provider.disconnect();
    }
    wallet = null;
    updateUI(false);
};

// ============================================
// БАЛАНС ТОКЕНОВ
// ============================================
async function fetchTokenBalance() {
    if (!wallet || !connection) return;

    try {
        console.log('⏳ Получаю баланс для:', wallet);
        document.getElementById('tokenBalance').textContent = 'Загрузка...';

        const walletPublicKey = new solanaWeb3.PublicKey(wallet);
        const tokenMint = new solanaWeb3.PublicKey(TOKEN_ADDRESS);

        const response = await connection.getParsedTokenAccountsByOwner(
            walletPublicKey, 
            { mint: tokenMint }
        );

        let uiAmount = 0;
        
        if (response.value.length > 0) {
            uiAmount = response.value[0].account.data.parsed.info.tokenAmount.uiAmount;
        }

        console.log('✅ Баланс токена:', uiAmount);
        
        const formattedBalance = uiAmount.toLocaleString('en-US', { 
            minimumFractionDigits: 0, 
            maximumFractionDigits: 2 
        });
        
        document.getElementById('tokenBalance').textContent = formattedBalance + ' $TOKEN';
        
        const hasBalance = uiAmount > 0;
        document.getElementById('betHigher').disabled = !hasBalance;
        document.getElementById('betLower').disabled = !hasBalance;

    } catch (error) {
        console.error('❌ Ошибка получения баланса:', error);
        document.getElementById('tokenBalance').textContent = 'Ошибка RPC';
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
        btn.onclick = window.disconnect;
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
// КАПИТАЛИЗАЦИЯ (ФИКС ДЛЯ LOCALHOST)
// ============================================
async function fetchMarketCap() {
    try {
        // Используем DexScreener API напрямую - он разрешает CORS и отлично работает на localhost
        // Это надежнее, чем Pump.fun API для клиента
        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_ADDRESS}`);
        const data = await response.json();
        
        if (data.pairs && data.pairs.length > 0) {
            // Берем первую пару (обычно самая ликвидная)
            const pair = data.pairs[0];
            const marketCap = pair.marketCap || pair.fdv || 0;
            console.log('✅ Market cap from DexScreener:', marketCap);
            return marketCap;
        } 
        
        // ЗАПАСНОЙ ВАРИАНТ: Если DexScreener еще не видит пару (токен только на pump.fun)
        // Используем прокси allorigins, чтобы обойти CORS при запросе к pump.fun
        console.log('⚠️ DexScreener пуст, пробую Pump.fun через прокси...');
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent('https://frontend-api.pump.fun/coins/' + TOKEN_ADDRESS)}`;
        
        const pumpResponse = await fetch(proxyUrl);
        const pumpData = await pumpResponse.json();
        
        if (pumpData.contents) {
            const parsedData = JSON.parse(pumpData.contents);
            const marketCap = parseFloat(parsedData.usd_market_cap) || 0;
            console.log('✅ Market cap from Pump.fun (via proxy):', marketCap);
            return marketCap;
        }

        return 0;
    } catch (error) {
        console.error('❌ Ошибка получения цены:', error);
        return 0; // Возвращаем 0, если все сломалось
    }
}

async function updateMarketCap() {
    currentMarketCap = await fetchMarketCap();
    
    // Если капа все еще 0 (ошибка или новый токен), ставим заглушку для теста UI
    // Убери эту строку, когда закончишь тесты!
    if (currentMarketCap === 0) {
        console.log('⚠️ Капа 0, ставлю тестовое значение 15000$');
        currentMarketCap = 15000; 
    }

    let formatted = '$0';
    if (currentMarketCap >= 1000000) {
        formatted = `$${(currentMarketCap / 1000000).toFixed(2)}M`;
    } else if (currentMarketCap >= 1000) {
        formatted = `$${(currentMarketCap / 1000).toFixed(1)}K`;
    } else {
        formatted = `$${currentMarketCap.toFixed(2)}`;
    }
    
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
        targetMarketCap = currentMarketCap;
        roundStartTime = now;
    }
    
    let targetFormatted = '$---';
    if (targetMarketCap >= 1000000) {
        targetFormatted = `$${(targetMarketCap / 1000000).toFixed(2)}M`;
    } else if (targetMarketCap >= 1000) {
        targetFormatted = `$${(targetMarketCap / 1000).toFixed(1)}K`;
    } else if (targetMarketCap > 0) {
        targetFormatted = `$${targetMarketCap.toFixed(2)}`;
    }
    
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
// ИНИЦИАЛИЗАЦИЯ
// ============================================
window.onload = async () => {
    updateUI(false);
    await updateMarketCap();
    initializeRound();
    
    setInterval(updateCountdown, 1000);
    setInterval(async () => {
        await updateMarketCap();
        // В реальном проекте roundStartTime нужно не сбрасывать, а проверять
        // Но для теста оставим так
    }, 5000);
};
};
