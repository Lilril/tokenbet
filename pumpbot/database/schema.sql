-- ============================================
-- PREDICTION MARKET DATABASE SCHEMA
-- PostgreSQL 14+
-- ============================================

-- Пользователи
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    wallet_address VARCHAR(44) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    last_seen TIMESTAMP DEFAULT NOW(),
    total_volume DECIMAL(20, 2) DEFAULT 0,
    total_trades INTEGER DEFAULT 0,
    is_banned BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_users_wallet ON users(wallet_address);

-- Раунды (торговые сессии)
CREATE TABLE rounds (
    id SERIAL PRIMARY KEY,
    round_number INTEGER UNIQUE NOT NULL,
    interval_minutes INTEGER NOT NULL,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    target_market_cap DECIMAL(20, 2) NOT NULL,
    final_market_cap DECIMAL(20, 2),
    winning_side VARCHAR(10),
    status VARCHAR(20) DEFAULT 'active',
    settled_at TIMESTAMP,
    total_higher_volume DECIMAL(20, 2) DEFAULT 0,
    total_lower_volume DECIMAL(20, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_rounds_status ON rounds(status);
CREATE INDEX idx_rounds_end_time ON rounds(end_time);

-- AMM Pool состояние
CREATE TABLE pool_snapshots (
    id SERIAL PRIMARY KEY,
    round_id INTEGER REFERENCES rounds(id),
    higher_reserve DECIMAL(20, 2) NOT NULL,
    lower_reserve DECIMAL(20, 2) NOT NULL,
    k_constant DECIMAL(40, 4) NOT NULL,
    snapshot_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_pool_round ON pool_snapshots(round_id);

-- Лимитные ордера
CREATE TABLE limit_orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    round_id INTEGER REFERENCES rounds(id),
    side VARCHAR(10) NOT NULL,
    amount DECIMAL(20, 2) NOT NULL,
    price DECIMAL(10, 8) NOT NULL,
    filled DECIMAL(20, 2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    cancelled_at TIMESTAMP,
    filled_at TIMESTAMP,
    
    CONSTRAINT valid_side CHECK (side IN ('higher', 'lower')),
    CONSTRAINT valid_price CHECK (price > 0 AND price < 1),
    CONSTRAINT valid_amount CHECK (amount > 0)
);

CREATE INDEX idx_orders_user ON limit_orders(user_id);
CREATE INDEX idx_orders_round ON limit_orders(round_id);
CREATE INDEX idx_orders_status ON limit_orders(status);
CREATE INDEX idx_orders_side_price ON limit_orders(side, price) WHERE status = 'active';

-- Сделки
CREATE TABLE trades (
    id SERIAL PRIMARY KEY,
    round_id INTEGER REFERENCES rounds(id),
    buyer_id INTEGER REFERENCES users(id),
    seller_id INTEGER REFERENCES users(id),
    buy_order_id INTEGER REFERENCES limit_orders(id),
    sell_order_id INTEGER REFERENCES limit_orders(id),
    side VARCHAR(10) NOT NULL,
    amount DECIMAL(20, 2) NOT NULL,
    price DECIMAL(10, 8) NOT NULL,
    total_cost DECIMAL(20, 2) NOT NULL,
    trade_type VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    
    CONSTRAINT valid_trade_side CHECK (side IN ('higher', 'lower'))
);

CREATE INDEX idx_trades_round ON trades(round_id);
CREATE INDEX idx_trades_buyer ON trades(buyer_id);
CREATE INDEX idx_trades_created ON trades(created_at DESC);

-- Позиции пользователей
CREATE TABLE user_positions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    round_id INTEGER REFERENCES rounds(id),
    side VARCHAR(10) NOT NULL,
    amount DECIMAL(20, 2) NOT NULL,
    avg_price DECIMAL(10, 8) NOT NULL,
    total_cost DECIMAL(20, 2) NOT NULL,
    settled BOOLEAN DEFAULT FALSE,
    payout DECIMAL(20, 2),
    settled_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(user_id, round_id, side),
    CONSTRAINT valid_position_side CHECK (side IN ('higher', 'lower'))
);

CREATE INDEX idx_positions_user_round ON user_positions(user_id, round_id);
CREATE INDEX idx_positions_settled ON user_positions(settled);

-- Settlements
CREATE TABLE settlements (
    id SERIAL PRIMARY KEY,
    round_id INTEGER REFERENCES rounds(id) UNIQUE,
    total_higher_positions DECIMAL(20, 2),
    total_lower_positions DECIMAL(20, 2),
    winning_side VARCHAR(10),
    winner_payout_ratio DECIMAL(10, 8),
    total_settled INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending',
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    error_message TEXT,
    
    CONSTRAINT valid_settlement_side CHECK (winning_side IN ('higher', 'lower', 'tie'))
);

CREATE INDEX idx_settlements_status ON settlements(status);

-- Market cap history
CREATE TABLE market_cap_history (
    id SERIAL PRIMARY KEY,
    market_cap DECIMAL(20, 2) NOT NULL,
    price DECIMAL(20, 10) NOT NULL,
    source VARCHAR(50),
    recorded_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_market_cap_time ON market_cap_history(recorded_at DESC);

-- Rate limiting
CREATE TABLE rate_limits (
    id SERIAL PRIMARY KEY,
    identifier VARCHAR(100) NOT NULL,
    endpoint VARCHAR(100) NOT NULL,
    request_count INTEGER DEFAULT 1,
    window_start TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(identifier, endpoint, window_start)
);

CREATE INDEX idx_rate_limits_lookup ON rate_limits(identifier, endpoint, window_start);

-- Audit log
CREATE TABLE audit_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    details JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_log(user_id);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

-- Функции и триггеры
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_limit_orders_updated_at
    BEFORE UPDATE ON limit_orders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_user_positions_updated_at
    BEFORE UPDATE ON user_positions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- Создать первый раунд
INSERT INTO rounds (
    round_number,
    interval_minutes,
    start_time,
    end_time,
    target_market_cap,
    status
) VALUES (
    1,
    15,
    NOW(),
    NOW() + INTERVAL '15 minutes',
    0,
    'active'
);

-- Создать начальный snapshot пула
INSERT INTO pool_snapshots (
    round_id,
    higher_reserve,
    lower_reserve,
    k_constant
) VALUES (
    1,
    10000.00,
    10000.00,
    100000000.0000
);
