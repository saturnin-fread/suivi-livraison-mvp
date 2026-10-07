// Tests locaux : lit le dernier code à 6 chiffres envoyé par e-mail à une
// adresse (dossier EMAIL_OUTBOX_DIR du serveur de test, jamais en production).
const fs = require('fs');
const path = require('path');

async function waitEmailCode(to, since = 0, { timeoutMs = 10000 } = {}) {
  const outbox = process.env.EMAIL_OUTBOX_DIR;
  if (!outbox) throw new Error('EMAIL_OUTBOX_DIR requis (même dossier que le serveur de test).');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = fs.existsSync(outbox) ? fs.readdirSync(outbox).filter((f) => f.endsWith('.json') && !f.endsWith('-wa.json')).sort().reverse() : [];
    for (const f of files) {
      if (Number(f.split('-')[0]) < since) break;
      const mail = JSON.parse(fs.readFileSync(path.join(outbox, f), 'utf8'));
      if (String(mail.to).toLowerCase() !== String(to).toLowerCase()) continue;
      const m = String(mail.subject || '').match(/\b(\d{6})\b/) || String(mail.text || '').match(/\b(\d{6})\b/);
      if (m) return m[1];
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Aucun code reçu pour ${to}.`);
}

// Accepter une invitation par e-mail comme le ferait la personne : demander le
// code, le lire, puis valider avec le mot de passe choisi.
async function acceptEmailInvitation(baseUrl, token, email, body) {
  const since = Date.now() - 1000;
  const sent = await fetch(`${baseUrl}/api/public/invitations/${encodeURIComponent(token)}/send-code`, { method: 'POST' });
  if (!sent.ok) throw new Error(`Envoi du code d’invitation impossible (${sent.status}).`);
  const code = await waitEmailCode(email, since);
  return fetch(`${baseUrl}/api/public/invitations/${encodeURIComponent(token)}/accept`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, code }),
  });
}

module.exports = { waitEmailCode, acceptEmailInvitation };
