//! USDC spend vault. The vault is the payer on `ft_transfer`. An agent key
//! may call only `pay` and `ping`. Its NEAR allowance pays gas, not tokens.
//!
//! Patterns, not copied code:
//! - soldanoandrea/allowance@74edffec `src/policy.rs` (`per_tx_cap`, budget
//!   window, reserve before the transfer, release on failure) and `src/lib.rs`
//!   (method-limited key via `Allowance::limited`).
//! - near/core-contracts@1b0436c9 `multisig2/src/lib.rs`: a function-call key
//!   whose method list is fixed, and a ceiling on outstanding requests.
//!
//! Checked against near-sdk 5.7, not against those repos:
//! - `Allowance::limited` and `add_access_key_allowance` (the allowance is gas):
//!   https://docs.rs/near-sdk/5.7.0/near_sdk/struct.Promise.html
//! - Function-call keys: https://docs.near.org/protocol/access-keys
//! - `ft_transfer` attaches 1 yoctoNEAR, and the sender must hold the amount:
//!   https://github.com/near/NEPs/blob/master/neps/nep-0141.md
//! - `storage_deposit` with `registration_only` runs before `ft_transfer`
//!   only for an allowlisted receiver. An empty allowlist sends `ft_transfer`
//!   alone, so a fresh account cannot spend the vault's NEAR.
//!   https://github.com/near/NEPs/blob/master/neps/nep-0145.md
//!
//! Allowance MIT notice: `near/spend-cap/THIRD_PARTY_NOTICES`.
#![deny(unused)]

mod policy;

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseOrValue, PromiseResult, PublicKey,
};
use policy::{evaluate, roll_window, Decision, Policy, Rejection, SpendSnap};
pub use policy::DEFAULT_MAX_OPEN_APPROVALS;

/// Methods the agent function-call key may call. `confirm` stays off this list.
pub const AGENT_METHODS: &str = "pay,ping";

/// Gas the agent key may burn. This is not a USDC budget.
pub const KEY_GAS_ALLOWANCE: NearToken = NearToken::from_near(1);

