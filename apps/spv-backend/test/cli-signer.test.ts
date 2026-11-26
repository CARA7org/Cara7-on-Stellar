import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { environment, environmentSchema } from '../src/config.js';
import {
  StellarCliCustody,
  execFileRunner,
  type CommandResult,
  type CommandRunner,
} from '../src/custody/cli-signer.js';
import { DfnsCustody } from '../src/custody/dfns.js';
import { DIFFERENT_TRANSACTION, OperatorError } from '../src/custody/errors.js';
import { Operator } from '../src/custody/operator.js';
import { operatorCustody } from '../src/custody/services.js';
import { projectRoot } from '../src/paths.js';
import { FakeNetwork } from './support/fakes.js';

const passphrase = environment.NETWORK_PASSPHRASE;
const rpcUrl = 'https://soroban-testnet.stellar.org';
const settings = {
  SOROBAN_RPC_URL: rpcUrl,
  CLI_ADMIN_IDENTITY: 'cara7-admin',
  CLI_SERVICER_IDENTITY: 'cara7-servicer',
  CLI_REPORTER_IDENTITY: 'cara7-reporter',
  CLI_CRANK_IDENTITY: 'cara7-crank',
};
/** Looks like a secret seed, but it is not a valid key. */
const SEED_LIKE = `S${'A'.repeat(55)}`;

interface Call {
  command: string;
  args: readonly string[];
  input: string | undefined;
}

type CliMode = 'sign' | 'tamper' | 'fail';

/**
 * A fake `stellar` program with an in-memory keystore. Like the real CLI,
 * `tx sign` reads the envelope on stdin, appends one signature and prints
 * the envelope. No file and no network.
 */
function fakeStellar(mode: CliMode = 'sign') {
  const keys: Record<string, Keypair> = {
    'cara7-admin': Keypair.random(),
    'cara7-servicer': Keypair.random(),
    'cara7-reporter': Keypair.random(),
    'cara7-crank': Keypair.random(),
  };
  const calls: Call[] = [];
  const fail = (stderr: string): CommandResult => ({ exitCode: 1, stdout: '', stderr });
  const runner: CommandRunner = async (command, args, input) => {
    calls.push({ command, args, input });
    if (args[0] === 'keys' && args[1] === 'address') {
      const key = keys[args[2] ?? ''];
      if (!key) return fail(`❌ error: Failed to find config identity for ${args[2]}\n`);
      return { exitCode: 0, stdout: `${key.publicKey()}\n`, stderr: '' };
    }
    if (args[0] === 'tx' && args[1] === 'sign') {
      if (mode === 'fail') return fail(`❌ error: cannot sign with ${SEED_LIKE}\n`);
      const key = keys[args[args.indexOf('--sign-with-key') + 1] ?? ''];
      if (!key) return fail('❌ error: no identity\n');
      const envelope = xdr.TransactionEnvelope.fromXDR(input ?? '', 'base64');
      if (mode === 'tamper') envelope.v1().tx().fee(envelope.v1().tx().fee() + 1000);
      const transaction = TransactionBuilder.fromXDR(envelope.toXDR('base64'), passphrase) as Transaction;
      transaction.sign(key);
      return { exitCode: 0, stdout: `${transaction.toXDR()}\n`, stderr: 'ℹ️ Signing transaction: 00\n' };
    }
    return fail('unknown command');
  };
  return { keys, calls, runner };
}

function transaction(source: string): Transaction {
  return new TransactionBuilder(new Account(source, '7'), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.bumpSequence({ bumpTo: '9' }))
    .setTimeout(60)
    .build();
}

const closeCall = {
  kind: 'close-deal',
  role: 'admin' as const,
  call: { type: 'contract' as const, contractId: environment.DEAL_CONTRACT_ID, method: 'close', args: [] },
};

