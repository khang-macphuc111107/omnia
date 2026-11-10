const fs = require('node:fs');
const path = require('node:path');

const base = path.resolve(__dirname, '../../upstream_extractions/desktop-apps');
const apps = fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory());
const rows = [];
for (const app of apps) {
  const root = path.join(base, app.name);
  const packagePath = path.join(root, 'package.json');
  if (!fs.existsSync(packagePath)) continue;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')); } catch (error) {
    rows.push({ app: app.name, status: 'package-parse-failed', error: error.message });
    continue;
  }
  const main = typeof pkg.main === 'string' ? pkg.main : null;
  const mainPath = main ? path.resolve(root, main) : null;
  rows.push({
    app: app.name,
    package: packagePath,
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    main,
    mainExists: Boolean(mainPath && fs.existsSync(mainPath)),
    mainPath,
    runtimeParity: 'unverified',
    sourceClassification: /reconstruct/i.test(String(pkg.description))
      ? 'reconstructed-package'
      : 'package-classification-unverified',
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  scope: 'desktop-apps package entrypoints; this does not launch Electron or prove IPC/backend parity',
  applications: rows,
};
if (process.argv[2]) {
  const output = path.resolve(process.argv[2]);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
for (const row of rows) console.log(`${row.app}: main=${row.mainExists ? 'present' : 'missing'} parity=${row.runtimeParity}`);
