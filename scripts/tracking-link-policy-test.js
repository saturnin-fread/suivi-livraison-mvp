'use strict';

const assert = require('node:assert/strict');
const {
  DEFAULT_TRACKING_LINK_TTL_MS,
  GENERIC_UNAVAILABLE_MESSAGE,
  LEGACY_NULL_EXPIRY_TTL_MS,
  MAX_TRACKING_LINK_TTL_MS,
  MIN_TRACKING_LINK_TTL_MS,
  TRACKING_LINK_STATES,
  TrackingLinkPolicyError,
  createTrackingLinkExpiration,
  evaluateTrackingLink,
  normalizeTrackingLinkTtl,
  planTrackingLinkRevocation,
  planTrackingLinkRotation,
  publicTrackingLinkMessage,
  resolveEffectiveExpiration,
  validateIdempotency,
} = require('../lib/tracking-link-policy');

const NOW = '2026-09-15T09:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1_000;
const KEY = 'rotation-order-42-01';
const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);
const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function expectPolicyError(run, code) {
  assert.throws(run, (error) => error instanceof TrackingLinkPolicyError && error.code === code);
}

test('les bornes documentées restent cohérentes', () => {
  assert.equal(MIN_TRACKING_LINK_TTL_MS, 15 * 60 * 1_000);
  assert.equal(DEFAULT_TRACKING_LINK_TTL_MS, 7 * DAY_MS);
  assert.equal(MAX_TRACKING_LINK_TTL_MS, 30 * DAY_MS);
  assert.equal(LEGACY_NULL_EXPIRY_TTL_MS, MAX_TRACKING_LINK_TTL_MS);
});

test('la durée par défaut et les deux bornes exactes sont acceptées', () => {
  assert.equal(normalizeTrackingLinkTtl(), DEFAULT_TRACKING_LINK_TTL_MS);
  assert.equal(normalizeTrackingLinkTtl(null), DEFAULT_TRACKING_LINK_TTL_MS);
  assert.equal(normalizeTrackingLinkTtl(''), DEFAULT_TRACKING_LINK_TTL_MS);
  assert.equal(normalizeTrackingLinkTtl(MIN_TRACKING_LINK_TTL_MS), MIN_TRACKING_LINK_TTL_MS);
  assert.equal(normalizeTrackingLinkTtl(MAX_TRACKING_LINK_TTL_MS), MAX_TRACKING_LINK_TTL_MS);
});

test('les durées invalides, trop courtes ou trop longues sont refusées sans arrondi', () => {
  for (const value of [0, -1, 1.5, '900000', Number.MAX_SAFE_INTEGER + 1]) {
    expectPolicyError(() => normalizeTrackingLinkTtl(value), 'invalid_ttl');
  }
  expectPolicyError(() => normalizeTrackingLinkTtl(MIN_TRACKING_LINK_TTL_MS - 1), 'ttl_too_short');
  expectPolicyError(() => normalizeTrackingLinkTtl(MAX_TRACKING_LINK_TTL_MS + 1), 'ttl_too_long');
});

test('une configuration incohérente de politique est refusée', () => {
  expectPolicyError(
    () => normalizeTrackingLinkTtl(undefined, { minimumTtlMs: 2_000, maximumTtlMs: 1_000, defaultTtlMs: 1_500 }),
    'invalid_ttl_policy',
  );
  expectPolicyError(
    () => normalizeTrackingLinkTtl(undefined, { minimumTtlMs: 1_000, maximumTtlMs: 3_000, defaultTtlMs: 4_000 }),
    'invalid_ttl_policy',
  );
  expectPolicyError(
    () => normalizeTrackingLinkTtl(undefined, { maximumTtlMs: DAY_MS, defaultTtlMs: DAY_MS, legacyNullExpiryTtlMs: 2 * DAY_MS }),
    'invalid_ttl_policy',
  );
});

test('la création d’échéance est déterministe et ne mute pas la date fournie', () => {
  const input = new Date(NOW);
  const result = createTrackingLinkExpiration({ now: input });
  assert.equal(result.issuedAt, NOW);
  assert.equal(result.expiresAt, '2026-09-22T09:00:00.000Z');
  assert.equal(result.ttlMs, DEFAULT_TRACKING_LINK_TTL_MS);
  assert.equal(input.toISOString(), NOW);
});

