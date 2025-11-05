-- Beispiel-Daten für das Smart Waschküchen-Management System

-- Beispiel-Benutzer
INSERT INTO users (user_token, wohnung, name, email, balance) VALUES
('USB-001-EG1', 'EG.1', 'Max Mustermann', 'max.mustermann@example.com', 50.00),
('USB-002-EG2', 'EG.2', 'Anna Schmidt', 'anna.schmidt@example.com', 30.00),
('USB-003-1OG1', '1OG.1', 'Peter Weber', 'peter.weber@example.com', 75.00),
('USB-004-1OG2', '1OG.2', 'Maria Müller', 'maria.mueller@example.com', 40.00),
('YK-001-2OG1', '2OG.1', 'Stefan Meier', 'stefan.meier@example.com', 60.00);

-- Geräte (Shelly Pro 1 PM)
INSERT INTO devices (device_id, device_name, device_type, location, shelly_ip, cost_per_kwh) VALUES
('shelly-pm-001', 'Waschmaschine 1', 'washer', 'Waschküche 1', '192.168.1.101', 0.30),
('shelly-pm-002', 'Trockner 1', 'dryer', 'Waschküche 1', '192.168.1.102', 0.30),
('shelly-pm-003', 'Waschmaschine 2', 'washer', 'Waschküche 2', '192.168.1.103', 0.30),
('shelly-pm-004', 'Trockner 2', 'dryer', 'Waschküche 2', '192.168.1.104', 0.30);

-- Authentifizierungs-Tokens
INSERT INTO auth_tokens (user_id, token_identifier, token_type) VALUES
(1, 'USB-001-EG1', 'usb'),
(2, 'USB-002-EG2', 'usb'),
(3, 'USB-003-1OG1', 'usb'),
(4, 'USB-004-1OG2', 'usb'),
(5, 'YK-001-2OG1', 'yubikey');

-- Beispiel-Transaktionen (Guthabenaufladungen)
INSERT INTO transactions (user_id, amount, transaction_type, description) VALUES
(1, 50.00, 'topup', 'Initiales Guthaben'),
(2, 30.00, 'topup', 'Initiales Guthaben'),
(3, 75.00, 'topup', 'Initiales Guthaben'),
(4, 40.00, 'topup', 'Initiales Guthaben'),
(5, 60.00, 'topup', 'Initiales Guthaben');

-- Beispiel-Sessions (abgeschlossene Nutzungen)
INSERT INTO usage_sessions (user_id, device_id, started_at, ended_at, energy_consumed, cost, status) VALUES
(1, 1, datetime('now', '-2 days'), datetime('now', '-2 days', '+1 hour'), 0.85, 0.26, 'completed'),
(1, 2, datetime('now', '-2 days', '+1 hour'), datetime('now', '-2 days', '+2 hours'), 1.20, 0.36, 'completed'),
(2, 3, datetime('now', '-1 day'), datetime('now', '-1 day', '+1 hour'), 0.90, 0.27, 'completed'),
(3, 1, datetime('now', '-1 day', '+2 hours'), datetime('now', '-1 day', '+3 hours'), 0.82, 0.25, 'completed');

-- Transaktionen für die Sessions
INSERT INTO transactions (user_id, amount, transaction_type, description, session_id) VALUES
(1, -0.26, 'usage', 'Waschmaschine 1 - 0.85 kWh', 1),
(1, -0.36, 'usage', 'Trockner 1 - 1.20 kWh', 2),
(2, -0.27, 'usage', 'Waschmaschine 2 - 0.90 kWh', 3),
(3, -0.25, 'usage', 'Waschmaschine 1 - 0.82 kWh', 4);

-- Update User Balances
UPDATE users SET balance = balance - 0.62 WHERE id = 1;  -- Max: 50 - 0.62 = 49.38
UPDATE users SET balance = balance - 0.27 WHERE id = 2;  -- Anna: 30 - 0.27 = 29.73
UPDATE users SET balance = balance - 0.25 WHERE id = 3;  -- Peter: 75 - 0.25 = 74.75
