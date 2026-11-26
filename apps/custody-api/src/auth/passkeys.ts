import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

/// A challenge expires after 5 minutes.
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type VerifiedPasskey = {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
};

export type StoredCredential = {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
};

/// The WebAuthn port. The server uses SimpleWebAuthn. The route tests use a
/// fake, because a real passkey needs a browser and an authenticator.
export interface PasskeyVerifier {
  registrationOptions(input: { displayName: string }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration(input: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
  }): Promise<VerifiedPasskey | null>;
  authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyAuthentication(input: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    credential: StoredCredential;
  }): Promise<{ newCounter: number } | null>;
}

export type RelyingParty = { id: string; name: string; origin: string };

/// Discoverable credentials (resident keys), user verification preferred.
export function createPasskeyVerifier(relyingParty: RelyingParty): PasskeyVerifier {
  return new SimpleWebAuthnVerifier(relyingParty);
}

class SimpleWebAuthnVerifier implements PasskeyVerifier {
  constructor(private readonly relyingParty: RelyingParty) {}

  registrationOptions({ displayName }: { displayName: string }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return generateRegistrationOptions({
      rpName: this.relyingParty.name,
      rpID: this.relyingParty.id,
      userName: displayName,
      userDisplayName: displayName,
      timeout: CHALLENGE_TTL_MS,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'preferred',
      },
    });
  }

  async verifyRegistration(input: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
  }): Promise<VerifiedPasskey | null> {
    const result = await verifyRegistrationResponse({
      ...input,
      expectedOrigin: this.relyingParty.origin,
      expectedRPID: this.relyingParty.id,
      requireUserVerification: false,
    }).catch(() => null);
    if (!result?.verified) return null;
    const { credential } = result.registrationInfo;
    return {
      credentialId: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ?? [],
    };
  }

  authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return generateAuthenticationOptions({
      rpID: this.relyingParty.id,
      userVerification: 'preferred',
      timeout: CHALLENGE_TTL_MS,
    });
  }

  async verifyAuthentication(input: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    credential: StoredCredential;
  }): Promise<{ newCounter: number } | null> {
    const { credential } = input;
    const result = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: this.relyingParty.origin,
      expectedRPID: this.relyingParty.id,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports,
      },
      requireUserVerification: false,
    }).catch(() => null);
    return result?.verified ? { newCounter: result.authenticationInfo.newCounter } : null;
  }
}
