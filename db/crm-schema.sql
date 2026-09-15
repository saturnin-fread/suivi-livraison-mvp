-- Fondation CRM additive pour suivi-livraison-mvp.
-- Prérequis : les tables companies, users, customer_requests, orders,
-- delivery_incidents et order_payment_accounts existent déjà.
-- Cette migration est réexécutable. Elle ne supprime ni ne réécrit les données existantes.

BEGIN;

SET LOCAL lock_timeout = '10s';
-- public est volontairement le schéma de destination. En production, le droit
-- CREATE sur ce schéma doit être réservé au rôle de migration.
-- public est le seul schéma de création. pg_catalog reste recherché implicitement
-- par PostgreSQL sans risquer d'y créer les séquences BIGSERIAL.
SET LOCAL search_path = public;

-- Ces index servent de cibles aux clés étrangères composites. Ils empêchent qu'une
-- relation CRM associe l'identifiant d'un objet à la mauvaise entreprise.
CREATE UNIQUE INDEX IF NOT EXISTS customer_requests_company_id_id_uq
  ON customer_requests (company_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS orders_company_id_id_uq
  ON orders (company_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_incidents_company_order_id_id_uq
  ON delivery_incidents (company_id, order_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS order_payment_accounts_company_order_id_id_uq
  ON order_payment_accounts (company_id, order_id, id);

CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_code TEXT NOT NULL,
  customer_type TEXT NOT NULL DEFAULT 'person'
    CHECK (customer_type IN ('person', 'organization')),
  display_name TEXT NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'do_not_contact', 'archived', 'merged', 'anonymized')),
  preferred_language TEXT CHECK (preferred_language IS NULL OR char_length(preferred_language) BETWEEN 2 AND 35),
  service_notes TEXT CHECK (service_notes IS NULL OR char_length(service_notes) <= 2000),
  created_from_request_id BIGINT,
  merged_into_customer_id BIGINT,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  archived_at TIMESTAMPTZ,
  anonymized_at TIMESTAMPTZ,
  anonymized_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  anonymization_reason TEXT CHECK (anonymization_reason IS NULL OR char_length(anonymization_reason) <= 500),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customers_company_id_id_uq UNIQUE (company_id, id),
  CONSTRAINT customers_company_code_uq UNIQUE (company_id, customer_code),
  CONSTRAINT customers_request_fk FOREIGN KEY (company_id, created_from_request_id)
    REFERENCES customer_requests(company_id, id) ON DELETE SET NULL (created_from_request_id),
  CONSTRAINT customers_merged_into_fk FOREIGN KEY (company_id, merged_into_customer_id)
    REFERENCES customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT customers_merge_not_self_ck CHECK (merged_into_customer_id IS NULL OR merged_into_customer_id <> id),
  CONSTRAINT customers_merge_state_ck CHECK (
    (status = 'merged' AND merged_into_customer_id IS NOT NULL)
    OR (status <> 'merged' AND merged_into_customer_id IS NULL)
  ),
  CONSTRAINT customers_anonymized_state_ck CHECK (
    (status = 'anonymized' AND anonymized_at IS NOT NULL)
    OR (status <> 'anonymized' AND anonymized_at IS NULL)
  ),
  CONSTRAINT customers_archive_state_ck CHECK (archived_at IS NULL OR status = 'archived')
);

CREATE TABLE IF NOT EXISTS customer_contacts (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('phone', 'email', 'whatsapp', 'other')),
  label TEXT CHECK (label IS NULL OR char_length(label) <= 80),
  contact_name TEXT CHECK (contact_name IS NULL OR char_length(contact_name) <= 200),
  value_display TEXT,
  value_normalized TEXT,
  value_hash TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  verified_at TIMESTAMPTZ,
  verification_source TEXT CHECK (verification_source IS NULL OR char_length(verification_source) <= 80),
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  anonymized_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_contacts_company_id_id_uq UNIQUE (company_id, id),
  CONSTRAINT customer_contacts_company_customer_id_id_uq UNIQUE (company_id, customer_id, id),
  CONSTRAINT customer_contacts_customer_fk FOREIGN KEY (company_id, customer_id)
    REFERENCES customers(company_id, id) ON DELETE CASCADE,
  CONSTRAINT customer_contacts_value_ck CHECK (
    (anonymized_at IS NULL AND value_display IS NOT NULL AND char_length(btrim(value_display)) BETWEEN 1 AND 320)
    OR (
      anonymized_at IS NOT NULL AND is_active = FALSE
      AND value_display IS NULL AND value_normalized IS NULL AND value_hash IS NULL
    )
  ),
  CONSTRAINT customer_contacts_normalized_length_ck CHECK (
    value_normalized IS NULL OR char_length(value_normalized) <= 320
  )
);

