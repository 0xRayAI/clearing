//! Sandbox flows. The token is near-contract-standards 5.7, so `ft_resolve_transfer`
//! is the standard callback, not a stub.
//! near-workspaces 0.24: https://docs.rs/near-workspaces/0.24.0
use clearing_escrow::{signed_message, MIN_AMOUNT};
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use near_workspaces::network::Sandbox;
use serde::de::DeserializeOwned;
use serde_json::json;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

const SEC: u64 = 1_000_000_000;
const LONG: u64 = 600 * SEC;
const SHORT: u64 = 2 * SEC;

struct Key {
    secret: [u8; 32],
    public_hex: String,
}

fn key(fill: u8) -> Key {
    let secret = [fill; 32];
    let signing = SigningKey::from_bytes(&secret);
    Key { secret, public_hex: hex_encode(signing.verifying_key().as_bytes()) }
}

fn sign(key: &Key, message: &str) -> String {
    let signing = SigningKey::from_bytes(&key.secret);
    hex_encode(&signing.sign(message.as_bytes()).to_bytes())
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn build_wasm(manifest: &str, artifact: &str, feature: Option<&str>) -> Vec<u8> {
    let target = std::env::temp_dir().join(format!("clearing-escrow-{artifact}"));
    let mut cmd = Command::new(env!("CARGO"));
    cmd.args([
        "build",
        "--locked",
        "--release",
        "--target",
        "wasm32-unknown-unknown",
        "--manifest-path",
        manifest,
        "--target-dir",
        target.to_str().expect("utf8 target dir"),
    ]);
    if let Some(feature) = feature {
        cmd.args(["--features", feature]);
    }
    let status = cmd.status().expect("spawn cargo");
    assert!(status.success(), "wasm build failed for {manifest}");
    let path = target.join(format!("wasm32-unknown-unknown/release/{artifact}.wasm"));
    std::fs::read(&path).unwrap_or_else(|err| panic!("read {}: {err}", path.display()))
}

fn manifest(rel: &str) -> String {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push(rel);
    path.to_str().expect("utf8 manifest").to_string()
}

fn escrow_wasm() -> &'static [u8] {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| build_wasm(&manifest("Cargo.toml"), "clearing_escrow", Some("sandbox-token")))
        .as_slice()
}

fn token_wasm() -> &'static [u8] {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| build_wasm(&manifest("tests/ft/Cargo.toml"), "clearing_escrow_token", None)).as_slice()
}

struct Rig {
    worker: Worker<Sandbox>,
    token: Contract,
    escrow: Contract,
    buyer: Account,
    creator: Account,
    arbiter: Account,
    creator_key: Key,
    client_key: Key,
}

