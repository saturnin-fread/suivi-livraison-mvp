// Contrôle de configuration : ce qui est signalé en production, et seulement là.
const assert = require('assert');
const { checkConfig } = require('../server/core/config');

const secret = 'x'.repeat(32);
const prod = {
  RAILWAY_ENVIRONMENT_NAME: 'production', DATABASE_URL: 'postgres://h/db', APP_BASE_URL: 'https://app.example',
  TRACKING_TOKEN_SECRET: secret, OTP_PEPPER: secret, MFA_SECRET: secret,
};
assert.deepStrictEqual(checkConfig(prod).problems, [], 'production complète : rien à signaler (SESSION_SECRET facultatif)');
assert.ok(checkConfig({ ...prod, OTP_PEPPER: '' }).problems.some((p) => /OTP_PEPPER/.test(p)), 'OTP_PEPPER manquant signalé');
assert.ok(checkConfig({ ...prod, MFA_SECRET: 'court' }).problems.some((p) => /MFA_SECRET est trop court/.test(p)), 'secret trop court signalé');
assert.ok(checkConfig({ ...prod, WHATSAPP_FAKE: 'outbox' }).problems.some((p) => /WHATSAPP_FAKE/.test(p)), 'réglage de test signalé');
assert.deepStrictEqual(checkConfig({}).problems, [], 'développement : aucune exigence');
const { enabled } = checkConfig({ ...prod, REDIS_URL: 'redis://h', ROUTING_PROVIDER: 'osrm', ROUTING_OSRM_URL: 'http://o' });
assert.ok(enabled.includes('Limites partagées (Redis)') && enabled.includes('Itinéraires (OSRM)'), 'fonctions détectées');
// Les valeurs ne sont jamais recopiées dans les messages.
assert.ok(!JSON.stringify(checkConfig({ ...prod, MFA_SECRET: 'abc' })).includes('abc'), 'aucune valeur dans les messages');
console.log('config-test: OK');
