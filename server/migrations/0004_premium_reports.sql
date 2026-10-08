-- Rapport Premium (Excel enrichi) : N rapports offerts au total par entreprise
-- (2 par défaut), puis payés depuis le portefeuille, au rapport ou au mois.
-- Remplace l'essai Excel de 7 jours (colonnes excel_trial_* conservées, plus lues).
ALTER TABLE company_export_access ADD COLUMN IF NOT EXISTS premium_free_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE company_export_access ADD COLUMN IF NOT EXISTS premium_month_until TIMESTAMPTZ;
