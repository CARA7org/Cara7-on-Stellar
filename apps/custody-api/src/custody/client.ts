import { DfnsApiClient } from '@dfns/sdk';
import { AsymmetricKeySigner } from '@dfns/sdk-keysigner';

/// The credentials of one Dfns service account. The server and the checker
/// each build their own client from their own credentials.
export type DfnsCredentials = {
  apiUrl: string;
  orgId: string;
  authToken: string;
  credId: string;
  privateKey: string;
};

export function createDfnsClient(credentials: DfnsCredentials): DfnsApiClient {
  return new DfnsApiClient({
    baseUrl: credentials.apiUrl,
    orgId: credentials.orgId,
    authToken: credentials.authToken,
    signer: new AsymmetricKeySigner({
      credId: credentials.credId,
      privateKey: credentials.privateKey,
    }),
  });
}