const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(15);
const GAS_FT_BALANCE: Gas = Gas::from_tgas(10);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(20);
const GAS_ON_PAID: Gas = Gas::from_tgas(20);
const GAS_ON_WITHDRAW_CHECK: Gas = Gas::from_tgas(80);
const MIN_GAS_PAY: Gas = Gas::from_tgas(80);
const MIN_GAS_WITHDRAW: Gas = Gas::from_tgas(120);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// One account on the reference fungible token.
/// near-contract-standards 5.7 measures it in `FungibleToken::new`
/// (`measure_account_storage_usage`) and `storage_balance_bounds` multiplies
/// that by the protocol byte cost, 10^19 yoctoNEAR. Excess is refunded.
const FT_STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const MAX_MEMO_LEN: usize = 128;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Prefix {
    Approvals,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Approval {
    pub id: u64,
    pub receiver: AccountId,
    pub amount: u128,
    pub memo: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct SpendVault {
    token_id: AccountId,
    owner_id: AccountId,
    agent_pk: Option<PublicKey>,
    per_tx_cap: u128,
    budget_limit: Option<u128>,
    budget_period_ns: Option<u64>,
    allow: Vec<AccountId>,
    deny: Vec<AccountId>,
    cooldown_ns: u64,
    approval_threshold: Option<u128>,
    max_open_approvals: u32,
    spent: u128,
    reserved: u128,
    /// USDC held for an in-flight owner withdraw. `on_withdraw` releases it.
    withdraw_inflight: u128,
    window_start_ns: u64,
    last_payment_ns: u64,
    next_approval: u64,
    approvals: LookupMap<u64, Approval>,
    open_approvals: u32,
}

#[near]
impl SpendVault {
    #[init]
    pub fn new(
        token_id: AccountId,
        owner_id: AccountId,
        per_tx_cap: U128,
        budget_limit: Option<U128>,
        budget_period_ns: Option<u64>,
        cooldown_ns: u64,
        approval_threshold: Option<U128>,
        max_open_approvals: u32,
    ) -> Self {
        require!(per_tx_cap.0 > 0, "per_tx_cap must be greater than zero");
        require!(owner_id != token_id, "owner must not be the token");
        if let Some(threshold) = approval_threshold {
            require!(threshold.0 < per_tx_cap.0, "approval_threshold must be below per_tx_cap");
        }
        require!(
            (1..=100).contains(&max_open_approvals),
            "max_open_approvals must be between 1 and 100"
        );
        if budget_limit.is_some() {
            require!(
                budget_period_ns.unwrap_or(0) > 0,
                "a budget needs a window length"
            );
        }
        Self {
            token_id,
            owner_id,
            agent_pk: None,
            per_tx_cap: per_tx_cap.0,
            budget_limit: budget_limit.map(|v| v.0),
            budget_period_ns,
            allow: Vec::new(),
            deny: Vec::new(),
            cooldown_ns,
            approval_threshold: approval_threshold.map(|v| v.0),
            max_open_approvals,
            spent: 0,
            reserved: 0,
            withdraw_inflight: 0,
            window_start_ns: 0,
            last_payment_ns: 0,
            next_approval: 1,
            approvals: LookupMap::new(Prefix::Approvals),
            open_approvals: 0,
        }
    }

    /// Owner only. The key can call `pay` and `ping` on this vault, and its
    /// allowance is gas.
    pub fn add_agent_key(&mut self, public_key: PublicKey) -> Promise {
        self.assert_owner();
        let allowance = Allowance::limited(KEY_GAS_ALLOWANCE).expect("gas allowance is non-zero");
        self.agent_pk = Some(public_key.clone());
        Promise::new(env::current_account_id()).add_access_key_allowance(
            public_key,
            allowance,
            env::current_account_id(),
            AGENT_METHODS.to_string(),
        )
    }

    pub fn set_allow(&mut self, allow: Vec<AccountId>) {
        self.assert_owner();
        self.allow = allow;
    }

    pub fn set_deny(&mut self, deny: Vec<AccountId>) {
        self.assert_owner();
        self.deny = deny;
    }

    /// Liveness for the agent key. No tokens move.
    pub fn ping(&self) -> bool {
        self.assert_spender();
        true
    }

    /// Pay `amount` of the vault's USDC. `memo` is the shop quote nonce.
    /// The transfer's sender is this vault.
    pub fn pay(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: String,
    ) -> PromiseOrValue<U128> {
        self.assert_spender();
        self.start_pay(receiver_id, amount.0, memo, false)
    }

    /// Owner takes USDC out. The cap, window, and allowlist do not apply.
    /// The agent key cannot call this: its method list is `pay,ping`, and a
    /// function-call key cannot attach the 1 yoctoNEAR NEP-141 requires.
    #[payable]
    pub fn withdraw(&mut self, receiver_id: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        require!(env::attached_deposit() == ONE_YOCTO, "attach 1 yoctoNEAR");
        require!(amount.0 > 0, "amount must be positive");
        require!(receiver_id != env::current_account_id(), "receiver must not be the vault");
        require!(env::prepaid_gas() >= MIN_GAS_WITHDRAW, "attach at least 120 TGas");
        ext_ft::ext(self.token_id.clone())
            .with_static_gas(GAS_FT_BALANCE)
            .ft_balance_of(env::current_account_id())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_WITHDRAW_CHECK)
                    .on_withdraw_check(receiver_id, amount),
            )
    }

    /// Owner confirms a pay that was above the approval threshold.
    pub fn confirm(&mut self, request_id: u64) -> Promise {
        self.assert_owner();
        let approval = self
            .approvals
            .remove(&request_id)
            .unwrap_or_else(|| env::panic_str("unknown approval"));
        self.open_approvals = self.open_approvals.saturating_sub(1);
        match self.start_pay(approval.receiver, approval.amount, approval.memo, true) {
            PromiseOrValue::Promise(promise) => promise,
            PromiseOrValue::Value(_) => env::panic_str("confirmed pay did not transfer"),
        }
    }

    #[private]
    pub fn on_paid(&mut self, amount: U128) {
        if matches!(env::promise_result(0), PromiseResult::Successful(_)) {
            self.commit(amount.0);
        } else {
            self.release_reserve(amount.0);
        }
    }

    /// `balance - reserved - inflight` is what a withdraw may take.
    /// In-flight pays still sit on this vault until `on_paid`.
    #[private]
    pub fn on_withdraw_check(&mut self, receiver_id: AccountId, amount: U128) -> Promise {
        let balance = match env::promise_result(0) {
            PromiseResult::Successful(bytes) => near_sdk::serde_json::from_slice::<U128>(&bytes)
                .unwrap_or_else(|_| env::panic_str("bad balance"))
                .0,
            _ => env::panic_str("balance lookup failed"),
        };
        let held = self.reserved.saturating_add(self.withdraw_inflight);
        let available = balance.saturating_sub(held);
        require!(amount.0 <= available, "withdraw exceeds available balance");
        self.withdraw_inflight = self
            .withdraw_inflight
            .checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str("withdraw overflow"));
        let register = self.allow.iter().any(|id| id == &receiver_id);
        self.transfer_out(
            receiver_id,
            amount.0,
            Some("owner-withdraw".to_string()),
            register,
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_PAID)
                .on_withdraw(U128(amount.0)),
        )
    }

    /// The token keeps the vault's balance when `ft_transfer` fails.
    /// Releasing the hold lets the owner withdraw that amount again.
    #[private]
    pub fn on_withdraw(&mut self, amount: U128) -> bool {
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        self.withdraw_inflight = self.withdraw_inflight.saturating_sub(amount.0);
        ok
    }

    pub fn get_spent(&self) -> U128 {
        U128(self.spent)
    }

    pub fn get_reserved(&self) -> U128 {
        U128(self.reserved)
    }

    pub fn get_open_approvals(&self) -> u32 {
        self.open_approvals
    }

    pub fn get_agent_methods(&self) -> String {
        AGENT_METHODS.to_string()
    }

    pub fn get_withdraw_inflight(&self) -> U128 {
        U128(self.withdraw_inflight)
    }
}

