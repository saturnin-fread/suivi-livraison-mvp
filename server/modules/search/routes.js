// Recherche globale (Ctrl/⌘ K).
// Numéros (fragment, format international), codes CMD/DEM/TRN/INC, et mots
// présents n'importe où dans la fiche (contacts, lieux, notes). Toujours limitée
// à l'entreprise de la session ; les tables CRM passent par la RLS.
const { createRateLimitMiddleware, createTokenPolicy } = require('../../../lib/rate-limit');
const { createGlobalSearch } = require('./service');

module.exports = function registerSearch(app, deps) {
  const {
    pool, withCompanyTransaction, asyncRoute, requireCompanyApi, trackingLimiter,
    trackingTokenSecret,
  } = deps;

  const globalSearch = pool ? createGlobalSearch({ pool, withCompanyTransaction }) : null;
  const globalSearchRateLimit = createRateLimitMiddleware({
    keySecret: process.env.RATE_LIMIT_KEY_SECRET || trackingTokenSecret() || undefined,
    policies: [
      createTokenPolicy({ limiter: trackingLimiter('search-user', { capacity: 90, refillTokens: 90, refillIntervalMs: 60_000, maxEntries: 20_000 }), key: (req) => `u${req.auth?.user_id || 'x'}` }),
    ],
  });
  app.get('/api/app/search', requireCompanyApi, globalSearchRateLimit, asyncRoute(async (req, res) => {
    if (!globalSearch) return res.status(503).json({ error: 'Recherche momentanément indisponible.' });
    const result = await globalSearch.search(req.auth.company_id, req.query.q, { scope: String(req.query.scope || 'all') });
    res.set('Cache-Control', 'no-store');
    return res.json(result);
  }));

  return { globalSearch };
};
