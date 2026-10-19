# Nebius × NVIDIA hackathon submission package

Status: draft for review; do not submit until the public acceptance gates below
pass. This file is a local preparation artifact, not a Devpost submission.

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

- Public demo: pending. Current Sites URL is
  `https://co-ai-demo.craftypoppy8.chatgpt.site`, but it is private and must
  not be submitted as judge-accessible until the public audience and full
  acceptance check are complete.
- Source repository: https://github.com/Deadheaven/CO-AI . The current local
  branch has uncommitted submission-readiness changes; publish the reviewed
  source only after the owner approves the exact GitHub push.
- YouTube demo under three minutes: pending recording and upload.
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

- [ ] Apply migration `0011_public_demo_guards.sql` and deploy the updated Edge
  Functions; confirm the synthetic fixture workspace loads for a new anonymous
  browser identity.
- [ ] Configure the worker only on a confirmed zero-cash host or separately
  verified AI Cloud credits. The standard Token Factory promo credit does not
  establish VM credit coverage.
- [ ] Confirm a real Nemotron model ID and a passing sandbox run; run a
  deliberately failing command and confirm it is not represented as passing
  evidence.
- [ ] Verify the public run cap, prompt cap, disabled GitHub endpoints, and
  inability to change the public workspace repository or verification command.
- [ ] Verify two independent browser sessions, approvals, replay export, and
  fresh-page reload.
- [ ] Publish the source changes only after approval of the exact GitHub diff;
  confirm the repository and license are public and the pushed source matches
  the demo.
- [ ] Change the Sites audience to public and verify judge access from a clean
  browser session.
- [ ] Record and publish the under-three-minute YouTube video; enter actual
  product feedback and final links.
- [ ] Review the final text against the live official rules immediately before
  submission. Devpost submission remains a separate user action.
