//! Sandbox checks for the spend vault.
//! Token: near-contract-standards 5.7, compiled from the escrow test token.
//! near-workspaces 0.24: https://docs.rs/near-workspaces/0.24.0
use clearing_spend_cap::AGENT_METHODS;
use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, InMemorySigner, Worker};
use serde_json::json;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

const CAP: u128 = 1_000_000;
const SEC: u64 = 1_000_000_000;

fn build_wasm(manifest: &str, artifact: &str) -> Vec<u8> {
    let target = std::env::temp_dir().join(format!("clearing-spend-{artifact}"));
    let status = Command::new(env!("CARGO"))
        .args([
            "build",
            "--locked",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "--manifest-path",
            manifest,
            "--target-dir",
            target.to_str().expect("utf8 target dir"),
        ])
        .status()
        .expect("spawn cargo");
    assert!(status.success(), "wasm build failed for {manifest}");
    let path = target.join(format!("wasm32-unknown-unknown/release/{artifact}.wasm"));
    std::fs::read(&path).unwrap_or_else(|err| panic!("read {}: {err}", path.display()))
}

fn manifest(rel: &str) -> String {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push(rel);
    path.to_str().expect("utf8 manifest").to_string()
}

fn vault_wasm() -> &'static [u8] {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| build_wasm(&manifest("Cargo.toml"), "clearing_spend_cap")).as_slice()
}

fn token_wasm() -> &'static [u8] {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| build_wasm(&manifest("../escrow/tests/ft/Cargo.toml"), "clearing_escrow_token"))
        .as_slice()
}

struct Rig {
    worker: Worker<Sandbox>,
    token: Contract,
    vault: Contract,
    owner: Account,
    shop: Account,
}