#[near_sdk::ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

impl SpendVault {
    fn policy(&self) -> Policy {
        Policy {
            per_tx_cap: self.per_tx_cap,
            budget_limit: self.budget_limit,
            budget_period_ns: self.budget_period_ns,
            allow: self.allow.clone(),
            deny: self.deny.clone(),
            cooldown_ns: self.cooldown_ns,
            approval_threshold: self.approval_threshold,
            max_open_approvals: self.max_open_approvals,
        }
    }

    fn snap(&self) -> SpendSnap {
        SpendSnap {
            spent: self.spent,
            reserved: self.reserved,
            window_start_ns: self.window_start_ns,
            last_payment_ns: self.last_payment_ns,
            open_approvals: self.open_approvals,
        }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "only the owner");
    }

    fn assert_spender(&self) {
        let caller = env::predecessor_account_id();
        if caller == self.owner_id {
            return;
        }
        require!(caller == env::current_account_id(), "only the owner or the agent key");
        let Some(agent) = &self.agent_pk else {
            env::panic_str("no agent key");
        };
        require!(env::signer_account_pk() == *agent, "signer is not the agent key");
    }

    fn start_pay(
        &mut self,
        receiver_id: AccountId,
        amount: u128,
        memo: String,
        approval_granted: bool,
    ) -> PromiseOrValue<U128> {
        require!(amount > 0, "amount must be positive");
        require!(!memo.is_empty() && memo.len() <= MAX_MEMO_LEN, "bad memo");
        let now = env::block_timestamp();
        let mut snap = self.snap();
        roll_window(&self.policy(), &mut snap, now);
        self.spent = snap.spent;
        self.window_start_ns = snap.window_start_ns;
        let decision = evaluate(
            &self.policy(),
            &self.snap(),
            &receiver_id,
            amount,
            now,
            approval_granted,
        );
        match decision {
            Err(reason) => env::panic_str(reason_text(reason)),
            Ok(Decision::NeedsApproval) => {
                let id = self.next_approval;
                self.next_approval += 1;
                self.approvals.insert(
                    id,
                    Approval { id, receiver: receiver_id, amount, memo },
                );
                self.open_approvals += 1;
                PromiseOrValue::Value(U128(id as u128))
            }
            Ok(Decision::Pay) => {
                require!(env::prepaid_gas() >= MIN_GAS_PAY, "attach at least 80 TGas");
                self.reserve(amount);
                let register = self.allow.iter().any(|id| id == &receiver_id);
                let promise = self.transfer_out(
                    receiver_id,
                    amount,
                    Some(memo),
                    register,
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_PAID)
                        .on_paid(U128(amount)),
                );
                PromiseOrValue::Promise(promise)
            }
        }
    }

    /// NEP-141 transfer. `register` adds NEP-145 `storage_deposit` first,
    /// and only an allowlisted receiver sets that flag. The callback's
    /// `promise_result(0)` is the transfer either way.
    fn transfer_out(
        &self,
        receiver_id: AccountId,
        amount: u128,
        memo: Option<String>,
        register: bool,
        callback: Promise,
    ) -> Promise {
        let transfer = ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(receiver_id.clone(), U128(amount), memo);
        let transfer = if register {
            ext_ft::ext(self.token_id.clone())
                .with_attached_deposit(FT_STORAGE_DEPOSIT)
                .with_static_gas(GAS_STORAGE_DEPOSIT)
                .storage_deposit(Some(receiver_id), Some(true))
                .then(transfer)
        } else {
            transfer
        };
        transfer.then(callback)
    }

    fn reserve(&mut self, amount: u128) {
        self.reserved = self
            .reserved
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("reserve overflow"));
    }

    fn release_reserve(&mut self, amount: u128) {
        self.reserved = self.reserved.saturating_sub(amount);
    }

    fn commit(&mut self, amount: u128) {
        self.reserved = self.reserved.saturating_sub(amount);
        self.spent = self
            .spent
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("spent overflow"));
        self.last_payment_ns = env::block_timestamp();
    }
}

