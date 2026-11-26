import { randomUUID } from 'node:crypto';
import { OperatorError } from './errors.js';
import type { OperatorRole } from './ports.js';

/**
 * In-memory registry of operator operations.
 *
 * An operation is one signed transaction of one role. While an operation of a
 * role is in progress, the registry refuses a second one for that role: the
 * two transactions would use the same sequence number.
 *
 * The registry is local to one process. A CLI script and the server do not
 * see the operations of each other.
 */
export type OperationStatus = 'awaiting_approval' | 'submitting' | 'done' | 'rejected' | 'failed';

export interface Operation {
  id: string;
  kind: string;
  role: OperatorRole;
  contractId: string | null;
  method: string;
  status: OperationStatus;
  approvalId: string | null;
  signatureId: string | null;
  hash: string | null;
  result: unknown;
  error: string | null;
  createdAt: string;
}

export interface OperationStart {
  kind: string;
  role: OperatorRole;
  contractId: string | null;
  method: string;
}

const ACTIVE: readonly OperationStatus[] = ['awaiting_approval', 'submitting'];
const KEEP_AT_MOST = 200;

export function isActive(operation: Operation): boolean {
  return ACTIVE.includes(operation.status);
}

export class OperationRegistry {
  private readonly operations = new Map<string, Operation>();

  /** Records a new operation in the `submitting` status. Throws 409 if the role is busy. */
  start(input: OperationStart): Operation {
    const busy = this.activeFor(input.role);
    if (busy) {
      throw new OperatorError(
        `The ${input.role} wallet already has an operation in progress (${busy.id}). ` +
          'A second transaction now would use the same sequence number. ' +
          'Approve or reject the first one in app.dfns.io, then try again.',
        409,
      );
    }
    this.prune();
    const operation: Operation = {
      id: `op-${randomUUID()}`,
      ...input,
      status: 'submitting',
      approvalId: null,
      signatureId: null,
      hash: null,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    this.operations.set(operation.id, operation);
    return { ...operation };
  }

  get(id: string): Operation | undefined {
    const operation = this.operations.get(id);
    return operation ? { ...operation } : undefined;
  }

  /** Newest first. */
  list(): Operation[] {
    return [...this.operations.values()].reverse().map((operation) => ({ ...operation }));
  }

  activeFor(role: OperatorRole): Operation | undefined {
    for (const operation of this.operations.values()) {
      if (operation.role === role && isActive(operation)) return { ...operation };
    }
    return undefined;
  }

  update(id: string, patch: Partial<Omit<Operation, 'id' | 'createdAt'>>): Operation {
    const operation = this.operations.get(id);
    if (!operation) throw new OperatorError(`No operation has the id ${id}.`, 404);
    Object.assign(operation, patch);
    return { ...operation };
  }

  /** Removes an operation that never reached the custody provider. */
  discard(id: string): void {
    this.operations.delete(id);
  }

  private prune(): void {
    for (const [id, operation] of this.operations) {
      if (this.operations.size < KEEP_AT_MOST) return;
      if (!isActive(operation)) this.operations.delete(id);
    }
  }
}
