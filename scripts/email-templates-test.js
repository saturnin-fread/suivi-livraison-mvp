// Modèles e-mail (kit TRAXO Emails Premium, édition 02) : rendu des 13 messages
// actuels, échappement unique, liens autorisés, codes, récapitulatif, objets.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'production';
delete process.env.APP_BASE_URL;
delete process.env.RAILWAY_ENVIRONMENT_NAME;
const { renderEmail, CATALOG, EmailTemplateError } = require('../server/email');

const APP = 'https://app.gettraxo.app';
const SAMPLE = {
  'A1-code-inscription': { code: '048213' },
  'A2-code-connexion': { code: '993100' },
  'A3-alerte-connexion': { date_heure: '10 octobre 2026 à 16:12', appareil: 'Chrome sur Android', methode: 'compte Google', url_securite: `${APP}/app/parametres?section=security`, url_preferences: `${APP}/app/parametres?section=security` },
  'A4-reinitialisation-mot-de-passe': { url_reinitialisation: `${APP}/app/reset?token=abc_DEF-123` },
  'A5-invitation-equipe': { entreprise: 'Boutique Ganhi', invitant: 'Idriss Soglo', prenom_nom: 'Awa Dossou', role: 'Opérateur', url_invitation: `${APP}/invitation/tok123` },
  'A6-code-invitation': { code: '000001', entreprise: 'Boutique Ganhi', prenom_nom: 'Awa Dossou' },
  'A7-recapitulatif-notifications': {
    nombre: '2', libelle_notifications: 'notifications', periode: 'aujourd’hui', url_notifications: `${APP}/app/notifications`, url_preferences: `${APP}/app/notifications?vue=preferences`,
    elements: [
      { type_libelle: 'Incident', titre: 'Colis endommagé', resume: 'Commande CMD-12', lien_libelle: 'Voir', lien_url: `${APP}/app/operations?vue=incidents` },
      { type_libelle: 'Support', titre: 'Réponse du support', resume: 'TRX-1', lien_libelle: 'Ouvrir', lien_url: `${APP}/app?support=1` },
    ],
  },
  'A11-support-client-nouvelle-reponse': { reference: 'TRX-2026-0042', sujet: 'Livreur hors ligne', url_demande: `${APP}/app?support=42` },
  'A12-support-client-resolue': { reference: 'TRX-2026-0042', sujet: 'Livreur hors ligne', url_demande: `${APP}/app?support=42` },
  'A13-support-client-attente-reponse': { reference: 'TRX-2026-0042', sujet: 'Livreur hors ligne', url_demande: `${APP}/app?support=42` },
};
const supportTeam = { reference: 'TRX-2026-0042', sujet: 'Livreur hors ligne', entreprise: 'Boutique Ganhi', id_espace: '27', auteur: 'Awa', message: 'Bonjour', url_demande: `${APP}/app/parametres?section=support&demande=42` };
for (const id of ['A8-support-equipe-nouvelle-demande', 'A9-support-equipe-nouveau-message', 'A10-support-equipe-demande-rouverte']) SAMPLE[id] = supportTeam;

