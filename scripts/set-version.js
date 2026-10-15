const fs = require('fs');
const path = require('path');

const rawVersion = process.argv[2];

if (!rawVersion) {
  console.error('Error: Version argument is required (e.g. node scripts/set-version.js 1.0.0 or v1.0.0)');
  process.exit(1);
}

// Strip leading 'v' or 'refs/tags/v' if passed from git ref
const cleanVersion = rawVersion.replace(/^refs\/tags\//, '').replace(/^v/, '').trim();

if (!cleanVersion) {
  console.error(`Error: Invalid version parsed from '${rawVersion}'`);
  process.exit(1);
}

const rootDir = path.resolve(__dirname, '..');

const filesToUpdate = [
  {
    path: path.join(rootDir, 'package.json'),
    updater: data => ({ ...data, version: cleanVersion }),
  },
  {
    path: path.join(rootDir, 'vscode-extension', 'package.json'),
    updater: data => ({ ...data, version: cleanVersion }),
  },
  {
    path: path.join(rootDir, 'browser-extension', 'package.json'),
    updater: data => ({ ...data, version: cleanVersion }),
  },
  {
    path: path.join(rootDir, 'browser-extension', 'manifest.json'),
    updater: (data) => {
      // Chrome extension manifest version must only contain numbers and dots (e.g. "1.2.3")
      const manifestVer = cleanVersion.split('-')[0];
      return { ...data, version: manifestVer };
    },
  },
];

console.log(`Setting version to: ${cleanVersion}`);

for (const file of filesToUpdate) {
  if (fs.existsSync(file.path)) {
    const raw = fs.readFileSync(file.path, 'utf8');
    const json = JSON.parse(raw);
    const updated = file.updater(json);
    fs.writeFileSync(file.path, JSON.stringify(updated, null, 2) + '\n', 'utf8');
    console.log(`Updated: ${path.relative(rootDir, file.path)} -> ${updated.version}`);
  } else {
    console.warn(`Warning: File not found: ${file.path}`);
  }
}

console.log('Version synchronization complete.');
