# CO-AI submission status — October 27, 2026

The final Devpost submission has not been made. A bounded live Nemotron
proposal now completed end to end through the local worker and Nebius Sandbox.
The resulting diff is pending human review. A deliberately failing Sandbox
check, continuous worker hosting, video upload, and final Devpost submission
remain outstanding. Gallery images and a two-minute demo video are created.

## Verified today

- Frontend unit tests and TypeScript checks pass.
- Worker adapter tests cover the documented operation/result format, polling,
  operation failure, process signals, file integrity, and operation origins.
- Linked PostgreSQL transaction regressions verify proposal reservation,
  duplicate invocation rejection, complete-proposal claiming, success/failure
  completion, repeated revisions, stale-source rejection, and stale-run recovery.
- Review transaction regression verifies that an unverified proposal cannot be
  approved, two distinct reviewers unlock the tested gate, and rejection locks
  it again. Its synthetic execution-evidence fixture is rolled back; it is not
  a claim that a real sandbox ran.
- Two independent anonymous users pass fixture access, protected file writes,
  stale-run reconciliation, replay export, and disabled public GitHub actions.
  See `evidence/backend-acceptance.json` for the last completed check.
- Desktop/mobile browser acceptance passes shared live chat, reload persistence,
  a real replay download, prepared-request behavior, no horizontal overflow,
  and no runtime errors. See `evidence/browser-acceptance.json`.
- Migrations `0012`–`0016` and the updated `coai-agent` are deployed to the
  existing Supabase project.
- Live Nebius check at 2026-10-26 16:48 UTC: all Sandbox permissions returned
  `true`; `python:3.12-slim` resolved to immutable image
  `4fa16c8f-62a9-35a4-a4ea-07b7e8cd44ae`, now configured in the private
  mode-0600 worker env. A network-disabled disposable operation returned
  `SUCCESS`, exit code 0, `sum: 29`, no timeout, and no truncated output. The
  operation ID and sanitized result are in
  `evidence/nebius-sandbox-smoke.json`; the read-only access response is in
  `evidence/sandbox-access.json`. No model inference or queue run was made.
- The live response exposed `signal: -1` for that clean exit. The worker now
  normalizes this negative sentinel to no terminating signal; the focused
  adapter suite passes 11 tests and `node scripts/coai-worker.mjs --check`
  reports complete configuration.
- Oct 27 IST end-to-end evidence: 14 live anonymous-user/backend acceptance
  checks passed; `node scripts/coai-preflight.mjs --live` found all local and
  remote migrations, function secrets, and Edge Functions ready. One bounded
  CO-AI agent request used `nvidia/nemotron-3-super-120b-a12b` and queued run
  `0dc3937c-83de-4221-b6ef-83ef1bb2548d`. The running local worker executed
  `python -m unittest` in a disposable Sandbox; operation
  `01a1799f-0852-7794-a46b-2cd9a6ba0b32` passed with untruncated output. The
  `payments.py` diff is still pending human review. No second provider request
  was made.
- The worker-only Compose configuration now accepts the configured
  `NEBIUS_API_KEY` name (with legacy `NEBIUS_IAM_TOKEN` fallback); the local
  worker container is running. This is not an always-on remote host.
- The active Sites version is v4. Access mode is `public` (policy
  revision 2), and an unauthenticated request to the live URL returned HTTP
  200. Evidence: `evidence/public-access.json`.
- Reviewed source was pushed to public repository branch
  `fix/nebius-secret-alias` at commit `a52e84e7e16dd41ae964c7777be83656bf4d0c6d`.
  No video upload or Devpost submission has been made.
- Oct 28 media capture found that agent/meta=diff messages were rendered as
  text, hiding their linked review cards. The mapping fix passed three focused
  regressions, typecheck/build, and public browser verification. Site v4 shows
  the real diff, saved passing output, and pending review controls.
- Four actual gallery PNGs (3:2, each under 5 MB), a 2:01 narrated MP4, a silent
  captioned MP4, and captions/narration text are prepared locally in
  `~/coai-submission-media/`. The walkthrough uses the saved completed run,
  casts no review votes, and sends no new model request. Video upload remains
  pending. See `evidence/media-acceptance.json`.

## Remaining before submission

1. Run a deliberately failing sandbox command and confirm it cannot produce
   passing evidence. The real passing run above is complete.
2. Confirm the remaining Nebius credit balance and set a monetary limit while
   the Site is public. Daily request caps do not establish a dollar spending
   limit.
3. Deploy the worker to a confirmed credits-only/zero-cash host for judging;
   the current local container is temporary.
4. Verify the full judge flow from a clean browser, including two real
   reviewers, protected fixture settings, reload, and replay export.
6. Upload the created 2:01 demo to YouTube/Vimeo as public or unlisted, complete
   product feedback, and enter its final URL on Devpost.

Official rules checked October 25:
https://nebiusglobalaihackathon.devpost.com/rules . The listed deadline is
October 30, 2026 at 10:00 a.m. PDT / 10:30 p.m. IST. The owner's target remains
submission today.
