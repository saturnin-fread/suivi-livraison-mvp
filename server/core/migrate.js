// Migrations SQL numérotées (server/migrations/NNNN_nom.sql).
// Chaque fichier s'applique une seule fois, dans sa propre transaction, et
// laisse une trace dans schema_migrations. Un verrou consultatif empêche deux
// instances de migrer en même temps (déploiement avec plusieurs réplicas).
// Règle : on n'édite jamais une migration déjà appliquée, on en ajoute une.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const LOCK_KEY = 7302100418;
const FILE_RE = /^(\d{4})_[a-z0-9_-]+\.sql$/;

function listMigrations(dir = MIGRATIONS_DIR) {
  const files = fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
  const seen = new Set();
  return files.map((file) => {
    const version = file.slice(0, 4);
    if (seen.has(version)) throw new Error(`Deux migrations portent le numéro ${version}.`);
    seen.add(version);
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    return { version, file, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
  });
}

async function runMigrations(pool, { dir = MIGRATIONS_DIR, log = console } = {}) {
  if (!pool) return { applied: [], skipped: [] };
  const migrations = listMigrations(dir);
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        file TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const done = new Map((await client.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum]));
    for (const m of migrations) {
      if (done.has(m.version)) {
        // Fichier modifié après coup : on le signale sans bloquer le démarrage.
        if (done.get(m.version) !== m.checksum) log.warn(`Migration ${m.file} modifiée après son application : ajoutez plutôt une nouvelle migration.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, file, checksum) VALUES ($1, $2, $3)', [m.version, m.file, m.checksum]);
        await client.query('COMMIT');
        applied.push(m.file);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw Object.assign(new Error(`Migration ${m.file} : ${error.message}`), { cause: error });
      }
    }
    if (applied.length) log.log(`Migrations appliquées : ${applied.join(', ')}`);
    return { applied };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { runMigrations, listMigrations, MIGRATIONS_DIR };
