// Read-only provider checks. Does not create images, execute code, or call inference.
import fs from 'node:fs';
process.loadEnvFile('worker/.env.worker');
const key = process.env.NEBIUS_API_KEY || process.env.NEBIUS_IAM_TOKEN;
const project = process.env.NEBIUS_PROJECT_ID;
if (!key || !project) throw new Error('Fill NEBIUS_API_KEY and NEBIUS_PROJECT_ID in worker/.env.worker first');
const base = process.env.NEBIUS_SANDBOX_BASE_URL ?? 'https://api.tokenfactory.nebius.com/sandboxes/v1';
if (!base.startsWith('https://')) throw new Error('Sandbox base URL must use HTTPS');
const imageTag = 'python:3.12-slim';
const result = { checked_at: new Date().toISOString(), execution_attempted: false, inference_attempted: false };
async function get(url, headers) {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Provider read failed: HTTP ${response.status}`);
  return response.json();
}
try {
  const headers = { Authorization: `Bearer ${key}`, Project: project };
  const auth = await get(`${base.replace(/\/$/, '')}/whoami`, headers);
  result.permissions = auth.permissions;
  result.limits = auth.limits;
  result.token_expiration = auth.token_expiration;
  const images = await get(`${base.replace(/\/$/, '')}/images?tag=${encodeURIComponent(imageTag)}&limit=1000`, headers);
  const matches = (images.images ?? []).filter(image => image.tag === imageTag && /^[0-9a-f-]{36}$/i.test(image.uuid));
  if (matches.length !== 1) throw new Error('The exact python:3.12-slim tag did not resolve to one immutable image UUID');
  result.image = { tag: imageTag, uuid: matches[0].uuid };
  const catalog = await get('https://api.tokenfactory.nebius.com/v1/models', { Authorization: `Bearer ${key}` });
  result.nemotron_models = (catalog.data ?? []).map(model => model.id).filter(id => typeof id === 'string' && /nemotron/i.test(id));
  if (process.argv.includes('--configure-image')) {
    const file = 'worker/.env.worker';
    const current = fs.readFileSync(file, 'utf8');
    const line = `NEBIUS_SANDBOX_IMAGE=${matches[0].uuid}`;
    fs.writeFileSync(file, /^NEBIUS_SANDBOX_IMAGE=.*$/m.test(current) ? current.replace(/^NEBIUS_SANDBOX_IMAGE=.*$/m, line) : current + `\n${line}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    result.worker_image_configured = true;
  }
  result.outcome = 'read-only checks passed';
} catch (error) {
  result.outcome = 'failed'; result.error = error.message; process.exitCode = 1;
} finally {
  fs.mkdirSync('deploy/evidence', { recursive: true });
  fs.writeFileSync('deploy/evidence/sandbox-access.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
