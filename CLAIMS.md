# What Airlock promises (and what it doesn't)

Airlock is a privacy tool, so this file is part of the product. It lists only claims we can
verify, and it says what is planned rather than done. If a claim here is ever false, that is a
bug of the highest severity: please report it.

## Current status: preview

**Airlock makes no privacy guarantees yet.** Today:

- There is **no sandbox**. Commands the agent runs have your user account's full permissions,
  including network access and every file you can read.
- The `dev-cloud` profile **sends your whole project to a cloud model** by design. It exists only
  to iterate on Airlock itself, and it refuses to run unless you pass `--dev-cloud` and the project
  contains `.airlock/dev-cloud-ok`. Only create that marker in synthetic or public projects.
- The `local` profile sends the agent's own LLM requests only to a model server on this machine. That
  is checked in code, as a guard against misconfiguration, but it is not yet enforced by the operating
  system.
- **Consults** (`consult_expert`) go to a cloud model in every profile. Before sending, Airlock rewrites
  the question as a generic example, runs a deterministic check for project identifiers, string
  literals, copied code, secrets and declared crown jewels, and (by default) shows you the exact text
  and asks before sending. The rewrite is done by a model and the check catches only literal leaks:
  a paraphrase of your idea can still get through.
- **Cover setting.** `airlock init` gives each project a fictional cover setting, drawn at random and
  never derived from your code. Consult questions are told in that setting so that a history of
  questions does not point back to your project. The technical question itself is never changed, and
  topics such as security exploitation, malware, weapons or biological/chemical agents are never given
  a cover story. You can edit or remove it in `.airlock/profile.md` (`airlock init --force --no-persona`).
- The consult log is plain JSON under `~/.airlock/dev-logs/`, not yet encrypted.

Use it only on test projects.

## What it does provide today

| Behaviour | How it's checked |
|---|---|
| The agent's file tools cannot read or write outside the project directory, including through symlinks | `packages/agent/test/workspace.test.ts` |
| The agent cannot write `.airlock/` (your policy files and the dev-cloud marker), `.git/hooks` or `.git/config` | `workspace.test.ts`, `tools.test.ts` |
| Commands the agent runs do not inherit API keys or other secrets from Airlock's environment | `tools.test.ts` |
| Under the `local` profile, the agent refuses to send LLM requests to anything but loopback | `guard.test.ts`, `agent.test.ts` |
| Requests identify honestly as `airlock/<version>`, with no extra platform metadata or attribution headers | `packages/agent/src/identity.ts` |
| Data-policy summaries for supported providers record when they were last verified and warn when that's more than 90 days ago | `packages/policy-data/test/policy.test.ts` |
| Nothing is sent to the consultant if the final outbound text contains a project identifier, project string literal, ≥63 characters copied from the repo, ≥31 characters copied from a crown-jewel file, a declared jewel term or a recognised secret | `packages/consult/test/gate.test.ts`, `service.test.ts` |
| After the consultant refuses a question, no further consults are sent that session (no rephrasing or re-routing) | `service.test.ts` |
| A consult about a file you declared as a crown jewel (`.airlock/jewels.json`) is never sent without asking you, whatever the approval mode; with consults disabled it is never sent | `service.test.ts` |
| Consultant answers reach the agent wrapped and labelled as untrusted | `service.test.ts`, `packages/broker/test/abstractor.test.ts` |

## Planned claims

| Claim | When |
|---|---|
| Raw source files never leave your machine through Airlock (`local` profile) | When the OS sandbox and egress gateway ship |
| Every outbound message is shown to you and logged in an encrypted, tamper-evident log | With the egress gateway |
| No telemetry; CI fails if Airlock or its bundled tools phone home | With the egress gateway |
| Published leakage measurements for consults, with a reproducible benchmark | Planned |
| Cumulative disclosure is tracked and budgeted across sessions | Planned |

## Claims we will never make

- "Complete privacy."
- Protection for anything outside Airlock's own process tree: your other apps, IDE extensions, or
  an agent you start without Airlock.
- That a provider's data policy is what we say it is today. We show what the provider published and
  the date we checked it. Policies change.