async fn rig() -> Rig {
    let worker = near_workspaces::sandbox().await.expect("sandbox");
    let token = worker.dev_deploy(token_wasm()).await.expect("deploy token");
    let escrow = worker.dev_deploy(escrow_wasm()).await.expect("deploy escrow");
    let buyer = worker.dev_create_account().await.expect("buyer");
    let creator = worker.dev_create_account().await.expect("creator");
    let arbiter = worker.dev_create_account().await.expect("arbiter");
    let creator_key = key(1);
    let client_key = key(2);
    must(
        escrow
            .call("new")
            .args_json(json!({
                "token_id": token.id(),
                "arbiter_id": arbiter.id(),
                "creator_id": creator.id(),
                "creator_pk": creator_key.public_hex,
                "chain_id": "testnet",
                "min_window_ns": SEC,
            }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await
            .expect("init call"),
    );
    must(
        token.call("new").gas(Gas::from_tgas(50)).transact().await.expect("token init"),
    );
    register(&buyer, &token, buyer.id()).await;
    register(&buyer, &token, escrow.id()).await;
    must(
        token
            .call("mint")
            .args_json(json!({ "account_id": buyer.id(), "amount": "5000000" }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await
            .expect("mint"),
    );
    Rig { worker, token, escrow, buyer, creator, arbiter, creator_key, client_key }
}

async fn register(payer: &Account, token: &Contract, account: &AccountId) {
    let bounds: serde_json::Value = token
        .view("storage_balance_bounds")
        .await
        .expect("bounds call")
        .json()
        .expect("bounds json");
    let min: u128 = bounds["min"].as_str().expect("min").parse().unwrap();
    must(
        payer
            .call(token.id(), "storage_deposit")
            .args_json(json!({ "account_id": account, "registration_only": true }))
            .deposit(NearToken::from_yoctonear(min))
            .gas(Gas::from_tgas(30))
            .transact()
            .await
            .expect("storage_deposit"),
    );
}

fn must(outcome: near_workspaces::result::ExecutionFinalResult) {
    assert!(
        outcome.is_success(),
        "call failed: {:?}",
        outcome.failures()
    );
}

async fn balance(token: &Contract, account: &AccountId) -> u128 {
    let value: serde_json::Value = token
        .view("ft_balance_of")
        .args_json(json!({ "account_id": account }))
        .await
        .expect("balance call")
        .json()
        .expect("balance json");
    value.as_str().expect("balance string").parse().unwrap()
}

async fn deal_state(escrow: &Contract, deal_id: u64) -> String {
    let value: serde_json::Value = escrow
        .view("get_deal")
        .args_json(json!({ "deal_id": deal_id }))
        .await
        .expect("deal call")
        .json()
        .expect("deal json");
    value["state"].as_str().unwrap_or("missing").to_string()
}

async fn escrow_balance(escrow: &Contract, account: &AccountId) -> u128 {
    let value: serde_json::Value = escrow
        .view("get_balance")
        .args_json(json!({ "account_id": account }))
        .await
        .expect("escrow balance")
        .json()
        .expect("escrow balance json");
    value.as_str().expect("u128 string").parse().unwrap()
}

fn payload(client_pk: &str, price: u128, deliver: u64, review: u64, dispute: u64, fund: u64) -> String {
    format!(
        r#"{{"client_pk":"{client_pk}","price":"{price}","deliver_ns":{deliver},"review_ns":{review},"dispute_ns":{dispute},"fund_ns":{fund}}}"#
    )
}

async fn open_and_fund(rig: &Rig, price: u128, deliver: u64, review: u64, dispute: u64, fund: u64) -> u64 {
    let body = payload(&rig.client_key.public_hex, price, deliver, review, dispute, fund);
    let nonce = format!("open{:016}", price);
    let signature = sign(
        &rig.creator_key,
        &signed_message("testnet", rig.escrow.id().as_str(), 0, "open", &nonce, &body),
    );
    let id: u64 = must_json(
        rig.buyer
            .call(rig.escrow.id(), "open")
            .args_json(json!({ "payload": body, "nonce": nonce, "signature": signature }))
            .gas(Gas::from_tgas(80))
            .transact()
            .await
            .expect("open"),
    );
    pay(rig, id, price.to_string(), format!(r#"{{"deal_id":{id}}}"#)).await;
    id
}

async fn pay(rig: &Rig, _id: u64, amount: String, msg: String) {
    must(
        rig.buyer
            .call(rig.token.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": rig.escrow.id(),
                "amount": amount,
                "memo": null,
                "msg": msg,
            }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(300))
            .transact()
            .await
            .expect("ft_transfer_call"),
    );
}

fn must_json<T: DeserializeOwned>(outcome: near_workspaces::result::ExecutionFinalResult) -> T {
    assert!(outcome.is_success(), "call failed: {:?}", outcome.failures());
    outcome.json().expect("json result")
}

async fn deliver(rig: &Rig, deal_id: u64) {
    let payload = "hash-1";
    let nonce = format!("deliver{:020}", deal_id);
    let signature = sign(
        &rig.creator_key,
        &signed_message("testnet", rig.escrow.id().as_str(), deal_id, "deliver", &nonce, payload),
    );
    must(
        rig.buyer
            .call(rig.escrow.id(), "deliver")
            .args_json(json!({
                "deal_id": deal_id,
                "nonce": nonce,
                "payload": payload,
                "signature": signature,
            }))
            .gas(Gas::from_tgas(80))
            .transact()
            .await
            .expect("deliver"),
    );
}

async fn accept(rig: &Rig, deal_id: u64) {
    let nonce = format!("accept{:020}", deal_id);
    let signature = sign(
        &rig.client_key,
        &signed_message("testnet", rig.escrow.id().as_str(), deal_id, "accept", &nonce, ""),
    );
    must(
        rig.buyer
            .call(rig.escrow.id(), "accept")
            .args_json(json!({ "deal_id": deal_id, "nonce": nonce, "signature": signature }))
            .gas(Gas::from_tgas(80))
            .transact()
            .await
            .expect("accept"),
    );
}

async fn dispute(rig: &Rig, deal_id: u64) {
    let nonce = format!("dispute{:020}", deal_id);
    let signature = sign(
        &rig.client_key,
        &signed_message("testnet", rig.escrow.id().as_str(), deal_id, "dispute", &nonce, ""),
    );
    must(
        rig.buyer
            .call(rig.escrow.id(), "dispute")
            .args_json(json!({ "deal_id": deal_id, "nonce": nonce, "signature": signature }))
            .gas(Gas::from_tgas(80))
            .transact()
            .await
            .expect("dispute"),
    );
}

#[tokio::test]
async fn bad_msg_refunds_full_amount() {
    let rig = rig().await;
    let before = balance(&rig.token, rig.buyer.id()).await;
    pay(&rig, 0, MIN_AMOUNT.to_string(), "not-json".to_string()).await;
    assert_eq!(balance(&rig.token, rig.buyer.id()).await, before);
}

#[tokio::test]
async fn wrong_token_refunds() {
    let rig = rig().await;
    let other = rig.worker.dev_deploy(token_wasm()).await.expect("other token");
    must(other.call("new").gas(Gas::from_tgas(50)).transact().await.expect("other init"));
    register(&rig.buyer, &other, rig.buyer.id()).await;
    register(&rig.buyer, &other, rig.escrow.id()).await;
    must(
        other
            .call("mint")
            .args_json(json!({ "account_id": rig.buyer.id(), "amount": MIN_AMOUNT.to_string() }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await
            .expect("mint other"),
    );
    must(
        rig.buyer
            .call(other.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": rig.escrow.id(),
                "amount": MIN_AMOUNT.to_string(),
                "memo": null,
                "msg": r#"{"deal_id":1}"#,
            }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(300))
            .transact()
            .await
            .expect("wrong token transfer"),
    );
    assert_eq!(balance(&other, rig.buyer.id()).await, MIN_AMOUNT);
}

#[tokio::test]
async fn below_min_amount_rejected() {
    let rig = rig().await;
    let before = balance(&rig.token, rig.buyer.id()).await;
    pay(&rig, 0, "999999".to_string(), r#"{"deal_id":1}"#.to_string()).await;
    assert_eq!(balance(&rig.token, rig.buyer.id()).await, before);
}

#[tokio::test]
async fn deal_release_on_client_accept() {
    let rig = rig().await;
    let before = balance(&rig.token, rig.buyer.id()).await;
    let id = open_and_fund(&rig, MIN_AMOUNT, LONG, LONG, LONG, LONG).await;
    assert_eq!(balance(&rig.token, rig.buyer.id()).await, before - MIN_AMOUNT);
    deliver(&rig, id).await;
    accept(&rig, id).await;
    assert_eq!(deal_state(&rig.escrow, id).await, "Released");
    assert_eq!(escrow_balance(&rig.escrow, rig.creator.id()).await, MIN_AMOUNT);
    let fee: u16 = rig
        .escrow
        .view("get_fee_bps")
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(fee, 0);
}

#[tokio::test]
async fn deal_release_after_review_timeout() {
    let rig = rig().await;
    let id = open_and_fund(&rig, MIN_AMOUNT, LONG, SHORT, SHORT, LONG).await;
    deliver(&rig, id).await;
    rig.worker.fast_forward(40).await.expect("fast forward");
    must(
        rig.buyer
            .call(rig.escrow.id(), "release_after_timeout")
            .args_json(json!({ "deal_id": id }))
            .gas(Gas::from_tgas(50))
            .transact()
            .await
            .expect("release"),
    );
    assert_eq!(deal_state(&rig.escrow, id).await, "Released");
    assert_eq!(escrow_balance(&rig.escrow, rig.creator.id()).await, MIN_AMOUNT);
}

#[tokio::test]
async fn dispute_resolved_by_arbiter() {
    let rig = rig().await;
    let id = open_and_fund(&rig, MIN_AMOUNT, LONG, LONG, LONG, LONG).await;
    deliver(&rig, id).await;
    dispute(&rig, id).await;
    must(
        rig.arbiter
            .call(rig.escrow.id(), "resolve_dispute")
            .args_json(json!({ "deal_id": id, "creator_bps": 7000 }))
            .gas(Gas::from_tgas(50))
            .transact()
            .await
            .expect("resolve"),
    );
    assert_eq!(escrow_balance(&rig.escrow, rig.creator.id()).await, 700_000);
    assert_eq!(escrow_balance(&rig.escrow, rig.buyer.id()).await, 300_000);
}

#[tokio::test]
async fn dispute_timeout_splits_50_50() {
    let rig = rig().await;
    let price = 1_000_001u128;
    let id = open_and_fund(&rig, price, LONG, LONG, SHORT, LONG).await;
    deliver(&rig, id).await;
    dispute(&rig, id).await;
    rig.worker.fast_forward(40).await.expect("fast forward");
    must(
        rig.buyer
            .call(rig.escrow.id(), "resolve_dispute_timeout")
            .args_json(json!({ "deal_id": id }))
            .gas(Gas::from_tgas(50))
            .transact()
            .await
            .expect("timeout split"),
    );
    assert_eq!(escrow_balance(&rig.escrow, rig.creator.id()).await, 500_000);
    assert_eq!(escrow_balance(&rig.escrow, rig.buyer.id()).await, 500_001);
}

#[tokio::test]
async fn failed_withdraw_puts_the_balance_back() {
    let rig = rig().await;
    let id = open_and_fund(&rig, MIN_AMOUNT, LONG, LONG, LONG, LONG).await;
    deliver(&rig, id).await;
    accept(&rig, id).await;
    assert_eq!(escrow_balance(&rig.escrow, rig.creator.id()).await, MIN_AMOUNT);
    let outcome = rig
        .creator
        .call(rig.escrow.id(), "withdraw")
        .gas(Gas::from_tgas(100))
        .transact()
        .await
        .expect("withdraw submitted");
    assert!(!outcome.receipt_failures().is_empty(), "ft_transfer should fail for an unregistered creator");
    assert_eq!(escrow_balance(&rig.escrow, rig.creator.id()).await, MIN_AMOUNT);
}
