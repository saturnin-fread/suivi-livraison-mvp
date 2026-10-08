-- Portefeuille prépayé : paiement à la commande (25 F par défaut), recharges,
-- bonus, remboursements. Montants en francs CFA entiers (XOF, pas de centimes).
--
-- wallet_entries est un journal : on n'y modifie ni n'y efface jamais une ligne
-- (un déclencheur l'interdit). Le solde mis en cache dans wallets est mis à jour
-- dans la même transaction que chaque ligne ; il doit toujours valoir la somme
-- du journal. order_id et created_by n'ont pas de clé étrangère : une commande
-- purgée de la corbeille ou un compte retiré gardent leur trace comptable.

CREATE TABLE IF NOT EXISTS wallets (
  company_id BIGINT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0,
  low_balance_notified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_payments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reference TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('kkiapay', 'test')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  bonus INTEGER NOT NULL DEFAULT 0 CHECK (bonus >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  provider_ref TEXT,
  failure_reason TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ
);
-- Une transaction du prestataire ne crédite qu'une seule recharge.
CREATE UNIQUE INDEX IF NOT EXISTS wallet_payments_provider_ref_unique
  ON wallet_payments(provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS wallet_payments_company_idx ON wallet_payments(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_entries (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('recharge', 'bonus', 'order_charge', 'order_refund', 'premium_report', 'premium_month', 'adjustment')),
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  order_id BIGINT,
  order_reference TEXT,
  payment_id BIGINT REFERENCES wallet_payments(id) ON DELETE CASCADE,
  unit_price INTEGER,
  note TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS wallet_entries_company_idx ON wallet_entries(company_id, id DESC);
-- Une commande n'est débitée qu'une fois, et remboursée au plus une fois.
CREATE UNIQUE INDEX IF NOT EXISTS wallet_entries_order_charge_unique ON wallet_entries(order_id) WHERE kind = 'order_charge';
CREATE UNIQUE INDEX IF NOT EXISTS wallet_entries_order_refund_unique ON wallet_entries(order_id) WHERE kind = 'order_refund';
CREATE UNIQUE INDEX IF NOT EXISTS wallet_entries_payment_unique ON wallet_entries(payment_id, kind) WHERE payment_id IS NOT NULL;

-- Seule exception : la suppression de l'entreprise elle-même (cascade), quand
-- la ligne parente a déjà disparu.
CREATE OR REPLACE FUNCTION wallet_entries_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'wallet_entries est un journal : modification et suppression interdites';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS wallet_entries_no_update ON wallet_entries;
CREATE TRIGGER wallet_entries_no_update BEFORE UPDATE OR DELETE ON wallet_entries
  FOR EACH ROW EXECUTE FUNCTION wallet_entries_append_only();

-- Réglages de facturation modifiables par l'équipe TRAXO sans redéployer.
-- Seules les valeurs changées y sont stockées ; le reste vient des valeurs par
-- défaut du code (server/modules/billing/service.js).
CREATE TABLE IF NOT EXISTS billing_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO billing_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;
