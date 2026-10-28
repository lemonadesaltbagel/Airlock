# What Airlock promises (and what it doesn't)

Airlock is a privacy tool, so this file is part of the product. It lists only claims we can
verify, and it says what is planned rather than done. If a claim here is ever false, that is a
bug of the highest severity: please report it.

## Current status: preview

The trust boundary is in place, but **Airlock makes no privacy guarantees yet**: it has not finished
the dogfooding period and outside review that gate use on private code. Today:

- **The agent runs in an OS sandbox** (Seatbelt on macOS, bubblewrap on Linux), with every command it
  starts. It can write only inside the project, cannot read your home directory, and has no network
  except Airlock's gateway. Connections to any other host are denied unless you allow them for the
  session (when asked, or with `--allow-host`). Run `airlock doctor` to check this on your machine.
- **Only the gateway holds API keys.** It runs outside the sandbox, relays the agent's own model calls
  to fixed addresses, and runs consults. The agent process and its commands never see a key.
- The `local` profile's model calls go only to a model server on this machine. The `dev-cloud`
  profiles **send your whole project to a cloud model** by design. They exist only to iterate on
  Airlock itself, and refuse to run unless you pass `--dev-cloud` and the project contains
  `.airlock/dev-cloud-ok`. Only create that marker in synthetic or public projects.
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
- **Everything that leaves is logged**: consults, model calls, connection decisions and sandbox denials
  go to an encrypted, tamper-evident log (`airlock log`).

Known gaps:

- The sandbox does not allow local servers: test suites that listen on a port fail inside it.
- On Linux, write protection covers only autorun files that exist when the session starts. Airlock checks
  the project again after every session and warns about any the agent created.
- Allowing a host allows everything sent to it. A host you allow (a package registry, say) is a channel
  the agent could use.
- Windows is not supported.

## What it does provide today

| Behaviour | How it's checked |
|---|---|
| The agent and every command it runs cannot write outside the project and the session's scratch space, and cannot read your home directory, Airlock's log or its key | `packages/sandbox/test/canary.test.ts`, `airlock doctor` |
| The sandboxed agent cannot reach the network except the gateway: direct connections, other hosts, DNS, raw TCP/UDP, SSH, loopback services and Unix sockets are blocked | `canary.test.ts`, `airlock doctor` |
| Telemetry from the agent and the tools it runs cannot leave: known telemetry endpoints are blocked, and CI checks this on macOS and Linux | `canary.test.ts`, `.github/workflows/ci.yml` |
| Files that other programs run automatically (git hooks and config, husky hooks, `.envrc`, editor and agent config, shell startup files) cannot be written by the agent; after every session Airlock reports any that changed | `canary.test.ts`, `packages/sandbox/test/autorun.test.ts` |
| The agent cannot launch other apps or script them with Apple Events (macOS) | `canary.test.ts` |
| API keys stay in the gateway: the agent process, the commands it runs and the model server never receive them | `apps/airlock/test/e2e.test.ts`, `canary.test.ts` |
| The gateway relays only the profile's own models to fixed addresses, strips any credentials the agent sends, and refuses requests without the session token | `packages/gateway/test/gateway.test.ts` |
| Consults, model calls, connection decisions and sandbox denials are logged with AES-256-GCM in an HMAC chain, so editing, reordering or removing entries is detected. The key is in the macOS Keychain or Linux Secret Service | `packages/ledger/test/ledger.test.ts`, `e2e.test.ts` |
| The agent's file tools cannot read or write outside the project directory, including through symlinks | `packages/agent/test/workspace.test.ts` |
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
| Raw source files never leave your machine through Airlock (`local` profile) | After the dogfooding period and an outside review |
| A review screen for pending consults, connection requests and the log | Planned |
| The local model server runs in its own sandbox with no network | Planned |
| Published leakage measurements for consults, with a reproducible benchmark | Planned |
| Cumulative disclosure is tracked and budgeted across sessions | Planned |

## Claims we will never make

- "Complete privacy."
- Protection for anything outside Airlock's own process tree: your other apps, IDE extensions, or
  an agent you start without Airlock.
- That a provider's data policy is what we say it is today. We show what the provider published and
  the date we checked it. Policies change.
