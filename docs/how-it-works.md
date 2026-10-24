# How Airlock works

Airlock splits a coding agent in two. A **local model** holds your whole project and does all the work. A **frontier cloud model** is consulted only as an outside expert, through questions that are rewritten so they don't describe your project.

## What leaves your machine, and what doesn't

| | Leaves the machine? |
|---|---|
| Your source code, files, data | No: the local agent reads them; consults never include them |
| Project names, identifiers, string literals, comments | No: removed by the rewrite, enforced by the gate |
| Crown jewels you declare | No: blocked outright, and consults about them always ask you |
| The technical question behind a consult | Yes, as a generic example in a fictional setting |
| The programming language and libraries you use | Yes: generic technology makes answers better and reveals little |
| That you use the provider, when, and how often | Yes: visible to any API provider |

## The consult path

1. **The local agent asks for help.** When it hits a hard problem (an algorithm, a numerical or timing subtlety, concurrency, a library's exact semantics), it calls `consult_expert` with the problem in full project terms. If it keeps failing its tests, Airlock tells it to consult.
2. **A separate local step rewrites the question.** It never sees the consultant's answers, so an answer can't steer it into revealing more. It:
   - keeps the technical crux;
   - re-synthesizes a minimal code example from scratch with neutral names;
   - changes the project's constants and example values;
   - tells the story in your project's cover setting.
3. **A deterministic gate checks the exact outbound text.** No model is involved. It blocks:
   - project identifiers in any casing;
   - project string literals;
   - text copied from the repository (63+ characters) or from crown-jewel files (31+ characters);
   - declared jewel terms;
   - secrets: keys, tokens, emails, home paths, private IPs.

   Standard-library and framework names pass. If anything is caught, the question is rewritten (up to twice) or not sent.
4. **You approve.** By default you see the exact text and confirm. Consults about crown-jewel files always ask, whatever the approval mode.
5. **The answer comes back as untrusted advice.** The local agent maps it back onto the real code, applies it with its normal tools and verifies it with your tests. Commands or instructions in an answer are never executed directly.
6. **Refusals are final.** If the consultant declines a question, Airlock does not rephrase it, split it up, or send it elsewhere; consults stop for that session.

## Cover settings

Abstraction removes names and code, but the *shape* of the technical questions can still hint at what a project does, especially across many questions over time. Airlock therefore tells every consult from a project in the same fictional setting.

- `airlock init` offers three settings from a neutral pool. Pick the one *least* like your project, because a setting that resembles it can give the mechanism away.
- The setting is never derived from your code.
- The technical question is unchanged.
- Questions about security exploitation, malware, weapons or biological/chemical agents never get a cover story.
- Edit or remove the setting in `.airlock/profile.md` at any time.

## Providers

You bring your own API key; consults go directly from your machine to the provider. Providers differ, per model, in whether they train on API data, how long they keep it, and whether zero-retention is available. `airlock policy <provider> <model>` shows what Airlock has on record and when it was last verified.

## Limits

- **There is no OS sandbox yet.** Commands the agent runs have your user's permissions, so Airlock is not ready for private code. The sandbox and egress gateway are next on the roadmap.
- **The rewrite is done by a model.** The gate catches literal leaks; a paraphrase of a distinctive idea can still get through.
- **Usage metadata is visible to the provider:** that you made requests, when, and how large they were.
- **Nothing outside Airlock's own process tree is covered.**

See [CLAIMS.md](../CLAIMS.md) for the full list of what Airlock does and does not promise.
