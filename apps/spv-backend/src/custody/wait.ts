import { setTimeout as delay } from 'node:timers/promises';
import type { Operation } from './operations.js';
import type { Operator, OperatorRequest } from './operator.js';

/**
 * Wait mode for the CLI scripts: the script polls the custody provider until
 * the person decides in app.dfns.io. The server does not use this loop.
 */
export interface WaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

const FIVE_SECONDS = 5_000;
const SIXTY_MINUTES = 60 * 60 * 1000;

/** Polls every 5 s. Stops on done, rejected, failed or after 60 minutes. */
export async function waitForOperation(
  operator: Operator,
  operation: Operation,
  options: WaitOptions = {},
): Promise<Operation> {
  const interval = options.intervalMs ?? FIVE_SECONDS;
  const timeout = options.timeoutMs ?? SIXTY_MINUTES;
  const log = options.log ?? console.log;
  const sleep = options.sleep ?? delay;
  let current = operation;
  let announced: string | null = null;
  let waited = 0;
  while (current.status === 'awaiting_approval' || current.status === 'submitting') {
    if (current.approvalId !== announced) {
      log(`Awaiting approval ${current.approvalId ?? '(no id yet)'}: approve it in app.dfns.io`);
      announced = current.approvalId;
    }
    if (waited >= timeout) {
      const minutes = Math.round(timeout / 60_000);
      throw new Error(
        `No decision after ${minutes} minutes. The script stops. Operation ${current.id}.`,
      );
    }
    await sleep(interval);
    waited += interval;
    current = await operator.refresh(current.id);
  }
  if (current.status !== 'done') {
    throw new Error(current.error ?? `The operation ${current.id} ended as ${current.status}.`);
  }
  return current;
}

/** Runs one operation and waits for its end. Returns the done operation. */
export async function runAndWait(
  operator: Operator,
  request: OperatorRequest,
  options: WaitOptions = {},
): Promise<Operation & { hash: string }> {
  const done = await waitForOperation(operator, await operator.run(request), options);
  if (!done.hash) throw new Error(`The operation ${done.id} ended with no transaction hash.`);
  return { ...done, hash: done.hash };
}
