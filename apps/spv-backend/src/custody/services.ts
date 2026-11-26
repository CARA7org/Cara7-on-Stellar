import { environment, type Environment } from '../config.js';
import { rpcNetwork } from '../waterfall/soroban.js';
import { StellarCliCustody } from './cli-signer.js';
import { DfnsCustody } from './dfns.js';
import { Operator } from './operator.js';
import type { OperatorCustody, StellarNetwork } from './ports.js';

/** What the routes and the CLI scripts need to read the chain and to sign. */
export interface OperatorServices {
  network: StellarNetwork;
  operator: Operator;
}

/**
 * The custody port that OPERATOR_SIGNER selects: Dfns (the default) or the
 * local Stellar CLI keystore (a development signer for the testnet demo).
 */
export function operatorCustody(settings: Environment = environment): OperatorCustody {
  if (settings.OPERATOR_SIGNER === 'stellar-cli') {
    return new StellarCliCustody(settings, settings.NETWORK_PASSPHRASE);
  }
  return new DfnsCustody(settings, settings.NETWORK_PASSPHRASE);
}

/** Production wiring: the selected custody for the signatures, Soroban RPC and Horizon for the chain. */
export function defaultOperatorServices(): OperatorServices {
  const operator = new Operator({
    custody: operatorCustody(),
    network: rpcNetwork,
    networkPassphrase: environment.NETWORK_PASSPHRASE,
  });
  return { network: rpcNetwork, operator };
}