test('une expiration explicite reste prioritaire pour les liens existants', () => {
  const result = resolveEffectiveExpiration({
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2026-09-20T00:00:00.000Z',
  });
  assert.deepEqual(result, {
    expiresAt: '2026-09-20T00:00:00.000Z',
    source: 'explicit',
    valid: true,
  });
});

test('un ancien lien sans expiration reçoit au plus trente jours depuis sa création', () => {
  const result = resolveEffectiveExpiration({ created_at: '2026-09-01T09:00:00.000Z', expires_at: null });
  assert.equal(result.source, 'legacy_created_at');
  assert.equal(result.expiresAt, '2026-10-01T09:00:00.000Z');
  assert.equal(result.valid, true);
});

test('un ancien lien sans date exploitable échoue de manière fermée', () => {
  assert.deepEqual(resolveEffectiveExpiration({ expires_at: null }), {
    expiresAt: null,
    source: 'legacy_missing_created_at',
    valid: false,
  });
  assert.equal(resolveEffectiveExpiration({ expires_at: 'pas-une-date' }).valid, false);
  assert.equal(resolveEffectiveExpiration({ expires_at: null, created_at: 'pas-une-date' }).valid, false);
});

test('un lien explicite futur est actif et autorise uniquement le suivi prévu', () => {
  const result = evaluateTrackingLink({ expires_at: '2026-09-16T09:00:00.000Z', order_status: 'En tournée' }, { now: NOW });
  assert.equal(result.state, TRACKING_LINK_STATES.ACTIVE);
  assert.equal(result.publicTrackingAllowed, true);
  assert.equal(result.positionVisible, true);
  assert.equal(result.shouldRefresh, true);
  assert.equal(result.expirationSource, 'explicit');
});

test('l’expiration est effective exactement à la borne', () => {
  for (const expiresAt of ['2026-09-15T08:59:59.999Z', NOW]) {
    const result = evaluateTrackingLink({ expiresAt, orderStatus: 'En tournée' }, { now: NOW });
    assert.equal(result.state, TRACKING_LINK_STATES.EXPIRED);
    assert.equal(result.publicTrackingAllowed, false);
  }
});

test('les anciennes lignes nulles restent compatibles mais ne deviennent pas éternelles', () => {
  const recent = evaluateTrackingLink({ created_at: '2026-09-01T09:00:00.000Z', expires_at: null }, { now: NOW });
  const old = evaluateTrackingLink({ created_at: '2026-08-16T09:00:00.000Z', expires_at: null }, { now: NOW });
  assert.equal(recent.state, TRACKING_LINK_STATES.ACTIVE);
  assert.equal(recent.expirationSource, 'legacy_created_at');
  assert.equal(old.state, TRACKING_LINK_STATES.EXPIRED);
});

test('la révocation et la rotation ont priorité sur expiration et état de commande', () => {
  const base = { expiresAt: '2026-01-01T00:00:00.000Z', orderStatus: 'Livrée' };
  assert.equal(evaluateTrackingLink({ ...base, revokedAt: NOW }, { now: NOW }).state, TRACKING_LINK_STATES.REVOKED);
  assert.equal(evaluateTrackingLink({ ...base, rotated_at: NOW }, { now: NOW }).reason, 'rotated');
  assert.equal(evaluateTrackingLink({ ...base, supersededAt: NOW }, { now: NOW }).state, TRACKING_LINK_STATES.REVOKED);
});

test('les trois états terminaux suppriment position et rafraîchissement mais gardent un reçu sûr', () => {
  for (const orderStatus of ['Livrée', 'Retournée', 'Annulée']) {
    const result = evaluateTrackingLink({ expiresAt: '2026-09-20T09:00:00.000Z', orderStatus }, { now: NOW });
    assert.equal(result.state, TRACKING_LINK_STATES.TERMINAL);
    assert.equal(result.publicTrackingAllowed, false);
    assert.equal(result.positionVisible, false);
    assert.equal(result.shouldRefresh, false);
    assert.equal(result.terminalReceiptVisible, true);
    assert.equal(result.orderStatus, orderStatus);
  }
});

test('un statut non terminal ne peut pas être confondu avec un état terminal', () => {
  for (const orderStatus of ['Échec', 'Retour', 'Arrivée', null]) {
    assert.equal(
      evaluateTrackingLink({ expiresAt: '2026-09-20T09:00:00.000Z', orderStatus }, { now: NOW }).state,
      TRACKING_LINK_STATES.ACTIVE,
    );
  }
});

