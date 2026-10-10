// E-mails transactionnels : modèles du kit « TRAXO Emails Premium » (édition 02).
// Les fichiers de templates/ sont copiés tels quels depuis le kit (HTML en
// tableaux, styles en ligne, blocs Outlook/VML) : ne pas les minifier.
//
// Syntaxe du kit (compilée ici, ce n'est pas celle de Brevo) :
//   {{variable}}               texte échappé une seule fois en HTML, brut en texte
//   {{#si cle}}…{{/si}}        bloc affiché si la valeur est vraie
//   {{#chaque liste}}…{{/chaque}}  bloc répété pour chaque élément (15 au plus)
//
// Seuls les 13 messages actuels (A1–A13) sont branchés. Les familles B et C du
// kit ne sont pas copiées : elles attendent leurs règles produit.
const fs = require('fs');
const path = require('path');

const TEMPLATE_DIR = path.join(__dirname, 'templates');

const CATALOG = {
  'A1-code-inscription': { subject: '{{code}} — votre code TRAXO' },
  'A2-code-connexion': { subject: '{{code}} — votre code TRAXO' },
  'A3-alerte-connexion': { subject: 'TRAXO — Nouvelle connexion à votre compte' },
  'A4-reinitialisation-mot-de-passe': { subject: 'TRAXO — Réinitialisation de votre mot de passe' },
  'A5-invitation-equipe': { subject: 'Invitation à rejoindre {{entreprise}} sur TRAXO' },
  'A6-code-invitation': { subject: '{{code}} est votre code pour rejoindre {{entreprise}} sur TRAXO' },
  'A7-recapitulatif-notifications': { subject: 'TRAXO — {{nombre}} {{libelle_notifications}} à traiter' },
  'A8-support-equipe-nouvelle-demande': { subject: '[{{reference}}] Nouvelle demande — {{sujet}}' },
  'A9-support-equipe-nouveau-message': { subject: '[{{reference}}] Nouveau message — {{sujet}}' },
  'A10-support-equipe-demande-rouverte': { subject: '[{{reference}}] Demande rouverte — {{sujet}}' },
  'A11-support-client-nouvelle-reponse': { subject: '[{{reference}}] Nouvelle réponse de l’équipe TRAXO' },
  'A12-support-client-resolue': { subject: '[{{reference}}] Votre demande est résolue' },
  'A13-support-client-attente-reponse': { subject: '[{{reference}}] Nous attendons votre réponse' },
};

class EmailTemplateError extends Error {}

// --- Moteur -------------------------------------------------------------------
function parseTemplate(source) {
  const root = [];
  const stack = [root];
  const kinds = [];
  for (const token of source.split(/(\{\{[\s\S]*?\}\})/)) {
    if (!token) continue;
    if (token.startsWith('{{#')) {
      const [kind, key] = token.slice(3, -2).trim().split(/\s+/, 2);
      if (!['si', 'chaque'].includes(kind) || !key) throw new EmailTemplateError(`Bloc inconnu : ${token}`);
      const node = { kind, key, children: [] };
      stack[stack.length - 1].push(node);
      stack.push(node.children);
      kinds.push(kind);
    } else if (token.startsWith('{{/')) {
      if (stack.length === 1 || token.slice(3, -2).trim() !== kinds.pop()) throw new EmailTemplateError(`Fermeture inattendue : ${token}`);
      stack.pop();
    } else if (token.startsWith('{{')) {
      stack[stack.length - 1].push({ kind: 'var', key: token.slice(2, -2).trim() });
    } else {
      stack[stack.length - 1].push({ kind: 'str', value: token });
    }
  }
  if (stack.length !== 1) throw new EmailTemplateError('Bloc non fermé');
  return root;
}

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

function renderNodes(nodes, ctx, html) {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'str') out += node.value;
    else if (node.kind === 'var') {
      if (!(node.key in ctx) || ctx[node.key] == null) throw new EmailTemplateError(`Variable manquante : ${node.key}`);
      out += html ? escapeHtml(ctx[node.key]) : String(ctx[node.key]);
    } else if (node.kind === 'si') {
      if (ctx[node.key]) out += renderNodes(node.children, ctx, html);
    } else {
      for (const item of ctx[node.key] || []) out += renderNodes(node.children, { ...ctx, ...item }, html);
    }
  }
  return out;
}

