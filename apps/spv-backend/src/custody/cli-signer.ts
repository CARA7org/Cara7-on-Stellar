import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Networks, StrKey } from '@stellar/stellar-sdk';
import type { Environment } from '../config.js';
import { OperatorError, errorMessage, missingSetting } from './errors.js';
import type {
  OperatorCustody,
  OperatorRole,
  RoleWallet,
  SignatureInput,
  SignatureState,
} from './ports.js';

/**
 * A development signer for the operator roles: the keystore of the local
 * Stellar CLI signs. The backend still holds no secret. It knows only the
 * identity name of each role, and it asks the `stellar` program to sign.
 *
 * OPERATOR_SIGNER=stellar-cli enables it, for the testnet demo without
 * Dfns. It refuses the public network: the production custody is Dfns.
 *
 * - resolveRole runs `stellar keys address <identity>`.
 * - requestSignature runs `stellar tx sign --sign-with-key <identity>
 *   --rpc-url <url> --network-passphrase <passphrase>` with the base64
 *   envelope XDR on stdin. The CLI needs the RPC URL, but it signs offline.
 *   It appends a signature and prints the signed envelope on stdout.
 * - A signature is immediate: the state is `signed` or `failed`, never
 *   `pending`. The Operator then checks the hash and the signature.
 */
export const IDENTITY_SETTING = {
  admin: 'CLI_ADMIN_IDENTITY',
  servicer: 'CLI_SERVICER_IDENTITY',
  reporter: 'CLI_REPORTER_IDENTITY',
  crank: 'CLI_CRANK_IDENTITY',
} as const satisfies Record<OperatorRole, keyof Environment>;

type IdentitySetting = (typeof IDENTITY_SETTING)[OperatorRole];

export type CliSignerSettings = Pick<Environment, 'SOROBAN_RPC_URL'> &
  Partial<Pick<Environment, IdentitySetting>>;

/** An identity name: letters, digits, "_" and "-". It never starts with "-". */
export const CLI_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A Stellar secret seed. An identity setting must never hold one. */
export const SECRET_SEED_PATTERN = /^S[A-Z2-7]{55}$/;

export function isCliIdentityName(value: string): boolean {
  return CLI_IDENTITY_PATTERN.test(value) && !SECRET_SEED_PATTERN.test(value);
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs a program without a shell. `input` goes to its stdin. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  input?: string,
) => Promise<CommandResult>;

const COMMAND_TIMEOUT_MS = 60_000;
const KEEP_AT_MOST = 200;

/** The production runner: `execFile`, so no shell reads the arguments. */
export const execFileRunner: CommandRunner = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr });
        } else if (typeof error.code === 'number' && !error.killed) {
          resolve({ exitCode: error.code, stdout, stderr });
        } else {
          reject(error);
        }
      },
    );
    // A program that stops at once closes its stdin. The callback above
    // reports the cause, so the write error is not necessary.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });

/** One readable line from the CLI output. A secret seed never goes out. */
function readable(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/^[^\p{L}\p{N}]+/u, '').trim())
    .filter((line) => line.length > 0);
  const message = lines.length > 0 ? lines.join(' ') : 'no message';
  return message.replace(/S[A-Z2-7]{55}/g, '[redacted]').slice(0, 500);
}

export class StellarCliCustody implements OperatorCustody {
  private readonly wallets = new Map<OperatorRole, RoleWallet>();
  private readonly signatures = new Map<string, SignatureState>();

  constructor(
    private readonly settings: CliSignerSettings,
    private readonly networkPassphrase: string,
    private readonly runner: CommandRunner = execFileRunner,
    private readonly command = 'stellar',
  ) {}

  /** Reads the address of the role identity once, then keeps it in memory. */
  async resolveRole(role: OperatorRole): Promise<RoleWallet> {
    this.refusePublicNetwork();
    const cached = this.wallets.get(role);
    if (cached) return cached;
    const identity = this.identity(role);
    const result = await this.run(['keys', 'address', identity], undefined, `read the ${role} address`);
    if (result.exitCode !== 0) {
      throw new OperatorError(
        `The Stellar CLI has no address for the ${role} identity ${identity}: ${readable(result.stderr)}`,
        503,
      );
    }
    const address = result.stdout.trim();
    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw new OperatorError(
        `The Stellar CLI returned no account address for the ${role} identity ${identity}.`,
        502,
      );
    }
    const wallet = { walletId: `stellar-cli:${identity}`, keyId: identity, address };
    this.wallets.set(role, wallet);
    return wallet;
  }

  async requestSignature(input: SignatureInput): Promise<SignatureState> {
    const wallet = await this.resolveRole(input.role);
    const args = [
      'tx',
      'sign',
      '--sign-with-key',
      wallet.keyId,
      '--rpc-url',
      this.settings.SOROBAN_RPC_URL,
      '--network-passphrase',
      this.networkPassphrase,
    ];
    const result = await this.run(args, input.transaction.toXDR(), `sign as the ${input.role} role`);
    const signatureId = `cli-${randomUUID()}`;
    const signedXdr = result.stdout.trim();
    let state: SignatureState;
    if (result.exitCode !== 0) {
      state = { signatureId, status: 'failed', reason: `stellar tx sign: ${readable(result.stderr)}` };
    } else if (signedXdr.length === 0) {
      state = { signatureId, status: 'failed', reason: 'stellar tx sign returned no envelope.' };
    } else {
      state = { signatureId, status: 'signed', signedXdr };
    }
    this.remember(state);
    return state;
  }

  /** The CLI signs at once, so the stored state is final. */
  async refreshSignature(_role: OperatorRole, signatureId: string): Promise<SignatureState> {
    const state = this.signatures.get(signatureId);
    if (!state) {
      throw new OperatorError(`The Stellar CLI signer has no signature ${signatureId}.`, 404);
    }
    return state;
  }

  private refusePublicNetwork(): void {
    if (this.networkPassphrase === Networks.PUBLIC) {
      throw new OperatorError(
        'OPERATOR_SIGNER=stellar-cli is a development signer and refuses the public network. ' +
          'Use OPERATOR_SIGNER=dfns.',
        503,
      );
    }
  }

  private identity(role: OperatorRole): string {
    const setting = IDENTITY_SETTING[role];
    const identity = this.settings[setting];
    if (!identity) throw missingSetting(setting, `sign as the ${role} role with the Stellar CLI`);
    if (!isCliIdentityName(identity)) {
      throw new OperatorError(`${setting} must be the name of a Stellar CLI identity, never a key.`, 503);
    }
    return identity;
  }

  private async run(args: string[], input: string | undefined, purpose: string): Promise<CommandResult> {
    try {
      return await this.runner(this.command, args, input);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new OperatorError(
          `The Stellar CLI (${this.command}) is not on the PATH. Install it, or set OPERATOR_SIGNER=dfns.`,
          503,
        );
      }
      throw new OperatorError(`The Stellar CLI could not ${purpose}: ${readable(errorMessage(error))}`, 502);
    }
  }

  private remember(state: SignatureState): void {
    this.signatures.set(state.signatureId, state);
    for (const id of this.signatures.keys()) {
      if (this.signatures.size <= KEEP_AT_MOST) break;
      this.signatures.delete(id);
    }
  }
}
