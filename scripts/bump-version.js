#!/usr/bin/env node
// =========================================================
// scripts/bump-version.js
//
// Bumps the version everywhere it's recorded, so the source
// files stay the single source of truth (no build step, no
// dependencies — plain Node, works locally and in CI):
//   - js/core/version.js   (APP_VERSION shown in the sidebar)
//   - version.json         (fetched at runtime to detect updates)
//   - sw.js                (CACHE_NAME, so old caches are dropped)
//   - CHANGELOG.md         (a dated entry is prepended)
//
// Usage:
//   node scripts/bump-version.js [patch|minor|major]
// Defaults to "patch". This is exactly what the GitHub Action
// runs automatically on every push to main.
// =========================================================
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const versionJsPath = path.join(root, 'js/core/version.js');
const versionJsonPath = path.join(root, 'version.json');
const swPath = path.join(root, 'sw.js');
const changelogPath = path.join(root, 'CHANGELOG.md');

const bumpType = process.argv[2] || 'patch';
if (!['patch', 'minor', 'major'].includes(bumpType)) {
  console.error(`Unknown bump type "${bumpType}". Use patch, minor, or major.`);
  process.exit(1);
}

function readCurrentVersion() {
  const content = fs.readFileSync(versionJsPath, 'utf8');
  const match = content.match(/APP_VERSION = '(\d+)\.(\d+)\.(\d+)'/);
  if (!match) throw new Error('Could not find APP_VERSION in js/core/version.js');
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function bump({ major, minor, patch }, type) {
  if (type === 'major') return { major: major + 1, minor: 0, patch: 0 };
  if (type === 'minor') return { major, minor: minor + 1, patch: 0 };
  return { major, minor, patch: patch + 1 };
}

const current = readCurrentVersion();
const next = bump(current, bumpType);
const nextStr = `${next.major}.${next.minor}.${next.patch}`;
const today = new Date().toISOString().slice(0, 10);

// version.js
let vjs = fs.readFileSync(versionJsPath, 'utf8');
vjs = vjs.replace(/APP_VERSION = '[\d.]+'/, `APP_VERSION = '${nextStr}'`);
vjs = vjs.replace(/BUILD_DATE = '[\d-]+'/, `BUILD_DATE = '${today}'`);
fs.writeFileSync(versionJsPath, vjs);

// version.json
fs.writeFileSync(versionJsonPath, JSON.stringify({ version: nextStr, buildDate: today }, null, 2) + '\n');

// sw.js — bump the cache name so the previous cache is dropped on activate
let sw = fs.readFileSync(swPath, 'utf8');
sw = sw.replace(/const CACHE_NAME = 'returns-system-v[\d.]+'/, `const CACHE_NAME = 'returns-system-v${nextStr}'`);
fs.writeFileSync(swPath, sw);

// CHANGELOG.md
// The arguments after the bump type become the entry text — CI passes
// every "سجل:" line from the commits being released, so the entries say
// what actually changed instead of a generic "تحديث تلقائي.".
// Every argument after the bump type is one changelog line, so a pull
// request carrying several changes lists them rather than merging them
// into one sentence.
const notes = process.argv.slice(3).map(n => String(n).trim()).filter(Boolean);
if (!notes.length) notes.push('تحديث تلقائي.');
const entry = `## ${nextStr} — ${today}\n\n${notes.map(n => `- ${n}`).join('\n')}\n\n`;
const existingChangelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '# سجل الإصدارات\n\n';
const headerEnd = existingChangelog.indexOf('\n\n') + 2;
const updatedChangelog = existingChangelog.slice(0, headerEnd) + entry + existingChangelog.slice(headerEnd);
fs.writeFileSync(changelogPath, updatedChangelog);

console.log(nextStr);
