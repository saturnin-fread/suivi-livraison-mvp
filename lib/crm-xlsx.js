'use strict';

// Dependency-free XLSX (OOXML SpreadsheetML) writer for CRM exports.
//
// It intentionally produces the smallest possible spreadsheet that Excel and
// LibreOffice open: no shared strings, no styles, no macros, no formulas, no
// external links. Every untrusted value is written as an inline string after
// passing through the export contract's formula neutralization, so a cell that
// starts with '=', '+', '-', '@' (or their full-width variants) cannot execute
// when the recipient opens the file. Numbers we produce ourselves stay numeric.
//
// The package is a store-only (uncompressed) ZIP built by hand, which keeps the
// worksheet XML verbatim in the artifact — easy to audit and to test without an
// unzip dependency.

const {
  OPERATIONAL_LIMITS,
  EXCEL_LIMITS,
  ExportContractError,
  neutralizeSpreadsheetText,
  validateVolume,
  sha256Hex,
} = require('./crm-export-contract');

const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function columnRef(index) {
  let n = index;
  let ref = '';
  do {
    ref = String.fromCharCode(65 + (n % 26)) + ref;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return ref;
}

// Escapes XML text and drops characters XML 1.0 forbids (control chars other
// than tab, LF, CR). NUL is already rejected upstream by neutralizeSpreadsheetText.
function escapeXmlText(value) {
  let out = '';
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (char === '&') out += '&amp;';
    else if (char === '<') out += '&lt;';
    else if (char === '>') out += '&gt;';
    else out += char;
  }
  return out;
}

function renderCell(ref, value) {
  if (value === null || value === undefined || value === '') {
    return `<c r="${ref}"/>`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ExportContractError('INVALID_CELL_VALUE', `Valeur numérique non finie en ${ref}.`);
    }
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  if (typeof value === 'bigint') {
    return `<c r="${ref}"><v>${value.toString()}</v></c>`;
  }
  // Everything else (strings, booleans, dates already formatted upstream) is an
  // untrusted text cell: neutralize formula triggers, then XML-escape.
  const text = neutralizeSpreadsheetText(typeof value === 'string' ? value : String(value));
  if (typeof text === 'string' && text.length > EXCEL_LIMITS.maxCharactersPerCell) {
    throw new ExportContractError('CELL_TOO_LONG', `Une cellule dépasse ${EXCEL_LIMITS.maxCharactersPerCell} caractères en ${ref}.`);
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(text)}</t></is></c>`;
}

function renderRow(rowNumber, values) {
  const cells = values.map((value, index) => renderCell(`${columnRef(index)}${rowNumber}`, value));
  return `<row r="${rowNumber}">${cells.join('')}</row>`;
}

function buildSheetXml(columns, rows, headerLabels) {
  const header = Array.isArray(headerLabels) && headerLabels.length === columns.length ? headerLabels : columns;
  const parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'];
  parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>');
  parts.push(renderRow(1, header));
  rows.forEach((row, index) => {
    const values = columns.map((column) => (row ? row[column] : null));
    parts.push(renderRow(index + 2, values));
  });
  parts.push('</sheetData></worksheet>');
  return parts.join('');
}

function sanitizeSheetName(dataset, index, total) {
  const base = String(dataset).replace(/[:\\/?*[\]]/g, '_').slice(0, 24) || 'export';
  const name = total > 1 ? `${base}-${index + 1}` : base;
  return name.slice(0, 31);
}

// --- Minimal store-only ZIP container ---------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0 ^ -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function zipStore(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const dataBytes = Buffer.from(file.data, 'utf8');
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // method: store
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBytes, dataBytes);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(0, 10); // method: store
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0x21, 14); // mod date
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra len
    centralHeader.writeUInt16LE(0, 32); // comment len
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + dataBytes.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localSection = Buffer.concat(localParts);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localSection.length, 16);
  end.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([localSection, centralDirectory, end]);
}

// --- Public API --------------------------------------------------------------

function buildWorkbook(contract, rows, options = {}) {
  if (!contract || !Array.isArray(contract.columns) || contract.columns.length === 0) {
    throw new ExportContractError('INVALID_CONTRACT', 'Le contrat d’export doit porter des colonnes.');
  }
  if (!Array.isArray(rows)) {
    throw new ExportContractError('INVALID_ROWS', 'Les lignes d’export doivent être un tableau.');
  }
  const columns = contract.columns;
  // En-têtes localisés (facultatif) ; repli sur les clés techniques.
  const headerLabels = Array.isArray(options.headerLabels) && options.headerLabels.length === columns.length
    ? options.headerLabels
    : columns;
  const maxPerSheet = OPERATIONAL_LIMITS.maxDataRowsPerWorksheet;

  const chunks = [];
  for (let i = 0; i < rows.length; i += maxPerSheet) {
    chunks.push(rows.slice(i, i + maxPerSheet));
  }
  if (chunks.length === 0) chunks.push([]);

  const sheetXmls = chunks.map((chunk) => buildSheetXml(columns, chunk, headerLabels));
  const rowsPerWorksheet = chunks.map((chunk) => chunk.length);
  const estimatedBytes = sheetXmls.reduce((total, xml) => total + Buffer.byteLength(xml, 'utf8'), 0);

  // Refuse an over-limit export before spending memory on the container. No
  // silent truncation: the contract says reduce the period or filters instead.
  validateVolume({ totalRows: rows.length, rowsPerWorksheet, estimatedBytes });

  const sheetNames = chunks.map((_, index) => sanitizeSheetName(contract.dataset || 'export', index, chunks.length));

  const sheetEntries = sheetNames.map((name, index) => ({
    name,
    partName: `xl/worksheets/sheet${index + 1}.xml`,
    relId: `rId${index + 1}`,
    xml: sheetXmls[index],
  }));

  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    ...sheetEntries.map((sheet) => (
      `<Override PartName="/${sheet.partName}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )),
    '</Types>',
  ].join('');

  const rootRels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    '</Relationships>',
  ].join('');

  const workbookXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>',
    ...sheetEntries.map((sheet, index) => (
      `<sheet name="${escapeXmlText(sheet.name)}" sheetId="${index + 1}" r:id="${sheet.relId}"/>`
    )),
    '</sheets></workbook>',
  ].join('');

  const workbookRels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...sheetEntries.map((sheet, index) => (
      `<Relationship Id="${sheet.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    )),
    '</Relationships>',
  ].join('');

  const files = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    ...sheetEntries.map((sheet) => ({ name: sheet.partName, data: sheet.xml })),
  ];

  const buffer = zipStore(files);
  if (buffer.length > OPERATIONAL_LIMITS.maxArtifactBytes) {
    throw new ExportContractError('EXPORT_TOO_LARGE', 'Le fichier généré dépasse la taille maximale autorisée.', {
      limitBytes: OPERATIONAL_LIMITS.maxArtifactBytes,
    });
  }

  return {
    buffer,
    contentType: CONTENT_TYPE,
    totalRows: rows.length,
    worksheetCount: chunks.length,
    artifactBytes: buffer.length,
    artifactSha256: sha256Hex(buffer),
  };
}

module.exports = {
  CONTENT_TYPE,
  buildWorkbook,
  columnRef,
  escapeXmlText,
  crc32,
};
