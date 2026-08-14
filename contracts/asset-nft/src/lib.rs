//! Asset NFT - the Data Spec Book's token stacks (Auto / Battery / Obligor /
//! Pool Token). One contract code, four testnet instances; each token's URI
//! points at the content-addressed IPFS metadata (`ipfs://<CID>`).
//!
//! Built on OpenZeppelin `stellar-tokens` NonFungible `Base` for storage and
//! transfer semantics, with one deliberate deviation: OZ's `token_uri`
//! composes `base_uri ++ token_id`, which cannot express one true CID per
//! token - so the URI is stored per token at mint time instead.

#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, String, Vec};
use stellar_tokens::non_fungible::Base;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AssetNftError {
    UriNotSet = 1,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Supply,
    Uri(u32),
}

#[contract]
pub struct AssetNft;

#[contractimpl]
impl AssetNft {
    /// Instance setup: admin gate + collection name/symbol.
    pub fn __constructor(e: Env, admin: Address, name: String, symbol: String) {
        Base::set_metadata(&e, String::from_str(&e, ""), name, symbol);
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::Supply, &0u32);
    }

    /// Admin-only batch mint: one URI per new token, ids are sequential.
    /// Batches keep the 61-token bootstrap to a handful of transactions.
    pub fn mint_batch(e: Env, to: Address, uris: Vec<String>) -> Vec<u32> {
        let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        let mut minted: Vec<u32> = Vec::new(&e);
        for uri in uris.iter() {
            let token_id = Base::sequential_mint(&e, &to);
            e.storage().persistent().set(&DataKey::Uri(token_id), &uri);
            minted.push_back(token_id);
        }
        let supply: u32 = e.storage().instance().get(&DataKey::Supply).unwrap_or(0);
        e.storage()
            .instance()
            .set(&DataKey::Supply, &(supply + uris.len()));
        minted
    }

    /// Per-token URI (ipfs://CID), set at mint. Panics if the token does not
    /// exist (owner_of check), errors if the URI was never stored.
    pub fn token_uri(e: Env, token_id: u32) -> Result<String, AssetNftError> {
        let _owner = Base::owner_of(&e, token_id);
        e.storage()
            .persistent()
            .get(&DataKey::Uri(token_id))
            .ok_or(AssetNftError::UriNotSet)
    }

    pub fn owner_of(e: Env, token_id: u32) -> Address {
        Base::owner_of(&e, token_id)
    }

    pub fn balance(e: Env, owner: Address) -> u32 {
        Base::balance(&e, &owner)
    }

    pub fn transfer(e: Env, from: Address, to: Address, token_id: u32) {
        Base::transfer(&e, &from, &to, token_id);
    }

    pub fn name(e: Env) -> String {
        Base::name(&e)
    }

    pub fn symbol(e: Env) -> String {
        Base::symbol(&e)
    }

    pub fn total_supply(e: Env) -> u32 {
        e.storage().instance().get(&DataKey::Supply).unwrap_or(0)
    }

    pub fn get_admin(e: Env) -> Address {
        e.storage().instance().get(&DataKey::Admin).unwrap()
    }
}

#[cfg(test)]
mod test;
