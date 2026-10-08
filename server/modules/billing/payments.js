// Prestataires de paiement des recharges.
//
// - kkiapay : actif dès que les trois clés sont définies (KKIAPAY_PUBLIC_KEY,
//   KKIAPAY_PRIVATE_KEY, KKIAPAY_SECRET_KEY). Le client paie dans le widget
//   Kkiapay (Mobile Money, carte) ; le serveur ne croit jamais le navigateur et
//   revérifie chaque transaction auprès de l'API Kkiapay avant de créditer.
//   KKIAPAY_SANDBOX=false pour passer en réel (bac à sable par défaut).
// - test : pour le développement et les tests automatiques uniquement ; toute
//   recharge est acceptée. Jamais disponible en production.
const axios = require('axios');

const KKIAPAY_API = { sandbox: 'https://api-sandbox.kkiapay.me', live: 'https://api.kkiapay.me' };

function isProduction(env) {
  return env.NODE_ENV === 'production' || env.RAILWAY_ENVIRONMENT_NAME === 'production';
}

function kkiapayProvider(env, http = axios) {
  const sandbox = env.KKIAPAY_SANDBOX !== 'false';
  const baseURL = env.KKIAPAY_API_URL || (sandbox ? KKIAPAY_API.sandbox : KKIAPAY_API.live);
  return {
    name: 'kkiapay',
    // Paramètres du widget côté navigateur : seule la clé publique y figure.
    checkout(payment) {
      return { provider: 'kkiapay', publicKey: env.KKIAPAY_PUBLIC_KEY, sandbox, amount: payment.amount, data: payment.reference };
    },
    async verify({ payment, transactionId }) {
      const id = String(transactionId || '').trim();
      if (!/^[A-Za-z0-9_-]{4,80}$/.test(id)) return { ok: false, final: false, message: 'Référence de paiement manquante.' };
      let body;
      try {
        const response = await http.post(`${baseURL}/api/v1/transactions/status`, { transactionId: id }, {
          headers: {
            'x-api-key': env.KKIAPAY_PUBLIC_KEY,
            'x-private-key': env.KKIAPAY_PRIVATE_KEY,
            'x-secret-key': env.KKIAPAY_SECRET_KEY,
          },
          timeout: 10000,
        });
        body = response.data || {};
      } catch (error) {
        const status = error.response && error.response.status;
        console.error('Kkiapay : vérification impossible', status || error.message);
        return { ok: false, final: false, message: 'Le paiement n’a pas encore pu être vérifié. Réessayez dans un instant.' };
      }
      const status = String(body.status || '').toUpperCase();
      if (status !== 'SUCCESS') {
        const final = status === 'FAILED';
        return { ok: false, final, reason: status || 'inconnu', message: final ? 'Le paiement a échoué. Aucun montant n’a été crédité.' : 'Le paiement n’est pas encore confirmé.' };
      }
      if (Number(body.amount) < Number(payment.amount)) {
        return { ok: false, final: true, reason: 'montant', message: 'Le montant payé ne correspond pas à la recharge.' };
      }
      // Donnée transmise au widget (référence de la recharge), si l'API la renvoie.
      const echoed = body.state ?? body.data ?? null;
      if (typeof echoed === 'string' && echoed && echoed !== payment.reference) {
        return { ok: false, final: true, reason: 'référence', message: 'Ce paiement ne correspond pas à cette recharge.' };
      }
      return { ok: true, transactionId: String(body.transactionId || id) };
    },
  };
}

function testProvider() {
  return {
    name: 'test',
    checkout(payment) {
      return { provider: 'test', amount: payment.amount, data: payment.reference };
    },
    async verify({ payment, transactionId }) {
      if (transactionId === 'refuse') return { ok: false, final: true, reason: 'test', message: 'Paiement de test refusé.' };
      return { ok: true, transactionId: transactionId || `test-${payment.reference}` };
    },
  };
}

function createPaymentProvider(env = process.env, { http } = {}) {
  if (env.KKIAPAY_PUBLIC_KEY && env.KKIAPAY_PRIVATE_KEY && env.KKIAPAY_SECRET_KEY) return kkiapayProvider(env, http);
  if (!isProduction(env) && env.BILLING_TEST_PAYMENTS === 'on') return testProvider();
  return null;
}

module.exports = { createPaymentProvider, kkiapayProvider, testProvider, KKIAPAY_API };
