-- Invitation livreur : la vérification est figée à la création, et le mode
-- « en personne » demande la confirmation du responsable (appairage).
--
-- verification : 'whatsapp' (code envoyé au numéro du profil) ou 'in_person'
--   (le responsable confirme sur son écran le numéro affiché par le
--   téléphone du livreur). Les invitations déjà émises (15 min de validité)
--   gardent le mode 'in_person'.
-- pairing_* : demande d'appairage en cours. Un nouveau scan remplace la
--   précédente ; seule la session du téléphone qui détient pairing_token peut
--   être ouverte, et seulement après pairing_approved_at.
ALTER TABLE driver_invitations ADD COLUMN IF NOT EXISTS verification TEXT NOT NULL DEFAULT 'in_person'
  CHECK (verification IN ('whatsapp', 'in_person'));
ALTER TABLE driver_invitations ADD COLUMN IF NOT EXISTS pairing_code TEXT;
ALTER TABLE driver_invitations ADD COLUMN IF NOT EXISTS pairing_token_hash TEXT;
ALTER TABLE driver_invitations ADD COLUMN IF NOT EXISTS pairing_at TIMESTAMPTZ;
ALTER TABLE driver_invitations ADD COLUMN IF NOT EXISTS pairing_approved_at TIMESTAMPTZ;
ALTER TABLE driver_invitations ADD COLUMN IF NOT EXISTS pairing_approved_by BIGINT;
-- Refus par le responsable : l'invitation est aussi annulée (le QR a pu fuiter).
ALTER TABLE driver_invitations ADD COLUMN IF NOT EXISTS pairing_refused_at TIMESTAMPTZ;
