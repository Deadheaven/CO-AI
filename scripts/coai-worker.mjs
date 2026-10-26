// Load private configuration without shell expansion or printing credentials.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
process.loadEnvFile('worker/.env.worker');
const result = spawnSync('python3', ['-m', 'coai_worker.main', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, PYTHONPATH: path.resolve('worker') },
});
if (result.error) { console.error('Could not start the Python worker:', result.error.message); }
process.exitCode = result.status ?? 1;
