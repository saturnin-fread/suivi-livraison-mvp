// Canal WhatsApp de TRAXO (Baileys : client WhatsApp Web non officiel).
// Un seul numéro, relié comme « appareil connecté ». La session est gardée en
// base, chiffrée (AES-256-GCM), pour survivre aux redéploiements.
//
// Garde-fous anti-blocage : envois uniquement à la demande de l'utilisateur
// (codes), plafond horaire global, intervalle minimal par destinataire,
// file d'envoi unique : chaque message part 5 à 7 s après la demande et au
// moins 5 à 7 s après le précédent, avec l'indicateur « en train d'écrire ».
'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');

const MAX_PER_HOUR = Number(process.env.WHATSAPP_MAX_PER_HOUR || 40);
const MIN_INTERVAL_PER_RECIPIENT_MS = Math.max(0, Number(process.env.WHATSAPP_RECIPIENT_GAP_MS ?? 25 * 1000));
const LINK_TIMEOUT_MS = 3 * 60 * 1000;
// Délai humain avant chaque message (réglable pour les tests locaux).
const DELAY_MIN_MS = Math.max(0, Number(process.env.WHATSAPP_DELAY_MIN_MS ?? 5000));
const DELAY_MAX_MS = Math.max(DELAY_MIN_MS, Number(process.env.WHATSAPP_DELAY_MAX_MS ?? 7000));
const MAX_QUEUE = 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

// Numéro international (« +229 01 97 12 34 56 ») → chiffres, sinon null.
function internationalDigits(phone) {
  const raw = String(phone || '').trim();
  if (!raw.startsWith('+')) return null;
  const digits = digitsOnly(raw);
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

// Variantes à essayer : au Bénin, les comptes WhatsApp créés avant la
// numérotation à 10 chiffres (novembre 2024) peuvent encore répondre à
// l'ancien numéro sans le préfixe « 01 ».
function candidateNumbers(digits) {
  const list = [digits];
  if (/^22901\d{8}$/.test(digits)) list.push(`229${digits.slice(5)}`);
  return list;
}

function maskPhone(phone) {
  const digits = digitsOnly(phone);
  if (digits.length < 6) return '';
  return `+${digits.slice(0, 3)} •• •• ${digits.slice(-4, -2)} ${digits.slice(-2)}`;
}

function createCipher(secret) {
  const key = crypto.createHash('sha256').update(`whatsapp-session:v1:${secret}`).digest();
  return {
    seal(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
    },
    open(value) {
      const [version, iv, tag, data] = String(value || '').split('.');
      if (version !== 'v1') return null;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
      } catch { return null; }
    },
  };
}

class WhatsAppChannel {
  constructor({ pool, secret, log = console }) {
    this.pool = pool;
    this.cipher = secret ? createCipher(secret) : null;
    this.log = log;
    this.sock = null;
    this.status = 'disconnected'; // disconnected | connecting | qr | pairing | connected | unavailable
    this.qr = null;
    this.pairingCode = null;
    this.me = null;
    this.lastError = null;
    this.since = null;
    this.stopping = false;
    this.linkTimer = null;
    this.retries = 0;
    this.sentLog = [];
    this.lastByRecipient = new Map();
    this.queue = Promise.resolve();
    this.queued = 0;
    this.lastDeliveredAt = 0;
  }

  enabled() { return Boolean(this.pool && this.cipher) && process.env.WHATSAPP_ENABLED !== 'off'; }

  snapshot() {
    return {
      enabled: this.enabled(),
      status: this.status,
      qr: this.status === 'qr' ? this.qr : null,
      pairingCode: this.status === 'pairing' ? this.pairingCode : null,
      number: this.me ? `+${this.me}` : null,
      since: this.since,
      lastError: this.lastError,
      sentLastHour: this.recentSends(),
      slow: this.status === 'connecting' && this.connectingSince != null && Date.now() - this.connectingSince > 45_000,
      maxPerHour: MAX_PER_HOUR,
    };
  }

  isReady() { return this.status === 'connected' && Boolean(this.sock); }

  recentSends() {
    const cutoff = Date.now() - 3600 * 1000;
    this.sentLog = this.sentLog.filter((t) => t > cutoff);
    return this.sentLog.length;
  }

