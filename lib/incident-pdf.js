// Dossier d'incident au format PDF (lisible, imprimable, partageable).
// Le JSON « certifié » reste disponible : le PDF reprend son empreinte SHA-256
// en pied de page pour relier les deux documents.
'use strict';

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

// Police TRAXO (Roboto, licence Apache 2.0) en TTF : pdfkit gère mal le WOFF2.
const FONT_DIR = path.join(__dirname, 'fonts');
const LOGO = path.join(__dirname, '..', 'public', 'brand', 'traxo-logo.png');
const INK = '#16171a';
const MUTED = '#6b6e76';
const LINE = '#e4e5e8';
const RED = '#dc263b';
const SOFT = '#f5f5f6';

const categoryLabels = {
  client_injoignable: 'Client injoignable', adresse: 'Adresse ou accès', colis: 'Colis endommagé ou manquant',
  paiement: 'Paiement', vehicule: 'Véhicule', gps: 'GPS ou connexion', autre: 'Autre',
};
const severityLabels = { low: 'Faible', medium: 'Moyenne', high: 'Élevée' };
const eventLabels = {
  opened: 'Incident déclaré', note_added: 'Note ajoutée', assigned: 'Responsable attribué',
  resolved: 'Incident résolu', retention_hold_placed: 'Protection des données activée',
  retention_hold_released: 'Protection des données retirée',
};
const paymentLabels = {
  configured: 'Paiement à la livraison demandé', collected: 'Montant encaissé', reconciled: 'Encaissement rapproché',
  reversed: 'Encaissement annulé', requirement_removed: 'Paiement à la livraison retiré', discrepancy: 'Écart constaté',
};
const methodLabels = { cash: 'Espèces', mobile_money: 'Mobile Money', card: 'Carte', bank_transfer: 'Virement', other: 'Autre' };
const proofLabels = { photo: 'Photo', signature: 'Signature', otp: 'Code de remise', pin: 'Code de remise' };

function fontFile(weight) {
  const file = path.join(FONT_DIR, `traxosans-${weight}.ttf`);
  return fs.existsSync(file) ? file : null;
}

