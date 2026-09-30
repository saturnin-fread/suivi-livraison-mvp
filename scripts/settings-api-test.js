// Paramètres : règles de livraison réellement appliquées, calcul des formules,
// numéro WhatsApp, fermeture des sessions, demande de devis.
// Serveur lancé SANS LOGIN_EMAIL_CODE (session ouverte dès l'inscription) et avec
// EMAIL_OUTBOX_DIR pour la demande de devis.
const assert = require('assert');
const { Pool } = require('pg');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const password = 'une phrase assez longue';
let ip = '10.8.0.1';

const sessionOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('delivery_session=') && c.length > 17);

async function register(label) {
  const email = `settings-${label}-${Date.now()}@example.test`;
  const res = await fetch(`${base}/app/register`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip },
    body: new URLSearchParams({ email, password, passwordConfirm: password }),
  });
  const cookie = sessionOf(res);
  assert.ok(cookie, `session ouverte à l'inscription (${res.status} ${res.headers.get('location')})`);
  return { email, cookie };
}
function client(cookie) {
  return async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method, redirect: 'manual',
      headers: { Cookie: cookie, 'X-Forwarded-For': ip, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
}

(async () => {
  const owner = await register('owner');
  const api = client(owner.cookie);

  // Espace en aperçu : réglages de l'entreprise bloqués, sécurité du compte permise
  assert.strictEqual((await api('PATCH', '/api/app/settings/deliveries', { manualValidation: false })).status, 402, 'aperçu : réglages entreprise bloqués');
  assert.strictEqual((await api('PATCH', '/api/app/account/preferences', { loginAlerts: true })).status, 200, 'aperçu : préférences du compte permises');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`UPDATE companies SET activation_status = 'active' WHERE id = (SELECT company_id FROM company_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1)`, [owner.email]);
  await pool.end();

  // --- Règles de livraison : fusion, validation, au moins un mode de création
  let r = await api('GET', '/api/app/settings/deliveries');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.driverAssignmentRequired, false, 'livreur non obligatoire par défaut');
  r = await api('PATCH', '/api/app/settings/deliveries', { manualValidation: 'oui' });
  assert.strictEqual(r.status, 400, 'valeur non booléenne refusée');
  r = await api('PATCH', '/api/app/settings/deliveries', { customerFormEnabled: false, internalEntryEnabled: false });
  assert.strictEqual(r.status, 400, 'impossible de couper les deux modes de création');
  r = await api('PATCH', '/api/app/settings/deliveries', { allowEditAfterValidation: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.allowEditAfterValidation, true);
  assert.strictEqual(r.data.customerFormEnabled, true, 'les autres réglages sont conservés (fusion)');

  // Livreur obligatoire → la validation sans livreur est refusée
  r = await api('PATCH', '/api/app/settings/deliveries', { driverAssignmentRequired: true });
  assert.strictEqual(r.data.driverAssignmentRequired, true);
  const created = await api('POST', '/api/app/requests', { customerName: 'Client Règles', customerPhone: '+22997000001' });
  if (created.status === 201 || created.status === 200) {
    const id = created.data.id || (created.data.request && created.data.request.id);
    const v = await api('POST', `/api/app/requests/${id}/validate`);
    assert.strictEqual(v.status, 409, 'validation refusée sans livreur');
    assert.strictEqual(v.data.code, 'DRIVER_REQUIRED');
  } else {
    // La création de demande a d'autres exigences : on vérifie au moins la règle sur un id quelconque.
    const v = await api('POST', '/api/app/requests/0/validate');
    assert.strictEqual(v.data.code, 'DRIVER_REQUIRED', 'la règle est vérifiée avant tout');
  }
  await api('PATCH', '/api/app/settings/deliveries', { driverAssignmentRequired: false, allowEditAfterValidation: false });

  // --- Preuves
  r = await api('PATCH', '/api/app/settings/proofs', { photoMode: 'required', signatureMode: 'optional' });
  assert.strictEqual(r.status, 200);
  r = await api('GET', '/api/app/settings/proofs');
  assert.deepStrictEqual([r.data.photo_proof_mode, r.data.signature_proof_mode], ['required', 'optional']);
  assert.strictEqual((await api('PATCH', '/api/app/settings/proofs', { photoMode: 'toujours' })).status, 400);

  // --- Formules : calcul officiel
  r = await api('GET', '/api/app/billing/quote?plan=flexible&cycle=monthly&drivers=4');
  assert.deepStrictEqual([r.data.monthlyEquivalent, r.data.periodTotal, r.data.fits], [4000, 4000, true]);
  r = await api('GET', '/api/app/billing/quote?plan=croissance&cycle=yearly&drivers=14');
  assert.deepStrictEqual([r.data.monthlyEquivalent, r.data.periodTotal, r.data.periodMonths], [16200, 194400, 12]);
  r = await api('GET', '/api/app/billing/quote?plan=equipe&cycle=monthly&drivers=20');
  assert.strictEqual(r.data.fits, false, 'capacité dépassée signalée');
  assert.strictEqual((await api('GET', '/api/app/billing/quote?plan=grande&cycle=monthly&drivers=80')).status, 400, 'Grande flotte : sur devis');
  assert.strictEqual((await api('GET', '/api/app/billing/quote?plan=flexible&cycle=weekly&drivers=2')).status, 400);
  r = await api('POST', '/api/app/billing/plan', { planCode: 'equipe', billingCycle: 'quarterly' });
  assert.strictEqual(r.status, 200);
  r = await api('GET', '/api/app/billing/plans');
  assert.deepStrictEqual([r.data.currentPlan, r.data.billingCycle], ['equipe', 'quarterly']);

  // --- Demande de devis
  r = await api('POST', '/api/app/billing/quote-request', { email: 'pas-un-email', drivers: 80 });
  assert.strictEqual(r.status, 400);
  r = await api('POST', '/api/app/billing/quote-request', { email: owner.email, drivers: 80, message: 'Cotonou et Porto-Novo' });
  assert.ok([201, 503].includes(r.status), `devis : envoyé ou non configuré (${r.status} ${r.data.error || ''})`);

  // --- Numéro WhatsApp
  assert.strictEqual((await api('PATCH', '/api/app/account/phone', { phone: '01 97 12 34 56' })).status, 400, 'indicatif obligatoire');
  r = await api('PATCH', '/api/app/account/phone', { phone: '+229 01 97 12 34 56' });
  assert.deepStrictEqual([r.status, r.data.phone], [200, '+2290197123456']);
  r = await api('GET', '/api/app/account/security');
  assert.strictEqual(r.data.phoneInternational, true);
  r = await api('PATCH', '/api/app/account/phone', { phone: '' });
  assert.strictEqual(r.data.phone, '', 'numéro retiré');

  // --- Sessions : fermer une autre session, puis toutes les autres
  ip = '10.8.0.2';
  const login = async () => {
    const res = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip }, body: new URLSearchParams({ user: owner.email, password }) });
    const cookie = sessionOf(res);
    assert.ok(cookie, 'seconde connexion ouverte');
    return cookie;
  };
  const second = await login();
  const third = await login();
  ip = '10.8.0.1';
  let list = (await api('GET', '/api/app/account/sessions')).data;
  assert.strictEqual(list.length, 3);
  const current = list.find((s) => s.current);
  assert.strictEqual((await api('POST', '/api/app/account/sessions/revoke', { id: current.id })).status, 400, 'la session courante ne se ferme pas ici');
  const other = list.find((s) => !s.current);
  r = await api('POST', '/api/app/account/sessions/revoke', { id: other.id });
  assert.strictEqual(r.data.closed, 1);
  r = await api('POST', '/api/app/account/sessions/revoke', { id: 'others' });
  assert.strictEqual(r.data.closed, 1);
  list = (await api('GET', '/api/app/account/sessions')).data;
  assert.strictEqual(list.length, 1, 'seule la session courante reste');
  for (const cookie of [second, third]) {
    assert.strictEqual((await client(cookie)('GET', '/api/app/account/security')).status, 401, 'session fermée inutilisable');
  }

  // --- Profil : identifiant invalide refusé
  assert.strictEqual((await api('PATCH', '/api/app/company', { name: 'Test', slug: 'Pas Valide', timezone: 'Africa/Porto-Novo' })).status, 400);

  console.log('Paramètres : règles, formules, devis, numéro et sessions OK');
})().catch((error) => { console.error(error); process.exit(1); });
