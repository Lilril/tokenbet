// ============================================
// КОНФИГУРАЦИЯ
// ============================================
const TOKEN_ADDRESS = '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';

let wallet = null;
let selectedInterval = 15;
let currentMarketCap = 0;
let targetMarketCap = 0;
let roundStartTime = null;
let fetchAttempts = 0;

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
// БАЛАНС ТОКЕНОВ
// ============================================
async function fetchTokenBalance() {
    if (!wallet) {
        document.getElementById('tokenBalance').textContent = '0 $TOKEN';
        return;
    }

    try {
        console.log('📊 Получаю баланс для:', wallet);
        
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
        
        console.log('⚠️ API не вернул данные, показываем 0');
        document.getElementById('tokenBalance').textContent = '0 $TOKEN';
        document.getElementById('betHigher').disabled = true;
        document.getElementById('betLower').disabled = true;

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
// КАПИТАЛИЗАЦИЯ через Vercel API
// ============================================
async function fetchMarketCap() {
    try {
        fetchAttempts++;
        console.log(`📡 Попытка ${fetchAttempts}: Запрашиваю market cap через API...`);
        
        const response = await fetch(`/api/marketcap?token=${TOKEN_ADDRESS}`, {
            method: 'GET',
            headers: {
                'Cache-Control': 'no-cache'
            }
        });
        
        console.log('Response status:', response.status);
        
        if (!response.ok) {
            console.error('API returned error status:', response.status);
            throw new Error(`API error: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('API response:', data);
        
        if (data.success && data.marketCap > 0) {
            console.log(`✅ Market cap: $${data.marketCap.toFixed(2)} (via ${data.method})`);
            fetchAttempts = 0; // Сбрасываем счетчик при успехе
            return data.marketCap;
        } else {
            console.warn('⚠️ API вернул success но marketCap = 0 или failed');
            console.warn('Error message:', data.error);
            console.warn('Method used:', data.method);
            
            // Если это демо-данные, используем их
            if (data.method === 'demo-fallback' && data.marketCap > 0) {
                return data.marketCap;
            }
            
            // Иначе возвращаем минимум
            return 3600;
        }
        
    } catch (error) {
        console.error('❌ Fetch error:', error);
        
        // После 3 неудачных попыток показываем ошибку пользователю
        if (fetchAttempts >= 3) {
            document.getElementById('currentCap').textContent = 'Ошибка API';
            document.getElementById('currentCap').style.color = '#ff0000';
        }
        
        return 3600; // Fallback значение
    }
}

async function updateMarketCap() {
    const cap = await fetchMarketCap();
    currentMarketCap = cap;
    
    const formatted = currentMarketCap >= 1000000 
        ? `$${(currentMarketCap / 1000000).toFixed(2)}M`
        : `$${(currentMarketCap / 1000).toFixed(1)}K`;
    
    document.getElementById('currentCap').textContent = formatted;
    document.getElementById('currentCap').style.color = '#ffaa00'; // Восстанавливаем цвет
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
    alert(`✅ Ставка ВЫШЕ принята!\nТекущая капа: $${currentMarketCap.toFixed(0)}\nЦелевая капа: $${targetMarketCap.toFixed(0)}`);
};

document.getElementById('betLower').onclick = () => {
    if (!wallet) return openModal();
    alert(`✅ Ставка НИЖЕ принята!\nТекущая капа: $${currentMarketCap.toFixed(0)}\nЦелевая капа: $${targetMarketCap.toFixed(0)}`);
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
    console.log('🚀 Приложение загружается...');
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
    
    // Первый запрос капитализации
    console.log('📊 Первый запрос капитализации...');
    await updateMarketCap();
    initializeRound();
    
    // Запускаем таймеры
    setInterval(updateCountdown, 1000);
    
    // Обновляем капитализацию каждые 10 секунд
    setInterval(async () => {
        console.log('🔄 Обновление капитализации...');
        await updateMarketCap();
        initializeRound();
    }, 10000);
    
    // Обновляем баланс каждые 15 секунд если подключен
    setInterval(() => {
        if (wallet) {
            fetchTokenBalance();
        }
    }, 15000);
    
    console.log('✅ Приложение инициализировано');
});
