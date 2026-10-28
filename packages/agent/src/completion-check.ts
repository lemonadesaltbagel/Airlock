import type { Agent } from "@earendil-works/pi-agent-core";

/**
 * Small local models often stop as soon as the existing tests pass, with the task's actual
 * requirement unmet. When the agent is about to finish, Airlock asks it once to check its work
 * against the task itself. A local message to the local model; nothing is sent anywhere.
 */
export const COMPLETION_CHECK = (opts: { consult: boolean }) =>
  [
    "[Airlock] Before you finish, verify the fix against the task itself, not only the existing tests:",
    "1. Re-read the task and list every behaviour it expects: the exact example inputs and outputs, error messages, edge cases and any speed requirement.",
    "2. For each one, run a check that exercises it. Reproduce the task's own example, and add a regression test for it if there is none.",
    "3. Run the full test suite.",
    `If any check fails, fix the code and check again${opts.consult ? "; if a hard technical point blocks you, use consult_expert" : ""}. When everything passes, reply with the list of behaviours and how you verified each one.`,
  ].join("\n");

/** Queues the check to run once, when the agent would otherwise stop. Call before prompting. */
export function attachCompletionCheck(agent: Agent, opts: { consult: boolean }): void {
  agent.followUp({ role: "user", content: COMPLETION_CHECK(opts), timestamp: Date.now() });
}