describe('Stellar CLI signer', () => {
  it('reads the role address with `stellar keys address <identity>`, once', async () => {
    const cli = fakeStellar();
    const custody = new StellarCliCustody(settings, passphrase, cli.runner);
    const wallet = await custody.resolveRole('admin');
    await custody.resolveRole('admin');
    expect(wallet).toEqual({
      walletId: 'stellar-cli:cara7-admin',
      keyId: 'cara7-admin',
      address: cli.keys['cara7-admin']?.publicKey(),
    });
    expect(cli.calls).toEqual([{ command: 'stellar', args: ['keys', 'address', 'cara7-admin'], input: undefined }]);
  });

  it('runs `stellar tx sign` with the identity, the RPC URL and the passphrase, and the XDR on stdin', async () => {
    const cli = fakeStellar();
    const custody = new StellarCliCustody(settings, passphrase, cli.runner);
    const servicer = await custody.resolveRole('servicer');
    const prepared = transaction(servicer.address);
    const state = await custody.requestSignature({ role: 'servicer', transaction: prepared });
    const sign = cli.calls[1];
    expect(sign?.args).toEqual([
      'tx',
      'sign',
      '--sign-with-key',
      'cara7-servicer',
      '--rpc-url',
      rpcUrl,
      '--network-passphrase',
      passphrase,
    ]);
    expect(sign?.input).toBe(prepared.toXDR());
    expect(state.status).toBe('signed');
    expect(state.signedXdr).not.toMatch(/\s$/);
    expect(await custody.refreshSignature('servicer', state.signatureId)).toEqual(state);
    await expect(custody.refreshSignature('servicer', 'cli-unknown')).rejects.toThrow(/no signature/);
  });

  it('passes the Operator hash and signer checks: the CLI only appends a signature', async () => {
    const cli = fakeStellar();
    const network = new FakeNetwork();
    const custody = new StellarCliCustody(settings, passphrase, cli.runner);
    const operator = new Operator({ custody, network, networkPassphrase: passphrase });
    const operation = await operator.run(closeCall);
    expect(operation.status).toBe('done');
    const submitted = network.submitted[0]?.transaction;
    const admin = cli.keys['cara7-admin'] as Keypair;
    expect(submitted?.source).toBe(admin.publicKey());
    expect(submitted?.signatures.some((signature) => admin.verify(submitted.hash(), signature.signature()))).toBe(true);
  });

  it('lets the Operator refuse an envelope whose body the CLI changed', async () => {
    const cli = fakeStellar('tamper');
    const network = new FakeNetwork();
    const custody = new StellarCliCustody(settings, passphrase, cli.runner);
    const operator = new Operator({ custody, network, networkPassphrase: passphrase });
    const operation = await operator.run(closeCall);
    expect(operation).toMatchObject({ status: 'failed', error: DIFFERENT_TRANSACTION });
    expect(network.submitted).toHaveLength(0);
  });

  it('reports a CLI failure as a failed signature, and never repeats a seed', async () => {
    const cli = fakeStellar('fail');
    const network = new FakeNetwork();
    const custody = new StellarCliCustody(settings, passphrase, cli.runner);
    const operator = new Operator({ custody, network, networkPassphrase: passphrase });
    const operation = await operator.run(closeCall);
    expect(operation.status).toBe('failed');
    expect(operation.error).toBe(
      'The custody provider could not sign the transaction: stellar tx sign: error: cannot sign with [redacted]',
    );
    expect(network.submitted).toHaveLength(0);
  });

  it('names a missing setting, an unknown identity and a missing CLI', async () => {
    const cli = fakeStellar();
    const unset = new StellarCliCustody({ SOROBAN_RPC_URL: rpcUrl }, passphrase, cli.runner);
    await expect(unset.resolveRole('crank')).rejects.toThrow(/^CLI_CRANK_IDENTITY is not set/);
    const unknown = new StellarCliCustody({ ...settings, CLI_ADMIN_IDENTITY: 'nobody' }, passphrase, cli.runner);
    await expect(unknown.resolveRole('admin')).rejects.toThrow(
      'The Stellar CLI has no address for the admin identity nobody: error: Failed to find config identity for nobody',
    );
    const absent: CommandRunner = async () => {
      throw Object.assign(new Error('spawn stellar ENOENT'), { code: 'ENOENT' });
    };
    const noCli = new StellarCliCustody(settings, passphrase, absent);
    await expect(noCli.resolveRole('admin')).rejects.toThrow(/not on the PATH/);
  });

  it('refuses a key in an identity setting, and the public network', async () => {
    const cli = fakeStellar();
    const withKey = new StellarCliCustody({ ...settings, CLI_ADMIN_IDENTITY: SEED_LIKE }, passphrase, cli.runner);
    const refused = withKey.resolveRole('admin');
    await expect(refused).rejects.toThrow(/must be the name of a Stellar CLI identity, never a key/);
    await expect(refused).rejects.toBeInstanceOf(OperatorError);
    const onPublic = new StellarCliCustody(settings, Networks.PUBLIC, cli.runner);
    await expect(onPublic.resolveRole('admin')).rejects.toThrow(/refuses the public network/);
    expect(cli.calls).toHaveLength(0);
  });
});

describe('the command runner', () => {
  const node = process.execPath;

  it('writes the input on stdin and reads stdout without a shell', async () => {
    const echo = await execFileRunner(node, ['-e', 'process.stdin.pipe(process.stdout)'], 'AAAA;$(no shell)');
    expect(echo).toEqual({ exitCode: 0, stdout: 'AAAA;$(no shell)', stderr: '' });
  });

  it('gives the exit code of a failed program, and rejects a missing program', async () => {
    const failed = await execFileRunner(node, ['-e', 'process.stderr.write("bad"); process.exit(3)']);
    expect(failed).toEqual({ exitCode: 3, stdout: '', stderr: 'bad' });
    await expect(execFileRunner('cara7-no-such-program', [])).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('signer selection and settings', () => {
  it('selects Dfns by default and the Stellar CLI with OPERATOR_SIGNER=stellar-cli', () => {
    expect(environmentSchema.parse({}).OPERATOR_SIGNER).toBe('dfns');
    expect(operatorCustody({ ...environment, OPERATOR_SIGNER: 'dfns' })).toBeInstanceOf(DfnsCustody);
    expect(operatorCustody({ ...environment, OPERATOR_SIGNER: 'stellar-cli' })).toBeInstanceOf(StellarCliCustody);
  });

  it('accepts identity names only, never a key or a seed phrase', () => {
    expect(environmentSchema.parse({ CLI_ADMIN_IDENTITY: 'cara7-admin_2' }).CLI_ADMIN_IDENTITY).toBe('cara7-admin_2');
    expect(environmentSchema.safeParse({ CLI_ADMIN_IDENTITY: SEED_LIKE }).success).toBe(false);
    expect(environmentSchema.safeParse({ CLI_CRANK_IDENTITY: 'kite urban apple' }).success).toBe(false);
    expect(environmentSchema.safeParse({ CLI_CRANK_IDENTITY: '--sign-with-lab' }).success).toBe(false);
    expect(environmentSchema.safeParse({ OPERATOR_SIGNER: 'ledger' }).success).toBe(false);
  });

  it('documents the signer settings in .env.example', () => {
    const example = readFileSync(path.join(projectRoot, '.env.example'), 'utf8');
    for (const name of ['OPERATOR_SIGNER', 'CLI_ADMIN_IDENTITY', 'CLI_SERVICER_IDENTITY', 'CLI_REPORTER_IDENTITY', 'CLI_CRANK_IDENTITY']) {
      expect(example).toContain(`# ${name}=`);
    }
  });
});
