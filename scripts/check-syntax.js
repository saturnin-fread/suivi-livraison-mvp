#!/usr/bin/env node
// Vérifie la syntaxe de tout le JavaScript du dépôt (serveur, modules, scripts,
// pages publiques hors bibliothèques tierces). Un nouveau fichier est couvert
// sans avoir à l'ajouter à une liste.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['server', 'lib', 'scripts', 'public'];
const SKIP = new Set(['node_modules', 'vendor']);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = [path.join(ROOT, 'server.js'), ...DIRS.flatMap((d) => walk(path.join(ROOT, d), []))];
const failed = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failed.push(file);
    process.stderr.write(String(error.stderr || error.message));
  }
}
if (failed.length) {
  console.error(`Syntaxe invalide : ${failed.map((f) => path.relative(ROOT, f)).join(', ')}`);
  process.exit(1);
}
console.log(`Syntaxe OK (${files.length} fichiers).`);