// 1. Les 13 modèles se rendent, sans balise oubliée, avec HTML + texte, et
//    gardent les blocs Outlook (VML) et le préheader.
assert.strictEqual(Object.keys(CATALOG).length, 13, '13 messages actuels');
assert.ok(!fs.readdirSync(path.join(__dirname, '..', 'server', 'email', 'templates')).some((f) => /^[BC]\d/.test(f)), 'familles B et C non installées');
for (const id of Object.keys(CATALOG)) {
  const mail = renderEmail(id, SAMPLE[id]);
  assert.strictEqual(mail.template, id);
  for (const part of [mail.subject, mail.html, mail.text]) assert.ok(part && !/\{\{/.test(part), `${id} : balise non rendue`);
  assert.ok(mail.html.includes('<!--[if mso]>') || mail.html.includes('<!--[if mso'), `${id} : bloc Outlook conservé`);
  assert.ok(mail.html.includes(`${APP}/brand/email-premium/v2/png/logo-light@2x.png`), `${id} : logo du kit`);
  for (const src of mail.html.match(/https:\/\/app\.gettraxo\.app\/brand\/email-premium\/v2\/[^"')\s]+/g) || []) {
    const file = path.join(__dirname, '..', 'public', src.replace(`${APP}/`, ''));
    assert.ok(fs.existsSync(file), `${id} : image publiée ${src}`);
  }
  assert.ok(!/[\r\n]/.test(mail.subject), `${id} : objet sur une ligne`);
}

// 2. Codes : texte de six chiffres, sans lien ni bouton autour.
for (const id of ['A1-code-inscription', 'A2-code-connexion', 'A6-code-invitation']) {
  const mail = renderEmail(id, SAMPLE[id]);
  assert.ok(mail.subject.startsWith(SAMPLE[id].code), `${id} : code dans l'objet`);
  assert.ok(mail.text.includes(SAMPLE[id].code));
  const anchors = mail.html.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) || [];
  assert.ok(!anchors.some((a) => a.includes(SAMPLE[id].code)), `${id} : le code n'est pas un lien`);
  for (const bad of ['12345', '1234567', 'abcdef', 123456]) {
    assert.throws(() => renderEmail(id, { ...SAMPLE[id], code: bad }), EmailTemplateError, `${id} : code ${bad} refusé`);
  }
}

// 3. Échappement unique : un nom d'entreprise piégé reste du texte.
{
  const mail = renderEmail('A5-invitation-equipe', { ...SAMPLE['A5-invitation-equipe'], entreprise: '<img src=x onerror=alert(1)> & "Cie"' });
  assert.ok(!mail.html.includes('<img src=x'), 'balise échappée');
  assert.ok(mail.html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Cie&quot;'), 'échappé une seule fois');
  assert.ok(!mail.html.includes('&amp;lt;'), 'pas de double échappement');
  assert.ok(mail.text.includes('<img src=x onerror=alert(1)> & "Cie"'), 'texte brut non échappé');
  assert.ok(mail.subject.includes('& "Cie"'), 'objet en texte brut');
}

// 4. Liens : https sur les domaines TRAXO seulement.
for (const bad of [
  'javascript:alert(1)', 'http://app.gettraxo.app/app/reset', 'https://app.gettraxo.app.evil.com/x', 'https://gettraxo-app.com/x',
  'https://user:pass@app.gettraxo.app/x', 'https://app.gettraxo.app:8443/x', 'https://evil.com/?https://app.gettraxo.app', 'https://app.gettraxo.app/x\n', '/app/reset',
]) {
  assert.throws(() => renderEmail('A4-reinitialisation-mot-de-passe', { url_reinitialisation: bad }), EmailTemplateError, `lien refusé : ${JSON.stringify(bad)}`);
}
{
  const url = `${APP}/app/reset?token=a&b="c"`;
  const mail = renderEmail('A4-reinitialisation-mot-de-passe', { url_reinitialisation: url });
  const occurrences = mail.html.split('https://app.gettraxo.app/app/reset?token=a&amp;b=&quot;c&quot;').length - 1;
  assert.ok(occurrences >= 3, 'même lien dans VML, bouton et lien de secours');
  assert.ok(mail.text.includes(url));
}
// APP_BASE_URL (staging) est ajouté à la liste ; un hôte voisin reste refusé.
process.env.APP_BASE_URL = 'https://staging.example.test';
assert.ok(renderEmail('A4-reinitialisation-mot-de-passe', { url_reinitialisation: 'https://staging.example.test/app/reset?token=x' }));
assert.throws(() => renderEmail('A4-reinitialisation-mot-de-passe', { url_reinitialisation: 'https://evil.example.test/app/reset' }), EmailTemplateError);
delete process.env.APP_BASE_URL;
// En production, http://localhost est refusé.
assert.throws(() => renderEmail('A4-reinitialisation-mot-de-passe', { url_reinitialisation: 'http://localhost:3000/app/reset' }), EmailTemplateError);

// 5. Variables manquantes : aucun e-mail rendu.
assert.throws(() => renderEmail('A5-invitation-equipe', { ...SAMPLE['A5-invitation-equipe'], invitant: undefined }), EmailTemplateError);
assert.throws(() => renderEmail('B1-recharge-confirmee', {}), EmailTemplateError, 'modèle B non branché');

// 6. Récapitulatif : 15 éléments au plus, chaque lien vérifié.
{
  const base = SAMPLE['A7-recapitulatif-notifications'];
  const item = base.elements[0];
  assert.ok(renderEmail('A7-recapitulatif-notifications', { ...base, nombre: '40', elements: Array(15).fill(item) }).html.includes('40'));
  assert.throws(() => renderEmail('A7-recapitulatif-notifications', { ...base, elements: Array(16).fill(item) }), EmailTemplateError);
  assert.throws(() => renderEmail('A7-recapitulatif-notifications', { ...base, elements: [{ ...item, lien_url: 'https://evil.com' }] }), EmailTemplateError);
  const one = renderEmail('A7-recapitulatif-notifications', { ...base, nombre: '1', libelle_notifications: 'notification', elements: [item] });
  assert.strictEqual(one.subject, 'TRAXO — 1 notification à traiter');
}

// 7. Support : message limité à 1 200 caractères, « pièce jointe » seulement
//    s'il n'y a pas de texte, rien pour une demande rouverte sans message.
{
  const long = renderEmail('A9-support-equipe-nouveau-message', { ...supportTeam, message: `${'x'.repeat(1300)}FIN` });
  assert.ok(long.text.includes('x'.repeat(1200)) && !long.text.includes('x'.repeat(1201)) && !long.text.includes('FIN'));
  const attachment = renderEmail('A9-support-equipe-nouveau-message', { ...supportTeam, message: '   ' });
  assert.ok(/pièce jointe/i.test(attachment.text));
  const reopened = renderEmail('A10-support-equipe-demande-rouverte', { ...supportTeam, message: '', sans_message: false });
  assert.ok(!/pièce jointe/i.test(reopened.text));
  const piped = renderEmail('A8-support-equipe-nouvelle-demande', { ...supportTeam, sujet: 'Objet\r\nBcc: x@evil.com' });
  assert.ok(!/[\r\n]/.test(piped.subject), 'pas d’en-tête injecté par l’objet');
}

console.log('email templates: OK');
