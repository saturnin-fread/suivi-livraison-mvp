// Migrations numérotées : application unique, ordre, échec annulé proprement,
// alerte si un fichier déjà appliqué a changé. Utilise un schéma PostgreSQL
// jetable pour ne rien toucher d'autre.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const { runMigrations, listMigrations } = require('../server/core/migrate');

(async () => {
  const schema = `mig_test_${Date.now().toString(36)}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traxo-mig-'));
  const warnings = [];
  const log = { log() {}, warn: (m) => warnings.push(m) };
  try {
    // Les vraies migrations du dépôt sont bien formées et numérotées sans doublon.
    const real = listMigrations();
    assert.ok(real.length >= 2 && real[0].file === '0001_baseline.sql', 'migrations du dépôt listées');

    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE t (id INT);');
    fs.writeFileSync(path.join(dir, '0002_b.sql'), 'INSERT INTO t VALUES (1);');
    let r = await runMigrations(pool, { dir, log });
    assert.deepStrictEqual(r.applied, ['0001_a.sql', '0002_b.sql'], 'appliquées dans l’ordre');
    r = await runMigrations(pool, { dir, log });
    assert.deepStrictEqual(r.applied, [], 'rien de rejoué au second démarrage');
    assert.strictEqual((await pool.query('SELECT count(*)::int n FROM t')).rows[0].n, 1, 'données insérées une seule fois');

    // Une migration en échec est annulée entièrement et bloque le démarrage.
    fs.writeFileSync(path.join(dir, '0003_c.sql'), 'INSERT INTO t VALUES (2); SELECT * FROM table_inexistante;');
    await assert.rejects(() => runMigrations(pool, { dir, log }), /0003_c\.sql/);
    assert.strictEqual((await pool.query('SELECT count(*)::int n FROM t')).rows[0].n, 1, 'échec : rien n’est appliqué à moitié');
    assert.ok(!(await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '0003'`)).rows[0], 'échec non enregistré');
    fs.writeFileSync(path.join(dir, '0003_c.sql'), 'INSERT INTO t VALUES (2);');
    r = await runMigrations(pool, { dir, log });
    assert.deepStrictEqual(r.applied, ['0003_c.sql'], 'corrigée, elle passe');

    // Fichier déjà appliqué modifié : alerte, sans bloquer.
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE t (id BIGINT);');
    await runMigrations(pool, { dir, log });
    assert.ok(warnings.some((w) => /0001_a\.sql/.test(w)), 'modification signalée');

    // Deux numéros identiques : refusé.
    fs.writeFileSync(path.join(dir, '0003_d.sql'), 'SELECT 1;');
    assert.throws(() => listMigrations(dir), /0003/);
    console.log('migrate-test: OK');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
