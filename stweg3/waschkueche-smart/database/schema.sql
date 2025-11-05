-- Smart Waschküchen-Management System
-- Datenbank-Schema für STWEG 3 Rosenweg

-- Benutzer (Bewohner)
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_token VARCHAR(255) UNIQUE NOT NULL,  -- USB-Stick/Yubikey ID
    wohnung VARCHAR(50) NOT NULL,              -- z.B. "EG.1", "1OG.2"
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    balance DECIMAL(10, 2) DEFAULT 0.00,      -- Guthaben in CHF
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1
);

-- Geräte (Shelly Pro 1 PM)
CREATE TABLE devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id VARCHAR(255) UNIQUE NOT NULL,    -- Shelly Geräte-ID
    device_name VARCHAR(255) NOT NULL,         -- "Waschmaschine 1", "Trockner 1", etc.
    device_type VARCHAR(50) NOT NULL,          -- "washer" oder "dryer"
    location VARCHAR(100) NOT NULL,            -- "Waschküche 1" oder "Waschküche 2"
    shelly_ip VARCHAR(15) NOT NULL,            -- IP-Adresse des Shelly
    cost_per_kwh DECIMAL(6, 4) DEFAULT 0.30,  -- Preis pro kWh in CHF
    is_available BOOLEAN DEFAULT 1,
    is_online BOOLEAN DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Nutzungs-Sessions
CREATE TABLE usage_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    device_id INTEGER NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP,
    energy_consumed DECIMAL(10, 4),            -- kWh
    cost DECIMAL(10, 2),                       -- CHF
    status VARCHAR(20) DEFAULT 'active',       -- 'active', 'completed', 'aborted'
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (device_id) REFERENCES devices(id)
);

-- Transaktionen (Guthabenaufladungen und Abbuchungen)
CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,            -- Positiv für Aufladung, negativ für Verbrauch
    transaction_type VARCHAR(50) NOT NULL,     -- 'topup', 'usage', 'refund', 'admin_adjustment'
    description TEXT,
    session_id INTEGER,                        -- Optional: Verknüpfung zu usage_sessions
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (session_id) REFERENCES usage_sessions(id)
);

-- Authentifizierungs-Tokens (USB-Stick/Yubikey)
CREATE TABLE auth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_identifier VARCHAR(255) UNIQUE NOT NULL,  -- USB-Stick/Yubikey eindeutige ID
    token_type VARCHAR(50) NOT NULL,                 -- 'usb', 'yubikey', 'nfc'
    is_active BOOLEAN DEFAULT 1,
    last_used TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Geräte-Status Log (für Monitoring und Statistiken)
CREATE TABLE device_status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    power_current DECIMAL(10, 4),              -- Aktuelle Leistung in W
    energy_total DECIMAL(10, 4),               -- Gesamtenergie seit letztem Reset in kWh
    is_online BOOLEAN DEFAULT 1,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (device_id) REFERENCES devices(id)
);

-- Admin-Logs
CREATE TABLE admin_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_user VARCHAR(255) NOT NULL,
    action VARCHAR(100) NOT NULL,
    details TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indizes für bessere Performance
CREATE INDEX idx_users_token ON users(user_token);
CREATE INDEX idx_sessions_user ON usage_sessions(user_id);
CREATE INDEX idx_sessions_device ON usage_sessions(device_id);
CREATE INDEX idx_sessions_status ON usage_sessions(status);
CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_device_status_device ON device_status_log(device_id);
CREATE INDEX idx_device_status_timestamp ON device_status_log(timestamp);

-- Views für einfache Abfragen

-- Aktuelle Gerätenutzung
CREATE VIEW current_device_usage AS
SELECT
    d.id as device_id,
    d.device_name,
    d.device_type,
    d.location,
    d.is_available,
    u.name as user_name,
    u.wohnung,
    s.started_at,
    s.energy_consumed,
    s.cost
FROM devices d
LEFT JOIN usage_sessions s ON d.id = s.device_id AND s.status = 'active'
LEFT JOIN users u ON s.user_id = u.id;

-- Benutzer-Verbrauchsübersicht
CREATE VIEW user_consumption_summary AS
SELECT
    u.id,
    u.name,
    u.wohnung,
    u.balance,
    COUNT(s.id) as total_sessions,
    COALESCE(SUM(s.energy_consumed), 0) as total_energy_kwh,
    COALESCE(SUM(s.cost), 0) as total_cost_chf
FROM users u
LEFT JOIN usage_sessions s ON u.id = s.user_id AND s.status = 'completed'
GROUP BY u.id, u.name, u.wohnung, u.balance;
