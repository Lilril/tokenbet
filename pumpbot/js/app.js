// ============================================
// КОНФИГУРАЦИЯ
// ============================================
const TOKEN_ADDRESS = '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';

let wallet = null;
let selectedInterval = 15;
let currentMarketCap = 0;
let targetMarketCap = 0;
let roundStartTime = null;
let lastSuccessfulFetch = null;

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
        
        console.log('⚠️ API не вернул данные');
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
// КАПИТАЛИЗАЦИЯ (ТОЛЬКО РЕАЛЬНЫЕ ДАННЫЕ)
// ============================================
async function fetchMarketCap() {
    const capElement = document.getElementById('currentCap');
    
    try {
        console.log('📡 Запрос цены токена...');
        
        const response = await fetch(`/api/marketcap?token=${TOKEN_ADDRESS}`, {
            method: 'GET',
            headers: {
                'Cache-Control': 'no-cache'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        console.log('API response:', data);
        
        if (data.success && data.marketCap > 0) {
            lastSuccessfulFetch = Date.now();
            
            console.log(`✅ Price: $${data.price?.toFixed(8) || 'N/A'}`);
            console.log(`✅ Market Cap: $${data.marketCap.toFixed(2)} (via ${data.method})`);
            
            // Убираем красный цвет ошибки если был
            capElement.style.color = '#ffaa00';
            
            return data.marketCap;
        } else {
            throw new Error(data.error || 'No market cap data');
        }
        
    } catch (error) {
        console.error('❌ Ошибка получения капы:', error.message);
        
        // Показываем ошибку только если прошло больше 30 секунд с последнего успешного запроса
        const timeSinceSuccess = lastSuccessfulFetch ? Date.now() - lastSuccessfulFetch : Infinity;
        
        if (timeSinceSuccess > 30000) {
            capElement.textContent = 'API недоступен';
            capElement.style.color = '#ff6b6b';
        }
        
        // Возвращаем последнее известное значение или 0
        return currentMarketCap || 0;
    }
}

async function updateMarketCap() {
    const newCap = await fetchMarketCap();
    
    // Обновляем только если получили валидное значение
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
        console.log('🎯 Раунд завершен!');
        console.log(`   Целевая капа была: $${targetMarketCap.toFixed(2)}`);
        console.log(`   Финальная капа: $${currentMarketCap.toFixed(2)}`);
        
        targetMarketCap = currentMarketCap;
        roundStartTime = now;
    }
    
    const targetFormatted = targetMarketCap >= 1000000 
        ? `$${(targetMarketCap / 1000000).toFixed(2)}M`
        : targetMarketCap >= 1000
        ? `$${(targetMarketCap / 1000).toFixed(1)}K`
        : `$${targetMarketCap.toFixed(2)}`;
    
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
    
    const difference = ((currentMarketCap - targetMarketCap) / targetMarketCap * 100).toFixed(2);
    
    alert(
        `✅ Ставка ВЫШЕ принята!\n\n` +
        `Текущая капа: $${currentMarketCap.toFixed(2)}\n` +
        `Целевая капа: $${targetMarketCap.toFixed(2)}\n` +
        `Разница: ${difference}%`
    );
};

document.getElementById('betLower').onclick = () => {
    if (!wallet) return openModal();
    
    const difference = ((currentMarketCap - targetMarketCap) / targetMarketCap * 100).toFixed(2);
    
    alert(
        `✅ Ставка НИЖЕ принята!\n\n` +
        `Текущая капа: $${currentMarketCap.toFixed(2)}\n` +
        `Целевая капа: $${targetMarketCap.toFixed(2)}\n` +
        `Разница: ${difference}%`
    );
};

document.querySelectorAll('.interval-btn').forEach(btn => {
    btn.onclick = function() {
        document.querySelectorAll('.interval-btn').forEach(b => 
            b.classList.remove('active'));
        this.classList.add('active');
        selectedInterval = parseInt(this.dataset.interval);
        roundStartTime = null;
        initializeRound();
        console.log(`⏱ Интервал изменен на ${selectedInterval} минут`);
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
    console.log('🚀 $TOKEN Prediction Market загружается...');
    console.log('📍 Token:', TOKEN_ADDRESS);
    
    // Ждем кошельки
    await waitForWallets(3000);
    
    // Проверяем автоподключение
    const phantom = window.phantom?.solana || window.solana;
    if (phantom?.isConnected && phantom?.publicKey) {
        wallet = phantom.publicKey.toString();
        console.log('✅ Кошелек автоматически подключен');
        updateUI(true);
        await fetchTokenBalance();
    } else {
        updateUI(false);
    }
    
    // ПЕРВЫЙ запрос капитализации
    console.log('📊 Получаю начальную капитализацию...');
    await updateMarketCap();
    
    // Инициализируем раунд только после получения капы
    if (currentMarketCap > 0) {
        initializeRound();
        console.log('✅ Раунд инициализирован');
    } else {
        console.warn('⚠️ Не удалось получить начальную капитализацию');
        document.getElementById('currentCap').textContent = 'Ожидание...';
    }
    
    // Таймер обратного отсчета (каждую секунду)
    setInterval(updateCountdown, 1000);
    
    // Обновление капитализации (каждые 10 секунд)
    setInterval(async () => {
        await updateMarketCap();
        if (currentMarketCap > 0) {
            initializeRound();
        }
    }, 10000);
    
    // Обновление баланса (каждые 15 секунд, только если подключен)
    setInterval(() => {
        if (wallet) {
            fetchTokenBalance();
        }
    }, 15000);
    
    console.log('✅ Приложение готово к работе');
});
