-- Alerte de solde bas, réglée par chaque entreprise (page Facturation ›
-- Préférences). Seuil en francs CFA ; NULL = seuil par défaut de TRAXO
-- (lowBalanceOrders commandes au prix de la prochaine commande).
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS low_balance_alert BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS low_balance_threshold INTEGER CHECK (low_balance_threshold IS NULL OR low_balance_threshold >= 0);

-- Mouvements filtrés par type et par période.
CREATE INDEX IF NOT EXISTS wallet_entries_company_kind_idx ON wallet_entries(company_id, kind, created_at DESC);