test('lien absent, expiration invalide et création absente restent indisponibles', () => {
  assert.equal(evaluateTrackingLink(null, { now: NOW }).state, TRACKING_LINK_STATES.UNAVAILABLE);
  assert.equal(evaluateTrackingLink({}, { now: NOW }).state, TRACKING_LINK_STATES.UNAVAILABLE);
  assert.equal(evaluateTrackingLink({ expiresAt: 'x' }, { now: NOW }).state, TRACKING_LINK_STATES.UNAVAILABLE);
});

test('les faux, expirés et révoqués reçoivent exactement le même message public', () => {
  const messages = [
    publicTrackingLinkMessage(TRACKING_LINK_STATES.UNAVAILABLE),
    publicTrackingLinkMessage(TRACKING_LINK_STATES.EXPIRED),
    publicTrackingLinkMessage(TRACKING_LINK_STATES.REVOKED),
  ];
  for (const message of messages) assert.deepEqual(message, GENERIC_UNAVAILABLE_MESSAGE);
  assert.equal(JSON.stringify(messages).includes('expired'), false);
  assert.equal(JSON.stringify(messages).includes('revoked'), false);
  assert.equal(JSON.stringify(messages).includes('token'), false);
});

test('les reçus terminaux ne contiennent que le résultat de livraison attendu', () => {
  assert.equal(publicTrackingLinkMessage(TRACKING_LINK_STATES.TERMINAL, 'Livrée').message, 'Votre livraison a été remise.');
  assert.equal(publicTrackingLinkMessage(TRACKING_LINK_STATES.TERMINAL, 'Retournée').statusCode, 200);
  assert.equal(publicTrackingLinkMessage(TRACKING_LINK_STATES.TERMINAL, 'inconnu').message, 'Cette livraison est terminée.');
  assert.equal(publicTrackingLinkMessage(TRACKING_LINK_STATES.ACTIVE), null);
});

test('la révocation est immédiate et un second appel est idempotent', () => {
  const link = { expiresAt: '2026-09-20T09:00:00.000Z', orderStatus: 'En tournée' };
  const first = planTrackingLinkRevocation({ link, now: NOW, reason: 'operator_request' });
  assert.equal(first.action, 'revoke');
  assert.equal(first.patch.revokedAt, NOW);
  const second = planTrackingLinkRevocation({ link: { ...link, ...first.patch }, now: NOW, reason: 'operator_request' });
  assert.equal(second.action, 'no_op');
  assert.equal(second.patch, null);
  expectPolicyError(() => planTrackingLinkRevocation({ link, now: NOW, reason: 'raison libre avec espaces' }), 'invalid_revocation_reason');
});

test('la rotation active crée une échéance bornée et invalide l’ancien token au même instant', () => {
  const oldLink = { expiresAt: '2026-09-20T09:00:00.000Z', orderStatus: 'En tournée' };
  const plan = planTrackingLinkRotation({ link: oldLink, now: NOW, ttlMs: DAY_MS });
  assert.equal(plan.action, 'rotate');
  assert.equal(plan.atomic, true);
  assert.equal(plan.effectiveAt, NOW);
  assert.equal(plan.previous.revokedAt, NOW);
  assert.equal(plan.next.expiresAt, '2026-09-16T09:00:00.000Z');

  const invalidatedOldLink = { ...oldLink, ...plan.previous };
  assert.equal(evaluateTrackingLink(invalidatedOldLink, { now: NOW }).state, TRACKING_LINK_STATES.REVOKED);
  assert.equal(publicTrackingLinkMessage(TRACKING_LINK_STATES.REVOKED).code, 'TRACKING_LINK_UNAVAILABLE');
});

test('un lien expiré ou révoqué peut être réémis pour une commande non terminale', () => {
  const expired = planTrackingLinkRotation({
    link: { expiresAt: '2026-09-14T09:00:00.000Z', orderStatus: 'En tournée' },
    now: NOW,
  });
  const revoked = planTrackingLinkRotation({
    link: { expiresAt: '2026-09-20T09:00:00.000Z', revokedAt: '2026-09-14T09:00:00.000Z', orderStatus: 'En tournée' },
    now: NOW,
  });
  assert.equal(expired.action, 'reissue');
  assert.equal(revoked.action, 'reissue');
});

