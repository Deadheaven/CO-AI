# CO-AI — Devpost draft

Draft only. The first live model and passing sandbox run now have recorded
evidence, but the patch review, failing-command check, judge access, video, and
final submission gates remain. Replace pending links and confirm the
description against the recorded demo. See `SUBMISSION_STATUS.md`.

## Project name

CO-AI

## Elevator pitch

A shared coding workspace where teams review an AI-proposed patch, inspect
tests run against that exact revision, and keep a replay of their decisions.

## Track

Coding and Agentic Engineering.

## Inspiration

AI coding tools can produce convincing explanations, but a team still needs to
know what changed, which tests actually ran, and who reviewed the result.
We built CO-AI to keep those facts together in one collaborative thread.

## What it does

CO-AI brings a coding request, a proposed patch, execution results, and human
reviews into a shared workspace. In the guided payment fixture, two teammates
can inspect a retry bug, request an idempotency fix, review the resulting diff,
and export a replay of the conversation and decisions.

The intended judge flow uses an NVIDIA Nemotron model through Nebius Token
Factory to propose the change, then runs the fixed fixture tests in a disposable
Nebius Sandbox. Only the sandbox worker can attach execution evidence. Human
approvals refer to the exact patch revision; an agent's self-assessment cannot
unlock the review gate. The guided demo cannot write to GitHub.

## How we built it

The frontend uses React, TypeScript, and Vite. Supabase supplies anonymous
identity, PostgreSQL, Realtime updates, and Edge Functions. A Python worker
claims complete proposals with an expiring lease, uploads exact file bytes,
and calls the Nebius Sandbox REST API with guest networking disabled.

Proposal persistence and queue publication happen in one database transaction.
Execution evidence records the configured command and provider operation URL.
Two distinct reviewers can approve the guided fixture after passing sandbox
evidence exists, while a rejection keeps the gate closed.

## Challenges we addressed

The worker could originally claim a queue entry before its patch was saved.
We made proposal publication atomic and limited claims to complete proposals.
We also fixed duplicate-request handling, stale-run recovery, database enum
assignments, approval persistence, and collaborator updates across sessions.

## What we learned

A model response, a deployed endpoint, and an execution result establish
different things. The interface and database must preserve that distinction.
We verified the shared workspace using two independent browser sessions and
tested the review gate against success, failure, and rejection conditions.

## What's next

Broader repository support, richer verification policies, and better ways to
compare alternative proposed fixes while retaining revision-specific evidence.

## Built with

React, TypeScript, Vite, Tailwind CSS, Supabase, PostgreSQL, Python, Nebius Token
Factory, Nebius Sandboxes, NVIDIA Nemotron.

## Links

- Source: https://github.com/Deadheaven/CO-AI — publish the reviewed changes first.
- Demo: https://co-ai-demo.craftypoppy8.chatgpt.site — owner-only until public
  access is approved and verified.
- Video: pending actual recording and public YouTube upload, under three minutes.

## Testing instructions

After public access is enabled: open the demo and select “Fix duplicate charges
on retry.” Use “Try this request” to prepare the guided prompt, then send it.
Inspect the proposed `payments.py` diff and expand its sandbox evidence.
Open a second independent browser session to inspect the same result and
record a second review. Use “Export replay” to download the decision trail.

## Product feedback

Observed facts from the first live check; add the owner's qualitative feedback
before submitting:

- Token Factory: `nvidia/nemotron-3-super-120b-a12b` returned a structured
  proposal in one request. No provider error was observed in this run.
- Sandboxes: immutable image
  `4fa16c8f-62a9-35a4-a4ea-07b7e8cd44ae` ran `python -m unittest` successfully
  as operation `01a1799f-0852-7794-a46b-2cd9a6ba0b32`; output was not
  truncated. A deliberately failing operation has not been run.
- NVIDIA model: it proposed a `payments.py` idempotency change and the existing
  fixture tests passed. The diff remains pending human review.
