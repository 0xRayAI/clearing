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

fn build_wasm(manifest: &str, artifact: &str, feature: Option<&str>) -> Vec<u8> {
    let target = std::env::temp_dir().join(format!("clearing-spend-{artifact}"));
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

fn vault_wasm() -> &'static [u8] {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| {
        build_wasm(
            &manifest("Cargo.toml"),
            "clearing_spend_cap",
            Some("sandbox-token"),
        )
    })
    .as_slice()
}

fn token_wasm() -> &'static [u8] {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| {
        build_wasm(
            &manifest("../escrow/tests/ft/Cargo.toml"),
            "clearing_escrow_token",
            None,
        )
    })
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
    rig_with(budget_limit, budget_period_ns, 10_000_000).await
}

async fn rig_with(budget_limit: u128, budget_period_ns: u64, mint_amount: u128) -> Rig {
    let worker = near_workspaces::sandbox().await.expect("sandbox");
    let token = worker.dev_deploy(token_wasm()).await.expect("token");
    let vault = worker.dev_deploy(vault_wasm()).await.expect("vault");
    let owner = worker.dev_create_account().await.expect("owner");
    let shop = worker.dev_create_account().await.expect("shop");
    must(
        token
            .call("new")
            .gas(Gas::from_tgas(50))
            .transact()
            .await
            .expect("token init"),
    );
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
    if mint_amount > 0 {
        mint(&token, vault.id(), mint_amount).await;
    }
    Rig {
        worker,
        token,
        vault,
        owner,
        shop,
    }
}

