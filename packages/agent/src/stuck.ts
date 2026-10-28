import type { Agent } from "@earendil-works/pi-agent-core";

/**
 * Local agents rarely ask for help on their own, even while failing. The stuck detector watches for repeated failing test
 * runs or a mostly-spent turn budget and, once, suggests a consult. The nudge is a local message to
 * the local model; nothing is sent anywhere because of it.
 */
export interface StuckDetectorOptions {
  /** The run's turn budget, if any. */
  maxTurns?: number;
  /** Failed test runs before nudging. Default 2. */
  failedTestThreshold?: number;
  /** Fraction of maxTurns after which to nudge if no consult happened yet. Default 0.6. */
  budgetFraction?: number;
  /** Name of the consult tool. Default "consult_expert". */
  consultTool?: string;
  /**
   * "suggest" (default) offers a consult. "require" tells the agent to consult now; small local
   * models tend to ignore suggestions.
   */
  mode?: "suggest" | "require";
  /**
   * In require mode, also force the next model request to call the consult tool (see
   * AirlockAgent.forceToolOnNextRequest). Without it the requirement is only an instruction.
   */
  forceTool?: (toolName: string) => void;
}

const TEST_COMMAND = /\b(unittest|pytest|py\.test|npm (run )?test|vitest|jest|go test|cargo test|mvn test|gradle test|rspec|phpunit)\b/;

export const STUCK_NUDGE = (reason: string) =>
  `[Airlock] ${reason} If a hard technical point is blocking you (an algorithm, numerical or timing subtlety, concurrency, a library's exact semantics), consider using consult_expert once: describe the problem fully, including what you tried. Otherwise carry on.`;

export const STUCK_REQUIRE = (reason: string) =>
  `[Airlock] ${reason} You appear to be stuck. Your next action must be one call to consult_expert: describe the problem fully (expected vs actual behaviour, the relevant code, what you tried). Then use the answer to finish the fix.`;

export interface StuckDetector {
  readonly nudged: boolean;
  readonly failedTestRuns: number;
  readonly consulted: boolean;
  detach(): void;
}

export function attachStuckDetector(agent: Agent, opts: StuckDetectorOptions = {}): StuckDetector {
  const threshold = opts.failedTestThreshold ?? 2;
  const fraction = opts.budgetFraction ?? 0.6;
  const consultTool = opts.consultTool ?? "consult_expert";
  const testCalls = new Set<string>();
  let failed = 0;
  let turns = 0;
  let consulted = false;
  let nudged = false;

  const unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      case "tool_execution_start":
        if (event.toolName === consultTool) consulted = true;
        if (event.toolName === "bash" && typeof event.args?.command === "string" && TEST_COMMAND.test(event.args.command)) testCalls.add(event.toolCallId);
        break;
      case "tool_execution_end":
        if (testCalls.delete(event.toolCallId) && event.isError) failed++;
        break;
      case "turn_end": {
        turns++;
        if (nudged || consulted) break;
        let reason: string | undefined;
        if (failed >= threshold) reason = `The tests have failed ${failed} time${failed === 1 ? "" : "s"}.`;
        else if (opts.maxTurns && turns >= Math.ceil(opts.maxTurns * fraction)) reason = `You have used ${turns} of ${opts.maxTurns} turns without solving the task.`;
        if (reason) {
          nudged = true;
          agent.steer({ role: "user", content: (opts.mode === "require" ? STUCK_REQUIRE : STUCK_NUDGE)(reason), timestamp: Date.now() });
          if (opts.mode === "require") opts.forceTool?.(consultTool);
        }
        break;
      }
    }
  });

  return {
    get nudged() {
      return nudged;
    },
    get failedTestRuns() {
      return failed;
    },
    get consulted() {
      return consulted;
    },
    detach: unsubscribe,
  };
}
