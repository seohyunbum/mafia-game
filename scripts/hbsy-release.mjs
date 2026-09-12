// Fail closed if the pinned local signer, key or distribution has drifted.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(resolve(root, 'provenance/release.json'), 'utf8'));
const pinned = JSON.parse(readFileSync(resolve(root, 'scripts/hbsy/vendor-hashes.json'), 'utf8'));
for (const [file, expected] of Object.entries(pinned.files)) {
  const bytes = readFileSync(resolve(root, 'scripts/hbsy', file));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Signer copy drifted: ' + file);
}
const command = process.argv[2] ?? 'seal';
if (!['seal', 'verify'].includes(command)) throw new Error('Expected seal or verify');
const artifactArg = process.argv.indexOf('--artifact');
const target = artifactArg >= 0 ? ['--artifact', process.argv[artifactArg + 1]] : ['--directory', config.directory];
if (target[1] === undefined) throw new Error('Missing artifact path');
const args = [resolve(root, 'scripts/hbsy/release.py'), command, ...target,
  '--project', config.project, '--index', 'provenance/index.jsonl',
  '--pubkey', '.github/hbsy-pubkey.b64', '--profile', 'public'];
if (process.argv.includes('--standalone')) args.push('--standalone');
const result = spawnSync(process.env.HBSY_PYTHON || 'python', args, { cwd: root, stdio: 'inherit', shell: false });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