async fn mint(token: &Contract, account: &AccountId, amount: u128) {
    must(
        token
            .call("mint")
            .args_json(json!({ "account_id": account, "amount": amount.to_string() }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await
            .expect("mint"),
    );
}

async fn register(payer: &Account, token: &Contract, account: &AccountId) {
    let bounds: serde_json::Value = token
        .view("storage_balance_bounds")
        .await
        .expect("bounds")
        .json()
        .expect("json");
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

fn must(
    outcome: near_workspaces::result::ExecutionFinalResult,
) -> near_workspaces::result::ExecutionFinalResult {
    assert!(
        outcome.is_success(),
        "call failed: {:?}",
        outcome.failures()
    );
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
        .gas(Gas::from_tgas(150))
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
    let rig = rig(CAP, 60 * SEC).await;
    must(pay(&rig, CAP, "nonce-window").await);
    let blocked = pay(&rig, 1, "nonce-blocked").await;
    assert!(!blocked.is_success(), "second pay in the window must fail");
    // nearcore sandbox fast config produces blocks every (120ms+500ms)/2.
    // fast_forward(120) is about 37s, which can stay inside this 60s window.
    // near-workspaces `Worker::fast_forward` moves block height and
    // `Block::timestamp` (nanoseconds). Keep going until that clock has
    // passed a full window, then require the next pay to succeed.
    let marked = rig.worker.view_block().await.expect("block").timestamp();
    let mut now = marked;
    for _ in 0..8 {
        if now.saturating_sub(marked) > 60 * SEC {
            break;
        }
        rig.worker.fast_forward(400).await.expect("fast forward");
        now = rig.worker.view_block().await.expect("block").timestamp();
    }
    assert!(
        now.saturating_sub(marked) > 60 * SEC,
        "block_timestamp moved {} ns, the 60s window is still open",
        now.saturating_sub(marked)
    );
    must(pay(&rig, CAP, "nonce-next-window").await);
    assert_eq!(balance(&rig.token, rig.shop.id()).await, CAP * 2);
}

#[tokio::test]
async fn budget_released_on_failed_transfer() {
    let rig = rig_with(CAP, 60 * SEC, 0).await;
    let failed = pay(&rig, CAP, "nonce-empty-vault").await;
    assert!(
        !failed.receipt_failures().is_empty(),
        "an empty vault must fail the transfer: {:?}",
        failed.failures()
    );
    let reserved: String = rig
        .vault
        .view("get_reserved")
        .await
        .expect("view")
        .json()
        .expect("json");
    assert_eq!(reserved, "0");
    mint(&rig.token, rig.vault.id(), CAP).await;
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
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(80))
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
        assert!(
            !outcome.is_success(),
            "agent key must not call ft_transfer: {:?}",
            outcome.failures()
        );
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
            .gas(Gas::from_tgas(150))
            .transact()
            .await
            .expect("agent pay"),
    );
    assert!(through.logs().join("\n").contains("nonce-via-agent-key"));
    let methods: String = rig
        .vault
        .view("get_agent_methods")
        .await
        .expect("methods")
        .json()
        .expect("json");
    assert_eq!(methods, AGENT_METHODS);
    assert!(!AGENT_METHODS
        .split(',')
        .any(|name| name == "ft_transfer" || name == "confirm" || name == "withdraw"));
}

#[tokio::test]
async fn empty_allowlist_pay_to_unregistered_releases_without_storage() {
    let rig = rig(5_000_000, 60 * SEC).await;
    let fresh = rig.worker.dev_create_account().await.expect("fresh");
    let tokens_before = balance(&rig.token, rig.vault.id()).await;
    let near_before = rig
        .worker
        .view_account(rig.vault.id())
        .await
        .expect("account")
        .balance;
    let failed = rig
        .owner
        .call(rig.vault.id(), "pay")
        .args_json(json!({
            "receiver_id": fresh.id(),
            "amount": "1",
            "memo": "nonce-empty-allow",
        }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await
        .expect("pay submitted");
    assert!(
        !failed.receipt_failures().is_empty(),
        "unregistered pay must fail: {:?}",
        failed.failures()
    );
    assert_eq!(balance(&rig.token, rig.vault.id()).await, tokens_before);
    assert_eq!(balance(&rig.token, fresh.id()).await, 0);
    let reserved: String = rig
        .vault
        .view("get_reserved")
        .await
        .expect("view")
        .json()
        .expect("json");
    assert_eq!(reserved, "0");
    let near_after = rig
        .worker
        .view_account(rig.vault.id())
        .await
        .expect("account")
        .balance;
    let dropped = near_before
        .as_yoctonear()
        .saturating_sub(near_after.as_yoctonear());
    assert!(
        dropped < 1_250_000_000_000_000_000_000,
        "vault NEAR dropped by {dropped}, storage deposit is 0.00125 NEAR"
    );
}

#[tokio::test]
async fn allowlisted_unregistered_receiver_succeeds() {
    let rig = rig(5_000_000, 60 * SEC).await;
    let fresh = rig.worker.dev_create_account().await.expect("fresh");
    must(
        rig.owner
            .call(rig.vault.id(), "set_allow")
            .args_json(json!({ "allow": [fresh.id()] }))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await
            .expect("allow"),
    );
    let before = balance(&rig.token, rig.vault.id()).await;
    must(
        rig.owner
            .call(rig.vault.id(), "pay")
            .args_json(json!({
                "receiver_id": fresh.id(),
                "amount": CAP.to_string(),
                "memo": "nonce-allowlisted",
            }))
            .gas(Gas::from_tgas(150))
            .transact()
            .await
            .expect("pay submitted"),
    );
    assert_eq!(balance(&rig.token, fresh.id()).await, CAP);
    assert_eq!(balance(&rig.token, rig.vault.id()).await, before - CAP);
}

#[tokio::test]
async fn owner_withdraw_restores_on_failure_then_pays_out() {
    let rig = rig(5_000_000, 60 * SEC).await;
    let fresh = rig.worker.dev_create_account().await.expect("fresh");
    let before = balance(&rig.token, rig.vault.id()).await;
    let too_much = rig
        .owner
        .call(rig.vault.id(), "withdraw")
        .args_json(json!({
            "receiver_id": fresh.id(),
            "amount": (before + 1).to_string(),
        }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(150))
        .transact()
        .await
        .expect("withdraw submitted");
    assert!(
        !too_much.receipt_failures().is_empty(),
        "a withdraw above the token balance must fail: {:?}",
        too_much.failures()
    );
    assert_eq!(balance(&rig.token, rig.vault.id()).await, before);
    assert_eq!(balance(&rig.token, fresh.id()).await, 0);
    let inflight: String = rig
        .vault
        .view("get_withdraw_inflight")
        .await
        .expect("view")
        .json()
        .expect("json");
    assert_eq!(inflight, "0");
    let spent: String = rig
        .vault
        .view("get_spent")
        .await
        .expect("view")
        .json()
        .expect("json");
    assert_eq!(spent, "0");
    must(
        rig.owner
            .call(rig.vault.id(), "set_allow")
            .args_json(json!({ "allow": [fresh.id()] }))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await
            .expect("allow"),
    );

    let out = CAP * 2;
    must(
        rig.owner
            .call(rig.vault.id(), "withdraw")
            .args_json(json!({
                "receiver_id": fresh.id(),
                "amount": out.to_string(),
            }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(150))
            .transact()
            .await
            .expect("withdraw"),
    );
    assert_eq!(balance(&rig.token, fresh.id()).await, out);
    assert_eq!(balance(&rig.token, rig.vault.id()).await, before - out);
    let spent_after: String = rig
        .vault
        .view("get_spent")
        .await
        .expect("view")
        .json()
        .expect("json");
    assert_eq!(spent_after, "0");
}

#[tokio::test]
async fn agent_key_cannot_withdraw() {
    let rig = rig(5_000_000, 60 * SEC).await;
    let secret = SecretKey::from_seed(KeyType::ED25519, "clearing-spend-agent-withdraw");
    let public = secret.public_key();
    must(
        rig.owner
            .call(rig.vault.id(), "add_agent_key")
            .args_json(json!({ "public_key": public.to_string() }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(80))
            .transact()
            .await
            .expect("add key"),
    );
    let signer = InMemorySigner::from_secret_key(rig.vault.id().clone(), secret);
    let before = balance(&rig.token, rig.vault.id()).await;
    let direct = rig
        .worker
        .call(&signer, rig.vault.id(), "withdraw")
        .args_json(json!({
            "receiver_id": rig.shop.id(),
            "amount": CAP.to_string(),
        }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(150))
        .transact()
        .await;
    if let Ok(outcome) = direct {
        assert!(
            !outcome.is_success(),
            "agent key must not withdraw: {:?}",
            outcome.failures()
        );
    }
    assert_eq!(balance(&rig.token, rig.vault.id()).await, before);
    let methods: String = rig
        .vault
        .view("get_agent_methods")
        .await
        .expect("methods")
        .json()
        .expect("json");
    assert_eq!(methods, AGENT_METHODS);
    assert!(!methods.split(',').any(|name| name == "withdraw"));
}