test('une commande terminale ne peut pas obtenir un nouveau lien', () => {
  for (const link of [
    { expiresAt: '2026-09-20T09:00:00.000Z', orderStatus: 'Livrée' },
    { expiresAt: '2026-09-14T09:00:00.000Z', orderStatus: 'Retournée' },
    { expiresAt: '2026-09-20T09:00:00.000Z', revokedAt: '2026-09-14T09:00:00.000Z', orderStatus: 'Annulée' },
  ]) {
    expectPolicyError(() => planTrackingLinkRotation({ link, now: NOW }), 'terminal_order');
  }
  expectPolicyError(() => planTrackingLinkRotation({ link: null, now: NOW }), 'link_unavailable');
});

test('une première clé d’idempotence valide peut être traitée', () => {
  assert.deepEqual(validateIdempotency({ key: KEY, fingerprint: FINGERPRINT_A }), {
    outcome: 'proceed',
    retryable: false,
  });
});

test('une même clé et empreinte rejoue un résultat terminé sans répéter la mutation', () => {
  for (const status of ['completed', 'failed']) {
    const result = validateIdempotency({
      key: KEY,
      fingerprint: FINGERPRINT_A,
      existing: { key: KEY, fingerprint: FINGERPRINT_A, status },
    });
    assert.equal(result.outcome, 'replay');
    assert.equal(result.retryable, false);
  }
});

test('une opération concurrente identique est signalée comme en cours', () => {
  const result = validateIdempotency({
    key: KEY,
    fingerprint: FINGERPRINT_A,
    existing: { key: KEY, fingerprint: FINGERPRINT_A, status: 'processing' },
  });
  assert.equal(result.outcome, 'in_progress');
  assert.equal(result.retryable, true);
});

test('réutiliser une clé avec une autre empreinte ou action produit un conflit', () => {
  const changedPayload = validateIdempotency({
    key: KEY,
    fingerprint: FINGERPRINT_B,
    existing: { key: KEY, fingerprint: FINGERPRINT_A, status: 'completed' },
  });
  const changedKey = validateIdempotency({
    key: `${KEY}-other`,
    fingerprint: FINGERPRINT_A,
    existing: { key: KEY, fingerprint: FINGERPRINT_A, status: 'completed' },
  });
  assert.equal(changedPayload.outcome, 'conflict');
  assert.equal(changedKey.outcome, 'conflict');
});

test('les clés, empreintes, enregistrements et états d’idempotence invalides sont refusés', () => {
  for (const key of [undefined, '', 'court', 'avec espace', 'x'.repeat(201)]) {
    expectPolicyError(() => validateIdempotency({ key, fingerprint: FINGERPRINT_A }), 'invalid_idempotency_key');
  }
  for (const fingerprint of [undefined, '', 'abc', 'g'.repeat(64), 'a'.repeat(63)]) {
    expectPolicyError(() => validateIdempotency({ key: KEY, fingerprint }), 'invalid_idempotency_fingerprint');
  }
  expectPolicyError(
    () => validateIdempotency({ key: KEY, fingerprint: FINGERPRINT_A, existing: 'incorrect' }),
    'invalid_existing_idempotency_record',
  );
  expectPolicyError(
    () => validateIdempotency({ key: KEY, fingerprint: FINGERPRINT_A, existing: { key: KEY, fingerprint: FINGERPRINT_A, status: 'unknown' } }),
    'invalid_idempotency_status',
  );
});

test('les erreurs de validation n’intègrent jamais la valeur brute sensible', () => {
  const sensitive = 'cle invalide contenant une valeur à ne pas journaliser';
  try {
    validateIdempotency({ key: sensitive, fingerprint: FINGERPRINT_A });
    assert.fail('Une erreur était attendue.');
  } catch (error) {
    assert.equal(JSON.stringify(error).includes(sensitive), false);
    assert.equal(error.message.includes(sensitive), false);
  }
});

(async () => {
  for (const { name, run } of tests) {
    try {
      await run();
      process.stdout.write(`✓ ${name}\n`);
    } catch (error) {
      process.stderr.write(`✗ ${name}\n${error.stack}\n`);
      process.exitCode = 1;
      return;
    }
  }
  process.stdout.write(`\n${tests.length} tests de politique de lien réussis.\n`);
})();
