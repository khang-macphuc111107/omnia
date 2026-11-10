"""Inventory every top-level extraction, without equating counts with parity."""
import json
import os
from pathlib import Path
from datetime import datetime, timezone

BASE = Path(__file__).resolve().parents[2]
ROOT = BASE / 'upstream_extractions'
SKIP = {'.git', 'node_modules', 'target', '__pycache__', '.venv', 'chrome_canary_profile'}
SOURCE = {'.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.rs', '.py', '.go', '.c', '.cpp', '.h', '.cs', '.vue', '.svelte', '.html', '.css', '.proto'}

def inventory(module):
    row = {'module': module.relative_to(ROOT).as_posix(), 'files': 0, 'sourceFiles': 0,
           'bytes': 0, 'junctions': [], 'errors': [], 'packageFiles': [], 'uiEntries': [],
           'provenance': 'unverified', 'behavioralParity': 'unverified', 'build': 'unverified'}
    package = module / 'package.json'
    if package.is_file():
        try:
            manifest = json.loads(package.read_text(encoding='utf-8-sig'))
            row['packageIdentity'] = {key: manifest.get(key) for key in ('name', 'version', 'description', 'repository', 'packageManager')}
            if str(manifest.get('name', '')).startswith('@omnia-upstream/'):
                row['provenance'] = 'omnia-wrapper-not-original-app'
        except (OSError, ValueError) as error:
            row['errors'].append({'path': str(package), 'error': str(error)})
    pending = [module]
    seen = set()
    while pending:
        folder = pending.pop()
        try:
            resolved = folder.resolve(strict=True)
            key = os.path.normcase(str(resolved))
            if key in seen:
                continue
            seen.add(key)
            for item in folder.iterdir():
                relative = item.relative_to(module).as_posix()
                if item.name in SKIP:
                    continue
                if item.is_symlink() or item.is_junction():
                    row['junctions'].append({'path': relative, 'target': str(item.resolve())})
                if item.is_dir():
                    pending.append(item)
                elif item.is_file():
                    row['files'] += 1
                    row['bytes'] += item.stat().st_size
                    row['sourceFiles'] += item.suffix.lower() in SOURCE
                    if item.name in {'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod'}:
                        row['packageFiles'].append(relative)
                    if item.name in {'index.html', 'workbench.html', 'captured.html'}:
                        row['uiEntries'].append(relative)
        except OSError as error:
            row['errors'].append({'path': str(folder), 'error': str(error)})
    return row

rows = []
for category in sorted(ROOT.iterdir()):
    if category.is_dir() and not category.name.startswith('.'):
        for module in sorted(category.iterdir()):
            if module.is_dir():
                rows.append(inventory(module))
report = {'generatedAt': datetime.now(timezone.utc).isoformat(),
          'scope': 'All category/module extraction directories',
          'excludedDirectoryNames': sorted(SKIP),
          'meaning': 'Inventory only; no count threshold, no extraction percentage, no completeness claim.',
          'counting': 'Each module is inventoried separately. Junction aliases can repeat the same files across modules; module counts must not be summed as unique recovered source.',
          'modules': rows}
output = BASE / 'artifacts/upstream-ui/ecosystem-inventory.json'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf8')
print(f'Inventoried {len(rows)} modules; {sum(len(row["errors"]) for row in rows)} read errors. Evidence: {output}')
