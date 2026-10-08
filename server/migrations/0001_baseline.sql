-- 0001 — Schéma de base (extrait tel quel de initDatabase, octobre 2026).
-- Idempotent : peut s'appliquer sur une base déjà créée par l'ancien démarrage.
-- Ne plus modifier ce fichier : toute évolution du schéma va dans une nouvelle migration.
CREATE TABLE IF NOT EXISTS companies (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE companies ADD COLUMN IF NOT EXISTS photo_proof_mode TEXT NOT NULL DEFAULT 'off';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS signature_proof_mode TEXT NOT NULL DEFAULT 'off';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS activation_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS admin_email TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Africa/Porto-Novo';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS delivery_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_code TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS trial_status TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_cycle TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_data BYTEA;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_mime TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMPTZ;
-- Configuration guidée après inscription. Les entreprises existantes
-- prennent la valeur par défaut « done » ; seules les nouvelles
-- inscriptions sont créées en « pending ».
ALTER TABLE companies ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'done';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS business_type TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fleet_estimate TEXT;

UPDATE companies
SET slug = 'chicago-consulting-group', updated_at = NOW()
WHERE id = (SELECT MIN(id) FROM companies WHERE name = 'Chicago Consulting Group')
  AND slug IS NULL
  AND NOT EXISTS (SELECT 1 FROM companies WHERE slug = 'chicago-consulting-group');

CREATE UNIQUE INDEX IF NOT EXISTS companies_slug_unique ON companies(slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
-- Canal préféré pour les codes de connexion : 'email', 'whatsapp' ou NULL (choix à chaque fois).
ALTER TABLE users ADD COLUMN IF NOT EXISTS code_channel TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_alerts BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery_hashes JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
-- Dernier espace ouvert : la connexion y revient quand la personne appartient à plusieurs entreprises.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_company_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique ON users(google_sub) WHERE google_sub IS NOT NULL;
CREATE TABLE IF NOT EXISTS mfa_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id BIGINT,
  role TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE mfa_challenges ADD COLUMN IF NOT EXISTS remember BOOLEAN NOT NULL DEFAULT FALSE;
-- Session WhatsApp (Baileys), chiffrée ; une ligne par clé.
CREATE TABLE IF NOT EXISTS whatsapp_auth (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Code de vérification envoyé par e-mail (inscription, nouvel appareil).
-- Code haché avec un secret serveur ; 10 min, 5 essais, 5 envois max.
CREATE TABLE IF NOT EXISTS login_codes (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id BIGINT,
  role TEXT,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  remember BOOLEAN NOT NULL DEFAULT FALSE,
  attempts INTEGER NOT NULL DEFAULT 0,
  sends INTEGER NOT NULL DEFAULT 1,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE login_codes ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'email';
ALTER TABLE login_codes ADD COLUMN IF NOT EXISTS delivery_failed BOOLEAN NOT NULL DEFAULT FALSE;
-- Appareils reconnus après un code valide : pas de nouveau code pendant 30 jours.
CREATE TABLE IF NOT EXISTS trusted_devices (
  token_hash TEXT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (token_hash, user_id)
);
-- Appareil reconnu uniquement si l'utilisateur a coché « Rester connecté ».
ALTER TABLE trusted_devices ADD COLUMN IF NOT EXISTS remembered BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS company_memberships (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'operator',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, user_id)
);

CREATE TABLE IF NOT EXISTS app_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('company', 'platform')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);

CREATE TABLE IF NOT EXISTS drivers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  traccar_unique_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, traccar_unique_id)
);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_type TEXT NOT NULL DEFAULT 'Moto';
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS capacity INTEGER NOT NULL DEFAULT 3;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS availability_status TEXT NOT NULL DEFAULT 'available';
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS photo_data BYTEA;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS photo_mime TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS photo_updated_at TIMESTAMPTZ;
-- Profil livreur complet (kit Livreurs) et permissions dans l'appli.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS plate TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS zone TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS team TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS can_contact BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS can_report_incident BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS driver_code TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS phone_digits TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS drivers_company_code_unique ON drivers(company_id, driver_code) WHERE driver_code IS NOT NULL;
UPDATE drivers SET phone_digits = NULLIF(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), '') WHERE phone_digits IS NULL AND phone IS NOT NULL;
WITH mx AS (
  SELECT company_id, COALESCE(MAX(NULLIF(regexp_replace(COALESCE(driver_code, ''), '\D', '', 'g'), '')::int), 0) AS m FROM drivers GROUP BY company_id
), todo AS (
  SELECT id, company_id, row_number() OVER (PARTITION BY company_id ORDER BY id) AS rn FROM drivers WHERE driver_code IS NULL
)
UPDATE drivers d SET driver_code = 'LIV-' || lpad((mx.m + todo.rn)::text, 3, '0')
FROM todo JOIN mx ON mx.company_id = todo.company_id WHERE d.id = todo.id;