const cache = new Map();
function compiled(file) {
  if (!cache.has(file)) cache.set(file, parseTemplate(fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8')));
  return cache.get(file);
}

// --- Contrôle des données -------------------------------------------------------
// Liens : https uniquement, hôte exact d'une liste fermée (pas de sous-domaine
// ressemblant), sans identifiants ni port exotique. En dehors de la production,
// http://localhost est accepté pour les tests locaux.
function allowedHosts() {
  const hosts = new Set(['gettraxo.app', 'app.gettraxo.app']);
  try {
    const configured = String(process.env.APP_BASE_URL || '').trim();
    if (configured) hosts.add(new URL(configured).hostname.toLowerCase());
  } catch { /* APP_BASE_URL invalide : ignoré */ }
  return hosts;
}
const isProduction = () => process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT_NAME === 'production';

function validateUrl(value, key) {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f\s]/.test(value)) throw new EmailTemplateError(`Lien invalide : ${key}`);
  let url;
  try { url = new URL(value); } catch { throw new EmailTemplateError(`Lien invalide : ${key}`); }
  const host = url.hostname.toLowerCase();
  const local = !isProduction() && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(host);
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || (!local && url.port && url.port !== '443')
    || (!local && !allowedHosts().has(host))) {
    throw new EmailTemplateError(`Lien hors des domaines autorisés : ${key}`);
  }
  return value;
}

function prepareContext(values) {
  const ctx = { ...values };
  const walk = (obj) => {
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith('url_') || key === 'lien_url') validateUrl(value, key);
      else if (key === 'elements') {
        if (!Array.isArray(value) || value.length > 15) throw new EmailTemplateError('15 éléments maximum par récapitulatif');
        value.forEach(walk);
      } else if (key === 'code') {
        if (typeof value !== 'string' || !/^\d{6}$/.test(value)) throw new EmailTemplateError('Code attendu : six chiffres');
      } else if (typeof value === 'string') {
        if (value.includes('\u0000')) throw new EmailTemplateError(`Caractère nul : ${key}`);
        if (key !== 'message' && value.length > 500) throw new EmailTemplateError(`Texte trop long : ${key}`);
      }
    }
  };
  walk(ctx);
  if ('message' in ctx) {
    ctx.message = String(ctx.message || '').trim().slice(0, 1200);
    ctx.message_present = Boolean(ctx.message);
    // « Pièce jointe seulement » : sauf si l'appelant sait qu'il n'y en a pas
    // (demande rouverte sans message).
    ctx.sans_message = !ctx.message_present && values.sans_message !== false;
  }
  return ctx;
}

// Objet : texte brut, une ligne. Les noms saisis par les utilisateurs ne
// peuvent pas y injecter d'en-tête.
function renderSubject(source, ctx) {
  const subject = renderNodes(parseTemplate(source), ctx, false).replace(/[\r\n\u0000]+/g, ' ').trim();
  return subject.length > 300 ? `${subject.slice(0, 297)}…` : subject;
}

// Rend un modèle : { template, subject, html, text }. Lève EmailTemplateError
// si une variable manque ou si un lien n'est pas autorisé (aucun envoi alors).
function renderEmail(id, values = {}) {
  const entry = CATALOG[id];
  if (!entry) throw new EmailTemplateError(`Modèle inconnu : ${id}`);
  const ctx = prepareContext(values);
  return {
    template: id,
    subject: renderSubject(entry.subject, ctx),
    html: renderNodes(compiled(`${id}.html`), ctx, true),
    text: `${renderNodes(compiled(`${id}.txt`), ctx, false).replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim()}\n`,
  };
}

// Retour à l'ancien gabarit sans redéploiement de code : EMAIL_TEMPLATES=legacy.
const legacyTemplates = () => String(process.env.EMAIL_TEMPLATES || '').trim().toLowerCase() === 'legacy';

module.exports = { renderEmail, validateUrl, legacyTemplates, EmailTemplateError, CATALOG, parseTemplate };
