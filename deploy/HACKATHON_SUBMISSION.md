# Nebius × NVIDIA submission draft

## Track

Coding and Agentic Engineering

## Project description

CO-AI gives a small engineering team one shared, reviewable path from a coding
task to a tested change. Nemotron, served through Nebius Token Factory, turns a
request into a proposed patch and plan. Teammates review the change together;
CO-AI stages the exact repository revision in a disposable Nebius Token Factory
Sandbox and attaches the real test result to that revision. Human approvals are
bound to the tested patch, and the decision trail can be replayed later.

The demo uses a small fixture repository so judges can follow the entire flow:
request, model proposal, isolated test run, approval, and replay. CO-AI does not
treat a model's own test claims as execution evidence.

Before submission, revise this text to match the live demo exactly and add the
public demo URL, repository URL, and video URL. Do not claim any stage as live
until it has passed the hosted acceptance check in `NEBIUS.md`.

## Video outline (target: 2 minutes 20 seconds)

| Time | Screen action | Narration |
| --- | --- | --- |
| 0:00–0:15 | Show the CO-AI room and a small coding task. | “CO-AI helps a team see how an AI-assisted code change became safe to ship.” |
| 0:15–0:40 | Two separate sessions join; show the repo and request. | “The team shares one thread, the repository context, and the review trail.” |
| 0:40–1:05 | Start the agent run; show the planning message with the selected model ID. | “Nemotron is served by Nebius Token Factory. The model ID is visible in the run.” |
| 1:05–1:35 | Open the proposed diff and show the queued verification. | “The proposal is not treated as proof. CO-AI queues the exact revision for execution.” |
| 1:35–1:58 | Show the real Nebius Sandbox result and its operation reference. | “The worker stages the files in an isolated Nebius Sandbox and attaches the actual test result to this patch.” |
| 1:58–2:15 | Show both approvals, then replay/export. | “Approvals bind to the tested revision, and the decision trail remains inspectable.” |
| 2:15–2:20 | Show repository and public demo URL. | “CO-AI: collaborative coding with evidence you can inspect.” |

Record only after the live path works. Show the actual model ID, real sandbox
result, and a blocked failing-test case if time permits. Keep the video under
three minutes, narrate it, publish it publicly on YouTube, and use only footage
and audio you have rights to share.

## Significant changes since the submission period opened

The repository's first commit is dated September 14, 2026; the submission period
opened August 26, 2026. Check for any earlier private versions before choosing
the final answer. If there was no earlier version, state that the project was
started during the submission period. If it did predate the period, describe
the substantial changes made after August 26, using committed features and live
demo evidence rather than planned work.

## Required links and feedback

- Public demo: TODO after deployment
- Public source repository: TODO after remote review and publication
- YouTube demo (under three minutes): TODO after recording
- Nebius Token Factory feedback: write from actual use
- Nebius Sandboxes / AI Cloud feedback: write from actual use
- NVIDIA Nemotron feedback: write from actual use