fn reason_text(reason: Rejection) -> &'static str {
    match reason {
        Rejection::Denylisted => "denylisted",
        Rejection::NotAllowlisted => "not allowlisted",
        Rejection::OverPerTxCap => "over per_tx_cap",
        Rejection::Cooldown => "cooldown",
        Rejection::OverBudget => "over budget",
        Rejection::TooManyOpenApprovals => "too many open approvals",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn owner() -> AccountId {
        "owner.testnet".parse().unwrap()
    }
    fn vault() -> AccountId {
        "vault.testnet".parse().unwrap()
    }
    fn token() -> AccountId {
        "token.testnet".parse().unwrap()
    }
    fn shop() -> AccountId {
        "shop.testnet".parse().unwrap()
    }

    fn set_owner(now: u64) {
        let ctx = VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(owner())
            .signer_account_id(owner())
            .block_timestamp(now)
            .prepaid_gas(Gas::from_tgas(300))
            .account_balance(NearToken::from_near(20))
            .build();
        testing_env!(ctx);
    }

    fn open_vault() -> SpendVault {
        set_owner(0);
        SpendVault::new(
            token(),
            owner(),
            U128(1_000_000),
            Some(U128(2_000_000)),
            Some(1_000),
            0,
            None,
            DEFAULT_MAX_OPEN_APPROVALS,
        )
    }

    #[test]
    fn pay_over_cap_rejects_before_a_transfer() {
        let mut spend = open_vault();
        set_owner(1);
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            spend.pay(shop(), U128(1_000_001), "nonce-1".to_string());
        }));
        assert!(caught.is_err());
        assert_eq!(spend.get_reserved().0, 0);
        assert_eq!(spend.get_spent().0, 0);
    }

    #[test]
    fn pay_at_cap_reserves_the_budget() {
        let mut spend = open_vault();
        set_owner(1);
        let result = spend.pay(shop(), U128(1_000_000), "nonce-at-cap".to_string());
        assert!(matches!(result, PromiseOrValue::Promise(_)));
        assert_eq!(spend.get_reserved().0, 1_000_000);
    }

    #[test]
    fn a_failed_transfer_releases_the_reservation() {
        let mut spend = open_vault();
        set_owner(1);
        let _ = spend.pay(shop(), U128(1_000_000), "nonce-fail".to_string());
        set_owner(2);
        // The callback's predecessor is the vault itself.
        let ctx = VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(vault())
            .block_timestamp(2)
            .prepaid_gas(Gas::from_tgas(300))
            .build();
        testing_env!(
            ctx,
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed],
        );
        spend.on_paid(U128(1_000_000));
        assert_eq!(spend.get_reserved().0, 0);
        assert_eq!(spend.get_spent().0, 0);
        set_owner(3);
        let again = spend.pay(shop(), U128(1_000_000), "nonce-retry".to_string());
        assert!(matches!(again, PromiseOrValue::Promise(_)));
    }

    #[test]
    fn budget_rolls_over_when_the_window_ends() {
        let mut spend = open_vault();
        set_owner(1);
        let _ = spend.pay(shop(), U128(1_000_000), "nonce-a".to_string());
        set_owner(2);
        let ctx = VMContextBuilder::new()
            .current_account_id(crate::tests::vault())
            .predecessor_account_id(crate::tests::vault())
            .block_timestamp(2)
            .prepaid_gas(Gas::from_tgas(300))
            .build();
        testing_env!(
            ctx,
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Successful(Vec::new())],
        );
        spend.on_paid(U128(1_000_000));
        set_owner(3);
        let _ = spend.pay(shop(), U128(1_000_000), "nonce-b".to_string());
        set_owner(4);
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            spend.pay(shop(), U128(1), "nonce-c".to_string());
        }));
        assert!(blocked.is_err());
        set_owner(1_000);
        let rolled = spend.pay(shop(), U128(1_000_000), "nonce-d".to_string());
        assert!(matches!(rolled, PromiseOrValue::Promise(_)));
    }

    #[test]
    fn withdraw_rejects_anyone_but_the_owner() {
        let mut spend = open_vault();
        let ctx = VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(shop())
            .signer_account_id(shop())
            .prepaid_gas(Gas::from_tgas(300))
            .attached_deposit(ONE_YOCTO)
            .build();
        testing_env!(ctx);
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            spend.withdraw(shop(), U128(1));
        }));
        assert!(caught.is_err());
        assert_eq!(spend.get_withdraw_inflight().0, 0);
    }

    fn callback_env(results: Vec<PromiseResult>) {
        let ctx = VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(vault())
            .block_timestamp(2)
            .prepaid_gas(Gas::from_tgas(300))
            .build();
        testing_env!(
            ctx,
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results,
        );
    }

    fn balance_result(amount: u128) -> PromiseResult {
        PromiseResult::Successful(near_sdk::serde_json::to_vec(&U128(amount)).expect("json"))
    }

    #[test]
    fn withdraw_rejects_more_than_balance_minus_reserved() {
        let mut spend = open_vault();
        spend.reserved = 400;
        callback_env(vec![balance_result(1_000)]);
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            spend.on_withdraw_check(shop(), U128(601));
        }));
        assert!(caught.is_err());
        assert_eq!(spend.get_withdraw_inflight().0, 0);
        callback_env(vec![balance_result(1_000)]);
        let _ = spend.on_withdraw_check(shop(), U128(600));
        assert_eq!(spend.get_withdraw_inflight().0, 600);
        assert_eq!(spend.get_reserved().0, 400);
    }

    #[test]
    fn a_failed_withdraw_releases_the_hold() {
        let mut spend = open_vault();
        callback_env(vec![balance_result(1_000)]);
        let _ = spend.on_withdraw_check(shop(), U128(50));
        assert_eq!(spend.get_withdraw_inflight().0, 50);
        assert_eq!(spend.get_spent().0, 0);
        assert_eq!(spend.get_reserved().0, 0);
        callback_env(vec![PromiseResult::Failed]);
        assert!(!spend.on_withdraw(U128(50)));
        assert_eq!(spend.get_withdraw_inflight().0, 0);
        assert_eq!(spend.get_spent().0, 0);
    }
}
