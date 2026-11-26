import { readFileSync } from 'node:fs';
import { Networks, StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

export type StellarNetwork = 'testnet' | 'mainnet';

const PASSPHRASES: Record<StellarNetwork, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

const contractId = z
  .string()
  .refine((value) => StrKey.isValidContract(value), 'must be a valid contract id (C...)');
const accountId = z
  .string()
  .refine((value) => StrKey.isValidEd25519PublicKey(value), 'must be a valid account id (G...)');
const integerString = z.string().regex(/^[0-9]+$/, 'must be a whole number in a string');
const decimalString = z.string().regex(/^[0-9]+(\.[0-9]+)?$/, 'must be a decimal number in a string');

const dealSchema = z.object({
  name: z.string().min(1),
  dealContractId: contractId,
  payingAgentContractId: contractId,
  noteDenomination: integerString,
});

const policySchema = z
  .object({
    network: z.enum(['testnet', 'mainnet']),
    networkPassphrase: z.string().min(1),
    eurc: z.object({
      code: z.string().min(1).max(12),
      issuer: accountId,
      contractId,
      decimals: z.number().int().min(0).max(18),
    }),
    thresholdEurc: decimalString,
    maxFeeStroops: integerString,
    maxValiditySeconds: z.number().int().positive(),
    deals: z.array(dealSchema).min(1),
  })
  .refine((policy) => policy.networkPassphrase === PASSPHRASES[policy.network], {
    message: 'networkPassphrase does not match network',
    path: ['networkPassphrase'],
  })
  .refine(
    (policy) => (policy.thresholdEurc.split('.')[1] ?? '').length <= policy.eurc.decimals,
    { message: 'thresholdEurc has more decimals than the EURC token', path: ['thresholdEurc'] },
  );

/// The allowlist that the guard and the checker apply to investor wallets.
export type Policy = z.infer<typeof policySchema>;
export type DealEntry = z.infer<typeof dealSchema>;

/// Validates a policy object. It throws a readable error when a field is wrong.
export function parsePolicy(value: unknown): Policy {
  const result = policySchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`The custody policy is not valid. ${issues.join('; ')}`);
  }
  return result.data;
}

/// Reads src/policy/<network>.json and validates it.
export function loadPolicy(network: StellarNetwork): Policy {
  const file = new URL(`./${network}.json`, import.meta.url);
  const policy = parsePolicy(JSON.parse(readFileSync(file, 'utf8')));
  if (policy.network !== network) {
    throw new Error(`The policy file ${network}.json is for the network ${policy.network}.`);
  }
  return policy;
}

export function passphraseFor(network: StellarNetwork): string {
  return PASSPHRASES[network];
}
