// ============================================
// КОНФИГУРАЦИЯ
// ============================================
const TOKEN_ADDRESS = '2KhMg3yGW4giMYAnvT28mXr4LEGeBvj8x8FKP5Tfpump';
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
let roundStartTime = null;
let tokenBalance = 0;

// Trading state
let orderBookData = { higher: [], lower: [] };
let ammPrices = { higher: 0.5, lower: 0.5 };
let recentTrades = [];
let selectedSide = 'higher';
let selectedOrderType = 'market';

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
    tokenBalance = 0;
    updateUI(false);
}

// ============================================
// БАЛАНС ТОКЕНОВ
// ============================================
async function fetchTokenBalance() {
    if (!wallet) {
        tokenBalance = 0;
        updateBalanceDisplay();
        return;
    }

    try {
        const apiResponse = await fetch(`${API_BASE}/api/balance?wallet=${wallet}&token=${TOKEN_ADDRESS}`);
        
        if (apiResponse.ok) {
            const data = await apiResponse.json();
            
            if (data.success && data.balance !== undefined) {
                tokenBalance = data.balance;
                console.log('✅ Баланс токена:', tokenBalance);
                updateBalanceDisplay();
                return;
            }
        }
        
        tokenBalance = 0;
        updateBalanceDisplay();

    } catch (error) {
        console.error('❌ Ошибка получения баланса:', error);
        tokenBalance = 0;
        updateBalanceDisplay();
    }
}

function updateBalanceDisplay() {
    const formatted = tokenBalance.toLocaleString('en-US', { 
        minimumFractionDigits: 0,
        maximumFractionDigits: 2 
    });
    
    document.getElementById('tokenBalance').textContent = formatted;
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
// ORDER BOOK & TRADING
// ============================================
async function fetchOrderBook() {
    try {
        const response = await fetch(`${API_BASE}/api/orders?action=orderbook`);
        const data = await response.json();
        
        if (data.success) {
            orderBookData = data.orderBook;
            ammPrices = data.ammPrice;
            
            renderOrderBook();
            updatePriceStats();
        }
    } catch (error) {
        console.error('❌ Order book fetch error:', error);
    }
}

function renderOrderBook() {
    const higherEl = document.getElementById('orderBookHigher');
    const lowerEl = document.getElementById('orderBookLower');
    
    // Render HIGHER orders
    if (orderBookData.higher.length === 0) {
        higherEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-dim);">Нет ордеров</div>';
    } else {
        const maxAmount = Math.max(...orderBookData.higher.map(o => o.amount));
        
        higherEl.innerHTML = orderBookData.higher.map(order => {
            const widthPercent = (order.amount / maxAmount) * 100;
            
            return `
                <div class="orderbook-row buy" style="--width: ${widthPercent}%">
                    <span>${order.price.toFixed(3)}</span>
                    <span>${order.amount.toFixed(0)}</span>
                    <span>${order.orders}</span>
                </div>
            `;
        }).join('');
    }
    
    // Render LOWER orders
    if (orderBookData.lower.length === 0) {
        lowerEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-dim);">Нет ордеров</div>';
    } else {
        const maxAmount = Math.max(...orderBookData.lower.map(o => o.amount));
        
        lowerEl.innerHTML = orderBookData.lower.map(order => {
            const widthPercent = (order.amount / maxAmount) * 100;
            
            return `
                <div class="orderbook-row sell" style="--width: ${widthPercent}%">
                    <span>${order.price.toFixed(3)}</span>
                    <span>${order.amount.toFixed(0)}</span>
                    <span>${order.orders}</span>
                </div>
            `;
        }).join('');
    }
}

function updatePriceStats() {
    const higherPrice = ammPrices.higher || 0.5;
    const lowerPrice = ammPrices.lower || 0.5;
    
    document.getElementById('statHigherPrice').textContent = higherPrice.toFixed(3);
    document.getElementById('statLowerPrice').textContent = lowerPrice.toFixed(3);
    document.getElementById('statSpread').textContent = 
        ((Math.abs(higherPrice - lowerPrice) / higherPrice) * 100).toFixed(2) + '%';
}

async function fetchRecentTrades() {
    try {
        const response = await fetch(`${API_BASE}/api/orders?action=trades`);
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
        const time = new Date(trade.timestamp).toLocaleTimeString('ru-RU');
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
            const response = await fetch(
                `${API_BASE}/api/orders?action=quote&side=${side}&amount=${amount}`
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
    
    try {
        const orderData = {
            wallet,
            side,
            amount,
            type: selectedOrderType
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
        
        if (result.success) {
            const sideText = side === 'higher' ? 'ВЫШЕ' : 'НИЖЕ';
            const typeText = selectedOrderType === 'market' ? 'Маркет' : 'Лимит';
            
            alert(`✅ ${typeText} ордер на ${sideText} размещен!\n\nКоличество: ${amount} токенов`);
            
            // Reset form
            amountInput.value = '';
            if (selectedOrderType === 'limit') {
                document.getElementById(`price${side === 'higher' ? 'Higher' : 'Lower'}`).value = '';
            }
            
            // Refresh data
            await Promise.all([
                fetchOrderBook(),
                fetchRecentTrades(),
                fetchTokenBalance()
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
// РАУНДЫ
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
    
    await Promise.all([
        updateMarketCap(),
        fetchOrderBook(),
        fetchRecentTrades()
    ]);
    
    if (currentMarketCap > 0) {
        initializeRound();
        console.log('✅ Раунд инициализирован');
    }
    
    // Intervals
    setInterval(updateCountdown, 1000);
    setInterval(updateMarketCap, 15000);
    setInterval(fetchOrderBook, 5000);
    setInterval(fetchRecentTrades, 10000);
    setInterval(() => {
        if (wallet) fetchTokenBalance();
    }, 20000);
    
    console.log('✅ Приложение готово к работе');
});
