#!/usr/bin/env node
// Régression complète : tests unitaires, puis suites d'intégration contre un
// vrai serveur (redémarré avant chaque suite, avec l'environnement du groupe),
// une base PostgreSQL de test et des faux services (GPS, itinéraires, lieux).
//
//   node scripts/test-all.js              tout lancer
//   node scripts/test-all.js --list       lister les suites
//   node scripts/test-all.js --only team,trash
//   node scripts/test-all.js --from reports
//
// Variables lues dans l'environnement ou dans .env.test (voir .env.test.example).
// Ne jamais pointer DATABASE_URL vers la production : les tests écrivent en base.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
if (fs.existsSync(path.join(ROOT, '.env.test'))) require('dotenv').config({ path: path.join(ROOT, '.env.test') });

const REQUIRED = ['DATABASE_URL', 'SESSION_SECRET', 'TRACKING_TOKEN_SECRET', 'OTP_PEPPER', 'ADMIN_USER', 'ADMIN_PASSWORD', 'PLATFORM_ADMIN_USER', 'PLATFORM_ADMIN_PASSWORD'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Variables manquantes : ${missing.join(', ')}. Copiez .env.test.example en .env.test.`);
  process.exit(2);
}
if (/railway|rlwy|amazonaws|supabase/i.test(process.env.DATABASE_URL) && process.env.ALLOW_REMOTE_TEST_DB !== '1') {
  console.error('DATABASE_URL ressemble à une base distante : les tests écrivent en base. Refusé (ALLOW_REMOTE_TEST_DB=1 pour forcer).');
  process.exit(2);
}

const PORT = Number(process.env.TEST_PORT || 3100);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'traxo-tests-'));
const outbox = (name) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };
const FAKES = { traccar: 8097, osrm: 8096, geocoder: 8095 };

// Environnement commun au serveur et aux tests.
const BASE_ENV = {
  PORT: String(PORT),
  SMOKE_BASE_URL: BASE,
  MFA_SECRET: process.env.MFA_SECRET || 'test-mfa-secret-0123456789abcdef',
  TILES_INTERNAL_URL: process.env.TILES_INTERNAL_URL || 'http://127.0.0.1:9',
  TRASH_PURGE: 'off',
};
const WA = { WHATSAPP_FAKE: 'outbox', WHATSAPP_DELAY_MIN_MS: '1500', WHATSAPP_DELAY_MAX_MS: '2000', WHATSAPP_RECIPIENT_GAP_MS: '1000' };
const MAIN = { EMAIL_OUTBOX_DIR: outbox('outbox-main') };
const MSG = { ...WA, EMAIL_OUTBOX_DIR: outbox('outbox') };
const TRACCAR = { TRACCAR_URL: `http://127.0.0.1:${FAKES.traccar}`, TRACCAR_USER: 'x', TRACCAR_PASSWORD: 'y' };

const npm = (script) => ['npm', 'run', '-s', script];
const unit = (name, cmd = npm(`test:${name}`)) => ({ name, cmd, server: false });
const srv = (name, env, cmd = npm(`test:${name}`)) => ({ name, cmd, server: true, env });

const SUITES = [
  unit('syntax'),
  ...['routing', 'rate-limit', 'tracking-links', 'dispatch', 'crm-metrics', 'crm-export', 'crm-xlsx', 'crm-operations-export', 'totp', 'whatsapp', 'eta'].map((n) => unit(n)),
  unit('dashboard-insights', ['node', 'scripts/dashboard-insights-test.js']),
  unit('migrate'),
  unit('config'),
  ...['smoke', 'customer-flow', 'mfa', 'driver', 'runs', 'payments', 'map', 'crm', 'settings', 'prefilled', 'notifications', 'pickup', 'drivers', 'vigilance', 'ops', 'clients'].map((n) => srv(n, MAIN)),
  srv('dashboard-api', MAIN, ['node', 'scripts/dashboard-api-test.js']),
  srv('auth', { ...MSG, LOGIN_EMAIL_CODE: 'on' }),
  srv('drivers-wa', MSG, npm('test:drivers')),
  srv('team', MSG),
  srv('invite-google', { ...MSG, GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret' }),
  srv('map-history', TRACCAR),
  srv('map-with-gps', TRACCAR, npm('test:map')),
  srv('live-route', { ...TRACCAR, ROUTING_PROVIDER: 'osrm', ROUTING_OSRM_URL: `http://127.0.0.1:${FAKES.osrm}`, EXPECT_ROUTING: '1' }),
  ...['places', 'reports', 'search', 'support', 'prices', 'trash'].map((n) => srv(n, { GEOCODER_URL: `http://127.0.0.1:${FAKES.geocoder}` })),
];

const args = process.argv.slice(2);
const argValue = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
if (args.includes('--list')) { SUITES.forEach((s) => console.log(`${s.server ? 'intégration' : 'unitaire   '}  ${s.name}`)); process.exit(0); }
let selected = SUITES;
const only = argValue('--only');
if (only) { const want = new Set(only.split(',')); selected = SUITES.filter((s) => want.has(s.name)); }
const from = argValue('--from');
if (from) { const i = SUITES.findIndex((s) => s.name === from); if (i < 0) { console.error(`Suite inconnue : ${from}`); process.exit(2); } selected = selected.filter((s) => SUITES.indexOf(s) >= i); }

const children = new Set();
function start(cmd, env, logFile) {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', out, out] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
function run(cmd, env, logFile, timeoutMs) {
  return new Promise((resolve) => {
    const child = start(cmd, env, logFile);
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(124); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? 1); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHealthy(url, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* pas encore prêt */ }
    await sleep(300);
  }
  return false;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((r) => child.on('exit', r));
  child.kill('SIGTERM');
  await Promise.race([done, sleep(5000).then(() => child.kill('SIGKILL'))]);
}

// Chaque suite part d'un état connu : double authentification coupée, preuves facultatives.
async function resetDb() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_recovery_hashes = '[]'::jsonb;
      UPDATE companies SET photo_proof_mode = 'off', signature_proof_mode = 'off';`);
  } catch (error) {
    if (error.code !== '42P01') throw error; // base vierge : le schéma n'existe pas encore
  } finally {
    await pool.end();
  }
}

const tail = (file, n = 12) => { try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n'); } catch { return ''; } };

(async () => {
  const started = Date.now();
  console.log(`Journaux : ${TMP}`);
  const fakes = [];
  if (selected.some((s) => s.server)) {
    fakes.push(start(['node', 'scripts/fake-traccar.js'], { FAKE_TRACCAR_PORT: String(FAKES.traccar) }, path.join(TMP, 'fake-traccar.log')));
    fakes.push(start(['node', 'scripts/fake-osrm.js'], { PORT: String(FAKES.osrm) }, path.join(TMP, 'fake-osrm.log')));
    fakes.push(start(['node', 'scripts/fake-geocoder.js'], { PORT: String(FAKES.geocoder) }, path.join(TMP, 'fake-geocoder.log')));
    await sleep(800);
  }
  const failed = [];
  for (const suite of selected) {
    const log = path.join(TMP, `${suite.name}.log`);
    const t0 = Date.now();
    let code;
    let server = null;
    if (suite.server) {
      await resetDb();
      const serverLog = path.join(TMP, `${suite.name}.server.log`);
      server = start(['node', 'server.js'], { ...BASE_ENV, ...suite.env }, serverLog);
      if (!(await waitHealthy(`${BASE}/health`))) {
        code = 'serveur';
        fs.appendFileSync(log, `Le serveur n'a pas démarré :\n${tail(serverLog, 30)}\n`);
      }
    }
    if (code === undefined) code = await run(suite.cmd, { ...BASE_ENV, ...(suite.env || {}) }, log, suite.server ? 300000 : 120000);
    await stop(server);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (code === 0) console.log(`PASS ${suite.name} (${secs} s)`);
    else {
      failed.push(suite.name);
      console.log(`FAIL ${suite.name} (${secs} s, code ${code})\n${tail(log).replace(/^/gm, '     ')}`);
    }
  }
  for (const f of fakes) await stop(f);
  const total = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n${selected.length - failed.length}/${selected.length} suites réussies en ${total} min.${failed.length ? ` Échecs : ${failed.join(', ')}` : ''}`);
  process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
  console.error(error);
  for (const c of children) c.kill('SIGKILL');
  process.exit(1);
});
process.on('SIGINT', () => { for (const c of children) c.kill('SIGKILL'); process.exit(130); });