CREATE TABLE IF NOT EXISTS customer_locations (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL,
  label TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 100),
  neighborhood TEXT CHECK (neighborhood IS NULL OR char_length(neighborhood) <= 200),
  locality TEXT CHECK (locality IS NULL OR char_length(locality) <= 200),
  address_text TEXT CHECK (address_text IS NULL OR char_length(address_text) <= 1000),
  landmark TEXT CHECK (landmark IS NULL OR char_length(landmark) <= 500),
  delivery_instructions TEXT CHECK (delivery_instructions IS NULL OR char_length(delivery_instructions) <= 2000),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  accuracy_meters DOUBLE PRECISION,
  coordinate_source TEXT CHECK (
    coordinate_source IS NULL OR coordinate_source IN ('customer_gps', 'map_pin', 'whatsapp_link', 'operator', 'import')
  ),
  coordinates_captured_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  verified_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  archived_at TIMESTAMPTZ,
  anonymized_at TIMESTAMPTZ,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_locations_company_id_id_uq UNIQUE (company_id, id),
  CONSTRAINT customer_locations_company_customer_id_id_uq UNIQUE (company_id, customer_id, id),
  CONSTRAINT customer_locations_customer_fk FOREIGN KEY (company_id, customer_id)
    REFERENCES customers(company_id, id) ON DELETE CASCADE,
  CONSTRAINT customer_locations_coordinate_pair_ck CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CONSTRAINT customer_locations_latitude_ck CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CONSTRAINT customer_locations_longitude_ck CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  CONSTRAINT customer_locations_accuracy_ck CHECK (accuracy_meters IS NULL OR accuracy_meters >= 0),
  CONSTRAINT customer_locations_coordinate_metadata_ck CHECK (
    latitude IS NULL OR (coordinate_source IS NOT NULL AND coordinates_captured_at IS NOT NULL)
  ),
  CONSTRAINT customer_locations_archive_ck CHECK (archived_at IS NULL OR is_active = FALSE),
  CONSTRAINT customer_locations_anonymized_ck CHECK (anonymized_at IS NULL OR is_active = FALSE)
);

