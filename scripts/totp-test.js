// Vecteurs officiels RFC 6238 (SHA-1, secret « 12345678901234567890 ») et règles
// de vérification (fenêtre, anti-rejeu, codes de secours).
const assert = require('assert');
const t = require('../lib/totp');

const secret = t.base32Encode(Buffer.from('12345678901234567890'));
assert.strictEqual(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
const vectors = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']];
for (const [seconds, expected] of vectors) assert.strictEqual(t.totp(secret, seconds * 1000), expected, `RFC 6238 à ${seconds}s`);

const now = 1_800_000_000_000;
const code = t.totp(secret, now);
assert.ok(t.verifyTotp(secret, code, { now }) != null, 'code courant accepté');
assert.ok(t.verifyTotp(secret, t.totp(secret, now - 30_000), { now }) != null, 'code précédent toléré (±30 s)');
assert.strictEqual(t.verifyTotp(secret, t.totp(secret, now - 90_000), { now }), null, 'code trop ancien refusé');
const step = t.verifyTotp(secret, code, { now });
assert.strictEqual(t.verifyTotp(secret, code, { now, lastStep: step }), null, 'même code refusé une seconde fois');
assert.strictEqual(t.verifyTotp(secret, '12345', { now }), null, 'format invalide refusé');
assert.strictEqual(t.base32Decode(t.base32Encode(Buffer.from('abc'))).toString(), 'abc');

const codes = t.generateRecoveryCodes();
assert.strictEqual(codes.length, 8);
assert.ok(codes.every((c) => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c)));
assert.strictEqual(t.normalizeRecoveryCode(codes[0].toLowerCase().replace('-', ' ')), codes[0]);
assert.ok(t.otpauthUrl({ secret, account: 'a@b.c' }).startsWith('otpauth://totp/TRAXO%3Aa%40b.c?secret='));
console.log('TOTP : vecteurs RFC 6238, fenêtre, anti-rejeu et codes de secours OK.');
