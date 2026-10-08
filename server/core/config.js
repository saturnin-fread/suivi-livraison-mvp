// Contrôle de la configuration au démarrage. On ne bloque pas le démarrage
// (une fonction absente se désactive d'elle-même) mais on dit clairement,
// dans les journaux, ce qui est actif, ce qui manque et ce qui est dangereux.
// Aucune valeur n'est jamais écrite : seulement les noms des variables.
const has = (env, ...keys) => keys.every((k) => Boolean(env[k] && String(env[k]).trim()));

const FEATURES = [
  ['E-mail', (e) => has(e, 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS') || has(e, 'BREVO_API_KEY') || has(e, 'RESEND_API_KEY')],
  ['Connexion Google', (e) => has(e, 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET')],
  ['WhatsApp', (e) => e.WHATSAPP_ENABLED !== 'off'],
  ['GPS (Traccar)', (e) => has(e, 'TRACCAR_URL', 'TRACCAR_USER', 'TRACCAR_PASSWORD')],
  ['Itinéraires (OSRM)', (e) => e.ROUTING_PROVIDER === 'osrm' && has(e, 'ROUTING_OSRM_URL')],
  ['Recherche de lieux', (e) => e.GEOCODER_PROVIDER !== 'disabled'],
  ['Limites partagées (Redis)', (e) => has(e, 'REDIS_URL')],
  ['Carte satellite', (e) => has(e, 'MAP_SATELLITE_TILE_URL')],
  ['Tuiles vectorielles', (e) => has(e, 'TILES_INTERNAL_URL')],
  ['Paiement en ligne (Kkiapay)', (e) => has(e, 'KKIAPAY_PUBLIC_KEY', 'KKIAPAY_PRIVATE_KEY', 'KKIAPAY_SECRET_KEY')],
];

// Secrets sans lesquels la production n'est pas sûre (liens, codes, double
// authentification). SESSION_SECRET n'est pas exigé : il ne sert que de repli à
// OTP_PEPPER, et les sessions sont des jetons aléatoires stockés hachés en base.
const PRODUCTION_SECRETS = ['DATABASE_URL', 'TRACKING_TOKEN_SECRET', 'OTP_PEPPER', 'MFA_SECRET', 'APP_BASE_URL'];
// Réglages réservés aux tests : jamais en production.
const TEST_ONLY = ['WHATSAPP_FAKE', 'EMAIL_OUTBOX_DIR', 'TRASH_PURGE_START', 'BILLING_TEST_PAYMENTS'];

function isProduction(env) {
  return env.NODE_ENV === 'production' || env.RAILWAY_ENVIRONMENT_NAME === 'production';
}

function checkConfig(env = process.env) {
  const production = isProduction(env);
  const enabled = FEATURES.filter(([, test]) => test(env)).map(([name]) => name);
  const disabled = FEATURES.filter(([, test]) => !test(env)).map(([name]) => name);
  const problems = [];
  if (production) {
    const missing = PRODUCTION_SECRETS.filter((k) => !has(env, k));
    if (missing.length) problems.push(`Variables manquantes en production : ${missing.join(', ')}`);
    const testOnly = TEST_ONLY.filter((k) => has(env, k));
    if (testOnly.length) problems.push(`Réglages de test actifs en production : ${testOnly.join(', ')} (à retirer)`);
    for (const k of ['SESSION_SECRET', 'TRACKING_TOKEN_SECRET', 'OTP_PEPPER', 'MFA_SECRET']) {
      if (has(env, k) && String(env[k]).length < 24) problems.push(`${k} est trop court (24 caractères minimum)`);
    }
  }
  return { production, enabled, disabled, problems };
}

function logConfig(env = process.env, log = console) {
  const { production, enabled, disabled, problems } = checkConfig(env);
  log.log(`Configuration (${production ? 'production' : 'développement'}) · actif : ${enabled.join(', ') || 'aucun'}${disabled.length ? ` · inactif : ${disabled.join(', ')}` : ''}`);
  for (const p of problems) log.warn(`Configuration : ${p}`);
  return { production, enabled, disabled, problems };
}

module.exports = { checkConfig, logConfig, FEATURES, PRODUCTION_SECRETS, TEST_ONLY };