CREATE TABLE IF NOT EXISTS customer_location_revisions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  changed_fields TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  before_state JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(before_state) = 'object'),
  after_state JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(after_state) = 'object'),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  request_fingerprint TEXT NOT NULL CHECK (char_length(request_fingerprint) = 64),
  redacted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_location_revisions_company_id_id_uq UNIQUE (company_id, id),
  CONSTRAINT customer_location_revisions_location_fk FOREIGN KEY (company_id, customer_id, location_id)
    REFERENCES customer_locations(company_id, customer_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS customer_interactions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id BIGINT,
  order_id BIGINT,
  incident_id BIGINT,
  payment_account_id BIGINT,
  channel TEXT NOT NULL CHECK (channel IN ('call', 'whatsapp', 'sms', 'email', 'in_person', 'internal', 'other')),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
  purpose TEXT NOT NULL CHECK (
    purpose IN ('delivery_confirmation', 'location_clarification', 'arrival', 'complaint', 'payment', 'follow_up', 'other')
  ),
  outcome TEXT CHECK (
    outcome IS NULL OR outcome IN ('reached', 'no_answer', 'callback_requested', 'information_received', 'technical_failure', 'other')
  ),
  summary TEXT CHECK (summary IS NULL OR char_length(summary) <= 2000),
  occurred_at TIMESTAMPTZ NOT NULL,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  next_action_at TIMESTAMPTZ,
  visibility TEXT NOT NULL DEFAULT 'operations'
    CHECK (visibility IN ('operations', 'manager', 'dispute')),
  external_provider TEXT CHECK (external_provider IS NULL OR char_length(external_provider) <= 80),
  external_event_id TEXT CHECK (external_event_id IS NULL OR char_length(external_event_id) <= 255),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint TEXT NOT NULL CHECK (char_length(request_fingerprint) = 64),
  retention_due_at TIMESTAMPTZ,
  anonymized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_interactions_company_id_id_uq UNIQUE (company_id, id),
  CONSTRAINT customer_interactions_idempotency_uq UNIQUE (company_id, idempotency_key),
  CONSTRAINT customer_interactions_customer_fk FOREIGN KEY (company_id, customer_id)
    REFERENCES customers(company_id, id) ON DELETE SET NULL (customer_id),
  CONSTRAINT customer_interactions_order_fk FOREIGN KEY (company_id, order_id)
    REFERENCES orders(company_id, id) ON DELETE CASCADE,
  CONSTRAINT customer_interactions_incident_fk FOREIGN KEY (company_id, order_id, incident_id)
    REFERENCES delivery_incidents(company_id, order_id, id) ON DELETE CASCADE,
  CONSTRAINT customer_interactions_payment_fk FOREIGN KEY (company_id, order_id, payment_account_id)
    REFERENCES order_payment_accounts(company_id, order_id, id) ON DELETE CASCADE,
  CONSTRAINT customer_interactions_context_ck CHECK (
    customer_id IS NOT NULL OR order_id IS NOT NULL OR incident_id IS NOT NULL OR payment_account_id IS NOT NULL
  ),
  CONSTRAINT customer_interactions_incident_order_ck CHECK (incident_id IS NULL OR order_id IS NOT NULL),
  CONSTRAINT customer_interactions_payment_order_ck CHECK (payment_account_id IS NULL OR order_id IS NOT NULL),
  CONSTRAINT customer_interactions_external_pair_ck CHECK (
    (external_provider IS NULL) = (external_event_id IS NULL)
  )
);