async fn rig(budget_limit: u128, budget_period_ns: u64) -> Rig {
    let worker = near_workspaces::sandbox().await.expect("sandbox");
    let token = worker.dev_deploy(token_wasm()).await.expect("token");
    let vault = worker.dev_deploy(vault_wasm()).await.expect("vault");
    let owner = worker.dev_create_account().await.expect("owner");
    let shop = worker.dev_create_account().await.expect("shop");
    must(token.call("new").gas(Gas::from_tgas(50)).transact().await.expect("token init"));
    must(
        owner
            .call(vault.id(), "new")
            .args_json(json!({
                "token_id": token.id(),
                "owner_id": owner.id(),
                "per_tx_cap": CAP.to_string(),
                "budget_limit": budget_limit.to_string(),
                "budget_period_ns": budget_period_ns,
                "cooldown_ns": 0,
                "approval_threshold": null,
                "max_open_approvals": 4,
            }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await
            .expect("vault init"),
    );
    register(&owner, &token, vault.id()).await;
    register(&owner, &token, shop.id()).await;
    must(
        token
            .call("mint")
            .args_json(json!({ "account_id": vault.id(), "amount": "10000000" }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await
            .expect("mint"),
    );
    Rig { worker, token, vault, owner, shop }
}

async fn register(payer: &Account, token: &Contract, account: &AccountId) {
    let bounds: serde_json::Value = token.view("storage_balance_bounds").await.expect("bounds").json().expect("json");
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

fn must(outcome: near_workspaces::result::ExecutionFinalResult) -> near_workspaces::result::ExecutionFinalResult {
    assert!(outcome.is_success(), "call failed: {:?}", outcome.failures());
    outcome
}

async fn balance(token: &Contract, account: &AccountId) -> u128 {
    let value: serde_json::Value = token
        .view("ft_balance_of")
        .args_json(json!({ "account_id": account }))
        .await
        .expect("balance")
        .json()
        .expect("json");
    value.as_str().expect("string").parse().unwrap()
}

async fn pay(rig: &Rig, amount: u128, memo: &str) -> near_workspaces::result::ExecutionFinalResult {
    rig.owner
        .call(rig.vault.id(), "pay")
        .args_json(json!({
            "receiver_id": rig.shop.id(),
            "amount": amount.to_string(),
            "memo": memo,
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await
        .expect("pay submitted")
}

#[tokio::test]
async fn pay_at_cap_succeeds() {
    let rig = rig(5_000_000, 60 * SEC).await;
    let before = balance(&rig.token, rig.vault.id()).await;
    must(pay(&rig, CAP, "nonce-at-cap").await);
    assert_eq!(balance(&rig.token, rig.vault.id()).await, before - CAP);
    assert_eq!(balance(&rig.token, rig.shop.id()).await, CAP);
}

#[tokio::test]
async fn pay_over_cap_rejected_no_transfer() {
    let rig = rig(5_000_000, 60 * SEC).await;
    let before = balance(&rig.token, rig.vault.id()).await;
    let outcome = pay(&rig, CAP + 1, "nonce-over").await;
    assert!(!outcome.is_success(), "over-cap pay must not succeed");
    assert_eq!(balance(&rig.token, rig.vault.id()).await, before);
    assert_eq!(balance(&rig.token, rig.shop.id()).await, 0);
}

#[tokio::test]
async fn budget_window_exhausted_rejected() {
    let rig = rig(CAP * 2, 60 * SEC).await;
    must(pay(&rig, CAP, "nonce-1").await);
    must(pay(&rig, CAP, "nonce-2").await);
    let before = balance(&rig.token, rig.vault.id()).await;
    let third = pay(&rig, 1, "nonce-3").await;
    assert!(!third.is_success());
    assert_eq!(balance(&rig.token, rig.vault.id()).await, before);
}

#[tokio::test]
async fn budget_window_rolls_over() {
    let rig = rig(CAP, 2 * SEC).await;
    must(pay(&rig, CAP, "nonce-window").await);
    let blocked = pay(&rig, 1, "nonce-blocked").await;
    assert!(!blocked.is_success());
    rig.worker.fast_forward(40).await.expect("fast forward");
    must(pay(&rig, CAP, "nonce-next-window").await);
    assert_eq!(balance(&rig.token, rig.shop.id()).await, CAP * 2);
}

#[tokio::test]
async fn budget_released_on_failed_transfer() {
    let rig = rig(CAP, 60 * SEC).await;
    let stranger = rig.worker.dev_create_account().await.expect("stranger");
    let failed = rig
        .owner
        .call(rig.vault.id(), "pay")
        .args_json(json!({
            "receiver_id": stranger.id(),
            "amount": CAP.to_string(),
            "memo": "nonce-unregistered",
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await
        .expect("pay submitted");
    assert!(
        !failed.receipt_failures().is_empty(),
        "unregistered receiver must fail the transfer: {:?}",
        failed.failures()
    );
    let reserved: String = rig.vault.view("get_reserved").await.expect("view").json().expect("json");
    assert_eq!(reserved, "0");
    must(pay(&rig, CAP, "nonce-after-release").await);
    assert_eq!(balance(&rig.token, rig.shop.id()).await, CAP);
}

#[tokio::test]
async fn payout_memo_equals_quote_nonce() {
    let rig = rig(5_000_000, 60 * SEC).await;
    let nonce = "quote-nonce-32hexchars000000000000";
    let outcome = must(pay(&rig, CAP, nonce).await);
    let logs = outcome.logs().join("\n");
    assert!(logs.contains(nonce), "memo missing from logs: {logs}");
}

#[tokio::test]
async fn agent_key_cannot_call_ft_transfer() {
    let rig = rig(5_000_000, 60 * SEC).await;
    let secret = SecretKey::from_seed(KeyType::ED25519, "clearing-spend-agent");
    let public = secret.public_key();
    must(
        rig.owner
            .call(rig.vault.id(), "add_agent_key")
            .args_json(json!({ "public_key": public.to_string() }))
            .gas(Gas::from_tgas(50))
            .transact()
            .await
            .expect("add key"),
    );
    let signer = InMemorySigner::from_secret_key(rig.vault.id().clone(), secret.clone());
    let direct = rig
        .worker
        .call(&signer, rig.token.id(), "ft_transfer")
        .args_json(json!({
            "receiver_id": rig.shop.id(),
            "amount": CAP.to_string(),
            "memo": "not-through-the-vault",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(30))
        .transact()
        .await;
    if let Ok(outcome) = direct {
        assert!(!outcome.is_success(), "agent key must not call ft_transfer: {:?}", outcome.failures());
    }
    assert_eq!(balance(&rig.token, rig.vault.id()).await, 10_000_000);

    let through = must(
        rig.worker
            .call(&signer, rig.vault.id(), "pay")
            .args_json(json!({
                "receiver_id": rig.shop.id(),
                "amount": CAP.to_string(),
                "memo": "nonce-via-agent-key",
            }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await
            .expect("agent pay"),
    );
    assert!(through.logs().join("\n").contains("nonce-via-agent-key"));
    let methods: String = rig.vault.view("get_agent_methods").await.expect("methods").json().expect("json");
    assert_eq!(methods, AGENT_METHODS);
    assert!(!AGENT_METHODS.split(',').any(|name| name == "ft_transfer" || name == "confirm"));
}