function buildIncidentPdf({ dossier, company, generatedBy, generatedAt, manifestSha256, timezone = 'Africa/Porto-Novo' }) {
  const incident = dossier.incident;
  const fmtDate = (value) => (value ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(value)) : '—');
  const fmtMoney = (value, currency = 'XOF') => (value == null ? '—' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: currency || 'XOF', maximumFractionDigits: 0 }).format(Number(value)).replace(/ /g, ' '));
  const orderRef = incident.order_reference || `Commande n° ${incident.order_id}`;

  const doc = new PDFDocument({
    size: 'A4', margins: { top: 56, bottom: 64, left: 50, right: 50 }, bufferPages: true,
    info: { Title: `Dossier incident INC-${incident.id}`, Author: company.name || 'TRAXO', Creator: 'TRAXO', Subject: orderRef },
  });
  const regular = fontFile(400);
  const medium = fontFile(500);
  const bold = fontFile(700);
  if (regular) doc.registerFont('R', regular); else doc.registerFont('R', 'Helvetica');
  if (medium) doc.registerFont('M', medium); else doc.registerFont('M', 'Helvetica-Bold');
  if (bold) doc.registerFont('B', bold); else doc.registerFont('B', 'Helvetica-Bold');

  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const L = doc.page.margins.left;
  const ensure = (h) => { if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage(); };

  // En-tête
  if (fs.existsSync(LOGO)) doc.image(LOGO, L, 44, { height: 22 });
  doc.font('R').fontSize(9).fillColor(MUTED).text(company.name || '', L, 48, { width: W, align: 'right' });
  doc.moveTo(L, 80).lineTo(L + W, 80).lineWidth(0.8).strokeColor(LINE).stroke();
  doc.y = 100;

  doc.font('R').fontSize(9).fillColor(MUTED).text('DOSSIER D’INCIDENT', L, doc.y, { characterSpacing: 1 });
  doc.moveDown(0.3);
  doc.font('B').fontSize(22).fillColor(INK).text(`INC-${incident.id} · ${categoryLabels[incident.category] || incident.category}`, { width: W });
  doc.moveDown(0.4);
  // Pastilles statut / gravité
  const pills = [
    [incident.status === 'resolved' ? 'Résolu' : 'Ouvert', incident.status === 'resolved' ? '#166534' : RED, incident.status === 'resolved' ? '#ebf7ef' : '#fdeeee'],
    [`Gravité ${String(severityLabels[incident.severity] || incident.severity).toLowerCase()}`, INK, SOFT],
    [orderRef, INK, SOFT],
  ];
  let px = L;
  const py = doc.y;
  doc.font('M').fontSize(9);
  for (const [label, color, bg] of pills) {
    const w = doc.widthOfString(label) + 16;
    doc.roundedRect(px, py, w, 18, 9).fill(bg);
    doc.fillColor(color).text(label, px + 8, py + 4.5, { lineBreak: false });
    px += w + 6;
  }
  doc.y = py + 32;

  // Fiche synthétique (2 colonnes)
  const fields = [
    ['Client', [incident.customer_name, incident.customer_phone].filter(Boolean).join(' · ') || '—'],
    ['Livreur', [incident.driver_name, incident.driver_phone].filter(Boolean).join(' · ') || '—'],
    ['Commande', `${orderRef} · ${incident.order_status || '—'}`],
    ['Responsable', incident.assigned_to || 'Non attribué'],
    ['Ouvert le', `${fmtDate(incident.created_at)}${incident.opened_by ? ` par ${incident.opened_by}` : ''}`],
    ['Résolu le', incident.resolved_at ? `${fmtDate(incident.resolved_at)}${incident.resolved_by ? ` par ${incident.resolved_by}` : ''}` : '—'],
  ];
  const colW = (W - 12) / 2;
  for (let i = 0; i < fields.length; i += 2) {
    ensure(46);
    const y = doc.y;
    [fields[i], fields[i + 1]].forEach((f, k) => {
      if (!f) return;
      const x = L + k * (colW + 12);
      doc.roundedRect(x, y, colW, 40, 6).lineWidth(0.8).strokeColor(LINE).stroke();
      doc.font('R').fontSize(8).fillColor(MUTED).text(f[0].toUpperCase(), x + 10, y + 7, { width: colW - 20, characterSpacing: 0.5 });
      doc.font('M').fontSize(10).fillColor(INK).text(f[1], x + 10, y + 19, { width: colW - 20, height: 14, ellipsis: true });
    });
    doc.y = y + 48;
  }
  const destination = [incident.neighborhood, incident.landmark, incident.delivery_address].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' — ');
  ensure(40);
  doc.font('R').fontSize(8).fillColor(MUTED).text('DESTINATION', L, doc.y, { characterSpacing: 0.5 });
  doc.font('R').fontSize(10).fillColor(INK).text(destination || '—', { width: W });
  if (incident.destination_lat != null) doc.font('R').fontSize(8.5).fillColor(MUTED).text(`Position GPS : ${Number(incident.destination_lat).toFixed(5)}, ${Number(incident.destination_lng).toFixed(5)}`);

  const section = (title) => {
    ensure(60);
    doc.moveDown(1.1);
    doc.font('B').fontSize(13).fillColor(INK).text(title, L, doc.y, { width: W });
    doc.moveTo(L, doc.y + 4).lineTo(L + 28, doc.y + 4).lineWidth(2).strokeColor(RED).stroke();
    doc.moveDown(0.7);
  };
  const para = (text, opts = {}) => { doc.font(opts.font || 'R').fontSize(opts.size || 10).fillColor(opts.color || INK).text(text, L, doc.y, { width: W, lineGap: 2 }); };
  // Liste chronologique : date à gauche, contenu à droite.
  const timeline = (rows) => {
    for (const row of rows) {
      const body = [row.title, row.detail].filter(Boolean).join('\n');
      doc.font('R').fontSize(9.5);
      const bodyH = doc.heightOfString(body, { width: W - 130 });
      doc.fontSize(8.5);
      const sideH = doc.heightOfString(row.when, { width: 120 }) + (row.who ? doc.fontSize(8).heightOfString(row.who, { width: 120 }) : 0);
      const h = Math.max(24, bodyH, sideH) + 10;
      ensure(h + 4);
      const y = doc.y;
      doc.font('R').fontSize(8.5).fillColor(MUTED).text(row.when, L, y, { width: 120 });
      if (row.who) doc.font('R').fontSize(8).fillColor(MUTED).text(row.who, L, doc.y, { width: 120 });
      doc.font('M').fontSize(10).fillColor(INK).text(row.title, L + 130, y, { width: W - 130 });
      if (row.detail) doc.font('R').fontSize(9.5).fillColor('#393b40').text(row.detail, L + 130, doc.y + 1, { width: W - 130, lineGap: 1.5 });
      doc.y = Math.max(doc.y, y + h) + 2;
      doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.y += 6;
    }
  };

  section('Déclaration initiale');
  para(incident.description || '—');
  doc.font('R').fontSize(8.5).fillColor(MUTED).text(`Déclarée par ${incident.opened_by || '—'} le ${fmtDate(incident.created_at)}. Ce texte ne peut plus être modifié.`, L, doc.y + 4, { width: W });

  if (incident.resolution) {
    section('Résolution');
    para(incident.resolution);
    doc.font('R').fontSize(8.5).fillColor(MUTED).text(`Résolu par ${incident.resolved_by || '—'} le ${fmtDate(incident.resolved_at)}.`, L, doc.y + 4, { width: W });
  }

  if (dossier.holds && dossier.holds.length) {
    section('Protection des données (litige)');
    timeline(dossier.holds.map((h) => ({
      when: fmtDate(h.placed_at), who: h.placed_by || '',
      title: h.status === 'active' ? 'Données protégées' : 'Protection retirée',
      detail: [`Motif : ${h.reason}`, h.review_due_at ? `À réexaminer le ${fmtDate(h.review_due_at)}` : '', h.released_at ? `Retirée le ${fmtDate(h.released_at)}${h.released_by ? ` par ${h.released_by}` : ''}${h.release_reason ? ` — ${h.release_reason}` : ''}` : ''].filter(Boolean).join('\n'),
    })));
  }

  section('Historique certifié de l’incident');
  const chain = dossier.eventChainValid;
  para(chain === true ? 'Chaîne d’intégrité vérifiée : aucun événement n’a été modifié ni supprimé.' : chain === false ? 'Attention : la chaîne d’intégrité ne correspond pas. Le dossier doit être examiné.' : 'Aucun événement enregistré.', { size: 9, color: chain === false ? RED : MUTED });
  doc.moveDown(0.5);
  timeline((dossier.events || []).map((e) => ({
    when: fmtDate(e.created_at), who: e.actor_name,
    title: eventLabels[e.event_type] || e.event_type,
    detail: [e.body, e.event_type === 'assigned' && e.details && e.details.assignedToName ? `Responsable : ${e.details.assignedToName}` : ''].filter(Boolean).join('\n'),
  })));

  if (dossier.orderEvents && dossier.orderEvents.length) {
    section('Historique de la commande');
    timeline(dossier.orderEvents.map((e) => ({
      when: fmtDate(e.created_at), who: e.actor_name,
      title: e.from_status ? `${e.from_status} › ${e.to_status}` : e.to_status,
      detail: e.reason || '',
    })));
  }

  const payments = [...(dossier.paymentEvents || []).map((p) => ({ at: p.created_at, who: p.actor_name, title: paymentLabels[p.event_type] || p.event_type, detail: [fmtMoney(p.amount_minor, p.currency), methodLabels[p.method] || p.method, p.reference, p.reason].filter(Boolean).join(' · ') })),
    ...(dossier.paymentAdjustments || []).map((a) => ({ at: a.created_at, who: a.actor_name, title: `Ajustement (${a.adjustment_type})`, detail: [`${a.direction === 'debit' ? '−' : '+'}${fmtMoney(a.amount_minor, a.currency)}`, a.reason, a.resulting_total_minor != null ? `Nouveau total : ${fmtMoney(a.resulting_total_minor, a.currency)}` : ''].filter(Boolean).join(' · ') }))]
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  if (payments.length) {
    section('Paiement à la livraison');
    timeline(payments.map((p) => ({ when: fmtDate(p.at), who: p.who, title: p.title, detail: p.detail })));
  }

  const proofs = [...(dossier.proofs || []).map((p) => ({ at: p.verified_at || p.created_at, title: `Preuve : ${proofLabels[p.proof_type] || p.proof_type}`, detail: 'Vérifiée' })),
    ...(dossier.evidence || []).map((e) => ({ at: e.created_at, title: `Fichier : ${proofLabels[e.evidence_type] || e.evidence_type}`, detail: [`${Math.round(Number(e.byte_size || 0) / 1024)} Ko`, e.content_sha256 ? `SHA-256 ${String(e.content_sha256).slice(0, 16)}…` : '', e.superseded_at ? 'remplacé' : '', e.deleted_at ? 'supprimé' : ''].filter(Boolean).join(' · ') }))]
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  if (proofs.length) {
    section('Preuves de livraison');
    timeline(proofs.map((p) => ({ when: fmtDate(p.at), title: p.title, detail: p.detail })));
  }

  const related = (dossier.relatedIncidents || []).filter((r) => String(r.id) !== String(incident.id));
  if (related.length) {
    section('Autres incidents sur cette commande');
    timeline(related.map((r) => ({ when: fmtDate(r.created_at), title: `INC-${r.id} · ${categoryLabels[r.category] || r.category}`, detail: [r.status === 'resolved' ? 'Résolu' : 'Ouvert', r.description].filter(Boolean).join(' · ') })));
  }

  // Pied de page sur chaque page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // écrire dans la marge sans créer de page
    const y = doc.page.height - 44;
    doc.moveTo(L, y - 8).lineTo(L + W, y - 8).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.font('R').fontSize(7.5).fillColor(MUTED);
    doc.text(`Généré le ${fmtDate(generatedAt)} par ${generatedBy || '—'} · Empreinte du dossier (SHA-256) : ${manifestSha256}`, L, y, { width: W - 60, lineBreak: true, height: 22 });
    doc.text(`Page ${i + 1} / ${range.count}`, L + W - 60, y, { width: 60, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}

module.exports = { buildIncidentPdf };