-- Consentements : journal d'états successifs, sans supposer que le consentement est
-- toujours la base juridique. Une ligne courante est celle sans superseded_at.
CREATE TABLE IF NOT EXISTS customer_consents (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL,
  contact_id BIGINT,
  purpose TEXT NOT NULL CHECK (char_length(btrim(purpose)) BETWEEN 2 AND 100),
  legal_basis TEXT NOT NULL CHECK (
    legal_basis IN ('consent', 'contract', 'legal_obligation', 'legitimate_interest', 'not_applicable')
  ),
  status TEXT NOT NULL CHECK (status IN ('granted', 'denied', 'withdrawn', 'not_required')),
  scope TEXT CHECK (scope IS NULL OR char_length(scope) <= 500),
  source TEXT NOT NULL CHECK (char_length(btrim(source)) BETWEEN 2 AND 100),
  evidence_reference TEXT CHECK (evidence_reference IS NULL OR char_length(evidence_reference) <= 255),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  supersedes_consent_id BIGINT,
  superseded_at TIMESTAMPTZ,
  recorded_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_consents_company_id_id_uq UNIQUE (company_id, id),
  CONSTRAINT customer_consents_customer_fk FOREIGN KEY (company_id, customer_id)
    REFERENCES customers(company_id, id) ON DELETE CASCADE,
  CONSTRAINT customer_consents_contact_fk FOREIGN KEY (company_id, customer_id, contact_id)
    REFERENCES customer_contacts(company_id, customer_id, id) ON DELETE SET NULL (contact_id),
  CONSTRAINT customer_consents_supersedes_fk FOREIGN KEY (company_id, supersedes_consent_id)
    REFERENCES customer_consents(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_consents_contact_customer_ck CHECK (contact_id IS NULL OR customer_id IS NOT NULL),
  CONSTRAINT customer_consents_dates_ck CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT customer_consents_withdrawal_ck CHECK (
    (status = 'withdrawn' AND withdrawn_at IS NOT NULL)
    OR (status <> 'withdrawn' AND withdrawn_at IS NULL)
  ),
  CONSTRAINT customer_consents_no_self_supersede_ck CHECK (
    supersedes_consent_id IS NULL OR supersedes_consent_id <> id
  )
);

CREATE TABLE IF NOT EXISTS customer_contact_preferences (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL,
  contact_id BIGINT,
  channel TEXT NOT NULL CHECK (channel IN ('call', 'whatsapp', 'sms', 'email', 'in_person')),
  purpose TEXT NOT NULL DEFAULT 'transactional' CHECK (purpose IN ('transactional', 'service', 'marketing')),
  preference TEXT NOT NULL DEFAULT 'unknown'
    CHECK (preference IN ('allowed', 'transactional_only', 'do_not_contact', 'unknown')),
  preferred_start_time TIME,
  preferred_end_time TIME,
  timezone TEXT NOT NULL DEFAULT 'Africa/Porto-Novo' CHECK (char_length(timezone) BETWEEN 3 AND 100),
  source TEXT NOT NULL CHECK (char_length(btrim(source)) BETWEEN 2 AND 100),
  effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_contact_preferences_company_id_id_uq UNIQUE (company_id, id),
  CONSTRAINT customer_contact_preferences_customer_fk FOREIGN KEY (company_id, customer_id)
    REFERENCES customers(company_id, id) ON DELETE CASCADE,
  CONSTRAINT customer_contact_preferences_contact_fk FOREIGN KEY (company_id, customer_id, contact_id)
    REFERENCES customer_contacts(company_id, customer_id, id) ON DELETE SET NULL (contact_id),
  CONSTRAINT customer_contact_preferences_hours_ck CHECK (
    preferred_start_time IS NULL OR preferred_end_time IS NULL OR preferred_start_time <> preferred_end_time
  )
);

CREATE TABLE IF NOT EXISTS crm_tags (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  color TEXT CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 500),
  archived_at TIMESTAMPTZ,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_tags_company_id_id_uq UNIQUE (company_id, id)
);

