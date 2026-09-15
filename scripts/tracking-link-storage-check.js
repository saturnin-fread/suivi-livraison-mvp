const { Pool } = require('pg');

function businessDatabaseUrl() {
  const explicit = process.env.BUSINESS_DATABASE_URL || process.env.DATABASE_URL;
  if (explicit) {
    const url = new URL(explicit);
    if (url.pathname !== '/delivery') throw new Error('Le diagnostic est limité à la base delivery.');
    return url.toString();
  }
  if (!process.env.DATABASE_PUBLIC_URL) throw new Error('Aucune URL PostgreSQL disponible.');
  const url = new URL(process.env.DATABASE_PUBLIC_URL);
  url.pathname = '/delivery';
  return url.toString();
}

async function run() {
  const connectionString = businessDatabaseUrl();
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE token IS NOT NULL)::int AS plaintext,
        COUNT(*) FILTER (WHERE token_hash IS NOT NULL AND token_ciphertext IS NOT NULL)::int AS protected,
        COUNT(*) FILTER (WHERE token_hash IS NULL OR token_ciphertext IS NULL)::int AS unprotected,
        COUNT(*) FILTER (WHERE expires_at IS NULL)::int AS missing_expiry,
        COUNT(*) FILTER (WHERE company_id IS NULL)::int AS missing_company
      FROM tracking_links
    `);
    console.log(JSON.stringify(result.rows[0]));
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error(`Diagnostic impossible : ${error.message}`);
  process.exitCode = 1;
});
