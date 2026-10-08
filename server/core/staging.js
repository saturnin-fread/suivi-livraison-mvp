// Environnement de recette (staging), isolé de la production.
//
// Tout ce module est inactif ailleurs que dans un environnement Railway nommé
// exactement « staging » (RAILWAY_ENVIRONMENT_NAME, fourni par Railway). En
// production, aucune de ces fonctions ne change le comportement.
//
// En staging :
// - toutes les réponses portent X-Robots-Tag: noindex et /robots.txt interdit
//   l'indexation ;
// - STAGING_RATE_LIMITS=off désactive les limites anti-abus (tests automatisés) ;
// - STAGING_SEED=on crée au démarrage des comptes et des données fictives.
//   Les mots de passe viennent des variables Railway (jamais du dépôt) ; un
//   compte dont la variable manque n'est pas créé.
const crypto = require('crypto');

const isStaging = (env = process.env) => env.RAILWAY_ENVIRONMENT_NAME === 'staging';
const rateLimitsRelaxed = (env = process.env) => isStaging(env) && env.STAGING_RATE_LIMITS === 'off';

function installStagingGuards(app, env = process.env) {
  if (!isStaging(env)) return false;
  app.use((_req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow, noarchive'); next(); });
  app.get('/robots.txt', (_req, res) => res.type('text/plain').set('Cache-Control', 'no-store').send('User-agent: *\nDisallow: /\n'));
  return true;
}

// Domaine réservé (RFC 2606) : aucune adresse de test ne peut recevoir d'e-mail.
const DOMAIN = 'staging-traxo.test';
const ORGS = [
  { key: 'A', slug: 'chicago-consulting-group', name: 'Chicago Consulting Group' }, // espace amorcé par ADMIN_USER
  { key: 'B', slug: 'staging-org-b', name: 'Livraisons Ganhi (staging B)' },
  { key: 'T', slug: 'staging-equipe-traxo', name: 'Équipe TRAXO (staging)' },
];
const ACCOUNTS = [
  { org: 'A', role: 'manager', email: `manager-a@${DOMAIN}`, name: 'Responsable A', passwordVar: 'STAGING_PASSWORD_MANAGER_A' },
  { org: 'A', role: 'operator', email: `operator-a@${DOMAIN}`, name: 'Opérateur A', passwordVar: 'STAGING_PASSWORD_OPERATOR_A' },
  { org: 'A', role: 'viewer', email: `viewer-a@${DOMAIN}`, name: 'Lecture seule A', passwordVar: 'STAGING_PASSWORD_VIEWER_A' },
  { org: 'B', role: 'owner', email: `owner-b@${DOMAIN}`, name: 'Propriétaire B', passwordVar: 'STAGING_PASSWORD_OWNER_B' },
  { org: 'B', role: 'operator', email: `operator-b@${DOMAIN}`, name: 'Opérateur B', passwordVar: 'STAGING_PASSWORD_OPERATOR_B' },
];

async function upsertUser(client, hashPassword, { email, name, password, platformAdmin = false }) {
  const salt = crypto.randomBytes(16).toString('hex');
  return (await client.query(
    `INSERT INTO users (email, display_name, password_salt, password_hash, is_platform_admin)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name, password_salt = EXCLUDED.password_salt,
       password_hash = EXCLUDED.password_hash, is_platform_admin = EXCLUDED.is_platform_admin, disabled = FALSE, updated_at = NOW()
     RETURNING id`,
    [email.toLowerCase(), name, salt, hashPassword(password, salt), platformAdmin]
  )).rows[0].id;
}

async function credit(client, companyId, amount, note) {
  await client.query('INSERT INTO wallets (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING', [companyId]);
  const w = (await client.query('SELECT balance FROM wallets WHERE company_id = $1 FOR UPDATE', [companyId])).rows[0];
  const after = Number(w.balance) + amount;
  await client.query(`INSERT INTO wallet_entries (company_id, kind, amount, balance_after, note) VALUES ($1, 'adjustment', $2, $3, $4)`, [companyId, amount, after, note]);
  await client.query('UPDATE wallets SET balance = $1, updated_at = NOW() WHERE company_id = $2', [after, companyId]);
}

// Données fictives d'un espace : livreurs, clients, demandes, commandes.
async function seedCompanyData(pool, withCompanyTransaction, companyId, tag) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const drivers = [];
    for (const [i, name] of [`Koffi ${tag}`, `Awa ${tag}`].entries()) {
      const id = (await client.query(
        `INSERT INTO drivers (company_id, name, traccar_unique_id, phone, active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (company_id, traccar_unique_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [companyId, name, `staging-${tag}-${i}`, `+2290197${tag === 'A' ? '10' : '20'}00${i}`]
      )).rows[0].id;
      drivers.push(id);
    }
    const statuses = ['En préparation', 'Confirmée', 'Vers la collecte', 'En livraison', 'Livrée', 'Annulée'];
    for (const [i, status] of statuses.entries()) {
      const order = (await client.query(
        `INSERT INTO orders (company_id, driver_id, customer_name, customer_phone, delivery_address, neighborhood, status, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'normal') RETURNING id`,
        [companyId, drivers[i % 2], `Client fictif ${tag}${i + 1}`, `+2290196${tag === 'A' ? '1' : '2'}0000${i}`,
          `Rue fictive ${i + 1}, Cotonou`, ['Ganhi', 'Akpakpa', 'Cadjehoun'][i % 3], status]
      )).rows[0];
      const year = new Date().getFullYear();
      const seq = (await client.query(
        `INSERT INTO order_reference_counters (company_id, year, last_seq) VALUES ($1, $2, 1)
         ON CONFLICT (company_id, year) DO UPDATE SET last_seq = order_reference_counters.last_seq + 1 RETURNING last_seq`,
        [companyId, year]
      )).rows[0].last_seq;
      await client.query('UPDATE orders SET reference = $1 WHERE id = $2', [`CMD-${year}-${String(seq).padStart(4, '0')}`, order.id]);
    }
    for (let i = 0; i < 2; i += 1) {
      await client.query(
        `INSERT INTO customer_requests (company_id, token, customer_name, customer_phone, neighborhood, landmark)
         VALUES ($1, $2, $3, $4, 'Fidjrossè', 'Près du marché (fictif)')`,
        [companyId, crypto.randomBytes(24).toString('base64url'), `Demande fictive ${tag}${i + 1}`, `+2290195${tag === 'A' ? '1' : '2'}0000${i}`]
      );
    }
    await credit(client, companyId, 5000, 'Crédit de recette (staging)');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await withCompanyTransaction(pool, companyId, async (c) => {
    for (const [i, name] of [`Boutique fictive ${tag}1`, `Restaurant fictif ${tag}2`, `Pharmacie fictive ${tag}3`].entries()) {
      await c.query(
        `INSERT INTO customers (company_id, customer_code, customer_type, display_name, status, main_city, created_at, updated_at)
         VALUES ($1, $2, 'organization', $3, 'active', 'Cotonou', NOW(), NOW()) ON CONFLICT (company_id, customer_code) DO NOTHING`,
        [companyId, `STAGING-${tag}-${i + 1}`, name]
      );
    }
  });
}

// Comptes et données de recette. Idempotent : les comptes sont remis à leur
// mot de passe à chaque démarrage, les données ne sont créées qu'une fois.
async function seedStaging({ pool, env = process.env, hashPassword, withCompanyTransaction, log = console }) {
  if (!isStaging(env) || env.STAGING_SEED !== 'on' || !pool) return null;
  const client = await pool.connect();
  const ids = {};
  const created = [];
  try {
    await client.query('BEGIN');
    for (const org of ORGS) {
      const row = (await client.query(
        `INSERT INTO companies (name, slug, activation_status, onboarding_status) VALUES ($1, $2, 'active', 'done')
         ON CONFLICT (slug) WHERE slug IS NOT NULL DO UPDATE SET activation_status = 'active' RETURNING id`,
        [org.name, org.slug]
      )).rows[0];
      ids[org.key] = row.id;
    }
    for (const account of ACCOUNTS) {
      const password = env[account.passwordVar];
      if (!password) continue;
      const userId = await upsertUser(client, hashPassword, { email: account.email, name: account.name, password });
      await client.query(
        `INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role, suspended_at = NULL, updated_at = NOW()`,
        [ids[account.org], userId, account.role]
      );
      created.push(`${account.email} (${account.role}, espace ${account.org})`);
    }
    // L'administrateur plateforme (amorcé par PLATFORM_ADMIN_USER) accède aux
    // outils TRAXO de /app via un espace dédié.
    if (env.PLATFORM_ADMIN_USER) {
      const admin = (await client.query('SELECT id FROM users WHERE email = $1', [String(env.PLATFORM_ADMIN_USER).toLowerCase()])).rows[0];
      if (admin) {
        await client.query(
          `INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT (company_id, user_id) DO NOTHING`,
          [ids.T, admin.id]
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  for (const key of ['A', 'B']) {
    const has = (await pool.query(`SELECT 1 FROM drivers WHERE company_id = $1 AND traccar_unique_id = $2`, [ids[key], `staging-${key}-0`])).rows[0];
    if (!has) await seedCompanyData(pool, withCompanyTransaction, ids[key], key);
  }
  log.log(`Staging : ${created.length} comptes de recette prêts, espaces ${ORGS.map((o) => `${o.key}=#${ids[o.key]}`).join(', ')}.`);
  return { ids, accounts: created };
}

module.exports = { isStaging, rateLimitsRelaxed, installStagingGuards, seedStaging, ACCOUNTS, ORGS, DOMAIN };
