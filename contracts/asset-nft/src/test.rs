#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{vec, Address, Env, String as SdkString};

fn setup() -> (Env, AssetNftClient<'static>, Address, Address) {
    let e = Env::default();
    let admin = Address::generate(&e);
    let holder = Address::generate(&e);
    let contract_id = e.register(
        AssetNft,
        (
            admin.clone(),
            SdkString::from_str(&e, "TrueABS Auto Token"),
            SdkString::from_str(&e, "tABSAUTO"),
        ),
    );
    let client = AssetNftClient::new(&e, &contract_id);
    (e, client, admin, holder)
}

#[test]
fn batch_mint_stores_sequential_ids_and_uris() {
    let (e, client, _admin, holder) = setup();
    e.mock_all_auths();

    let uris = vec![
        &e,
        SdkString::from_str(&e, "ipfs://bafkreiaaaa"),
        SdkString::from_str(&e, "ipfs://bafkreibbbb"),
        SdkString::from_str(&e, "ipfs://bafkreicccc"),
    ];
    let ids = client.mint_batch(&holder, &uris);

    assert_eq!(ids, vec![&e, 0u32, 1u32, 2u32]);
    assert_eq!(client.total_supply(), 3);
    assert_eq!(client.balance(&holder), 3);
    assert_eq!(client.owner_of(&1), holder);
    assert_eq!(client.token_uri(&1), SdkString::from_str(&e, "ipfs://bafkreibbbb"));
}

#[test]
fn transfer_moves_ownership() {
    let (e, client, _admin, holder) = setup();
    e.mock_all_auths();
    let receiver = Address::generate(&e);

    client.mint_batch(&holder, &vec![&e, SdkString::from_str(&e, "ipfs://bafkreidddd")]);
    client.transfer(&holder, &receiver, &0);

    assert_eq!(client.owner_of(&0), receiver);
    assert_eq!(client.balance(&holder), 0);
    assert_eq!(client.balance(&receiver), 1);
    // URI survives the transfer.
    assert_eq!(client.token_uri(&0), SdkString::from_str(&e, "ipfs://bafkreidddd"));
}

#[test]
fn mint_requires_admin_auth() {
    let (e, client, _admin, holder) = setup();
    // No auth mocked: require_auth must abort the call.
    let result = client.try_mint_batch(&holder, &vec![&e, SdkString::from_str(&e, "ipfs://x")]);
    assert!(result.is_err());
}

#[test]
fn metadata_is_exposed() {
    let (e, client, admin, _holder) = setup();
    assert_eq!(client.name(), SdkString::from_str(&e, "TrueABS Auto Token"));
    assert_eq!(client.symbol(), SdkString::from_str(&e, "tABSAUTO"));
    assert_eq!(client.get_admin(), admin);
}
