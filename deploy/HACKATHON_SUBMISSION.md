# Nebius × NVIDIA hackathon submission package

Status: draft for review; do not submit until the public acceptance gates below
pass. This file is a local preparation artifact, not a Devpost submission.

October 27 update: see [SUBMISSION_STATUS.md](SUBMISSION_STATUS.md) and
`evidence/` for verified deployment and acceptance results. One bounded live
Nemotron proposal and passing queue-backed Sandbox run now work end to end;
the resulting diff awaits human review. The Site is now public; the remaining
submission gates are listed in the status file.

## Track

Coding and Agentic Engineering.

## Project title

CO-AI — evidence-first collaborative coding

## Project description

CO-AI gives an engineering team one shared trail from a coding request to a
reviewable, tested patch. A Nemotron model served through Nebius Token Factory
proposes a plan and code change. CO-AI sends the exact proposed revision to a
disposable Token Factory Sandbox and attaches the command result to that
revision. Teammates can inspect the diff, discuss it, approve it, and export a
replay of the decision trail. The agent's own test claims never count as
execution evidence. The judge demo uses a small synthetic payment fixture and
has no connection to an external GitHub repository; GitHub write actions are
disabled in the public build.

Use this wording only after the hosted model and sandbox acceptance checks
pass. Until then, say that the live flow is still being prepared.

## Links and submission fields

- Public demo: https://co-ai-demo.craftypoppy8.chatgpt.site (public Site v4;
  full judge-flow browser acceptance remains pending).
- Source repository: https://github.com/Deadheaven/CO-AI/tree/fix/nebius-secret-alias
  (reviewed branch at commit `a52e84e`).
- YouTube demo under three minutes: 2:01 video created; upload pending.
- License: Apache-2.0 (`LICENSE`).
- Nebius Token Factory feedback: fill in after actual judge-path use.
- Token Factory Sandboxes feedback: fill in after actual passing and failing
  sandbox runs.
- NVIDIA Nemotron feedback: fill in after actual inference use.

## Demo recording outline (about 2 minutes 20 seconds)

| Time | Screen action | Narration |
| --- | --- | --- |
| 0:00–0:15 | Open the public fixture workspace and show its synthetic payment repository. | “CO-AI helps a team inspect how an AI-assisted change was proposed, tested, and reviewed.” |
| 0:15–0:35 | In two browser sessions, open `DEMO-COAI`; show the failing retry scenario. | “The demo uses a small synthetic repository, so the workflow is easy to follow and isolated from real code.” |
| 0:35–1:00 | Ask Nemotron through Nebius Token Factory to make the retry-safe change; show the model ID. | “Nemotron proposes the change and plan. Its own test claims are not trusted as proof.” |
| 1:00–1:30 | Inspect the diff and the queued sandbox run. | “The exact patch is sent to a disposable Token Factory Sandbox for verification.” |
| 1:30–1:55 | Show the passing result attached to that revision; optionally show the failing case. | “CO-AI records the real command result against this patch revision.” |
| 1:55–2:15 | Show approvals and replay export. | “The team reviews the evidence and keeps a replayable decision trail. The public demo cannot write to GitHub.” |
| 2:15–2:20 | Show repository and public demo links. | “CO-AI: collaborative coding with evidence you can inspect.” |

Record only after the live acceptance check passes. Show the actual model ID,
sandbox operation evidence, and test result. Keep the video under three minutes,
make it public on YouTube, and use footage and audio you have rights to share.

## Significant changes since the project period opened

The current Git history begins on September 14, 2026, after the August 26
opening date. This supports saying that this repository's project work began
during the submission period; check for an earlier private version before
making that claim final. Changes visible in the repository include the live
agent loop, revision-bound human approvals, executor-backed verification,
replay export, and split frontend/worker deployment support. Describe only the
features that pass the hosted acceptance checks as working demo capabilities.

## Final review gates

- [x] Apply migration `0011_public_demo_guards.sql` and deploy the updated Edge
  Functions; confirm the synthetic fixture workspace loads for a new anonymous
  browser identity.
- [x] Repair and deploy the proposal/verification queue, stale-run recovery,
  transactional reviews, and realtime collaboration updates (migrations
  `0012`–`0016`). Verify source-revision checks and review gates in rolled-back
  PostgreSQL transactions.
- [x] Verify two fresh browser sessions, shared live chat, reload persistence,
  replay download, desktop/mobile layout, and protected fixture files. The
  inference/worker execution checks below remain separate.
- [ ] Configure the worker only on a confirmed zero-cash host or separately
  verified AI Cloud credits. The standard Token Factory promo credit does not
  establish VM credit coverage.
- [x] Confirm a real Nemotron model ID and one passing queue-backed sandbox
  run; see `evidence/queue-backed-nemotron-run.json`.
- [ ] Run a deliberately failing command and confirm it is not represented as
  passing evidence.
- [ ] Verify the public run cap, prompt cap, disabled GitHub endpoints, and
  inability to change the public workspace repository or verification command.
- [ ] Verify two independent browser sessions, approvals, replay export, and
  fresh-page reload.
- [x] Push the reviewed source to the public repository branch
  `fix/nebius-secret-alias` at commit `a52e84e`; the repository and license are
  public.
- [x] Change the Sites audience to public; an unauthenticated request returned
  HTTP 200. Full judge-flow browser acceptance remains pending.
- [x] Create four actual gallery screenshots and a 2:01 captioned demo video.
- [ ] Upload the video to YouTube/Vimeo; enter actual product feedback and links.
- [ ] Review the final text against the live official rules immediately before
  submission. Devpost submission remains a separate user action.
