const { Pool } = require('pg');
const crypto = require('node:crypto');

const nativeFetch = global.fetch;
global.fetch = (url, options = {}) => nativeFetch(url, {
  ...options,
  signal: options.signal || AbortSignal.timeout(30000),
});

const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const email = process.env.ADMIN_USER;
const password = process.env.ADMIN_PASSWORD;

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(response) {
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function verifyPublicTrackingBrowser(path) {
  if (process.env.RUN_BROWSER_TEST !== '1') return;
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_EXECUTABLE || undefined,
  });
  try {
    const browserContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      geolocation: { latitude: 6.381, longitude: 2.441 },
      permissions: ['geolocation'],
    });
    const page = await browserContext.newPage();
    const outgoing = [];
    page.on('request', (request) => outgoing.push({ method: request.method(), url: request.url() }));
    const response = await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
    ensure(response?.headers()['referrer-policy'] === 'origin', 'La page publique doit limiter le référent à l’origine sans exposer le token.');
    await page.locator('#statusText').getByText('Commande validée', { exact: false }).waitFor({ state: 'visible' });
    await page.locator('#zoomIn').waitFor({ state: 'visible' });
    await page.locator('#map .trk-dest').waitFor({ state: 'visible' });
    ensure(await page.locator('#map .trk-drv').count() === 0, 'Le livreur ne doit pas apparaître sur la carte avant son départ.');
    ensure(!(await page.locator('#recenter').isDisabled()), 'Le recentrage doit fonctionner sur la destination du client.');
    await page.locator('#panelToggle').click();
    ensure(await page.locator('#panelToggle').getAttribute('aria-expanded') === 'false', 'Le panneau de suivi doit être réductible.');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    ensure(!overflow, 'Le suivi public déborde horizontalement sur mobile.');
    ensure(!outgoing.some((request) => request.method !== 'GET' && request.url.includes('/api/tracking/')),
      'La page de suivi ne doit jamais envoyer de données à l’API de suivi.');
  } finally {
    await browser.close();
  }
}