  // --- Stockage de la session en base (équivalent de useMultiFileAuthState) ---
  async authState(lib) {
    const { BufferJSON, initAuthCreds, proto } = lib;
    const read = async (ids) => {
      const rows = (await this.pool.query('SELECT id, data FROM whatsapp_auth WHERE id = ANY($1)', [ids])).rows;
      const out = {};
      for (const row of rows) {
        const plain = this.cipher.open(row.data);
        if (plain) out[row.id] = JSON.parse(plain, BufferJSON.reviver);
      }
      return out;
    };
    const write = (id, value) => this.pool.query(
      `INSERT INTO whatsapp_auth (id, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [id, this.cipher.seal(JSON.stringify(value, BufferJSON.replacer))]
    );
    const creds = (await read(['creds'])).creds || initAuthCreds();
    return {
      state: {
        creds,
        keys: {
          get: async (type, ids) => {
            const found = await read(ids.map((id) => `${type}-${id}`));
            const data = {};
            for (const id of ids) {
              let value = found[`${type}-${id}`];
              if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
              data[id] = value;
            }
            return data;
          },
          set: async (data) => {
            const writes = [];
            const removals = [];
            for (const category of Object.keys(data)) {
              for (const id of Object.keys(data[category])) {
                const value = data[category][id];
                if (value) writes.push(write(`${category}-${id}`, value));
                else removals.push(`${category}-${id}`);
              }
            }
            if (removals.length) writes.push(this.pool.query('DELETE FROM whatsapp_auth WHERE id = ANY($1)', [removals]));
            await Promise.all(writes);
          },
        },
      },
      saveCreds: () => write('creds', creds),
      registered: Boolean(creds.registered),
    };
  }

  async clearSession() {
    await this.pool.query('DELETE FROM whatsapp_auth');
  }

  // Au démarrage : reconnecte seulement si un numéro a déjà été relié.
  async start() {
    if (!this.enabled()) { this.status = 'unavailable'; return; }
    const row = (await this.pool.query("SELECT 1 FROM whatsapp_auth WHERE id = 'creds'")).rows[0];
    if (row) await this.connect({});
  }

  async connect({ phone = null } = {}) {
    if (!this.enabled()) throw Object.assign(new Error('Le canal WhatsApp n’est pas configuré sur ce serveur.'), { statusCode: 503 });
    const lib = await import('@whiskeysockets/baileys');
    const pino = require('pino');
    this.stopping = false;
    this.closeSocket();
    const { state, saveCreds, registered } = await this.authState(lib);
    let version;
    try { ({ version } = await lib.fetchLatestBaileysVersion()); } catch { version = undefined; }
    this.status = 'connecting';
    this.connectingSince = Date.now();
    this.lastError = null;
    const logger = pino({ level: process.env.WHATSAPP_LOG_LEVEL || 'silent' });
    const sock = lib.makeWASocket({
      auth: { creds: state.creds, keys: lib.makeCacheableSignalKeyStore(state.keys, logger) },
      version,
      logger,
      browser: lib.Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });
    this.sock = sock;
    sock.ev.on('creds.update', () => { saveCreds().catch((e) => this.log.error('WhatsApp creds:', e.message)); });
    let pairingRequested = false;
    sock.ev.on('connection.update', async (update) => {
      if (this.sock !== sock) return;
      const { connection, lastDisconnect, qr } = update;
      if (qr && !registered) {
        if (phone && !pairingRequested) {
          pairingRequested = true;
          try {
            const code = await sock.requestPairingCode(phone);
            this.pairingCode = code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
            this.status = 'pairing';
          } catch (error) {
            this.lastError = `Code de liaison refusé : ${error.message}`;
            this.status = 'qr';
          }
        } else if (!phone) {
          this.qr = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
          this.status = 'qr';
        }
        this.armLinkTimeout();
      }
      if (connection === 'open') {
        clearTimeout(this.linkTimer);
        this.status = 'connected';
        this.retries = 0;
        this.qr = null;
        this.pairingCode = null;
        this.me = digitsOnly(String(sock.user && sock.user.id || '').split(':')[0].split('@')[0]);
        this.since = new Date().toISOString();
        this.log.log(`WhatsApp relié (${maskPhone(this.me)})`);
      }
      if (connection === 'close') {
        const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
        this.sock = null;
        if (this.stopping) { this.status = 'disconnected'; return; }
        if (code === lib.DisconnectReason.loggedOut) {
          this.status = 'disconnected';
          this.me = null;
          this.lastError = 'Le téléphone a retiré TRAXO de ses appareils connectés.';
          await this.clearSession().catch(() => {});
          this.log.log('WhatsApp : session retirée depuis le téléphone');
          return;
        }
        if (code === lib.DisconnectReason.connectionReplaced) {
          // Une autre instance du serveur a repris la session : on s'efface.
          this.status = 'disconnected';
          this.lastError = 'Session reprise par une autre instance du serveur.';
          return;
        }
        if (code === lib.DisconnectReason.forbidden) {
          this.status = 'disconnected';
          this.lastError = 'WhatsApp a refusé la connexion (compte restreint ou banni ?).';
          this.log.error('WhatsApp : connexion refusée (403)');
          return;
        }
        this.retries += 1;
        const delay = Math.min(60_000, 2_000 * 2 ** Math.min(this.retries, 5));
        this.status = 'connecting';
        this.lastError = code ? `Connexion perdue (code ${code}), nouvelle tentative…` : 'Connexion perdue, nouvelle tentative…';
        setTimeout(() => {
          if (this.stopping || this.sock) return;
          this.connect({ phone: registered ? null : phone }).catch((e) => { this.lastError = e.message; this.status = 'disconnected'; });
        }, delay);
      }
    });
  }

  // Sans liaison terminée dans les 3 minutes, on arrête de générer des codes.
  armLinkTimeout() {
    if (this.linkTimer) return;
    this.linkTimer = setTimeout(() => {
      this.linkTimer = null;
      if (this.status === 'qr' || this.status === 'pairing') {
        this.stop();
        this.lastError = 'Liaison non terminée à temps. Recommencez.';
      }
    }, LINK_TIMEOUT_MS);
  }

  closeSocket() {
    const sock = this.sock;
    this.sock = null;
    if (sock) { try { sock.end(undefined); } catch { /* déjà fermé */ } }
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.linkTimer);
    this.linkTimer = null;
    this.closeSocket();
    this.status = 'disconnected';
    this.qr = null;
    this.pairingCode = null;
  }

  async logout() {
    this.stopping = true;
    const sock = this.sock;
    if (sock) { try { await sock.logout(); } catch { /* hors ligne */ } }
    this.stop();
    this.me = null;
    this.since = null;
    await this.clearSession();
  }

  // Recherche du compte WhatsApp d'un numéro (remplaçable en test).
  async lookupJid(digits) {
    for (const candidate of candidateNumbers(digits)) {
      const [found] = (await this.sock.onWhatsApp(candidate)) || [];
      if (found && found.exists) return found.jid;
    }
    return null;
  }

  // Remise effective du message, l'indicateur « écrit… » affiché pendant l'attente.
  async deliver(jid, text, waitMs) {
    const sock = this.sock;
    try { await sock.sendPresenceUpdate('composing', jid); } catch { /* facultatif */ }
    let left = waitMs;
    while (left > 0) {
      const step = Math.min(left, 4000);
      await sleep(step);
      left -= step;
      if (left > 0) { try { await sock.sendPresenceUpdate('composing', jid); } catch { /* facultatif */ } }
    }
    try { await sock.sendPresenceUpdate('paused', jid); } catch { /* facultatif */ }
    await sock.sendMessage(jid, { text });
  }

  randomDelay() { return DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS + 1)); }

  // Envoi d'un texte à un numéro international. Les vérifications (connexion,
  // numéro, plafonds) sont immédiates ; la remise passe par la file d'envoi.
  // background : on n'attend pas la remise (la page répond tout de suite).
  async sendText(phone, text, { background = false, onError = null } = {}) {
    if (!this.isReady()) throw Object.assign(new Error('WhatsApp n’est pas relié pour le moment.'), { code: 'not_connected' });
    const digits = internationalDigits(phone);
    if (!digits) throw Object.assign(new Error('Numéro de téléphone incomplet (indicatif manquant).'), { code: 'bad_number' });
    if (this.recentSends() >= MAX_PER_HOUR) throw Object.assign(new Error('Limite d’envois WhatsApp atteinte pour cette heure.'), { code: 'rate_limited' });
    if (this.queued >= MAX_QUEUE) throw Object.assign(new Error('Trop de messages en attente. Réessayez dans une minute.'), { code: 'rate_limited' });
    const last = this.lastByRecipient.get(digits) || 0;
    if (Date.now() - last < MIN_INTERVAL_PER_RECIPIENT_MS) throw Object.assign(new Error('Un message vient déjà d’être envoyé à ce numéro.'), { code: 'too_soon' });
    const jid = await this.lookupJid(digits);
    if (!jid) throw Object.assign(new Error('Ce numéro n’a pas de compte WhatsApp.'), { code: 'not_on_whatsapp' });
    this.lastByRecipient.set(digits, Date.now());
    this.sentLog.push(Date.now());
    const requestedAt = Date.now();
    const gap = this.randomDelay();
    this.queued += 1;
    const run = async () => {
      // 5 à 7 s après la demande, et autant après le message précédent.
      const waitMs = Math.max(requestedAt + gap - Date.now(), this.lastDeliveredAt + gap - Date.now(), 0);
      try {
        await this.deliver(jid, text, waitMs);
      } finally {
        this.lastDeliveredAt = Date.now();
        this.queued -= 1;
      }
    };
    const delivery = this.queue.then(run, run);
    this.queue = delivery.catch(() => {});
    const etaMs = Math.max(gap, (this.queued - 1) * gap);
    if (background) {
      delivery.catch((error) => {
        this.log.error?.('WhatsApp delivery failed:', error.code || error.message);
        if (onError) { try { onError(error); } catch { /* ignore */ } }
      });
      return { jid, queued: true, etaMs };
    }
    await delivery;
    return { jid, etaMs };
  }
}

module.exports = { WhatsAppChannel, internationalDigits, maskPhone, candidateNumbers };