ALTER TABLE company_memberships ADD COLUMN IF NOT EXISTS driver_id BIGINT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_memberships_driver_fk') THEN
    ALTER TABLE company_memberships
      ADD CONSTRAINT company_memberships_driver_fk FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS company_memberships_driver_unique
  ON company_memberships(company_id, driver_id) WHERE driver_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_invitations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  driver_id BIGINT REFERENCES drivers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_invitations_company_created_idx
  ON user_invitations(company_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS user_invitations_active_email_unique
  ON user_invitations(company_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS user_invitations_active_driver_unique
  ON user_invitations(company_id, driver_id)
  WHERE driver_id IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  driver_id BIGINT NOT NULL REFERENCES drivers(id),
  customer_name TEXT,
  customer_phone TEXT,
  delivery_address TEXT,
  status TEXT NOT NULL DEFAULT 'En préparation',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tracking_links (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  token TEXT UNIQUE,
  token_hash TEXT,
  token_ciphertext TEXT,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  revocation_reason TEXT,
  revocation_idempotency_key TEXT,
  revocation_fingerprint TEXT,
  last_rotated_at TIMESTAMPTZ,
  rotation_idempotency_key TEXT,
  rotation_fingerprint TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE tracking_links ALTER COLUMN token DROP NOT NULL;
ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS token_hash TEXT;
ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS token_ciphertext TEXT;
ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS revoked_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS revocation_reason TEXT;
ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS revocation_idempotency_key TEXT;
ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS revocation_fingerprint TEXT;
ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS last_rotated_at TIMESTAMPTZ;
ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS rotation_idempotency_key TEXT;
ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS rotation_fingerprint TEXT;
ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
UPDATE tracking_links t SET company_id = o.company_id FROM orders o
WHERE o.id = t.order_id AND t.company_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tracking_links_token_hash_unique
  ON tracking_links(token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS tracking_links_active_token_idx
  ON tracking_links(token) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS tracking_links_order_state_idx
  ON tracking_links(order_id, revoked_at, expires_at);
UPDATE tracking_links
SET expires_at = created_at + INTERVAL '30 days'
WHERE expires_at IS NULL;

CREATE TABLE IF NOT EXISTS tracking_link_events (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tracking_link_id BIGINT NOT NULL REFERENCES tracking_links(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'rotated', 'revoked', 'revealed')),
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  idempotency_key TEXT,
  request_fingerprint TEXT,
  result_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tracking_link_events_idempotency_unique
  ON tracking_link_events(company_id, event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS tracking_link_events_link_created_idx
  ON tracking_link_events(tracking_link_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS customer_requests (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'En attente d’informations',
  customer_name TEXT,
  customer_phone TEXT,
  requested_time TEXT,
  location_lat DOUBLE PRECISION,
  location_lng DOUBLE PRECISION,
  location_accuracy DOUBLE PRECISION,
  location_at TIMESTAMPTZ,
  neighborhood TEXT,
  landmark TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS edit_token_hash TEXT;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
-- Demandes pré-remplies par l'équipe, que le client confirme (code à 4 chiffres).
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS prefilled_by_user_id BIGINT;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS confirm_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS confirm_locked_at TIMESTAMPTZ;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS customer_confirmed_at TIMESTAMPTZ;
-- Colis et point de collecte facultatif (le colis est récupéré ailleurs avant la remise).
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS package_description TEXT;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS package_type TEXT;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS pickup_name TEXT;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS pickup_phone TEXT;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS pickup_address TEXT;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS pickup_lat DOUBLE PRECISION;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS pickup_lng DOUBLE PRECISION;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS pickup_ready TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS customer_requests_edit_token_unique
  ON customer_requests(edit_token_hash) WHERE edit_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS customer_request_photos (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES customer_requests(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS customer_request_photos_request_idx
  ON customer_request_photos(request_id, id);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_request_id BIGINT REFERENCES customer_requests(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS requested_time TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS destination_lat DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS destination_lng DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS destination_accuracy DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS neighborhood TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_description TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_type TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_address TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_lat DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_lng DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_priority_check CHECK (priority IN ('normal', 'urgent'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_ready TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS picked_up_lat DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS picked_up_lng DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS landmark TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
-- Numéro métier lisible CMD-AAAA-NNNN (par entreprise, par année).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reference TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS orders_reference_unique
  ON orders(company_id, reference) WHERE reference IS NOT NULL;
CREATE TABLE IF NOT EXISTS order_reference_counters (
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, year)
);
-- Backfill idempotent : attribue un numéro aux commandes qui n'en ont pas,
-- dans l'ordre de création, par entreprise et par année.
WITH numbered AS (
  SELECT id,
         'CMD-' || EXTRACT(YEAR FROM created_at)::int || '-' ||
         LPAD((ROW_NUMBER() OVER (
           PARTITION BY company_id, EXTRACT(YEAR FROM created_at)
           ORDER BY created_at, id))::text, 4, '0') AS ref
  FROM orders WHERE reference IS NULL
)
UPDATE orders o SET reference = n.ref FROM numbered n WHERE o.id = n.id;
-- Amorce les compteurs à partir du plus grand numéro existant.
INSERT INTO order_reference_counters (company_id, year, last_seq)
  SELECT company_id, SPLIT_PART(reference, '-', 2)::int AS year,
         MAX(SPLIT_PART(reference, '-', 3)::int) AS last_seq
  FROM orders WHERE reference LIKE 'CMD-%'
  GROUP BY company_id, SPLIT_PART(reference, '-', 2)::int
  ON CONFLICT (company_id, year)
    DO UPDATE SET last_seq = GREATEST(order_reference_counters.last_seq, EXCLUDED.last_seq);
CREATE UNIQUE INDEX IF NOT EXISTS orders_customer_request_unique
  ON orders(customer_request_id) WHERE customer_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_status_events (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS delivery_otp_challenges (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  code_salt TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  attempts_remaining INTEGER NOT NULL DEFAULT 5,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS delivery_proofs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  proof_type TEXT NOT NULL,
  otp_challenge_id BIGINT REFERENCES delivery_otp_challenges(id) ON DELETE SET NULL,
  verified_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(order_id, proof_type)
);

CREATE TABLE IF NOT EXISTS delivery_evidence_files (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('photo', 'signature')),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png')),
  byte_size INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  content BYTEA,
  uploaded_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  superseded_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_evidence_active_unique
  ON delivery_evidence_files(order_id, evidence_type)
  WHERE superseded_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS delivery_evidence_order_created_idx
  ON delivery_evidence_files(order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS delivery_otp_attempts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  otp_challenge_id BIGINT REFERENCES delivery_otp_challenges(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  success BOOLEAN NOT NULL,
  attempts_remaining INTEGER NOT NULL,
  attempted_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS delivery_incidents (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  opened_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  resolved_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  resolution TEXT,
  resolution_idempotency_key TEXT,
  resolution_fingerprint TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, idempotency_key)
);
ALTER TABLE delivery_incidents ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
ALTER TABLE delivery_incidents ADD COLUMN IF NOT EXISTS resolution_idempotency_key TEXT;
ALTER TABLE delivery_incidents ADD COLUMN IF NOT EXISTS resolution_fingerprint TEXT;
-- Essai « Excel enrichi » : un par entreprise, enregistré côté serveur.
CREATE TABLE IF NOT EXISTS company_export_access (
  company_id BIGINT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  excel_trial_started_at TIMESTAMPTZ,
  excel_trial_ends_at TIMESTAMPTZ,
  excel_trial_started_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE delivery_incidents ADD COLUMN IF NOT EXISTS assigned_to_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS incident_events (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  incident_id BIGINT NOT NULL REFERENCES delivery_incidents(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  body TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS order_retention_holds (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  reason TEXT NOT NULL,
  review_due_at TIMESTAMPTZ NOT NULL,
  placed_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  placed_idempotency_key TEXT NOT NULL,
  placed_fingerprint TEXT NOT NULL,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  release_reason TEXT,
  release_idempotency_key TEXT,
  release_fingerprint TEXT,
  released_at TIMESTAMPTZ,
  UNIQUE(company_id, placed_idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS order_retention_holds_active_unique
  ON order_retention_holds(order_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS order_retention_holds_release_key_unique
  ON order_retention_holds(company_id, release_idempotency_key)
  WHERE release_idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS delivery_runs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  driver_id BIGINT NOT NULL REFERENCES drivers(id),
  name TEXT NOT NULL,
  service_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'planned', 'active', 'completed', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  create_idempotency_key TEXT NOT NULL,
  create_fingerprint TEXT NOT NULL,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, create_idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_runs_driver_day_open_unique
  ON delivery_runs(company_id, driver_id, service_date)
  WHERE status IN ('draft', 'planned', 'active');

CREATE TABLE IF NOT EXISTS delivery_stops (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id BIGINT NOT NULL REFERENCES delivery_runs(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  assignment_active BOOLEAN NOT NULL DEFAULT TRUE,
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_stops_active_order_unique
  ON delivery_stops(order_id) WHERE assignment_active = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS delivery_stops_run_sequence_unique
  ON delivery_stops(run_id, sequence) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS delivery_stops_run_idx
  ON delivery_stops(run_id, sequence) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS delivery_run_events (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id BIGINT NOT NULL REFERENCES delivery_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS delivery_run_events_run_created_idx
  ON delivery_run_events(run_id, created_at ASC, id ASC);

-- Durée prévue / réelle du dernier trajet vers chaque client : sert à caler
-- l'estimation d'arrivée sur la circulation réelle de l'entreprise.
CREATE TABLE IF NOT EXISTS eta_samples (
  order_id BIGINT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  predicted_seconds INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actual_seconds INTEGER,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS eta_samples_company_idx ON eta_samples(company_id, completed_at DESC);
-- Invitation d'un livreur à l'appli : QR + code de secours, 15 min, usage unique.
CREATE TABLE IF NOT EXISTS driver_invitations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  driver_id BIGINT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL UNIQUE,
  replacement BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  verify_code_hash TEXT,
  verify_sent_at TIMESTAMPTZ,
  verify_attempts INTEGER NOT NULL DEFAULT 0,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE driver_invitations ADD COLUMN IF NOT EXISTS verify_sends INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS driver_invitations_driver_idx ON driver_invitations(driver_id, created_at DESC);
-- Places livreurs utilisées dans le mois (anti-partage d'abonnement) : une
-- personne compte une fois dans le mois, même si son profil est supprimé puis recréé.
CREATE TABLE IF NOT EXISTS driver_seat_usage (
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  month DATE NOT NULL,
  seat_key TEXT NOT NULL,
  driver_id BIGINT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, month, seat_key)
);
-- Vigilance : signaux à vérifier par le responsable (ou par TRAXO quand
-- company_id est vide : cas qui concernent plusieurs entreprises).
CREATE TABLE IF NOT EXISTS fraud_signals (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  driver_id BIGINT,
  order_id BIGINT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by_user_id BIGINT
);
CREATE INDEX IF NOT EXISTS fraud_signals_company_idx ON fraud_signals(company_id, created_at DESC);
-- Relevés de position des livreurs aux moments clés (arrivée, remise).
CREATE TABLE IF NOT EXISTS driver_fixes (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  driver_id BIGINT NOT NULL,
  order_id BIGINT,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  accuracy DOUBLE PRECISION,
  source TEXT NOT NULL,
  fixed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS driver_fixes_driver_idx ON driver_fixes(driver_id, fixed_at DESC);
-- Opérations : corbeille réversible (commandes terminées, incidents
-- résolus) et vues enregistrées. Rien n'est effacé : la ligne est masquée.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived_by_user_id BIGINT;
ALTER TABLE delivery_incidents ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE delivery_incidents ADD COLUMN IF NOT EXISTS archived_by_user_id BIGINT;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS status_before_archive TEXT;
-- Informations commerciales déclarées par l'entreprise (articles, valeur,
-- poids, prix annoncé, règlement au vendeur). TRAXO n'encaisse rien.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS commercial JSONB;
-- Prix indicatifs saisis dès la demande (livraison, montant de la commande), recopiés sur la commande.
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS commercial JSONB;
CREATE TABLE IF NOT EXISTS ops_views (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  shared BOOLEAN NOT NULL DEFAULT FALSE,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ops_views_company_idx ON ops_views(company_id, user_id);
-- Équipe et accès : suspension par entreprise, dernière activité,
-- invitations par e-mail ou téléphone, lien recopiable (chiffré).
ALTER TABLE company_memberships ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE company_memberships ADD COLUMN IF NOT EXISTS suspended_by_user_id BIGINT;
ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE user_invitations ALTER COLUMN email DROP NOT NULL;
ALTER TABLE user_invitations ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE user_invitations ADD COLUMN IF NOT EXISTS token_ciphertext TEXT;
ALTER TABLE user_invitations ADD COLUMN IF NOT EXISTS verify_code_hash TEXT;
ALTER TABLE user_invitations ADD COLUMN IF NOT EXISTS verify_sent_at TIMESTAMPTZ;
ALTER TABLE user_invitations ADD COLUMN IF NOT EXISTS verify_sends INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_invitations ADD COLUMN IF NOT EXISTS verify_attempts INTEGER NOT NULL DEFAULT 0;
-- Essai gratuit : une seule fois par personne (adresse, numéro, appareil).
CREATE TABLE IF NOT EXISTS trial_identities (
  key_hash TEXT PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS notification_states (
  user_id BIGINT NOT NULL,
  company_id BIGINT NOT NULL,
  notif_key TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  later_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, company_id, notif_key)
);
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id BIGINT NOT NULL,
  company_id BIGINT NOT NULL,
  categories JSONB NOT NULL DEFAULT '{}'::jsonb,
  digest TEXT NOT NULL DEFAULT 'off',
  digest_hour INTEGER NOT NULL DEFAULT 8,
  digest_day INTEGER NOT NULL DEFAULT 1,
  timezone TEXT,
  last_digest_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, company_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL,
  entity_id BIGINT,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS export_logs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  dataset TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  purpose TEXT,
  period_from DATE,
  period_to DATE,
  columns JSONB,
  filters JSONB,
  row_count INTEGER,
  worksheet_count INTEGER,
  artifact_bytes INTEGER,
  artifact_sha256 TEXT,
  request_fingerprint_sha256 TEXT,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS export_logs_company_created_idx
  ON export_logs(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS customer_requests_company_created_idx
  ON customer_requests(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_company_created_idx
  ON orders(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_company_created_idx
  ON audit_logs(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_status_events_order_created_idx
  ON order_status_events(order_id, created_at ASC);
CREATE INDEX IF NOT EXISTS delivery_otp_challenges_order_created_idx
  ON delivery_otp_challenges(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS delivery_otp_attempts_order_created_idx
  ON delivery_otp_attempts(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS delivery_incidents_order_created_idx
  ON delivery_incidents(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS incident_events_incident_created_idx
  ON incident_events(incident_id, created_at ASC, id ASC);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_incidents_resolution_key_unique
  ON delivery_incidents(company_id, resolution_idempotency_key)
  WHERE resolution_idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_payment_accounts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  expected_amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'XOF',
  status TEXT NOT NULL DEFAULT 'pending',
  collected_amount_minor BIGINT,
  collection_method TEXT,
  collection_reference TEXT,
  discrepancy_reason TEXT,
  collected_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  collected_at TIMESTAMPTZ,
  reconciled_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reconciled_at TIMESTAMPTZ,
  reconciliation_note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_events (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_account_id BIGINT NOT NULL REFERENCES order_payment_accounts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  amount_minor BIGINT,
  currency TEXT NOT NULL,
  method TEXT,
  reference TEXT,
  reason TEXT,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS payment_events_order_created_idx
  ON payment_events(order_id, created_at ASC);

CREATE TABLE IF NOT EXISTS payment_adjustments (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_account_id BIGINT NOT NULL REFERENCES order_payment_accounts(id) ON DELETE CASCADE,
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('refund', 'additional_collection', 'reversal')),
  direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  method TEXT NOT NULL,
  reference TEXT,
  reason TEXT NOT NULL,
  effective_date DATE NOT NULL,
  resulting_total_minor BIGINT NOT NULL,
  reverses_adjustment_id BIGINT REFERENCES payment_adjustments(id),
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_adjustments_reversal_unique
  ON payment_adjustments(reverses_adjustment_id) WHERE reverses_adjustment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_adjustments_order_created_idx
  ON payment_adjustments(order_id, created_at ASC, id ASC);

INSERT INTO order_status_events (
  company_id, order_id, from_status, to_status, actor_user_id,
  idempotency_key, request_fingerprint, metadata, created_at
)
SELECT o.company_id, o.id, NULL, o.status, NULL,
       'system:bootstrap-order:' || o.id,
       md5('bootstrap:' || o.id || ':' || o.status),
       jsonb_build_object('source', 'bootstrap'), o.created_at
FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM order_status_events e WHERE e.order_id = o.id);
