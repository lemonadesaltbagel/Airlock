import { createInterface } from "node:readline/promises";

/**
 * Yes/no questions to the user on the terminal, one at a time: consult approvals and network
 * requests can arrive together. Without a terminal every question is answered "no".
 */
export interface Prompter {
  readonly interactive: boolean;
  confirm(question: string, details?: string): Promise<boolean>;
}

export function terminalPrompter(log: (line: string) => void): Prompter {
  const interactive = process.stdin.isTTY === true;
  let queue: Promise<unknown> = Promise.resolve();
  async function ask(question: string, details?: string): Promise<boolean> {
    if (!interactive) return false;
    if (details) log(details);
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
    } finally {
      rl.close();
    }
  }
  return {
    interactive,
    confirm(question, details) {
      const next = queue.then(() => ask(question, details));
      queue = next.catch(() => false);
      return next;
    },
  };
}