async function verifyTrackingLinkControlsBrowser(cookie, orderId) {
  if (process.env.RUN_BROWSER_TEST !== '1') return;
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_EXECUTABLE || undefined,
  });
  try {
    const browserContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const [name, value] = cookie.split('=');
    await browserContext.addCookies([{ name, value, url: baseUrl }]);
    const page = await browserContext.newPage();
    await page.goto(`${baseUrl}/app/commandes/${encodeURIComponent(orderId)}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Lien de suivi client' }).waitFor({ state: 'visible' });
    ensure(await page.getByRole('button', { name: 'Afficher et copier' }).isVisible(),
      'La révélation unitaire du lien doit être disponible dans la commande.');
    await page.getByRole('button', { name: 'Afficher et copier' }).click();
    await page.locator('#trackingLinkResult .notice.success').waitFor({ state: 'visible' });
    ensure(await page.locator('#trackingLinkResult a[href*="/suivi/"]').count() === 1,
      'Le lien ne doit apparaître qu’après l’action explicite de l’utilisateur.');
    ensure(!await page.locator('body').evaluate((body) => body.textContent.includes('token_ciphertext')),
      'Aucun détail de stockage du jeton ne doit apparaître dans l’interface.');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    ensure(!overflow, 'La gestion du lien de suivi déborde horizontalement sur mobile.');
  } finally {
    await browser.close();
  }
}

async function run() {
  ensure(email && password, 'ADMIN_USER et ADMIN_PASSWORD sont requis.');
  const health = await json(await fetch(`${baseUrl}/health`));
  ensure(health.response.ok && health.payload.status === 'ok', 'Le contrôle de santé de l’application a échoué.');
  let requestToken;
  let requestId;
  let orderId;
  let pool;
  let operatorUserId;
  let operatorSessionHash;
  let operatorCookie;
  let foreignCompanyId;
  let foreignSessionHash;
  let foreignCookie;

  try {
    const login = await fetch(`${baseUrl}/app/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user: email, password }),
    });
    ensure(login.status === 302, `Connexion attendue en 302, reçue ${login.status}.`);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    ensure(cookie, 'Cookie de session absent.');

    const context = await json(await fetch(`${baseUrl}/api/app/context`, { headers: { Cookie: cookie } }));
    ensure(context.response.ok && context.payload.company?.id, 'Contexte entreprise indisponible.');

    const platform = await fetch(`${baseUrl}/admin`, { headers: { Cookie: cookie }, redirect: 'manual' });
    ensure(platform.status === 302 && platform.headers.get('location') === '/admin/login', 'Séparation /app et /admin invalide.');

    const created = await json(await fetch(`${baseUrl}/api/app/request-links`, {
      method: 'POST', headers: { Cookie: cookie },
    }));
    ensure(created.response.status === 201 && created.payload.token, 'Création du formulaire impossible.');
    requestToken = created.payload.token;

    if (process.env.DATABASE_URL) {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
      });
      const operator = await pool.query(
        `INSERT INTO users (email, display_name, password_salt, password_hash)
         VALUES ($1, 'Opérateur test', 'test', $2) RETURNING id`,
        [`smoke-operator-${requestToken}@example.invalid`, '0'.repeat(128)]
      );
      operatorUserId = operator.rows[0].id;
      await pool.query(
        `INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, 'operator')`,
        [context.payload.company.id, operatorUserId]
      );
      const operatorSessionToken = crypto.randomBytes(32).toString('base64url');
      operatorSessionHash = crypto.createHash('sha256').update(operatorSessionToken).digest('hex');
      await pool.query(
        `INSERT INTO app_sessions (token_hash, user_id, company_id, scope, expires_at)
         VALUES ($1, $2, $3, 'company', NOW() + INTERVAL '15 minutes')`,
        [operatorSessionHash, operatorUserId, context.payload.company.id]
      );
      operatorCookie = `delivery_session=${operatorSessionToken}`;
      const operatorContext = await json(await fetch(`${baseUrl}/api/app/context`, { headers: { Cookie: operatorCookie } }));
      ensure(
        operatorContext.response.ok && operatorContext.payload.user?.role === 'operator',
        `Session opérateur invalide (statut ${operatorContext.response.status}, réponse ${JSON.stringify(operatorContext.payload)}).`
      );
      const foreignCompany = await pool.query(
        `INSERT INTO companies (name, slug) VALUES ('Entreprise cloisonnement test', $1) RETURNING id`,
        [`smoke-foreign-${requestToken}`]
      );
      foreignCompanyId = foreignCompany.rows[0].id;
      await pool.query(
        `INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [foreignCompanyId, context.payload.user.id]
      );
      const foreignSessionToken = crypto.randomBytes(32).toString('base64url');
      foreignSessionHash = crypto.createHash('sha256').update(foreignSessionToken).digest('hex');
      await pool.query(
        `INSERT INTO app_sessions (token_hash, user_id, company_id, scope, expires_at)
         VALUES ($1, $2, $3, 'company', NOW() + INTERVAL '15 minutes')`,
        [foreignSessionHash, context.payload.user.id, foreignCompanyId]
      );
      foreignCookie = `delivery_session=${foreignSessionToken}`;
    }

    const submitted = await json(await fetch(`${baseUrl}/api/public/requests/${encodeURIComponent(requestToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'Test automatique',
        customerPhone: '0197123456',
        customerPhoneCountry: 'BJ',
        neighborhood: 'Zone de test',
        requestedTime: '15 h - 17 h',
        landmark: 'Repère de test',
        notes: 'Donnée temporaire supprimée à la fin du test',
        locationLat: 6.37,
        locationLng: 2.43,
        locationAccuracy: 12,
      }),
    }));
    ensure(submitted.response.ok && submitted.payload.redirect, 'Soumission publique impossible.');
    ensure(!submitted.payload.redirect.includes('edit='), 'Aucun secret ne doit figurer dans l’URL de confirmation.');
    // L'accès à la demande est lié à l'appareil : cookie HttpOnly posé à l'envoi.
    const requestCookie = submitted.response.headers.get('set-cookie')?.split(';')[0];
    ensure(requestCookie && requestCookie.startsWith('traxo_req='), 'Cookie d’appareil absent après l’envoi.');

    const details = await json(await fetch(`${baseUrl}/api/public/requests/${encodeURIComponent(requestToken)}`, { headers: { Cookie: requestCookie } }));
    ensure(details.response.ok && details.payload.canEdit, 'La demande soumise devrait être modifiable.');

    const updated = await json(await fetch(`${baseUrl}/api/public/requests/${encodeURIComponent(requestToken)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: requestCookie },
      body: JSON.stringify({
        version: details.payload.version,
        customerName: 'Test automatique modifié',
        customerPhone: '0197123456',
        customerPhoneCountry: 'BJ',
        neighborhood: 'Zone de test',
        requestedTime: '16 h - 18 h',
        landmark: 'Repère corrigé',
        notes: 'Donnée temporaire',
        locationLat: 6.38,
        locationLng: 2.44,
        locationAccuracy: 10,
      }),
    }));
    ensure(updated.response.ok, 'Modification client impossible.');

    const list = await json(await fetch(`${baseUrl}/api/app/requests`, { headers: { Cookie: cookie } }));
    const request = list.payload.find((item) => item.token === requestToken);
    ensure(request, 'Demande absente de la file entreprise.');
    requestId = request.id;

    const drivers = await json(await fetch(`${baseUrl}/api/app/drivers`, { headers: { Cookie: cookie } }));
    ensure(drivers.response.ok && Array.isArray(drivers.payload), 'Liste des livreurs indisponible.');
    const driver = drivers.payload.find((item) => item.active && !['off_duty', 'incident', 'inactive'].includes(item.operationalState));
    ensure(driver, 'Aucun livreur utilisable pour convertir la demande.');

    const converted = await json(await fetch(`${baseUrl}/api/app/requests/${requestId}/convert`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverId: driver.id }),
    }));
    ensure(converted.response.status === 201 && converted.payload.orderId && converted.payload.path, 'Conversion en commande impossible.');
    orderId = converted.payload.orderId;

    let publicTrackingPath = converted.payload.path.replace('/suivi/', '/api/tracking/');
    const publicTracking = await json(await fetch(`${baseUrl}${publicTrackingPath}`));
    ensure(publicTracking.response.ok, 'Le suivi public actif doit rester disponible même si le GPS est momentanément indisponible.');
    ensure(publicTracking.payload.orderStatus === 'Confirmée'
      && publicTracking.payload.destination?.latitude === 6.38
      && publicTracking.payload.destination?.longitude === 2.44,
    'Le suivi public ne restitue pas correctement l’état et la destination du colis concerné.');
    ensure(publicTracking.payload.positionVisible === false
      && publicTracking.payload.latitude == null && publicTracking.payload.longitude == null,
    'La position du livreur ne doit pas être exposée avant son départ effectif.');
    ensure(publicTracking.payload.driver?.name === converted.payload.driverName
      && publicTracking.payload.mapConfig?.base?.url,
    'Les informations publiques utiles ou la configuration cartographique sont absentes.');
    const serializedTracking = JSON.stringify(publicTracking.payload);
    ensure(!serializedTracking.includes('traccar_unique_id')
      && !serializedTracking.includes('customerPhone')
      && !serializedTracking.includes('runs')
      && !serializedTracking.includes('stops'),
    'Le suivi public expose des données internes ou d’autres arrêts de tournée.');
    await verifyPublicTrackingBrowser(converted.payload.path);

    const repeated = await json(await fetch(`${baseUrl}/api/app/requests/${requestId}/convert`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverId: driver.id }),
    }));
    ensure(repeated.response.ok && repeated.payload.alreadyConverted && repeated.payload.orderId === orderId, 'La conversion répétée doit rester sans doublon.');

    const orders = await json(await fetch(`${baseUrl}/api/app/orders`, { headers: { Cookie: cookie } }));
    ensure(orders.response.ok && orders.payload.some((item) => item.id === orderId), 'Commande absente de la liste entreprise.');
    const listedOrder = orders.payload.find((item) => item.id === orderId);
    ensure(listedOrder.trackingLink?.state === 'active' && !listedOrder.trackingLink.path
      && !JSON.stringify(listedOrder).includes('tracking_token'),
    'La liste entreprise doit exposer uniquement l’état du lien, jamais le secret ou son chemin.');
    if (foreignCookie) {
      const foreignReveal = await fetch(`${baseUrl}/api/app/orders/${orderId}/tracking-link/reveal`, {
        method: 'POST', headers: { Cookie: foreignCookie },
      });
      const foreignRotate = await fetch(`${baseUrl}/api/app/orders/${orderId}/tracking-link/rotate`, {
        method: 'POST', headers: { Cookie: foreignCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expiresInDays: 7, expectedVersion: listedOrder.trackingLink.version,
          idempotencyKey: `smoke-foreign-rotate-${requestToken}`,
        }),
      });
      const foreignRevoke = await fetch(`${baseUrl}/api/app/orders/${orderId}/tracking-link/revoke`, {
        method: 'POST', headers: { Cookie: foreignCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'Tentative entreprise etrangere', expectedVersion: listedOrder.trackingLink.version,
          idempotencyKey: `smoke-foreign-revoke-${requestToken}`,
        }),
      });
      ensure([foreignReveal.status, foreignRotate.status, foreignRevoke.status].every((status) => status === 404),
        'Une autre entreprise ne doit ni révéler, ni renouveler, ni révoquer ce lien.');
    }
    const revealed = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/tracking-link/reveal`, {
      method: 'POST', headers: { Cookie: cookie },
    }));
    ensure(revealed.response.ok && revealed.payload.trackingLink?.path === converted.payload.path,
      'La révélation unitaire et auditée du lien a échoué.');

    const originalTrackingPath = publicTrackingPath;
    const rotationKey = `smoke-tracking-rotate-${requestToken}`;
    const rotated = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/tracking-link/rotate`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresInDays: 3, expectedVersion: listedOrder.trackingLink.version, idempotencyKey: rotationKey }),
    }));
    ensure(rotated.response.ok && rotated.payload.trackingLink?.path,
      'Le renouvellement du lien de suivi a échoué.');
    publicTrackingPath = rotated.payload.trackingLink.path.replace('/suivi/', '/api/tracking/');
    ensure(publicTrackingPath !== originalTrackingPath, 'La rotation doit produire un nouveau lien.');
    const invalidatedOriginal = await fetch(`${baseUrl}${originalTrackingPath}`);
    ensure(invalidatedOriginal.status === 404, 'L’ancien lien doit être invalidé immédiatement après rotation.');
    const repeatedRotation = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/tracking-link/rotate`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresInDays: 3, expectedVersion: listedOrder.trackingLink.version, idempotencyKey: rotationKey }),
    }));
    ensure(repeatedRotation.response.ok && repeatedRotation.payload.alreadyApplied
      && repeatedRotation.payload.trackingLink.path === rotated.payload.trackingLink.path,
    'La rotation répétée doit rester idempotente.');
    const conflictingRotation = await fetch(`${baseUrl}/api/app/orders/${orderId}/tracking-link/rotate`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresInDays: 7, expectedVersion: listedOrder.trackingLink.version, idempotencyKey: rotationKey }),
    });
    ensure(conflictingRotation.status === 409, 'Une clé de rotation réutilisée avec une autre durée doit être refusée.');
    const staleRotation = await fetch(`${baseUrl}/api/app/orders/${orderId}/tracking-link/rotate`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expiresInDays: 7, expectedVersion: listedOrder.trackingLink.version,
        idempotencyKey: `smoke-tracking-stale-${requestToken}`,
      }),
    });
    ensure(staleRotation.status === 409, 'Une seconde rotation fondée sur une version ancienne doit être refusée.');

    const revocationKey = `smoke-tracking-revoke-${requestToken}`;
    const revoked = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/tracking-link/revoke`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Lien volontairement révoqué pendant le test', expectedVersion: rotated.payload.trackingLink.version, idempotencyKey: revocationKey }),
    }));
    ensure(revoked.response.ok && revoked.payload.trackingLink?.state === 'revoked', 'La révocation du lien a échoué.');
    const invalidatedRotated = await fetch(`${baseUrl}${publicTrackingPath}`);
    ensure(invalidatedRotated.status === 404, 'Un lien révoqué doit être refusé publiquement.');
    const repeatedRevocation = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/tracking-link/revoke`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Lien volontairement révoqué pendant le test', expectedVersion: rotated.payload.trackingLink.version, idempotencyKey: revocationKey }),
    }));
    ensure(repeatedRevocation.response.ok && repeatedRevocation.payload.alreadyApplied,
      'La révocation répétée doit rester idempotente.');

    const reissued = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/tracking-link/rotate`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresInDays: 7, expectedVersion: revoked.payload.trackingLink.version, idempotencyKey: `smoke-tracking-reissue-${requestToken}` }),
    }));
    ensure(reissued.response.ok && reissued.payload.trackingLink?.state === 'active',
      'La réémission après révocation a échoué.');
    publicTrackingPath = reissued.payload.trackingLink.path.replace('/suivi/', '/api/tracking/');
    const reissuedPublicTracking = await fetch(`${baseUrl}${publicTrackingPath}`);
    ensure(reissuedPublicTracking.ok, 'Le nouveau lien réémis doit être utilisable.');
    const replayedOldRevocation = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/tracking-link/revoke`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason: 'Lien volontairement révoqué pendant le test',
        expectedVersion: rotated.payload.trackingLink.version,
        idempotencyKey: revocationKey,
      }),
    }));
    ensure(replayedOldRevocation.response.ok && replayedOldRevocation.payload.alreadyApplied,
      'Le rejeu tardif de l’ancienne révocation doit être reconnu.');
    ensure((await fetch(`${baseUrl}${publicTrackingPath}`)).ok,
      'Le rejeu d’une ancienne révocation ne doit pas désactiver le nouveau lien.');

    const pathBeforeConcurrentRotation = publicTrackingPath;
    const concurrentRotationPayloads = await Promise.all([
      `smoke-tracking-concurrent-a-${requestToken}`,
      `smoke-tracking-concurrent-b-${requestToken}`,
    ].map((idempotencyKey) => fetch(`${baseUrl}/api/app/orders/${orderId}/tracking-link/rotate`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expiresInDays: 7,
        expectedVersion: reissued.payload.trackingLink.version,
        idempotencyKey,
      }),
    }).then(json)));
    const concurrentWinners = concurrentRotationPayloads.filter(({ response }) => response.ok);
    const concurrentLosers = concurrentRotationPayloads.filter(({ response }) => response.status === 409);
    const concurrentWinner = concurrentWinners[0];
    ensure(concurrentWinners.length === 1 && concurrentLosers.length === 1
      && concurrentWinner?.payload.trackingLink?.path,
      'Deux rotations concurrentes doivent produire exactement un succès et un conflit 409.');
    publicTrackingPath = concurrentWinner.payload.trackingLink.path.replace('/suivi/', '/api/tracking/');
    ensure((await fetch(`${baseUrl}${pathBeforeConcurrentRotation}`)).status === 404,
      'Le lien remplacé par la rotation concurrente doit être refusé.');
    ensure((await fetch(`${baseUrl}${publicTrackingPath}`)).ok,
      'Le seul lien issu de la rotation concurrente gagnante doit fonctionner.');
    await verifyTrackingLinkControlsBrowser(cookie, orderId);

    const paymentConfigurationKey = `smoke-payment-configure-${requestToken}`;
    const configuredPayment = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/payment/configure`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedAmountMinor: 5000, currency: 'XOF', idempotencyKey: paymentConfigurationKey }),
    }));
    ensure(configuredPayment.response.status === 201 && configuredPayment.payload.status === 'pending', 'Configuration de l’encaissement impossible.');
    const repeatedConfiguration = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/payment/configure`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedAmountMinor: 5000, currency: 'XOF', idempotencyKey: paymentConfigurationKey }),
    }));
    ensure(repeatedConfiguration.response.ok && repeatedConfiguration.payload.alreadyApplied, 'La configuration financière répétée doit rester sans doublon.');

    const removedPayment = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/payment/remove`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Correction temporaire du test', idempotencyKey: `smoke-payment-remove-${requestToken}` }),
    }));
    ensure(removedPayment.response.ok && removedPayment.payload.status === 'not_required', 'Retrait de l’encaissement impossible.');
    const reconfiguredPayment = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/payment/configure`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedAmountMinor: 5000, currency: 'XOF', idempotencyKey: `smoke-payment-reconfigure-${requestToken}` }),
    }));
    ensure(reconfiguredPayment.response.status === 201 && reconfiguredPayment.payload.status === 'pending', 'Réactivation de l’encaissement impossible.');

    const transition = async (toStatus, suffix, reason = '') => json(await fetch(`${baseUrl}/api/app/orders/${orderId}/transition`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toStatus, reason, idempotencyKey: `smoke-transition-${suffix}-${requestToken}` }),
    }));

    const invalidTransition = await transition('Arrivée', 'invalid');
    ensure(invalidTransition.response.status === 409, 'Une transition incohérente devait être refusée.');

    const concurrentBody = JSON.stringify({
      toStatus: 'Récupérée', reason: '', idempotencyKey: `smoke-transition-concurrent-${requestToken}`,
    });
    const concurrentTransitions = await Promise.all([1, 2].map(async () => json(await fetch(`${baseUrl}/api/app/orders/${orderId}/transition`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: concurrentBody,
    }))));
    ensure(concurrentTransitions.every((item) => item.response.ok && item.payload.status === 'Récupérée'), 'Les répétitions concurrentes doivent produire le même résultat.');
    ensure(concurrentTransitions.some((item) => item.payload.alreadyApplied), 'Une répétition concurrente devait être reconnue sans doublon.');

    for (const [index, status] of ['En tournée', 'En livraison'].entries()) {
      const progressed = await transition(status, `step-${index}`);
      ensure(progressed.response.ok && progressed.payload.status === status, `Transition vers ${status} impossible.`);
    }

    const activePublicTracking = await json(await fetch(`${baseUrl}${publicTrackingPath}`));
    ensure(activePublicTracking.response.ok && activePublicTracking.payload.orderStatus === 'En livraison'
      && activePublicTracking.payload.positionVisible === true,
    'Le suivi GPS public ne s’active pas au départ effectif de la livraison.');
    ensure(!JSON.stringify(activePublicTracking.payload).includes('traccar_unique_id'),
      'Le suivi GPS actif expose un identifiant technique interne.');

    const failedDelivery = await transition('Échec', 'public-tracking-failure', 'Client momentanément injoignable');
    ensure(failedDelivery.response.ok && failedDelivery.payload.status === 'Échec', 'Transition de contrôle vers Échec impossible.');
    const hiddenDuringFailure = await json(await fetch(`${baseUrl}${publicTrackingPath}`));
    ensure(hiddenDuringFailure.response.ok && hiddenDuringFailure.payload.positionVisible === false
      && hiddenDuringFailure.payload.latitude == null && hiddenDuringFailure.payload.longitude == null,
    'La position du livreur doit être masquée pendant un échec de livraison.');
    const resumedDelivery = await transition('En livraison', 'public-tracking-resume');
    ensure(resumedDelivery.response.ok && resumedDelivery.payload.status === 'En livraison', 'Reprise après échec impossible.');

    const collectionKey = `smoke-payment-collect-${requestToken}`;
    const collected = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/payment/collect`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountMinor: 5000, method: 'cash', reference: 'TEST', discrepancyReason: '', idempotencyKey: collectionKey }),
    }));
    ensure(collected.response.status === 201 && collected.payload.status === 'collected', 'Encaissement exact impossible.');
    const repeatedCollection = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/payment/collect`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountMinor: 5000, method: 'cash', reference: 'TEST', discrepancyReason: '', idempotencyKey: collectionKey }),
    }));
    ensure(repeatedCollection.response.ok && repeatedCollection.payload.alreadyApplied, 'L’encaissement répété doit rester sans doublon.');

    const reversed = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/payment/reverse`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Montant saisi pour tester la correction', idempotencyKey: `smoke-payment-reverse-${requestToken}` }),
    }));
    ensure(reversed.response.ok && reversed.payload.status === 'pending', 'Annulation de la saisie financière impossible.');

    const missingDiscrepancyReason = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/payment/collect`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountMinor: 4500, method: 'mobile_money', reference: 'TEST-ECART', discrepancyReason: '', idempotencyKey: `smoke-payment-gap-invalid-${requestToken}` }),
    }));
    ensure(missingDiscrepancyReason.response.status === 400, 'Un écart financier sans motif devait être refusé.');
    const discrepantCollection = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/payment/collect`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountMinor: 4500, method: 'mobile_money', reference: 'TEST-ECART', discrepancyReason: 'Client a versé un montant inférieur', idempotencyKey: `smoke-payment-gap-${requestToken}` }),
    }));
    ensure(discrepantCollection.response.status === 201 && discrepantCollection.payload.status === 'discrepancy', 'Enregistrement de l’écart financier impossible.');

    const arrived = await transition('Arrivée', 'step-arrived');
    ensure(arrived.response.ok && arrived.payload.status === 'Arrivée', 'Transition vers Arrivée impossible.');

    const incidentKey = `smoke-incident-${requestToken}`;
    const incident = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/incidents`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'adresse', severity: 'low', description: 'Incident temporaire du test automatique',
        idempotencyKey: incidentKey,
      }),
    }));
    ensure(incident.response.status === 201 && incident.payload.id, 'Création de l’incident impossible.');
    const repeatedIncident = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/incidents`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'adresse', severity: 'low', description: 'Incident temporaire du test automatique',
        idempotencyKey: incidentKey,
      }),
    }));
    ensure(repeatedIncident.response.ok && repeatedIncident.payload.alreadyCreated, 'L’incident répété devait rester sans doublon.');

    const incidentList = await json(await fetch(`${baseUrl}/api/app/incidents?scope=open`, { headers: { Cookie: cookie } }));
    ensure(incidentList.response.ok && incidentList.payload.some((item) => String(item.id) === String(incident.payload.id)), 'L’incident est absent de la file dédiée.');
    const initialDossier = await json(await fetch(`${baseUrl}/api/app/incidents/${incident.payload.id}`, { headers: { Cookie: cookie } }));
    ensure(initialDossier.response.ok && initialDossier.payload.eventChainValid === true
      && initialDossier.payload.events.length === 1, 'La chronologie initiale de l’incident n’est pas vérifiable.');

    if (operatorCookie) {
      const forbiddenHold = await fetch(`${baseUrl}/api/app/incidents/${incident.payload.id}/retention-hold`, {
        method: 'POST', headers: { Cookie: operatorCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'Tentative de gel interdite à un opérateur',
          reviewDueAt: new Date(Date.now() + 30 * 86400000).toISOString(),
          idempotencyKey: `smoke-hold-forbidden-${requestToken}`,
        }),
      });
      ensure(forbiddenHold.status === 403, 'Un opérateur ne doit pas pouvoir geler la conservation.');

      const assigned = await json(await fetch(`${baseUrl}/api/app/incidents/${incident.payload.id}/assign`, {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: operatorUserId, idempotencyKey: `smoke-assign-${requestToken}` }),
      }));
      ensure(assigned.response.ok && assigned.payload.assignedTo === 'Opérateur test', 'Attribution du dossier impossible.');
    }

    const noteKey = `smoke-incident-note-${requestToken}`;
    const note = await json(await fetch(`${baseUrl}/api/app/incidents/${incident.payload.id}/notes`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Client rappelé et repère confirmé pendant le test.', idempotencyKey: noteKey }),
    }));
    ensure(note.response.status === 201 && note.payload.id, 'Ajout d’une note au dossier impossible.');
    const repeatedNote = await json(await fetch(`${baseUrl}/api/app/incidents/${incident.payload.id}/notes`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Client rappelé et repère confirmé pendant le test.', idempotencyKey: noteKey }),
    }));
    ensure(repeatedNote.response.ok && repeatedNote.payload.alreadyCreated, 'Une note répétée ne doit pas créer de doublon.');
    if (pool) {
      await pool.query(`UPDATE incident_events SET body = body || ' altération-test' WHERE id = $1 AND incident_id = $2`, [note.payload.id, incident.payload.id]);
      const alteredDossier = await json(await fetch(`${baseUrl}/api/app/incidents/${incident.payload.id}`, { headers: { Cookie: cookie } }));
      ensure(alteredDossier.response.ok && alteredDossier.payload.eventChainValid === false, 'Une altération directe devait invalider la chaîne.');
      await pool.query(`UPDATE incident_events SET body = $1 WHERE id = $2 AND incident_id = $3`,
        ['Client rappelé et repère confirmé pendant le test.', note.payload.id, incident.payload.id]);
      const restoredDossier = await json(await fetch(`${baseUrl}/api/app/incidents/${incident.payload.id}`, { headers: { Cookie: cookie } }));
      ensure(restoredDossier.response.ok && restoredDossier.payload.eventChainValid === true, 'La chaîne restaurée devait redevenir valide.');
    }

    const reviewDueAt = new Date(Date.now() + 30 * 86400000).toISOString();
    const holdKey = `smoke-retention-hold-${requestToken}`;
    const hold = await json(await fetch(`${baseUrl}/api/app/incidents/${incident.payload.id}/retention-hold`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Réclamation client à conserver pendant le test.', reviewDueAt, idempotencyKey: holdKey }),
    }));
    ensure(hold.response.status === 201 && hold.payload.id, 'Activation du gel de conservation impossible.');
    const repeatedHold = await json(await fetch(`${baseUrl}/api/app/incidents/${incident.payload.id}/retention-hold`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Réclamation client à conserver pendant le test.', reviewDueAt, idempotencyKey: holdKey }),
    }));
    ensure(repeatedHold.response.ok && repeatedHold.payload.alreadyPlaced, 'Le gel répété devait rester sans doublon.');

    const exported = await fetch(`${baseUrl}/api/app/incidents/${incident.payload.id}/export`, { headers: { Cookie: cookie } });
    const exportPayload = await exported.json();
    ensure(exported.ok && exported.headers.get('content-disposition')?.includes('dossier.json')
      && exportPayload.integrity?.manifestSha256 && exportPayload.integrity.incidentEventChainValid === true,
    'L’export vérifiable du dossier est invalide.');
    ensure(exportPayload.incident?.description === 'Incident temporaire du test automatique'
      && exportPayload.retentionHolds?.some((item) => item.status === 'active'), 'Le dossier exporté est incomplet.');
    const serializedExport = JSON.stringify(exportPayload);
    ensure(!serializedExport.includes('idempotency_key') && !serializedExport.includes('request_fingerprint')
      && !serializedExport.includes('traccar_unique_id'), 'L’export expose des identifiants techniques internes.');

    const releaseKey = `smoke-retention-release-${requestToken}`;
    const released = await json(await fetch(`${baseUrl}/api/app/incidents/${incident.payload.id}/retention-hold/release`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Fin de la vérification automatisée du dossier.', idempotencyKey: releaseKey }),
    }));
    ensure(released.response.ok && released.payload.releasedAt, 'Levée du gel de conservation impossible.');
    const repeatedRelease = await json(await fetch(`${baseUrl}/api/app/incidents/${incident.payload.id}/retention-hold/release`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Fin de la vérification automatisée du dossier.', idempotencyKey: releaseKey }),
    }));
    ensure(repeatedRelease.response.ok && repeatedRelease.payload.alreadyReleased, 'La levée répétée devait rester sans doublon.');

    const resolved = await json(await fetch(`${baseUrl}/api/app/incidents/${incident.payload.id}/resolve`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: 'Résolution temporaire validée', idempotencyKey: `smoke-resolve-${requestToken}` }),
    }));
    ensure(resolved.response.ok && resolved.payload.status === 'resolved', 'Résolution de l’incident impossible.');
    const resolvedDossier = await json(await fetch(`${baseUrl}/api/app/incidents/${incident.payload.id}`, { headers: { Cookie: cookie } }));
    ensure(resolvedDossier.response.ok && resolvedDossier.payload.eventChainValid === true
      && resolvedDossier.payload.events.some((event) => event.event_type === 'resolved')
      && resolvedDossier.payload.holds[0]?.status === 'released', 'Le dossier résolu ou sa chaîne d’intégrité est incomplet.');

    const otpKey = `smoke-otp-${requestToken}`;
    const otp = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/otp`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: otpKey }),
    }));
    ensure(otp.response.status === 201 && /^\d{6}$/.test(otp.payload.code), 'Génération OTP impossible.');
    const repeatedOtp = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/otp`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: otpKey }),
    }));
    ensure(repeatedOtp.response.ok && repeatedOtp.payload.alreadyGenerated && repeatedOtp.payload.code === otp.payload.code, 'La répétition OTP doit rendre le même résultat.');

    const blockedByDiscrepancy = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/otp/verify`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: otp.payload.code, idempotencyKey: `smoke-payment-block-${requestToken}` }),
    }));
    ensure(blockedByDiscrepancy.response.status === 409, 'Un écart non rapproché devait bloquer la remise finale.');

    if (operatorCookie) {
      const forbiddenReconciliation = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/payment/reconcile`, {
        method: 'POST', headers: { Cookie: operatorCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Tentative non autorisée', idempotencyKey: `smoke-payment-forbidden-${requestToken}` }),
      }));
      ensure(
        forbiddenReconciliation.response.status === 403,
        `Un opérateur ne doit pas pouvoir rapprocher un écart financier (statut ${forbiddenReconciliation.response.status}, réponse ${JSON.stringify(forbiddenReconciliation.payload)}).`
      );
    }

    const reconciled = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/payment/reconcile`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Écart accepté pour le test automatique', idempotencyKey: `smoke-payment-reconcile-${requestToken}` }),
    }));
    ensure(reconciled.response.ok && reconciled.payload.status === 'reconciled', 'Rapprochement de l’écart impossible.');

    const wrongCode = otp.payload.code === '000000' ? '111111' : '000000';
    const wrongOtpKey = `smoke-wrong-otp-${requestToken}`;
    const wrongOtp = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/otp/verify`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: wrongCode, idempotencyKey: wrongOtpKey }),
    }));
    ensure(wrongOtp.response.status === 400 && wrongOtp.payload.attemptsRemaining === 4, 'Un mauvais OTP doit consommer exactement un essai.');
    const repeatedWrongOtp = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/otp/verify`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: wrongCode, idempotencyKey: wrongOtpKey }),
    }));
    ensure(repeatedWrongOtp.response.status === 400 && repeatedWrongOtp.payload.attemptsRemaining === 4 && repeatedWrongOtp.payload.alreadyAttempted, 'Une tentative OTP répétée ne doit pas consommer un second essai.');

    const verifyKey = `smoke-verify-otp-${requestToken}`;
    const verified = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/otp/verify`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: otp.payload.code, idempotencyKey: verifyKey }),
    }));
    ensure(verified.response.ok && verified.payload.status === 'Livrée' && verified.payload.proofId, 'Validation de la remise impossible.');
    const repeatedVerification = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/otp/verify`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: otp.payload.code, idempotencyKey: verifyKey }),
    }));
    ensure(repeatedVerification.response.ok && repeatedVerification.payload.alreadyVerified, 'La validation OTP répétée doit rester sans doublon.');

    const orderDetail = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}`, { headers: { Cookie: cookie } }));
    ensure(orderDetail.response.ok && orderDetail.payload.status === 'Livrée' && orderDetail.payload.proof_id, 'La preuve de remise est absente de la commande.');
    ensure(orderDetail.payload.payment_status === 'reconciled' && orderDetail.payload.paymentEvents.length >= 6, 'L’historique financier ou son rapprochement est incomplet.');
    ensure(orderDetail.payload.events.length >= 5 && orderDetail.payload.incidents[0]?.status === 'resolved', 'Chronologie ou incident incomplet.');

    const privateAfterDelivery = await json(await fetch(`${baseUrl}${publicTrackingPath}`));
    ensure(privateAfterDelivery.response.ok && privateAfterDelivery.payload.status === 'completed', 'Le suivi public doit signaler la fin de livraison.');
    ensure(privateAfterDelivery.payload.positionVisible === false, 'Le suivi GPS doit être désactivé après livraison.');
    ensure(privateAfterDelivery.payload.latitude == null && privateAfterDelivery.payload.longitude == null, 'La position du livreur ne doit plus être exposée après livraison.');
    ensure(privateAfterDelivery.payload.destination == null, 'La destination ne doit plus être exposée après la clôture de la livraison.');

    const locked = await fetch(`${baseUrl}/api/public/requests/${encodeURIComponent(requestToken)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: requestCookie },
      body: JSON.stringify({
        version: updated.payload.version,
        customerName: 'Modification interdite',
        customerPhone: '0197123456',
        customerPhoneCountry: 'BJ',
        neighborhood: 'Zone de test',
        locationLat: 6.38,
        locationLng: 2.44,
      }),
    });
    ensure(locked.status === 409, `La modification après validation devait être bloquée, reçue ${locked.status}.`);

    console.log('Smoke test réussi : demande, affectation, transitions, encaissement, rapprochement, incidents, OTP et confidentialité.');
  } finally {
    if (process.env.DATABASE_URL) {
      if (!pool) {
        pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
        });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (requestToken && !requestId) {
          const found = await client.query('SELECT id FROM customer_requests WHERE token = $1', [requestToken]);
          requestId = found.rows[0]?.id;
        }
        if (requestId) {
          const order = await client.query('SELECT id FROM orders WHERE customer_request_id = $1', [requestId]);
          orderId = order.rows[0]?.id || orderId;
          if (orderId) {
            const trackingLink = await client.query('SELECT id FROM tracking_links WHERE order_id = $1', [orderId]);
            if (trackingLink.rows[0]) {
              await client.query("DELETE FROM audit_logs WHERE entity_type = 'tracking_link' AND entity_id = $1", [trackingLink.rows[0].id]);
            }
            await client.query("DELETE FROM audit_logs WHERE entity_type = 'order' AND entity_id = $1", [orderId]);
            await client.query('DELETE FROM orders WHERE id = $1', [orderId]);
          }
          await client.query("DELETE FROM audit_logs WHERE entity_type = 'customer_request' AND entity_id = $1", [requestId]);
          await client.query('DELETE FROM customer_requests WHERE id = $1 AND token = $2', [requestId, requestToken]);
        }
        if (operatorUserId) {
          if (operatorSessionHash) await client.query('DELETE FROM app_sessions WHERE token_hash = $1', [operatorSessionHash]);
          await client.query('DELETE FROM app_sessions WHERE user_id = $1', [operatorUserId]);
          await client.query('DELETE FROM users WHERE id = $1', [operatorUserId]);
        }
        if (foreignCompanyId) {
          if (foreignSessionHash) await client.query('DELETE FROM app_sessions WHERE token_hash = $1', [foreignSessionHash]);
          await client.query('DELETE FROM company_memberships WHERE company_id = $1', [foreignCompanyId]);
          await client.query('DELETE FROM companies WHERE id = $1', [foreignCompanyId]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
        await pool.end();
      }
    }
  }
}

run().catch((error) => {
  console.error(`Smoke test échoué : ${error.message}`);
  process.exitCode = 1;
});
