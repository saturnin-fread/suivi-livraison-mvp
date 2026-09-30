// Canal WhatsApp hors réseau : numéros, masquage, chiffrement de la session et
// stockage des clés Baileys en base (base locale de test uniquement).
const assert = require('assert');
const { Pool } = require('pg');
const { WhatsAppChannel, internationalDigits, maskPhone, candidateNumbers } = require('../lib/whatsapp');

(async () => {
  assert.strictEqual(internationalDigits('+229 01 40 05 67 66'), '2290140056766');
  assert.strictEqual(internationalDigits('01 40 05 67 66'), null, 'sans indicatif : refusé');
  assert.strictEqual(internationalDigits('+22'), null);
  assert.deepStrictEqual(candidateNumbers('2290140056766'), ['2290140056766', '22940056766'], 'Bénin : ancien numéro essayé');
  assert.deepStrictEqual(candidateNumbers('2250707070707'), ['2250707070707']);
  assert.strictEqual(maskPhone('+229 01 40 05 67 66'), '+229 •• •• 67 66');

  if (!process.env.DATABASE_URL || /railway|rlwy/.test(process.env.DATABASE_URL)) {
    console.log('WhatsApp : tests de base OK (stockage non testé sans base locale).');
    return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS whatsapp_auth (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query('DELETE FROM whatsapp_auth');
    const lib = await import('@whiskeysockets/baileys');
    const channel = new WhatsAppChannel({ pool, secret: 'test-secret-0123456789abcdef' });
    assert.ok(channel.enabled());
    const first = await channel.authState(lib);
    assert.strictEqual(first.registered, false, 'aucune session au départ');
    first.state.creds.me = { id: '2290140056766:3@s.whatsapp.net' };
    await first.saveCreds();
    await first.state.keys.set({ 'pre-key': { 1: { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5]) }, 2: null } });

    const raw = (await pool.query("SELECT data FROM whatsapp_auth WHERE id = 'creds'")).rows[0].data;
    assert.ok(raw.startsWith('v1.') && !raw.includes('2290140056766'), 'session chiffrée en base');

    const second = await channel.authState(lib);
    assert.strictEqual(second.state.creds.me.id, '2290140056766:3@s.whatsapp.net', 'identifiants relus');
    assert.deepStrictEqual(Buffer.from(second.state.creds.noiseKey.public), Buffer.from(first.state.creds.noiseKey.public), 'clés binaires intactes');
    const keys = await second.state.keys.get('pre-key', ['1', '2']);
    assert.deepStrictEqual(Buffer.from(keys['1'].public), Buffer.from([1, 2, 3]));
    assert.strictEqual(keys['2'], undefined);

    const other = new WhatsAppChannel({ pool, secret: 'une-autre-cle-0123456789abcdef' });
    const foreign = await other.authState(lib);
    assert.strictEqual(foreign.state.creds.me, undefined, 'autre clé : session illisible (nouvelle liaison)');

    await assert.rejects(channel.sendText('+22901000000', 'x'), (e) => e.code === 'not_connected', 'envoi refusé hors connexion');
    await channel.clearSession();
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM whatsapp_auth')).rows[0].n, 0);
    console.log('WhatsApp OK : numéros, masquage, session chiffrée, clés binaires, refus hors connexion.');
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error('Test WhatsApp échoué :', error.message);
  process.exit(1);
});
