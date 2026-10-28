# Airlock

**A local coding agent that keeps your project private and asks frontier models for help without showing them your code.**

Your project stays with a model running on your machine, and that model does the work. When it gets stuck on a hard technical point, Airlock asks a frontier cloud model as an outside consultant. The question is rewritten first as a small, generic example, like the minimal reproducible example an experienced developer would post on Stack Overflow. It carries no file names, identifiers, business details or code from your project. You see the exact text before it leaves.

> **Status: preview.** The sandbox and gateway are in place, but Airlock has not yet finished the dogfooding and outside review that gate use on private code. Use it on test projects for now. See [CLAIMS.md](CLAIMS.md) for exactly what is and isn't guaranteed today.

## How it works

```
your project ──► local agent (your machine) ──► stuck on a hard point?
                                                   │
                     rewritten as a generic example │  identifiers, names, constants removed;
                     told in a fictional cover story │  checked by a deterministic gate;
                                                   ▼  shown to you for approval
                                         frontier model (consultant)
                                                   │
                     answer comes back as untrusted ▼  advice; the local agent applies it
```

- **The local agent does the work.** It reads and edits your code, runs your tests and talks only to a model server on your machine.
- **It runs in an OS sandbox.** The agent and every command it starts (Seatbelt on macOS, bubblewrap on Linux) can write only inside the project, cannot read your home directory, and have no network except Airlock's gateway. Other hosts, such as a package registry, are denied unless you allow them for the session.
- **Only the gateway holds API keys.** It runs outside the sandbox, relays the agent's model calls to fixed addresses, and runs consults. It logs everything that leaves in an encrypted, tamper-evident log.
- **Consults are abstracted.** A consult is rewritten from scratch as a minimal example in a neutral setting. Project constants and example values are changed, and the technical question is kept exactly.
- **A deterministic gate checks every outbound message.** Nothing is sent if it contains a project identifier, a project string literal, code copied from your repository, a secret, or a term you declared as a crown jewel.
- **Cover setting.** Each project gets a fictional setting, which you choose at `airlock init`. Every consult is told in it, so a history of questions doesn't point back to what you're building. The question itself never changes, and safety-critical topics never get a cover story.
- **You stay in control.**
  - By default you approve each consult.
  - With `--approve-consults jewels`, only consults that touch your declared crown jewels ask first.
  - Answers are labelled untrusted, and a refusal from the consultant is final.
- **When stuck, it asks.** If the agent keeps failing its tests, it is told to consult, so you get help when you need it rather than never or always.

More detail: [docs/how-it-works.md](docs/how-it-works.md).

## Quick start

Requires macOS or Linux, Node.js ≥ 22.21, and, for the default profile, an OpenAI-compatible local model server such as [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server` on `127.0.0.1:9931` (or set `AIRLOCK_LOCAL_URL`). On Linux the sandbox needs `bubblewrap`, `socat` and `ripgrep`.

```sh
git clone https://github.com/lemonadesaltbagel/Airlock.git && cd Airlock
npm install && npm run build
node apps/airlock/dist/main.js doctor                     # check the sandbox on this machine

cd path/to/your-test-project
node /path/to/Airlock/apps/airlock/dist/main.js init     # cover setting + crown-jewel file
export ANTHROPIC_API_KEY=...                             # your own key, used only for consults
node /path/to/Airlock/apps/airlock/dist/main.js run "fix the failing date parsing test"
```

## Commands

| Command | What it does |
|---|---|
| `airlock init` | Creates `.airlock/profile.md` (what may be revealed, plus your cover setting) and `.airlock/jewels.json` |
| `airlock run <task>` | Runs the local agent on the current project |
| `airlock run --approve-consults ask\|jewels\|auto\|never` | How consults are approved (default `ask`) |
| `airlock run --no-consult` | Never consult; everything stays local |
| `airlock run --allow-host registry.npmjs.org` | Let the sandboxed agent reach a host without asking (otherwise it asks, or denies without a terminal) |
| `airlock log` | Shows what left the machine for this project: consults, model calls, connection decisions, sandbox denials |
| `airlock doctor` | Checks that the OS sandbox blocks every known way out on this machine |
| `airlock policy <provider> <model>` | Shows the data policy Airlock has on record for a cloud model, and when it was verified |
| `airlock profiles` | Lists model profiles |

### Crown jewels

List what must never leave in `.airlock/jewels.json`:

```json
{
  "terms": ["Project Bluebird", "Acme Corp", "0.0137"],
  "files": ["src/pricing/**"],
  "descriptions": ["Our pricing rule weights demand by ..."]
}
```

Terms and copied fragments of jewel files are blocked outright. Consults about jewel files always ask you first.

## Providers and data policies

Consults use your own API key; Airlock never proxies through a subscription or a hosted service. `airlock policy` shows, per model, whether the provider trains on API data, how long it retains it, and whether zero-retention is available, with the date the policy was last verified. Policies differ per model and change over time.

## Roadmap

- [x] Local agent with workspace-confined tools and a scrubbed environment
- [x] Abstracted consults with a deterministic gate, crown jewels, cover settings and approval
- [x] OS sandbox around the whole agent (macOS Seatbelt, Linux bubblewrap)
- [x] Gateway: the only process holding cloud keys; every outbound request logged
- [x] Encrypted, tamper-evident outbound log
- [ ] Review screen for consults, connection requests and the log
- [ ] Local model server in its own no-network sandbox
- [ ] Cumulative disclosure tracking across sessions
- [ ] One-step install and hardware-tier detection

## Development

```sh
npm install
npm run check        # typecheck + tests
```

The `dev-cloud` profile runs the agent's own roles on cloud models for faster development. It sends the whole project to the cloud, so it refuses to run unless you pass `--dev-cloud` and the project contains `.airlock/dev-cloud-ok`. Never use it on private code.

## License

Apache-2.0