CREATE TABLE IF NOT EXISTS customer_tags (
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL,
  tag_id BIGINT NOT NULL,
  assigned_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, customer_id, tag_id),
  CONSTRAINT customer_tags_customer_fk FOREIGN KEY (company_id, customer_id)
    REFERENCES customers(company_id, id) ON DELETE CASCADE,
  CONSTRAINT customer_tags_tag_fk FOREIGN KEY (company_id, tag_id)
    REFERENCES crm_tags(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS customer_location_tags (
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  tag_id BIGINT NOT NULL,
  assigned_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, location_id, tag_id),
  CONSTRAINT customer_location_tags_location_fk FOREIGN KEY (company_id, customer_id, location_id)
    REFERENCES customer_locations(company_id, customer_id, id) ON DELETE CASCADE,
  CONSTRAINT customer_location_tags_tag_fk FOREIGN KEY (company_id, tag_id)
    REFERENCES crm_tags(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS order_tags (
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL,
  tag_id BIGINT NOT NULL,
  assigned_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, order_id, tag_id),
  CONSTRAINT order_tags_order_fk FOREIGN KEY (company_id, order_id)
    REFERENCES orders(company_id, id) ON DELETE CASCADE,
  CONSTRAINT order_tags_tag_fk FOREIGN KEY (company_id, tag_id)
    REFERENCES crm_tags(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS incident_tags (
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL,
  incident_id BIGINT NOT NULL,
  tag_id BIGINT NOT NULL,
  assigned_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, incident_id, tag_id),
  CONSTRAINT incident_tags_incident_fk FOREIGN KEY (company_id, order_id, incident_id)
    REFERENCES delivery_incidents(company_id, order_id, id) ON DELETE CASCADE,
  CONSTRAINT incident_tags_tag_fk FOREIGN KEY (company_id, tag_id)
    REFERENCES crm_tags(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payment_account_tags (
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL,
  payment_account_id BIGINT NOT NULL,
  tag_id BIGINT NOT NULL,
  assigned_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, payment_account_id, tag_id),
  CONSTRAINT payment_account_tags_payment_fk FOREIGN KEY (company_id, order_id, payment_account_id)
    REFERENCES order_payment_accounts(company_id, order_id, id) ON DELETE CASCADE,
  CONSTRAINT payment_account_tags_tag_fk FOREIGN KEY (company_id, tag_id)
    REFERENCES crm_tags(company_id, id) ON DELETE CASCADE
);

-- Une ressemblance devient une suggestion à arbitrer, jamais une fusion automatique.
CREATE TABLE IF NOT EXISTS customer_duplicate_candidates (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  left_customer_id BIGINT NOT NULL,
  right_customer_id BIGINT NOT NULL,
  confidence NUMERIC(5,4) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  signals JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(signals) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'not_duplicate', 'dismissed', 'merged')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  CONSTRAINT customer_duplicate_candidates_company_id_id_uq UNIQUE (company_id, id),
  CONSTRAINT customer_duplicate_candidates_pair_uq UNIQUE (company_id, left_customer_id, right_customer_id),
  CONSTRAINT customer_duplicate_candidates_left_fk FOREIGN KEY (company_id, left_customer_id)
    REFERENCES customers(company_id, id) ON DELETE CASCADE,
  CONSTRAINT customer_duplicate_candidates_right_fk FOREIGN KEY (company_id, right_customer_id)
    REFERENCES customers(company_id, id) ON DELETE CASCADE,
  CONSTRAINT customer_duplicate_candidates_order_ck CHECK (left_customer_id < right_customer_id),
  CONSTRAINT customer_duplicate_candidates_resolution_ck CHECK (
    (status = 'pending' AND resolved_at IS NULL)
    OR (status <> 'pending' AND resolved_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS customer_merge_events (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_customer_id BIGINT NOT NULL,
  target_customer_id BIGINT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'merge' CHECK (operation IN ('merge', 'split')),
  reverses_event_id BIGINT,
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  preview_fingerprint TEXT NOT NULL CHECK (char_length(preview_fingerprint) = 64),
  result_summary JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(result_summary) = 'object'),
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint TEXT NOT NULL CHECK (char_length(request_fingerprint) = 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_merge_events_company_id_id_uq UNIQUE (company_id, id),
  CONSTRAINT customer_merge_events_idempotency_uq UNIQUE (company_id, idempotency_key),
  CONSTRAINT customer_merge_events_source_fk FOREIGN KEY (company_id, source_customer_id)
    REFERENCES customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_merge_events_target_fk FOREIGN KEY (company_id, target_customer_id)
    REFERENCES customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_merge_events_reverses_fk FOREIGN KEY (company_id, reverses_event_id)
    REFERENCES customer_merge_events(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_merge_events_distinct_ck CHECK (source_customer_id <> target_customer_id),
  CONSTRAINT customer_merge_events_reverse_ck CHECK (
    (operation = 'merge' AND reverses_event_id IS NULL)
    OR (operation = 'split' AND reverses_event_id IS NOT NULL)
  )
);

ALTER TABLE customers ADD COLUMN IF NOT EXISTS merged_by_event_id BIGINT;
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.customers'::regclass AND conname = 'customers_merged_by_event_fk'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_merged_by_event_fk
      FOREIGN KEY (company_id, merged_by_event_id)
      REFERENCES customer_merge_events(company_id, id)
      ON DELETE RESTRICT NOT VALID;
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS crm_retention_policies (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  data_category TEXT NOT NULL CHECK (char_length(btrim(data_category)) BETWEEN 2 AND 100),
  trigger_event TEXT NOT NULL CHECK (char_length(btrim(trigger_event)) BETWEEN 2 AND 100),
  retain_for INTERVAL NOT NULL CHECK (retain_for > INTERVAL '0 seconds'),
  disposition TEXT NOT NULL CHECK (disposition IN ('archive', 'anonymize', 'delete')),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  justification TEXT NOT NULL CHECK (char_length(btrim(justification)) BETWEEN 1 AND 2000),
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  approved_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  effective_at TIMESTAMPTZ NOT NULL,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_retention_policies_company_id_id_uq UNIQUE (company_id, id),
  CONSTRAINT crm_retention_policies_version_uq UNIQUE (company_id, data_category, policy_version),
  CONSTRAINT crm_retention_policies_approval_ck CHECK (
    (approved_at IS NULL AND approved_by_user_id IS NULL)
    OR approved_at IS NOT NULL
  ),
  CONSTRAINT crm_retention_policies_current_ck CHECK (
    (is_current = TRUE AND retired_at IS NULL)
    OR (is_current = FALSE)
  )
);

CREATE TABLE IF NOT EXISTS crm_retention_holds (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id BIGINT,
  order_id BIGINT,
  incident_id BIGINT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  review_due_at TIMESTAMPTZ NOT NULL,
  placed_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  placed_idempotency_key TEXT NOT NULL CHECK (char_length(placed_idempotency_key) BETWEEN 8 AND 200),
  placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  release_reason TEXT CHECK (release_reason IS NULL OR char_length(release_reason) <= 1000),
  release_idempotency_key TEXT,
  released_at TIMESTAMPTZ,
  CONSTRAINT crm_retention_holds_company_id_id_uq UNIQUE (company_id, id),
  CONSTRAINT crm_retention_holds_place_idempotency_uq UNIQUE (company_id, placed_idempotency_key),
  CONSTRAINT crm_retention_holds_customer_fk FOREIGN KEY (company_id, customer_id)
    REFERENCES customers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_retention_holds_order_fk FOREIGN KEY (company_id, order_id)
    REFERENCES orders(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_retention_holds_incident_fk FOREIGN KEY (company_id, order_id, incident_id)
    REFERENCES delivery_incidents(company_id, order_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_retention_holds_target_ck CHECK (
    customer_id IS NOT NULL OR order_id IS NOT NULL OR incident_id IS NOT NULL
  ),
  CONSTRAINT crm_retention_holds_incident_order_ck CHECK (incident_id IS NULL OR order_id IS NOT NULL),
  CONSTRAINT crm_retention_holds_release_ck CHECK (
    (status = 'active' AND released_at IS NULL AND released_by_user_id IS NULL AND release_reason IS NULL)
    OR (status = 'released' AND released_at IS NOT NULL AND release_reason IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS crm_privacy_actions (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id BIGINT,
  retention_policy_id BIGINT,
  action_type TEXT NOT NULL CHECK (action_type IN ('archive', 'anonymize', 'delete', 'correct', 'export')),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'previewed', 'approved', 'executing', 'completed', 'failed', 'cancelled')),
  scope JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(scope) = 'object'),
  result_counts JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(result_counts) = 'object'),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
  requested_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  approved_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  executed_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint TEXT NOT NULL CHECK (char_length(request_fingerprint) = 64),
  error_code TEXT CHECK (error_code IS NULL OR char_length(error_code) <= 100),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT crm_privacy_actions_company_id_id_uq UNIQUE (company_id, id),
  CONSTRAINT crm_privacy_actions_idempotency_uq UNIQUE (company_id, idempotency_key),
  CONSTRAINT crm_privacy_actions_customer_fk FOREIGN KEY (company_id, customer_id)
    REFERENCES customers(company_id, id) ON DELETE SET NULL (customer_id),
  CONSTRAINT crm_privacy_actions_policy_fk FOREIGN KEY (company_id, retention_policy_id)
    REFERENCES crm_retention_policies(company_id, id) ON DELETE SET NULL (retention_policy_id),
  CONSTRAINT crm_privacy_actions_completion_ck CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR status <> 'completed'
  )
);

-- Journal CRM séparé des événements métier. metadata doit contenir des identifiants,
-- catégories et résultats, jamais de token, OTP, contact brut ou coordonnées précises.
CREATE TABLE IF NOT EXISTS crm_audit_events (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (char_length(btrim(action)) BETWEEN 2 AND 100),
  entity_type TEXT NOT NULL CHECK (char_length(btrim(entity_type)) BETWEEN 2 AND 100),
  entity_id BIGINT,
  result TEXT NOT NULL CHECK (result IN ('success', 'denied', 'conflict', 'failed')),
  changed_fields TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object'),
  correlation_id UUID,
  previous_hash TEXT CHECK (previous_hash IS NULL OR char_length(previous_hash) = 64),
  event_hash TEXT NOT NULL CHECK (char_length(event_hash) = 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_audit_events_company_id_id_uq UNIQUE (company_id, id),
  CONSTRAINT crm_audit_events_hash_uq UNIQUE (company_id, event_hash)
);

-- Liaisons CRM facultatives : les champs historiques de orders restent des instantanés.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_contact_id BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_location_id BIGINT;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS customer_id BIGINT;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS customer_contact_id BIGINT;
ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS customer_location_id BIGINT;

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.orders'::regclass AND conname = 'orders_customer_crm_fk') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_customer_crm_fk
      FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id)
      ON DELETE SET NULL (customer_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.orders'::regclass AND conname = 'orders_customer_contact_crm_fk') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_customer_contact_crm_fk
      FOREIGN KEY (company_id, customer_id, customer_contact_id)
      REFERENCES customer_contacts(company_id, customer_id, id)
      ON DELETE SET NULL (customer_contact_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.orders'::regclass AND conname = 'orders_customer_location_crm_fk') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_customer_location_crm_fk
      FOREIGN KEY (company_id, customer_id, customer_location_id)
      REFERENCES customer_locations(company_id, customer_id, id)
      ON DELETE SET NULL (customer_location_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.customer_requests'::regclass AND conname = 'customer_requests_customer_crm_fk') THEN
    ALTER TABLE customer_requests ADD CONSTRAINT customer_requests_customer_crm_fk
      FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id)
      ON DELETE SET NULL (customer_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.customer_requests'::regclass AND conname = 'customer_requests_customer_contact_crm_fk') THEN
    ALTER TABLE customer_requests ADD CONSTRAINT customer_requests_customer_contact_crm_fk
      FOREIGN KEY (company_id, customer_id, customer_contact_id)
      REFERENCES customer_contacts(company_id, customer_id, id)
      ON DELETE SET NULL (customer_contact_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.customer_requests'::regclass AND conname = 'customer_requests_customer_location_crm_fk') THEN
    ALTER TABLE customer_requests ADD CONSTRAINT customer_requests_customer_location_crm_fk
      FOREIGN KEY (company_id, customer_id, customer_location_id)
      REFERENCES customer_locations(company_id, customer_id, id)
      ON DELETE SET NULL (customer_location_id) NOT VALID;
  END IF;
END
$migration$;

-- Index orientés listes, recherche exacte normalisée, files de travail et audit.
CREATE INDEX IF NOT EXISTS customers_company_status_updated_idx
  ON customers (company_id, status, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS customers_company_name_idx
  ON customers (company_id, lower(display_name), id);
CREATE INDEX IF NOT EXISTS customer_contacts_company_customer_active_idx
  ON customer_contacts (company_id, customer_id, kind, is_active);
CREATE INDEX IF NOT EXISTS customer_contacts_company_normalized_idx
  ON customer_contacts (company_id, value_normalized) WHERE value_normalized IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customer_contacts_one_primary_kind_uq
  ON customer_contacts (company_id, customer_id, kind)
  WHERE is_active = TRUE AND is_primary = TRUE AND anonymized_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_locations_company_customer_active_idx
  ON customer_locations (company_id, customer_id, is_active, last_used_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS customer_locations_company_coordinates_idx
  ON customer_locations (company_id, latitude, longitude)
  WHERE is_active = TRUE AND latitude IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_location_revisions_location_created_idx
  ON customer_location_revisions (company_id, location_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS customer_interactions_customer_occurred_idx
  ON customer_interactions (company_id, customer_id, occurred_at DESC, id DESC)
  WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_interactions_order_occurred_idx
  ON customer_interactions (company_id, order_id, occurred_at DESC, id DESC)
  WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_interactions_next_action_idx
  ON customer_interactions (company_id, next_action_at, assigned_to_user_id)
  WHERE next_action_at IS NOT NULL AND anonymized_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customer_interactions_external_event_uq
  ON customer_interactions (company_id, external_provider, external_event_id)
  WHERE external_provider IS NOT NULL AND external_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customer_consents_current_scope_uq
  ON customer_consents (company_id, customer_id, COALESCE(contact_id, 0), purpose)
  WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_consents_customer_created_idx
  ON customer_consents (company_id, customer_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS customer_contact_preferences_scope_uq
  ON customer_contact_preferences (
    company_id,
    customer_id,
    COALESCE(contact_id, 0),
    channel,
    purpose
  );
CREATE UNIQUE INDEX IF NOT EXISTS crm_tags_active_name_uq
  ON crm_tags (company_id, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_duplicate_candidates_pending_idx
  ON customer_duplicate_candidates (company_id, confidence DESC NULLS LAST, detected_at ASC, id ASC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS customer_merge_events_customer_created_idx
  ON customer_merge_events (company_id, target_customer_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS crm_retention_policies_one_current_uq
  ON crm_retention_policies (company_id, data_category) WHERE is_current = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS crm_retention_holds_release_idempotency_uq
  ON crm_retention_holds (company_id, release_idempotency_key)
  WHERE release_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS crm_retention_holds_active_target_uq
  ON crm_retention_holds (
    company_id,
    COALESCE(customer_id, 0),
    COALESCE(order_id, 0),
    COALESCE(incident_id, 0)
  ) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS crm_retention_holds_review_idx
  ON crm_retention_holds (company_id, review_due_at, id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS crm_privacy_actions_status_requested_idx
  ON crm_privacy_actions (company_id, status, requested_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS crm_audit_events_company_created_idx
  ON crm_audit_events (company_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS crm_audit_events_entity_idx
  ON crm_audit_events (company_id, entity_type, entity_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS orders_company_customer_created_idx
  ON orders (company_id, customer_id, created_at DESC, id DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_requests_company_customer_created_idx
  ON customer_requests (company_id, customer_id, created_at DESC, id DESC) WHERE customer_id IS NOT NULL;

-- Contexte RLS : l'application doit exécuter, dans chaque transaction métier :
-- SELECT set_config('app.company_id', '<id>', true);
CREATE OR REPLACE FUNCTION crm_current_company_id()
RETURNS BIGINT
LANGUAGE SQL
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(current_setting('app.company_id', true), '')::BIGINT
$function$;

DO $rls$
DECLARE
  table_name TEXT;
  tenant_tables CONSTANT TEXT[] := ARRAY[
    'customers',
    'customer_contacts',
    'customer_locations',
    'customer_location_revisions',
    'customer_interactions',
    'customer_consents',
    'customer_contact_preferences',
    'crm_tags',
    'customer_tags',
    'customer_location_tags',
    'order_tags',
    'incident_tags',
    'payment_account_tags',
    'customer_duplicate_candidates',
    'customer_merge_events',
    'crm_retention_policies',
    'crm_retention_holds',
    'crm_privacy_actions',
    'crm_audit_events'
  ];
BEGIN
  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = table_name
        AND policyname = 'crm_company_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY crm_company_isolation ON public.%I USING (company_id = public.crm_current_company_id()) WITH CHECK (company_id = public.crm_current_company_id())',
        table_name
      );
    END IF;
  END LOOP;
END
$rls$;

COMMENT ON FUNCTION crm_current_company_id() IS
  'Identifiant locataire lu depuis app.company_id, à définir localement dans chaque transaction.';
COMMENT ON TABLE customers IS
  'Référentiel CRM multi-entreprise ; les commandes conservent leurs champs historiques comme instantanés.';
COMMENT ON TABLE customer_duplicate_candidates IS
  'Suggestions de doublons à arbitrage humain ; aucune fusion automatique.';
COMMENT ON TABLE customer_merge_events IS
  'Journal append-only des fusions et séparations assistées de clients.';
COMMENT ON TABLE crm_audit_events IS
  'Audit CRM minimal sans secret ni contenu personnel brut.';

COMMIT;
