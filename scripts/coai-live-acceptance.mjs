// Browser-equivalent backend checks. No model or sandbox request is made.
// Run from the project root with the browser-safe .env.local configured.
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.local');
const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) throw new Error('Browser configuration is missing');
const result = { checked_at: new Date().toISOString(), checks: {}, inference: 'not attempted', sandbox: 'not attempted' };
function check(name, ok) {
  result.checks[name] = Boolean(ok);
  if (!ok) throw new Error(`Acceptance failed: ${name}`);
}
const clients = [0, 1].map(() => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
try {
  const users = [];
  for (const [i, client] of clients.entries()) {
    const { data, error } = await client.auth.signInAnonymously();
    check(`anonymous_user_${i + 1}`, !error && Boolean(data.user?.id));
    users.push(data.user.id);
    const profile = await client.from('members').upsert({ id: data.user.id, display_name: `Acceptance reviewer ${i + 1}`, color: '#93c5fd' });
    check(`profile_${i + 1}`, !profile.error);
  }
  check('independent_identities', users[0] !== users[1]);
  const { data: workspace, error: workspaceError } = await clients[0].from('workspaces').select('id,verification_command').eq('public_demo', true).single();
  check('public_fixture_workspace', !workspaceError && workspace.verification_command === 'python -m unittest');
  const { data: thread, error: threadError } = await clients[0].from('threads').select('id').eq('workspace_id', workspace.id).eq('share_code', 'DEMO-COAI').single();
  check('public_fixture_thread', !threadError && Boolean(thread));
  result.thread_id = thread.id;
  for (const [i, client] of clients.entries()) {
    const membership = await client.from('thread_members').upsert({ thread_id: thread.id, member_id: users[i] });
    check(`membership_${i + 1}`, !membership.error);
  }
  const files = await clients[1].from('files').select('path,content').eq('thread_id', thread.id);
  check('second_user_reads_fixture', !files.error && ['payments.py', 'test_payments.py'].every(path => files.data.some(file => file.path === path)));
  const testFile = files.data.find(file => file.path === 'test_payments.py');
  const forbidden = await clients[1].from('files').update({ content: testFile.content }).eq('thread_id', thread.id).eq('path', 'test_payments.py').select('id');
  check('fixture_files_cannot_be_changed_by_visitors', Boolean(forbidden.error) || forbidden.data?.length === 0);
  const expired = await clients[0].rpc('expire_stale_verification_runs');
  if (expired.error) result.reconciliation_error = { code: expired.error.code, message: expired.error.message };
  check('stale_run_reconciliation', !expired.error);
  result.expired_runs = expired.data;
  const replay = await clients[1].functions.invoke('coai-replay', { body: { threadId: thread.id } });
  check('second_user_exports_replay', !replay.error && replay.data?.schema === 'co-ai.replay.v1');
  const disabled = await clients[0].functions.invoke('coai-gh', { body: { threadId: thread.id, action: 'import' } });
  check('public_github_connector_disabled', disabled.data?.reason === 'public-demo-disabled' || disabled.error?.context?.status === 403);
  result.outcome = 'passed';
} catch (error) {
  result.outcome = 'failed';
  result.error = error.message;
  process.exitCode = 1;
} finally {
  for (const client of clients) await client.removeAllChannels();
  fs.mkdirSync('deploy/evidence', { recursive: true });
  fs.writeFileSync('deploy/evidence/backend-acceptance.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
