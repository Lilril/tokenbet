-- ============================================
-- MERCUROME PREDICTION MARKET — COMPLETE SCHEMA
-- PostgreSQL 14+ | February 2026
-- ============================================

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

CREATE TABLE rounds (
    id SERIAL PRIMARY KEY,
    round_number INTEGER,
    slug VARCHAR(100) UNIQUE,
    interval_minutes INTEGER NOT NULL,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    target_market_cap DECIMAL(20, 2) DEFAULT 0,
    start_market_cap DECIMAL(20, 2) DEFAULT 0,
    final_market_cap DECIMAL(20, 2),
    winning_side VARCHAR(10),
    status VARCHAR(20) DEFAULT 'active',
    settlement_status VARCHAR(20) DEFAULT 'pending',
    settled_at TIMESTAMP,
    total_higher_volume DECIMAL(20, 2) DEFAULT 0,
    total_lower_volume DECIMAL(20, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_rounds_status ON rounds(status);
CREATE INDEX idx_rounds_end_time ON rounds(end_time);

CREATE TABLE pool_snapshots (
    id SERIAL PRIMARY KEY,
    round_id INTEGER REFERENCES rounds(id),
    higher_reserve DECIMAL(20, 2) NOT NULL,
    lower_reserve DECIMAL(20, 2) NOT NULL,
    k_constant DECIMAL(40, 4) NOT NULL,
    snapshot_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_pool_round ON pool_snapshots(round_id);

CREATE TABLE limit_orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    round_id INTEGER REFERENCES rounds(id),
    side VARCHAR(10) NOT NULL CHECK (side IN ('higher', 'lower')),
    amount DECIMAL(20, 2) NOT NULL CHECK (amount > 0),
    price DECIMAL(10, 2) NOT NULL CHECK (price > 0 AND price < 1),
    filled DECIMAL(20, 2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',
    order_type VARCHAR(10) DEFAULT 'buy' CHECK (order_type IN ('buy', 'sell')),
    cost_basis DECIMAL(10, 4),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    cancelled_at TIMESTAMP,
    filled_at TIMESTAMP
);
CREATE INDEX idx_orders_user ON limit_orders(user_id);
CREATE INDEX idx_orders_round ON limit_orders(round_id);
CREATE INDEX idx_orders_status ON limit_orders(status);
CREATE INDEX idx_orders_side_price ON limit_orders(side, price) WHERE status = 'active';

CREATE TABLE trades (
    id SERIAL PRIMARY KEY,
    round_id INTEGER REFERENCES rounds(id),
    buyer_id INTEGER REFERENCES users(id),
    seller_id INTEGER REFERENCES users(id),
    buy_order_id INTEGER REFERENCES limit_orders(id),
    sell_order_id INTEGER REFERENCES limit_orders(id),
    side VARCHAR(10) NOT NULL CHECK (side IN ('higher', 'lower')),
    amount DECIMAL(20, 2) NOT NULL,
    price DECIMAL(10, 8) NOT NULL,
    total_cost DECIMAL(20, 2) NOT NULL,
    trade_type VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_trades_round ON trades(round_id);
CREATE INDEX idx_trades_buyer ON trades(buyer_id);
CREATE INDEX idx_trades_seller ON trades(seller_id);
CREATE INDEX idx_trades_created ON trades(created_at DESC);

CREATE TABLE user_positions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    round_id INTEGER REFERENCES rounds(id),
    side VARCHAR(10) NOT NULL CHECK (side IN ('higher', 'lower')),
    amount DECIMAL(20, 2) NOT NULL,
    avg_price DECIMAL(10, 8) NOT NULL,
    total_cost DECIMAL(20, 2) NOT NULL,
    settled BOOLEAN DEFAULT FALSE,
    payout DECIMAL(20, 2),
    settled_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, round_id, side)
);
CREATE INDEX idx_positions_user_round ON user_positions(user_id, round_id);

CREATE TABLE user_balances (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) UNIQUE,
    available DECIMAL(20, 2) DEFAULT 0 CHECK (available >= 0),
    locked DECIMAL(20, 2) DEFAULT 0 CHECK (locked >= 0),
    total_deposited DECIMAL(20, 2) DEFAULT 0,
    total_withdrawn DECIMAL(20, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE balance_transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    type VARCHAR(30) NOT NULL,
    amount DECIMAL(20, 2) NOT NULL,
    balance_before DECIMAL(20, 2),
    balance_after DECIMAL(20, 2),
    reference_id INTEGER,
    reference_type VARCHAR(30),
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_bal_tx_user ON balance_transactions(user_id);

CREATE TABLE deposits (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    wallet_address VARCHAR(44) NOT NULL,
    amount DECIMAL(20, 2) NOT NULL,
    tx_signature VARCHAR(128) UNIQUE NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    slot BIGINT DEFAULT 0,
    confirmed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_deposits_tx ON deposits(tx_signature);

CREATE TABLE withdrawals (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    wallet_address VARCHAR(44) NOT NULL,
    amount DECIMAL(20, 2) NOT NULL,
    fee DECIMAL(20, 2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'processing',
    tx_signature VARCHAR(128),
    error_message TEXT,
    confirmed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE user_settlements (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    round_id INTEGER REFERENCES rounds(id),
    side VARCHAR(10) NOT NULL,
    amount DECIMAL(20, 2) DEFAULT 0,
    avg_price DECIMAL(10, 8) DEFAULT 0,
    total_cost DECIMAL(20, 2) DEFAULT 0,
    won BOOLEAN DEFAULT FALSE,
    payout DECIMAL(20, 2) DEFAULT 0,
    profit_loss DECIMAL(20, 2) DEFAULT 0,
    claimed BOOLEAN DEFAULT FALSE,
    claimed_at TIMESTAMP,
    claim_tx_hash VARCHAR(128),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, round_id, side)
);
CREATE INDEX idx_user_settlements_unclaimed ON user_settlements(claimed) WHERE claimed = false;

CREATE TABLE market_cap_history (
    id SERIAL PRIMARY KEY,
    market_cap NUMERIC NOT NULL,
    price NUMERIC,
    source TEXT,
    recorded_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_market_cap_time ON market_cap_history(recorded_at DESC);

CREATE TABLE rate_limits (
    id SERIAL PRIMARY KEY,
    identifier VARCHAR(100) NOT NULL,
    endpoint VARCHAR(100) NOT NULL,
    request_count INTEGER DEFAULT 1,
    window_start TIMESTAMP DEFAULT NOW(),
    UNIQUE(identifier, endpoint, window_start)
);

CREATE TABLE audit_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    details JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

-- Auto-update triggers
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON limit_orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_positions_updated BEFORE UPDATE ON user_positions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_balances_updated BEFORE UPDATE ON user_balances FOR EACH ROW EXECUTE FUNCTION update_updated_at();
