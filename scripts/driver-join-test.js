// Livreurs : profil, invitation par QR, vérification, usage unique, un seul
// téléphone, permissions, suspension et places du mois (anti-partage).
// Avec WHATSAPP_FAKE=outbox et EMAIL_OUTBOX_DIR, la vérification passe par un
// code WhatsApp simulé ; sinon, le QR montré en personne fait foi.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const outbox = process.env.WHATSAPP_FAKE === 'outbox' ? process.env.EMAIL_OUTBOX_DIR : null;
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
async function call(method, url, { cookie, body } = {}) {
  const res = await fetch(`${base}${url}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { res, status: res.status, data: await res.json().catch(() => ({})) };
}
// Le message part en différé (file d'envoi WhatsApp) : on attend son arrivée.
async function lastWhatsappCode(digits, since, timeoutMs = 20000) {
  if (!outbox) return null;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const files = fs.existsSync(outbox) ? fs.readdirSync(outbox).filter((f) => f.endsWith('-wa.json')).sort() : [];
    for (let i = files.length - 1; i >= 0; i -= 1) {
      const msg = JSON.parse(fs.readFileSync(path.join(outbox, files[i]), 'utf8'));
      if ((msg.at || 0) >= since && String(msg.whatsapp).endsWith(digits.slice(-8))) return (/\*(\d{6})\*/.exec(msg.text) || [])[1] || null;
    }
    await new Promise((resolve) => { setTimeout(resolve, 200); });
  }
  return null;
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const login = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }) });
  const staff = cookieOf(login, 'delivery_session');
  assert.ok(staff, 'connexion équipe');
  const marker = Date.now().toString(36);
  const rand8 = () => `97${String(Math.floor(100000 + Math.random() * 899999))}`; // 0197… : préfixe mobile valide
  const phone = `01${rand8()}`;
  const created = [];
  try {
    const cid = (await pool.query("SELECT company_id FROM company_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1", [process.env.ADMIN_USER])).rows[0].company_id;
    const seats = async () => Number((await pool.query(`SELECT COUNT(*)::int AS n FROM driver_seat_usage WHERE company_id = $1 AND month = date_trunc('month', NOW() AT TIME ZONE 'Africa/Porto-Novo')::date`, [cid])).rows[0].n);
    const seatsBefore = await seats();

    // --- Profil -------------------------------------------------------------
    let r = await call('POST', '/api/app/drivers', { cookie: staff, body: { name: `Marc ${marker}` } });
    assert.strictEqual(r.status, 400, 'téléphone obligatoire');
    assert.strictEqual(r.data.field, 'phone');
    r = await call('POST', '/api/app/drivers', { cookie: staff, body: { name: `Marc ${marker}`, phone: '12', phoneCountry: 'BJ' } });
    assert.strictEqual(r.status, 400, 'numéro invalide refusé');
    r = await call('POST', '/api/app/drivers', { cookie: staff, body: { name: `Marc Ahounou ${marker}`, phone, phoneCountry: 'BJ', zone: 'Akpakpa', team: 'Équipe Est', plate: 'AB 1234', capacity: 8 } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const driverId = r.data.id;
    created.push(driverId);
    assert.match(r.data.code, /^LIV-\d{3,}$/, 'identifiant livreur attribué');
    assert.strictEqual(await seats(), seatsBefore + 1, 'une place comptée');

    r = await call('POST', '/api/app/drivers', { cookie: staff, body: { name: `Doublon ${marker}`, phone: `+229 ${phone}` } });
    assert.strictEqual(r.status, 409, 'même numéro refusé');
    assert.strictEqual(String(r.data.driverId), String(driverId), 'le doublon pointe vers le profil existant');

    let list = (await call('GET', '/api/app/drivers', { cookie: staff })).data;
    let me = list.find((d) => d.id === driverId);
    assert.deepStrictEqual([me.accessState, me.zone, me.team, me.plate, me.canContact], ['none', 'Akpakpa', 'Équipe Est', 'AB 1234', true]);

    // --- Invitation -----------------------------------------------------------
    r = await call('POST', `/api/app/drivers/${driverId}/invitation`, { cookie: staff, body: {} });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const inv1 = r.data;
    assert.match(inv1.code, /^TX-[A-Z0-9]{8}$/);
    assert.ok(inv1.path.startsWith('/rejoindre/'));
    const token1 = inv1.path.split('/').pop();
    list = (await call('GET', '/api/app/drivers', { cookie: staff })).data;
    assert.strictEqual(list.find((d) => d.id === driverId).accessState, 'invited');

    r = await call('GET', `/api/public/driver-invitations/${token1}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.driver.firstName, 'Marc');
    assert.strictEqual(r.data.driver.zone, 'Akpakpa');
    assert.ok(!JSON.stringify(r.data).includes(phone), 'numéro complet jamais exposé');
    const verification = r.data.verification;
    assert.strictEqual(verification, outbox ? 'whatsapp' : 'in_person');
    r = await call('GET', `/api/public/driver-invitations/${inv1.code.toLowerCase()}`);
    assert.strictEqual(r.status, 200, 'le code de secours fonctionne (casse indifférente)');
    r = await call('GET', '/api/public/driver-invitations/TX-ZZZZZZZZ');
    assert.strictEqual(r.status, 404);
    const page = await fetch(`${base}/rejoindre/${token1}`);
    assert.strictEqual(page.status, 200);
    assert.ok((await page.text()).includes('Rejoindre votre équipe'), 'page Rejoindre servie');

    // Une seule invitation valable : la deuxième remplace la première.
    r = await call('POST', `/api/app/drivers/${driverId}/invitation`, { cookie: staff, body: {} });
    const inv2 = r.data;
    r = await call('GET', `/api/public/driver-invitations/${token1}`);
    assert.strictEqual(r.status, 410, 'ancienne invitation remplacée');
    assert.strictEqual(r.data.state, 'revoked');
    const token2 = inv2.path.split('/').pop();

    // --- Rejoindre ------------------------------------------------------------
    async function join(token, digits) {
      if (verification === 'whatsapp') {
        const since = Date.now();
        let s = await call('POST', `/api/public/driver-invitations/${token}/send-code`, { body: {} });
        assert.strictEqual(s.status, 200, JSON.stringify(s.data));
        assert.strictEqual(s.data.sent, true);
        s = await call('POST', `/api/public/driver-invitations/${token}/send-code`, { body: {} });
        assert.strictEqual(s.status, 429, 'renvoi limité (1 min après le premier code)');
        assert.ok(s.data.resendIn > 50 && s.data.resendIn <= 60, 'délai de renvoi indiqué');
        const code = await lastWhatsappCode(digits, since);
        assert.ok(code, 'code WhatsApp reçu');
        const bad = code === '000000' ? '111111' : '000000';
        s = await call('POST', `/api/public/driver-invitations/${token}/accept`, { body: { code: bad } });
        assert.strictEqual(s.status, 400, 'mauvais code refusé');
        assert.ok(Number.isInteger(s.data.attemptsLeft) && s.data.attemptsLeft < 5, 'essais restants décomptés');
        return call('POST', `/api/public/driver-invitations/${token}/accept`, { body: { code } });
      }
      return call('POST', `/api/public/driver-invitations/${token}/accept`, { body: {} });
    }
    r = await join(token2, phone);
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    assert.strictEqual(r.data.redirect, '/driver');
    const phoneA = cookieOf(r.res, 'delivery_session');
    assert.ok(phoneA, 'session ouverte sur le téléphone');
    r = await call('GET', '/api/driver/context', { cookie: phoneA });
    assert.strictEqual(r.status, 200, 'le livreur accède à son espace');
    r = await call('GET', '/api/app/drivers', { cookie: phoneA });
    assert.ok([401, 403].includes(r.status), 'pas d’accès à la gestion de l’entreprise');
    r = await call('POST', `/api/public/driver-invitations/${token2}/accept`, { body: { code: '123456' } });
    assert.strictEqual(r.status, 410, 'invitation à usage unique');
    assert.strictEqual(r.data.state, 'used');
    const session = (await pool.query(`SELECT s.expires_at - s.created_at AS d FROM app_sessions s JOIN company_memberships m ON m.user_id = s.user_id WHERE m.driver_id = $1 ORDER BY s.created_at DESC LIMIT 1`, [driverId])).rows[0];
    assert.ok(session.d.days >= 89, 'session de 90 jours');
    list = (await call('GET', '/api/app/drivers', { cookie: staff })).data;
    me = list.find((d) => d.id === driverId);
    assert.strictEqual(me.accessState, 'active');
    assert.ok(me.device && me.device.since, 'téléphone associé visible');

    // Un seul téléphone : un nouveau QR (changement de téléphone) déconnecte l'ancien.
    r = await call('POST', `/api/app/drivers/${driverId}/invitation`, { cookie: staff, body: { replacement: true } });
    assert.strictEqual(r.status, 201);
    r = await call('GET', '/api/driver/context', { cookie: phoneA });
    assert.strictEqual(r.status, 200, 'l’ancien téléphone reste connecté tant que le nouveau n’a pas rejoint');
    const inv3 = (await pool.query('SELECT id FROM driver_invitations WHERE driver_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [driverId])).rows;
    assert.strictEqual(inv3.length, 1, 'une seule invitation en attente');
    // Le jeton n'est stocké qu'haché : on en recrée un dont on garde la réponse.
    const inv4 = (await call('POST', `/api/app/drivers/${driverId}/invitation`, { cookie: staff, body: { replacement: true } })).data;
    const pub = (await call('GET', `/api/public/driver-invitations/${inv4.path.split('/').pop()}`)).data;
    assert.strictEqual(pub.replacement, true, 'le livreur est prévenu du changement de téléphone');
    r = await call('POST', `/api/public/driver-invitations/${inv4.path.split('/').pop()}/accept`, { body: verification === 'whatsapp' ? { code: '' } : {} });
    if (verification === 'whatsapp') {
      assert.strictEqual(r.status, 400, 'code requis');
      // Le renvoi est limité : on remet l'horloge de l'envoi pour ce test.
      await pool.query('UPDATE driver_invitations SET verify_sent_at = NULL WHERE driver_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [driverId]);
      r = await join(inv4.path.split('/').pop(), phone);
    }
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const phoneB = cookieOf(r.res, 'delivery_session');
    r = await call('GET', '/api/driver/context', { cookie: phoneA });
    assert.strictEqual(r.status, 401, 'ancien téléphone déconnecté');
    r = await call('GET', '/api/driver/context', { cookie: phoneB });
    assert.strictEqual(r.status, 200, 'nouveau téléphone connecté');
    assert.strictEqual(await seats(), seatsBefore + 1, 'même personne : toujours une seule place');

    // --- Permissions ------------------------------------------------------------
    r = await call('POST', '/api/app/orders', { cookie: staff, body: { customerName: `Awa ${marker}`, customerPhone: '01 97 44 55 66', customerPhoneCountry: 'BJ', neighborhood: 'Cadjèhoun', driverId } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const orderId = r.data.orderId;
    let orders = (await call('GET', '/api/driver/orders', { cookie: phoneB })).data;
    assert.ok(orders.find((o) => o.id === orderId).customer_phone, 'numéro visible par défaut');
    r = await call('PATCH', `/api/app/drivers/${driverId}`, { cookie: staff, body: { canContact: false, canReportIncident: false } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    orders = (await call('GET', '/api/driver/orders', { cookie: phoneB })).data;
    assert.strictEqual(orders.find((o) => o.id === orderId).customer_phone, null, 'numéro masqué sans permission');
    r = await call('GET', `/api/driver/orders/${orderId}`, { cookie: phoneB });
    assert.strictEqual(r.data.customer_phone ?? null, null);
    assert.strictEqual(r.data.canContact, false);
    r = await call('POST', `/api/driver/orders/${orderId}/incidents`, { cookie: phoneB, body: { category: 'customer_absent', description: 'Personne' } });
    assert.strictEqual(r.status, 403, 'signalement d’incident désactivé');
    await call('PATCH', `/api/app/drivers/${driverId}`, { cookie: staff, body: { canContact: true, canReportIncident: true } });

    // --- Suspension ----------------------------------------------------------------
    r = await call('POST', `/api/app/drivers/${driverId}/suspend`, { cookie: staff, body: {} });
    assert.strictEqual(r.status, 409, 'impossible de suspendre avec des livraisons en cours');
    r = await call('POST', `/api/app/orders/${orderId}/transition`, { cookie: staff, body: { toStatus: 'Annulée', idempotencyKey: `dj-${marker}-cancel`, reason: 'Annulation de test' } });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    r = await call('POST', `/api/app/drivers/${driverId}/suspend`, { cookie: staff, body: {} });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    r = await call('GET', '/api/driver/context', { cookie: phoneB });
    assert.strictEqual(r.status, 401, 'suspendu : déconnecté');
    r = await call('POST', `/api/app/drivers/${driverId}/invitation`, { cookie: staff, body: {} });
    assert.strictEqual(r.status, 409, 'pas d’invitation pour un profil suspendu');
    list = (await call('GET', '/api/app/drivers', { cookie: staff })).data;
    assert.strictEqual(list.find((d) => d.id === driverId).accessState, 'suspended');
    r = await call('POST', `/api/app/drivers/${driverId}/reactivate`, { cookie: staff, body: {} });
    assert.strictEqual(r.status, 200);

    // --- Anti-partage d'une place ---------------------------------------------------
    // Changer le numéro = une autre personne : l'accès est coupé et une place s'ajoute.
    const other = `01${rand8()}`;
    r = await call('PATCH', `/api/app/drivers/${driverId}`, { cookie: staff, body: { phone: other, phoneCountry: 'BJ' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.accessReset, true, 'accès coupé au changement de numéro');
    assert.strictEqual(await seats(), seatsBefore + 2, 'nouveau numéro = nouvelle place');
    // Retirer puis recréer la même personne ne libère pas de place.
    r = await call('DELETE', `/api/app/drivers/${driverId}`, { cookie: staff });
    assert.strictEqual(r.status, 200);
    r = await call('POST', '/api/app/drivers', { cookie: staff, body: { name: `Marc revenu ${marker}`, phone: other, phoneCountry: 'BJ' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    created.push(r.data.id);
    assert.strictEqual(await seats(), seatsBefore + 2, 'même personne recréée : pas de place en plus, pas de place libérée');
    const billing = (await call('GET', '/api/app/billing/plans', { cookie: staff })).data;
    assert.ok(billing.seatsThisMonth >= seatsBefore + 2, 'la facturation compte les places du mois');

    // Trop de mauvais codes : invitation annulée.
    if (verification === 'whatsapp') {
      const inv5 = (await call('POST', `/api/app/drivers/${r.data.id}/invitation`, { cookie: staff, body: {} })).data;
      const t5 = inv5.path.split('/').pop();
      await call('POST', `/api/public/driver-invitations/${t5}/send-code`, { body: {} });
      let last;
      for (let i = 0; i < 5; i += 1) last = await call('POST', `/api/public/driver-invitations/${t5}/accept`, { body: { code: '999999' } });
      assert.strictEqual(last.status, 423, 'cinq essais : invitation annulée');
    }

    console.log(`Livreurs : profil, invitation (${verification}), usage unique, un seul téléphone, permissions, suspension, places du mois OK`);
  } finally {
    for (const id of created) {
      await pool.query('DELETE FROM app_sessions s USING company_memberships m WHERE m.user_id = s.user_id AND m.driver_id = $1', [id]).catch(() => {});
    }
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
