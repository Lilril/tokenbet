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
// TOKEN BALANCE
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
        const data = await response.json();
        
        if (data.success) {
            orderBookData = data.orderBook;
            ammPrices = data.ammPrice;
            
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
    
    // Render HIGHER orders
    if (orderBookData.higher.length === 0) {
        higherEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-dim);">Нет ордеров</div>';
    } else {
        const maxAmount = Math.max(...orderBookData.higher.map(o => o.amount));
        
        higherEl.innerHTML = orderBookData.higher.map(order => {
            const pct = (order.amount / maxAmount) * 100;
            return `
                <div class="order-book-row">
                    <div class="order-bar" style="width: ${pct}%; background: linear-gradient(90deg, transparent, rgba(0, 255, 159, 0.2));"></div>
                    <div style="display: flex; justify-content: space-between; position: relative; z-index: 1;">
                        <span class="text-green">${order.price.toFixed(4)}</span>
                        <span>${order.amount.toFixed(0)}</span>
                    </div>
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
            const pct = (order.amount / maxAmount) * 100;
            return `
                <div class="order-book-row">
                    <div class="order-bar" style="width: ${pct}%; background: linear-gradient(90deg, transparent, rgba(255, 71, 87, 0.2));"></div>
                    <div style="display: flex; justify-content: space-between; position: relative; z-index: 1;">
                        <span class="text-red">${order.price.toFixed(4)}</span>
                        <span>${order.amount.toFixed(0)}</span>
                    </div>
                </div>
            `;
        }).join('');
    }
}

function updatePriceStats() {
    document.getElementById('statHigherPrice').textContent = ammPrices.higher.toFixed(3);
    document.getElementById('statLowerPrice').textContent = ammPrices.lower.toFixed(3);
    
    if (currentMarketCap > 0) {
        const formatted = currentMarketCap >= 1000000 
            ? `$${(currentMarketCap / 1000000).toFixed(2)}M`
            : currentMarketCap >= 1000
            ? `$${(currentMarketCap / 1000).toFixed(1)}K`
            : `$${currentMarketCap.toFixed(2)}`;
        
        document.getElementById('targetCap').textContent = formatted;
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
        const response = await fetch(`${API_BASE}/api/orders?action=user-positions&wallet=${wallet}&intervalMinutes=${intervalMinutes}`);
        const data = await response.json();
        
        if (data.success) {
            userPositions = data.positions || [];
            updatePositionsDisplay();
        }
    } catch (error) {
        console.error('❌ Failed to fetch user positions:', error);
    }
}

function updateOrdersDisplay() {
    // Update counter
    document.getElementById('activeOrdersCount').textContent = userOrders.length;
    
    // Update orders list
    const container = document.getElementById('myOrdersList');
    
    if (userOrders.length === 0) {
        container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-dim);">Нет активных ордеров</div>';
        return;
    }
    
    container.innerHTML = userOrders.map(order => {
        const sideClass = order.side === 'higher' ? 'buy' : 'sell';
        const sideText = order.side === 'higher' ? '⬆ ВЫШЕ' : '⬇ НИЖЕ';
        const filled = order.filled || 0;
        const remaining = order.amount - filled;
        const filledPercent = (filled / order.amount * 100).toFixed(1);
        
        return `
            <div class="trade-item ${sideClass}" style="position: relative;">
                <div style="flex: 1;">
                    <div style="font-weight: 600;">${sideText} @ ${order.price.toFixed(4)}</div>
                    <div class="trade-time">
                        ${remaining.toFixed(0)} / ${order.amount.toFixed(0)} шт
                        ${filled > 0 ? `(${filledPercent}% заполнено)` : ''}
                    </div>
                </div>
                <button 
                    onclick="cancelOrder(${order.id})" 
                    style="padding: 8px 16px; background: var(--accent-red); color: #000; border: none; cursor: pointer; font-weight: 600; border-radius: 4px; font-size: 0.9em;"
                >
                    ✕
                </button>
            </div>
        `;
    }).join('');
}

function updatePositionsDisplay() {
    // Update counter
    const hasPositions = userPositions.length > 0 ? '1' : '0';
    document.getElementById('openPositionsCount').textContent = hasPositions;
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

function toggleMyOrders() {
    const myOrdersSection = document.getElementById('myOrdersSection');
    if (myOrdersSection.style.display === 'none') {
        myOrdersSection.style.display = 'block';
        fetchUserOrders();
    } else {
        myOrdersSection.style.display = 'none';
    }
}

// Make functions globally available
window.cancelOrder = cancelOrder;
window.toggleMyOrders = toggleMyOrders;

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
// РАУНДЫ
// ============================================
async function loadRoundData() {
    await fetchAllRounds();
}

// Make this function available globally for index.html to call
window.loadMarketData = async function() {
    const intervalMinutes = getCurrentInterval();
    console.log(`📊 Loading data for ${intervalMinutes}m round`);
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
        fetchUserOrders(),      // NEW: Load user orders
        fetchUserPositions()    // NEW: Load positions
    ]);
    
    console.log('✅ Раунд инициализирован');
    
    // Intervals
    setInterval(updateCountdown, 1000);
    setInterval(updateAllRoundTabs, 1000); // FIXED: Update all tabs every second
    setInterval(updateMarketCap, 15000);
    setInterval(fetchOrderBook, 5000);
    setInterval(fetchRecentTrades, 10000);
    setInterval(fetchAllRounds, 30000); // FIXED: Refresh round data every 30s
    setInterval(() => {
        if (wallet) {
            fetchTokenBalance();
            fetchUserOrders();      // NEW: Refresh user orders
            fetchUserPositions();   // NEW: Refresh positions
        }
    }, 20000);
    
    console.log('✅ Приложение готово к работе');
});
