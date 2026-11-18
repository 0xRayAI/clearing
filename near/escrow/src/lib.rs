//! Testnet USDC escrow. The buyer locks a price. The creator is paid after the
//! buyer accepts the work, when the review window ends, or when both keys sign
//! a split.
//!
//! Patterns, not copied code, from Basssoman/pinky@c94cb144 `contract/src/lib.rs`:
//! `escrow-v1|` signed actions, `creator_pk`, `settle` with both signatures,
//! `close_unpaid` after an unpaid funding window, a fee taken only from the
//! creator's share (fixed here at 0), and a private callback after `ft_transfer`.
//! This message also binds the chain id and a nonce, so a signature cannot be
//! replayed on another chain or twice on this contract.
//! Pinky's copyright and MIT permission text: `near/escrow/THIRD_PARTY_NOTICES`.
//!
//! Unused-amount refund idea, path and sha only, nothing copied:
//! Balloon-DefAI/balloons-contracts@eb1f045 `src/ft_receiver.rs`.
//! A bad message, a short payment, or any tokens above the price are returned
//! from `ft_on_transfer` so the token's `ft_resolve_transfer` sends them back.
//!
//! APIs checked against near-sdk 5.7, not against those repos:
//! - `env::ed25519_verify`: https://docs.rs/near-sdk/5.7.0/near_sdk/env/fn.ed25519_verify.html
//! - `#[private]` (predecessor must be this contract):
//!   https://docs.rs/near-sdk/5.7.0/near_sdk/attr.near.html
//! - `PromiseResult`: https://docs.rs/near-sdk/5.7.0/near_sdk/enum.PromiseResult.html
//! - NEP-141 refund: https://nomicon.io/Standards/Tokens/FungibleToken/Core
//! - `ft_transfer` attaches 1 yoctoNEAR: https://docs.near.org/primitives/ft
//!
//! Init accepts Circle USDC on NEAR testnet or mainnet.
#![deny(unused)]

use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue, PromiseResult,
};

/// Circle USDC on NEAR testnet (ft_metadata: symbol USDC, decimals 6).
pub const CIRCLE_USDC_NEAR_TESTNET: &str =
    "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

/// Circle USDC on NEAR mainnet (ft_metadata: symbol USDC, decimals 6).
pub const CIRCLE_USDC_NEAR_MAINNET: &str =
    "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/// Every signed string starts with this. The rest is chain, contract, deal,
/// action, nonce, and the exact payload.
pub const MESSAGE_PREFIX: &str = "escrow-v1";

/// Jobs below 1 USDC (6 decimals) are not escrowed. The direct rail covers them.
pub const MIN_AMOUNT: u128 = 1_000_000;

/// The card fixes the fee at zero. Nothing is skimmed from the creator's share.
pub const FEE_BPS: u16 = 0;

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(20);
const GAS_FT_BALANCE: Gas = Gas::from_tgas(10);
const GAS_ON_WITHDRAW: Gas = Gas::from_tgas(20);
const GAS_ON_SETTLE: Gas = Gas::from_tgas(30);
/// `ft_transfer` plus the callback, with room for the host.
const MIN_GAS_WITHDRAW: Gas = Gas::from_tgas(80);
/// Balance read plus `on_settle`.
const MIN_GAS_SETTLE: Gas = Gas::from_tgas(50);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const MAX_BPS: u128 = 10_000;
/// Half, rounding the odd unit to the client.
const TIMEOUT_SPLIT_BPS: u128 = 5_000;
const MAX_HASH_LEN: usize = 128;
const MAX_PAYLOAD_LEN: usize = 1024;
/// 90 days. A window above this is refused.
const MAX_WINDOW_NS: u64 = 90 * 24 * 3600 * 1_000_000_000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Prefix {
    Deals,
    Balances,
    Used,
    Pending,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DealState {
    /// Opened by the creator key. No tokens yet.
    Created,
    Funded,
    Delivered,
    Disputed,
    Released,
    Refunded,
    /// Funding window ended with no payment (`close_unpaid`).
    Expired,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Deal {
    pub id: u64,
    pub client: Option<AccountId>,
    pub client_pk: [u8; 32],
    pub price: u128,
    pub state: DealState,
    pub fund_by_ns: u64,
    pub deliver_ns: u64,
    pub review_ns: u64,
    pub dispute_ns: u64,
    pub deliver_by_ns: Option<u64>,
    pub review_ends_ns: Option<u64>,
    pub dispute_ends_ns: Option<u64>,
    pub deliverable_hash: Option<String>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct OpenPayload {
    client_pk: String,
    price: String,
    deliver_ns: u64,
    review_ns: u64,
    dispute_ns: u64,
    fund_ns: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PendingStage {
    Outgoing,
    Settling,
}

/// One in-flight withdraw. `settle` reads it once and then removes it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Pending {
    pub account: AccountId,
    pub amount: u128,
    pub stage: PendingStage,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct FundMsg {
    deal_id: u64,
    nonce: String,
    signature: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Escrow {
    token_id: AccountId,
    arbiter_id: AccountId,
    /// Account that receives the creator's share.
    creator_id: AccountId,
    /// Foundry key. Signs deliver, open, and the creator half of settle.
    creator_pk: [u8; 32],
    /// Bound into every signed message. A testnet signature fails on mainnet.
    chain_id: String,
    /// Payer-chosen windows below this are refused.
    min_window_ns: u64,
    next_id: u64,
    deals: LookupMap<u64, Deal>,
    /// Withdrawable token units.
    balances: LookupMap<AccountId, u128>,
    /// `deal|action|nonce` already accepted.
    used: LookupSet<String>,
    /// Debited withdraws whose callback has not finished.
    pending: LookupMap<AccountId, Pending>,
    /// Token units this contract still owes: balances, open deals, and pending withdraws.
    accounted: u128,
}

/// `escrow-v1|{chain_id}|{contract_id}|{deal_id}|{action}|{nonce}|{payload}`
pub fn signed_message(
    chain_id: &str,
    contract_id: &str,
    deal_id: u64,
    action: &str,
    nonce: &str,
    payload: &str,
) -> String {
    format!("{MESSAGE_PREFIX}|{chain_id}|{contract_id}|{deal_id}|{action}|{nonce}|{payload}")
}

#[near]
impl Escrow {
    /// `token_id` must be Circle USDC on NEAR testnet or mainnet. `creator_pk`
    /// is the foundry ed25519 key (64 hex chars). `fee_bps` is not a parameter:
    /// it is 0.
    #[init]
    pub fn new(
        token_id: AccountId,
        arbiter_id: AccountId,
        creator_id: AccountId,
        creator_pk: String,
        chain_id: String,
        min_window_ns: u64,
    ) -> Self {
        require!(
            !env::state_exists(),
            "The contract has already been initialized"
        );
        require!(
            cfg!(feature = "sandbox-token")
                || token_id.as_str() == CIRCLE_USDC_NEAR_TESTNET
                || token_id.as_str() == CIRCLE_USDC_NEAR_MAINNET,
            "token_id must be Circle USDC on NEAR testnet or mainnet"
        );
        require!(
            arbiter_id != token_id && creator_id != token_id && arbiter_id != creator_id,
            "token, arbiter, and creator must be distinct"
        );
        require!(
            arbiter_id != env::current_account_id() && creator_id != env::current_account_id(),
            "arbiter and creator must not be the contract"
        );
        require!(
            !chain_id.is_empty() && chain_id.len() <= 32 && !chain_id.contains('|'),
            "bad chain_id"
        );
        require!(
            min_window_ns > 0 && min_window_ns <= MAX_WINDOW_NS,
            "bad min window"
        );
        let creator_pk =
            decode_fixed::<32>(&creator_pk).unwrap_or_else(|| env::panic_str("bad creator_pk"));
        Self {
            token_id,
            arbiter_id,
            creator_id,
            creator_pk,
            chain_id,
            min_window_ns,
            next_id: 1,
            deals: LookupMap::new(Prefix::Deals),
            balances: LookupMap::new(Prefix::Balances),
            used: LookupSet::new(Prefix::Used),
            pending: LookupMap::new(Prefix::Pending),
            accounted: 0,
        }
    }

    /// Creator key opens an unpaid deal. The payload is the exact signed JSON.
    /// Windows below `min_window_ns` are refused. `deal_id` in the message is 0.
    /// The caller pays for the new row. `close_unpaid` keeps the row so `get_deal`
    /// can still show `Expired`, and does not refund that storage.
    #[payable]
    pub fn open(&mut self, payload: String, nonce: String, signature: String) -> u64 {
        let before = env::storage_usage();
        require!(payload.len() <= MAX_PAYLOAD_LEN, "payload too long");
        let open: OpenPayload = near_sdk::serde_json::from_str(&payload)
            .unwrap_or_else(|_| env::panic_str("bad open payload"));
        let price: u128 = open
            .price
            .parse()
            .unwrap_or_else(|_| env::panic_str("bad price"));
        require!(price >= MIN_AMOUNT, "amount below the minimum (1 USDC)");
        self.require_window(open.deliver_ns);
        self.require_window(open.review_ns);
        self.require_window(open.dispute_ns);
        self.require_window(open.fund_ns);
        let client_pk =
            decode_fixed::<32>(&open.client_pk).unwrap_or_else(|| env::panic_str("bad client_pk"));
        require!(
            client_pk != self.creator_pk,
            "client key and creator key must differ"
        );
        self.check_sig(0, "open", &nonce, &payload, &signature, &self.creator_pk);
        self.commit_nonce(0, "open", &nonce);
        let id = self.next_id;
        self.next_id += 1;
        let now = env::block_timestamp();
        self.deals.insert(
            id,
            Deal {
                id,
                client: None,
                client_pk,
                price,
                state: DealState::Created,
                fund_by_ns: now.saturating_add(open.fund_ns),
                deliver_ns: open.deliver_ns,
                review_ns: open.review_ns,
                dispute_ns: open.dispute_ns,
                deliver_by_ns: None,
                review_ends_ns: None,
                dispute_ends_ns: None,
                deliverable_hash: None,
            },
        );
        env::log_str(&format!("escrow:opened|id={id}|price={price}"));
        // store::LookupMap writes on flush. Measure the new row after that.
        self.deals.flush();
        charge_storage(before);
        id
    }

    /// NEP-141 receiver. `msg` is `{"deal_id":N,"nonce":"...","signature":"..."}`.
    /// The client key must sign this deal and the paying account. Windows are
    /// not read from the payer. Anything we will not lock is returned so the
    /// token refunds it. A plain `ft_transfer` never reaches this method.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.token_id {
            return PromiseOrValue::Value(amount);
        }
        if amount.0 < MIN_AMOUNT {
            return PromiseOrValue::Value(amount);
        }
        let Some(fund) = parse_fund_msg(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        let Some(mut deal) = self.deals.get(&fund.deal_id).cloned() else {
            return PromiseOrValue::Value(amount);
        };
        if deal.state != DealState::Created || sender_id == self.creator_id {
            return PromiseOrValue::Value(amount);
        }
        let now = env::block_timestamp();
        if now > deal.fund_by_ns || amount.0 < deal.price {
            return PromiseOrValue::Value(amount);
        }
        if !self.fund_signature_ok(&deal, &sender_id, &fund.nonce, &fund.signature) {
            return PromiseOrValue::Value(amount);
        }
        let Some(accounted) = self.accounted.checked_add(deal.price) else {
            return PromiseOrValue::Value(amount);
        };
        self.commit_nonce(deal.id, "fund", &fund.nonce);
        deal.client = Some(sender_id);
        deal.state = DealState::Funded;
        deal.deliver_by_ns = Some(now.saturating_add(deal.deliver_ns));
        let price = deal.price;
        let deal_id = deal.id;
        self.accounted = accounted;
        self.deals.insert(deal_id, deal);
        env::log_str(&format!("escrow:funded|id={deal_id}|price={price}"));
        PromiseOrValue::Value(U128(amount.0 - price))
    }

    /// Anyone, after the funding window, if the deal was never paid.
    /// The row stays. `get_deal` is the history of an expired deal, so this
    /// does not refund the storage charged at `open`.
    pub fn close_unpaid(&mut self, deal_id: u64) {
        let mut deal = self.deal_or_panic(deal_id);
        require!(deal.state == DealState::Created, "deal must be unpaid");
        require!(
            env::block_timestamp() > deal.fund_by_ns,
            "the funding window is not over yet"
        );
        deal.state = DealState::Expired;
        self.deals.insert(deal_id, deal);
    }

    /// Creator key, before the delivery deadline. `payload` is the hash.
    pub fn deliver(&mut self, deal_id: u64, nonce: String, payload: String, signature: String) {
        let mut deal = self.deal_or_panic(deal_id);
        require!(deal.state == DealState::Funded, "deal is not funded");
        let now = env::block_timestamp();
        require!(
            now <= deal.deliver_by_ns.unwrap_or(0),
            "delivery deadline has passed"
        );
        require!(
            !payload.is_empty() && payload.len() <= MAX_HASH_LEN,
            "bad deliverable_hash"
        );
        self.check_sig(
            deal_id,
            "deliver",
            &nonce,
            &payload,
            &signature,
            &self.creator_pk,
        );
        self.commit_nonce(deal_id, "deliver", &nonce);
        deal.state = DealState::Delivered;
        deal.deliverable_hash = Some(payload);
        deal.review_ends_ns = Some(now.saturating_add(deal.review_ns));
        self.deals.insert(deal_id, deal);
    }

    /// Client key, during review. The price becomes withdrawable by the creator.
    pub fn accept(&mut self, deal_id: u64, nonce: String, signature: String) {
        let mut deal = self.deal_or_panic(deal_id);
        require!(deal.state == DealState::Delivered, "deal is not delivered");
        let now = env::block_timestamp();
        require!(
            now <= deal.review_ends_ns.unwrap_or(0),
            "review period is over"
        );
        self.check_sig(deal_id, "accept", &nonce, "", &signature, &deal.client_pk);
        self.commit_nonce(deal_id, "accept", &nonce);
        self.credit(&self.creator_id.clone(), deal.price);
        deal.state = DealState::Released;
        self.deals.insert(deal_id, deal);
    }

    /// Anyone. Delivered, review window over, no dispute: pay the creator.
    pub fn release_after_timeout(&mut self, deal_id: u64) {
        let mut deal = self.deal_or_panic(deal_id);
        require!(deal.state == DealState::Delivered, "deal is not delivered");
        let ends = deal.review_ends_ns.unwrap_or(u64::MAX);
        require!(
            env::block_timestamp() > ends,
            "review period is not over yet"
        );
        self.credit(&self.creator_id.clone(), deal.price);
        deal.state = DealState::Released;
        self.deals.insert(deal_id, deal);
    }

    /// Client key, during review. Stops the auto-release.
    pub fn dispute(&mut self, deal_id: u64, nonce: String, signature: String) {
        let mut deal = self.deal_or_panic(deal_id);
        require!(deal.state == DealState::Delivered, "deal is not delivered");
        let now = env::block_timestamp();
        require!(
            now <= deal.review_ends_ns.unwrap_or(0),
            "review period is over"
        );
        self.check_sig(deal_id, "dispute", &nonce, "", &signature, &deal.client_pk);
        self.commit_nonce(deal_id, "dispute", &nonce);
        deal.state = DealState::Disputed;
        deal.dispute_ends_ns = Some(now.saturating_add(deal.dispute_ns));
        self.deals.insert(deal_id, deal);
    }

    /// Both keys sign `split_bps` as a decimal string. Allowed only while the
    /// current timer is still running. Fee is 0, so the split is the whole price.
    pub fn settle(
        &mut self,
        deal_id: u64,
        nonce: String,
        split_bps: u16,
        creator_signature: String,
        client_signature: String,
    ) {
        require!(
            u128::from(split_bps) <= MAX_BPS,
            "split_bps must be <= 10000"
        );
        let mut deal = self.deal_or_panic(deal_id);
        let now = env::block_timestamp();
        match deal.state {
            DealState::Funded => require!(
                now <= deal.deliver_by_ns.unwrap_or(0),
                "the deal timer is over"
            ),
            DealState::Delivered => require!(
                now <= deal.review_ends_ns.unwrap_or(0),
                "the deal timer is over"
            ),
            DealState::Disputed => require!(
                now <= deal.dispute_ends_ns.unwrap_or(0),
                "the deal timer is over"
            ),
            _ => env::panic_str("settle: deal must be Funded, Delivered or Disputed"),
        }
        let payload = split_bps.to_string();
        self.check_sig(
            deal_id,
            "settle",
            &nonce,
            &payload,
            &creator_signature,
            &self.creator_pk,
        );
        self.check_sig(
            deal_id,
            "settle",
            &nonce,
            &payload,
            &client_signature,
            &deal.client_pk,
        );
        self.commit_nonce(deal_id, "settle", &nonce);
        self.split(&mut deal, u128::from(split_bps));
        self.deals.insert(deal_id, deal);
    }

    /// Arbiter, while the dispute window is open. `creator_bps` is 0..=10000.
    #[payable]
    pub fn resolve_dispute(&mut self, deal_id: u64, creator_bps: u16) {
        require!(env::attached_deposit() == ONE_YOCTO, "attach 1 yoctoNEAR");
        require!(
            env::predecessor_account_id() == self.arbiter_id,
            "only the arbiter"
        );
        require!(
            u128::from(creator_bps) <= MAX_BPS,
            "creator_bps must be <= 10000"
        );
        let mut deal = self.deal_or_panic(deal_id);
        require!(deal.state == DealState::Disputed, "deal is not disputed");
        let ends = deal.dispute_ends_ns.unwrap_or(0);
        require!(
            env::block_timestamp() <= ends,
            "dispute period is over; the timeout split applies"
        );
        self.split(&mut deal, u128::from(creator_bps));
        self.deals.insert(deal_id, deal);
    }

    /// Anyone, after the dispute window with no arbiter decision. 50/50.
    pub fn resolve_dispute_timeout(&mut self, deal_id: u64) {
        let mut deal = self.deal_or_panic(deal_id);
        require!(deal.state == DealState::Disputed, "deal is not disputed");
        let ends = deal.dispute_ends_ns.unwrap_or(u64::MAX);
        require!(
            env::block_timestamp() > ends,
            "dispute period is not over yet"
        );
        self.split(&mut deal, TIMEOUT_SPLIT_BPS);
        self.deals.insert(deal_id, deal);
    }

    /// Client account, after the delivery deadline, if nothing was delivered.
    pub fn refund_late(&mut self, deal_id: u64) {
        let mut deal = self.deal_or_panic(deal_id);
        let client = deal
            .client
            .clone()
            .unwrap_or_else(|| env::panic_str("unfunded"));
        require!(
            env::predecessor_account_id() == client,
            "only the client refunds"
        );
        require!(deal.state == DealState::Funded, "deal is not still funded");
        require!(
            env::block_timestamp() > deal.deliver_by_ns.unwrap_or(u64::MAX),
            "delivery deadline has not passed"
        );
        self.credit(&client, deal.price);
        deal.state = DealState::Refunded;
        self.deals.insert(deal_id, deal);
    }

    /// Pay the caller's balance out. The balance row is removed first. On a
    /// failed `ft_transfer` the callback writes the amount back. If that
    /// callback never runs, `settle` restores it once. Attach at least 80 TGas.
    #[payable]
    pub fn withdraw(&mut self) -> Promise {
        require!(env::attached_deposit() == ONE_YOCTO, "attach 1 yoctoNEAR");
        require!(
            env::prepaid_gas() >= MIN_GAS_WITHDRAW,
            "attach at least 80 TGas"
        );
        let caller = env::predecessor_account_id();
        let amount = self.balances.get(&caller).copied().unwrap_or(0);
        require!(amount > 0, "nothing to withdraw");
        require!(self.pending.get(&caller).is_none(), "withdraw in flight");
        self.balances.remove(&caller);
        self.pending.insert(
            caller.clone(),
            Pending {
                account: caller.clone(),
                amount,
                stage: PendingStage::Outgoing,
            },
        );
        ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(
                caller.clone(),
                U128(amount),
                Some("escrow withdraw".to_string()),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_WITHDRAW)
                    .on_withdraw_resolve(caller, U128(amount)),
            )
    }

    /// Restores `amount` when the transfer receipt did not succeed.
    /// A missing pending, or a settle already in progress, is left alone.
    #[private]
    pub fn on_withdraw_resolve(&mut self, account_id: AccountId, amount: U128) {
        let Some(pending) = self.pending.get(&account_id).cloned() else {
            return;
        };
        if pending.stage != PendingStage::Outgoing
            || pending.account != account_id
            || pending.amount != amount.0
        {
            return;
        }
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        self.pending.remove(&account_id);
        if ok {
            self.accounted = self.accounted.saturating_sub(pending.amount);
            return;
        }
        if !self.restore(&account_id, pending.amount) {
            self.pending.insert(account_id, pending);
        }
    }

    /// Reconcile one stuck withdraw. Does not transfer. Restores the internal
    /// credit when the token balance still covers every accounted liability.
    /// Otherwise the tokens already left, and the credit stays off.
    #[payable]
    pub fn settle_pending(&mut self) -> Promise {
        require!(env::attached_deposit() == ONE_YOCTO, "attach 1 yoctoNEAR");
        require!(
            env::prepaid_gas() >= MIN_GAS_SETTLE,
            "attach at least 50 TGas"
        );
        let caller = env::predecessor_account_id();
        let Some(mut pending) = self.pending.get(&caller).cloned() else {
            env::panic_str("nothing pending");
        };
        require!(
            pending.stage == PendingStage::Outgoing,
            "settle already in progress"
        );
        require!(pending.account == caller, "pending account mismatch");
        pending.stage = PendingStage::Settling;
        self.pending.insert(caller.clone(), pending);
        ext_ft::ext(self.token_id.clone())
            .with_static_gas(GAS_FT_BALANCE)
            .ft_balance_of(env::current_account_id())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_SETTLE)
                    .on_settle(caller),
            )
    }

    /// Applies `settle` once. A failed balance read puts the pending back.
    #[private]
    pub fn on_settle(&mut self, account_id: AccountId) {
        let Some(pending) = self.pending.get(&account_id).cloned() else {
            return;
        };
        if pending.stage != PendingStage::Settling || pending.account != account_id {
            return;
        }
        let token_balance = match env::promise_result(0) {
            PromiseResult::Successful(bytes) => {
                match near_sdk::serde_json::from_slice::<U128>(&bytes) {
                    Ok(value) => value.0,
                    Err(_) => {
                        self.reopen_pending(account_id, pending);
                        return;
                    }
                }
            }
            _ => {
                self.reopen_pending(account_id, pending);
                return;
            }
        };
        let shortfall = self.accounted.saturating_sub(token_balance);
        if shortfall != 0 && shortfall != pending.amount {
            self.reopen_pending(account_id, pending);
            return;
        }
        self.pending.remove(&account_id);
        if shortfall == 0 {
            if !self.restore(&account_id, pending.amount) {
                self.reopen_pending(account_id, pending);
            }
            return;
        }
        self.accounted = self.accounted.saturating_sub(pending.amount);
        env::log_str(&format!(
            "escrow:settled|account={account_id}|amount={}",
            pending.amount
        ));
    }

    pub fn get_pending(&self, account_id: AccountId) -> Option<Pending> {
        self.pending.get(&account_id).cloned()
    }

    pub fn get_deal(&self, deal_id: u64) -> Option<Deal> {
        self.deals.get(&deal_id).cloned()
    }

    pub fn get_balance(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_token_id(&self) -> AccountId {
        self.token_id.clone()
    }

    pub fn get_creator_pk(&self) -> String {
        hex_encode(&self.creator_pk)
    }

    pub fn get_chain_id(&self) -> String {
        self.chain_id.clone()
    }

    pub fn get_fee_bps(&self) -> u16 {
        FEE_BPS
    }

    pub fn get_min_window_ns(&self) -> u64 {
        self.min_window_ns
    }
}

#[near_sdk::ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

fn parse_fund_msg(msg: &str) -> Option<FundMsg> {
    near_sdk::serde_json::from_str(msg).ok()
}

fn charge_storage(before: u64) {
    let used = env::storage_usage().saturating_sub(before);
    let required = env::storage_byte_cost().saturating_mul(u128::from(used));
    let attached = env::attached_deposit();
    require!(attached >= required, "attach enough NEAR for storage");
    let refund = attached.saturating_sub(required);
    if !refund.is_zero() {
        Promise::new(env::predecessor_account_id()).transfer(refund);
    }
}

fn decode_fixed<const N: usize>(hex_str: &str) -> Option<[u8; N]> {
    if hex_str.len() != N * 2 {
        return None;
    }
    let bytes = hex_str.as_bytes();
    let mut out = [0u8; N];
    for i in 0..N {
        let hi = hex_nibble(bytes[i * 2])?;
        let lo = hex_nibble(bytes[i * 2 + 1])?;
        out[i] = (hi << 4) | lo;
    }
    Some(out)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
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

impl Escrow {
    fn require_window(&self, window: u64) {
        require!(
            window >= self.min_window_ns && window <= MAX_WINDOW_NS,
            "window is outside the on-chain bounds"
        );
    }

    fn deal_or_panic(&self, deal_id: u64) -> Deal {
        self.deals
            .get(&deal_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown deal"))
    }

    fn check_sig(
        &self,
        deal_id: u64,
        action: &str,
        nonce: &str,
        payload: &str,
        signature_hex: &str,
        public_key: &[u8; 32],
    ) {
        require!(
            (16..=64).contains(&nonce.len()) && nonce.bytes().all(|b| b.is_ascii_alphanumeric()),
            "bad nonce"
        );
        let message = signed_message(
            &self.chain_id,
            env::current_account_id().as_str(),
            deal_id,
            action,
            nonce,
            payload,
        );
        let signature =
            decode_fixed::<64>(signature_hex).unwrap_or_else(|| env::panic_str("bad signature"));
        require!(
            env::ed25519_verify(&signature, message.as_bytes(), public_key),
            "invalid signature"
        );
    }

    fn commit_nonce(&mut self, deal_id: u64, action: &str, nonce: &str) {
        let key = format!("{deal_id}|{action}|{nonce}");
        require!(self.used.insert(key), "replayed signature");
    }

    /// Client key signs `escrow-v1|...|fund|{nonce}|{sender}`. A mismatch refunds.
    fn fund_signature_ok(
        &self,
        deal: &Deal,
        sender: &AccountId,
        nonce: &str,
        signature_hex: &str,
    ) -> bool {
        if !(16..=64).contains(&nonce.len()) || !nonce.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return false;
        }
        let Some(signature) = decode_fixed::<64>(signature_hex) else {
            return false;
        };
        let message = signed_message(
            &self.chain_id,
            env::current_account_id().as_str(),
            deal.id,
            "fund",
            nonce,
            sender.as_str(),
        );
        if !env::ed25519_verify(&signature, message.as_bytes(), &deal.client_pk) {
            return false;
        }
        let key = format!("{}|fund|{nonce}", deal.id);
        !self.used.contains(&key)
    }

    /// Failure-path credit. Returns false instead of panicking on overflow.
    fn restore(&mut self, account: &AccountId, amount: u128) -> bool {
        let Some(next) = self
            .balances
            .get(account)
            .copied()
            .unwrap_or(0)
            .checked_add(amount)
        else {
            return false;
        };
        if next == 0 {
            self.balances.remove(account);
        } else {
            self.balances.insert(account.clone(), next);
        }
        true
    }

    fn reopen_pending(&mut self, account_id: AccountId, mut pending: Pending) {
        pending.stage = PendingStage::Outgoing;
        self.pending.insert(account_id, pending);
    }

    fn credit(&mut self, account: &AccountId, amount: u128) {
        let next = self
            .balances
            .get(account)
            .copied()
            .unwrap_or(0)
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("balance overflow"));
        self.balances.insert(account.clone(), next);
    }

    fn split(&mut self, deal: &mut Deal, creator_bps: u128) {
        // FEE_BPS is 0, so the creator's share is not reduced.
        let _fee = FEE_BPS;
        let to_creator = deal.price * creator_bps / MAX_BPS;
        let to_client = deal.price - to_creator;
        if to_creator > 0 {
            self.credit(&self.creator_id.clone(), to_creator);
        }
        if let Some(client) = deal.client.clone() {
            if to_client > 0 {
                self.credit(&client, to_client);
            }
        }
        deal.state = DealState::Released;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{test_vm_config, testing_env, RuntimeFeesConfig};
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const PRICE: u128 = 1_000_000;
    const WINDOW: u64 = 1_000;

    struct Key {
        secret: [u8; 32],
        public_hex: String,
    }

    fn key(fill: u8) -> Key {
        let secret = [fill; 32];
        let signing = SigningKey::from_bytes(&secret);
        Key {
            secret,
            public_hex: hex_encode(&signing.verifying_key().to_bytes()),
        }
    }

    fn sign(key: &Key, message: &str) -> String {
        let signing = SigningKey::from_bytes(&key.secret);
        hex_encode(&signing.sign(message.as_bytes()).to_bytes())
    }

    fn token() -> AccountId {
        CIRCLE_USDC_NEAR_TESTNET.parse().unwrap()
    }
    fn escrow_id() -> AccountId {
        "escrow.testnet".parse().unwrap()
    }
    fn client() -> AccountId {
        "client.testnet".parse().unwrap()
    }
    fn creator() -> AccountId {
        "creator.testnet".parse().unwrap()
    }
    fn arbiter() -> AccountId {
        "arbiter.testnet".parse().unwrap()
    }

    fn set_caller(predecessor: AccountId, now: u64) {
        set_caller_deposit(predecessor, now, NearToken::from_yoctonear(0));
    }

    fn set_caller_deposit(predecessor: AccountId, now: u64, deposit: NearToken) {
        let ctx = VMContextBuilder::new()
            .current_account_id(escrow_id())
            .predecessor_account_id(predecessor.clone())
            .signer_account_id(predecessor)
            .block_timestamp(now)
            .account_balance(NearToken::from_near(50))
            .attached_deposit(deposit)
            .prepaid_gas(Gas::from_tgas(300))
            .build();
        testing_env!(ctx);
    }

    fn set_callback(now: u64, result: PromiseResult) {
        let ctx = VMContextBuilder::new()
            .current_account_id(escrow_id())
            .predecessor_account_id(escrow_id())
            .block_timestamp(now)
            .prepaid_gas(Gas::from_tgas(300))
            .build();
        testing_env!(
            ctx,
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
    }

    fn contract() -> Escrow {
        set_caller(arbiter(), 0);
        Escrow::new(
            token(),
            arbiter(),
            creator(),
            key(1).public_hex,
            "testnet".into(),
            WINDOW,
        )
    }

    fn message(deal_id: u64, action: &str, nonce: &str, payload: &str) -> String {
        signed_message(
            "testnet",
            escrow_id().as_str(),
            deal_id,
            action,
            nonce,
            payload,
        )
    }

    fn open_payload(client_key: &Key, price: u128) -> String {
        format!(
            r#"{{"client_pk":"{}","price":"{price}","deliver_ns":{WINDOW},"review_ns":{WINDOW},"dispute_ns":{WINDOW},"fund_ns":{WINDOW}}}"#,
            client_key.public_hex
        )
    }

    fn open_deal(escrow: &mut Escrow, payload: &str, nonce: &str) -> u64 {
        let creator_key = key(1);
        let signature = sign(&creator_key, &message(0, "open", nonce, payload));
        set_caller_deposit(creator(), 0, NearToken::from_near(1));
        escrow.open(payload.to_string(), nonce.to_string(), signature)
    }

    fn fund_msg(deal_id: u64, payer: &AccountId, nonce: &str, client_key: &Key) -> String {
        let signature = sign(client_key, &message(deal_id, "fund", nonce, payer.as_str()));
        format!(r#"{{"deal_id":{deal_id},"nonce":"{nonce}","signature":"{signature}"}}"#)
    }

    fn fund_as(
        escrow: &mut Escrow,
        payer: AccountId,
        deal_id: u64,
        amount: u128,
        now: u64,
        client_key: &Key,
    ) -> u128 {
        let nonce = format!("noncefund{deal_id:08}{now:08}");
        let msg = fund_msg(deal_id, &payer, &nonce, client_key);
        set_caller(token(), now);
        let PromiseOrValue::Value(refund) = escrow.ft_on_transfer(payer, U128(amount), msg) else {
            panic!("refund must be a value, not a promise");
        };
        refund.0
    }

    fn fund(escrow: &mut Escrow, deal_id: u64, amount: u128, now: u64) -> u128 {
        fund_as(escrow, client(), deal_id, amount, now, &key(2))
    }

    fn deliver(escrow: &mut Escrow, deal_id: u64, now: u64, nonce: &str) {
        let payload = "hash-1";
        let signature = sign(&key(1), &message(deal_id, "deliver", nonce, payload));
        set_caller("relayer.testnet".parse().unwrap(), now);
        escrow.deliver(deal_id, nonce.to_string(), payload.to_string(), signature);
    }

    fn accept(escrow: &mut Escrow, deal_id: u64, now: u64, nonce: &str) {
        let signature = sign(&key(2), &message(deal_id, "accept", nonce, ""));
        set_caller("relayer.testnet".parse().unwrap(), now);
        escrow.accept(deal_id, nonce.to_string(), signature);
    }

    #[test]
    fn init_rejects_a_token_that_is_not_circle_testnet_usdc() {
        set_caller(arbiter(), 0);
        let caught = catch_unwind(|| {
            Escrow::new(
                "usdc.fakes.testnet".parse().unwrap(),
                arbiter(),
                creator(),
                key(1).public_hex,
                "testnet".into(),
                WINDOW,
            );
        });
        assert!(caught.is_err());
    }

    #[test]
    fn init_accepts_circle_usdc_on_near_mainnet() {
        set_caller(arbiter(), 0);
        let escrow = Escrow::new(
            CIRCLE_USDC_NEAR_MAINNET.parse().unwrap(),
            arbiter(),
            creator(),
            key(1).public_hex,
            "mainnet".into(),
            WINDOW,
        );
        assert_eq!(escrow.get_token_id().as_str(), CIRCLE_USDC_NEAR_MAINNET);
        assert_eq!(escrow.get_chain_id(), "mainnet");
    }

    #[test]
    fn fee_bps_is_zero_and_creator_pk_is_bound() {
        let escrow = contract();
        assert_eq!(escrow.get_fee_bps(), 0);
        assert_eq!(escrow.get_chain_id(), "testnet");
        assert_eq!(escrow.get_creator_pk(), key(1).public_hex);
        assert_eq!(escrow.get_min_window_ns(), WINDOW);
    }

    #[test]
    fn bad_msg_refunds_full_amount() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        set_caller(token(), 1);
        let PromiseOrValue::Value(refund) =
            escrow.ft_on_transfer(client(), U128(PRICE), "not-json".to_string())
        else {
            panic!("value");
        };
        assert_eq!(refund.0, PRICE);
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Created);
    }

    #[test]
    fn wrong_token_refunds() {
        let mut escrow = contract();
        set_caller("other.token.testnet".parse().unwrap(), 0);
        let PromiseOrValue::Value(refund) =
            escrow.ft_on_transfer(client(), U128(PRICE), r#"{"deal_id":1}"#.to_string())
        else {
            panic!("value");
        };
        assert_eq!(refund.0, PRICE);
    }

    #[test]
    fn below_min_amount_rejected() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        let refund = fund(&mut escrow, 1, 999_999, 1);
        assert_eq!(refund, 999_999);
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Created);
    }

    #[test]
    fn underpay_is_refunded_and_overpay_returns_only_the_unused_amount() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE + 1);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        let under = fund(&mut escrow, 1, PRICE, 1);
        assert_eq!(under, PRICE);
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Created);

        let unused = fund(&mut escrow, 1, PRICE + 50, 1);
        assert_eq!(unused, 49);
        let deal = escrow.get_deal(1).unwrap();
        assert_eq!(deal.price, PRICE + 1);
        assert_eq!(deal.state, DealState::Funded);
        assert_eq!(deal.client, Some(client()));
    }

    #[test]
    fn a_one_nanosecond_window_is_refused() {
        let escrow = contract();
        let mut bad = open_payload(&key(2), PRICE);
        bad = bad.replace(r#""deliver_ns":1000"#, r#""deliver_ns":1"#);
        let signature = sign(&key(1), &message(0, "open", "nonceopen00000001", &bad));
        set_caller(creator(), 0);
        let mut escrow = escrow;
        let refused = catch_unwind(AssertUnwindSafe(|| {
            escrow.open(bad, "nonceopen00000001".to_string(), signature);
        }));
        assert!(refused.is_err());
        assert!(escrow.get_deal(1).is_none());
    }

    #[test]
    fn close_unpaid_after_the_funding_window() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        set_caller("anyone.testnet".parse().unwrap(), WINDOW);
        let early = catch_unwind(AssertUnwindSafe(|| escrow.close_unpaid(1)));
        assert!(early.is_err());
        set_caller("anyone.testnet".parse().unwrap(), WINDOW + 1);
        escrow.close_unpaid(1);
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Expired);
        let late = fund(&mut escrow, 1, PRICE, WINDOW + 2);
        assert_eq!(late, PRICE);
    }

    #[test]
    fn a_signature_for_another_chain_or_a_replayed_nonce_fails() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        let nonce = "nonceopen00000001";
        let foreign = signed_message("mainnet", escrow_id().as_str(), 0, "open", nonce, &payload);
        let signature = sign(&key(1), &foreign);
        set_caller(creator(), 0);
        let rejected = catch_unwind(AssertUnwindSafe(|| {
            escrow.open(payload.clone(), nonce.to_string(), signature);
        }));
        assert!(rejected.is_err());

        open_deal(&mut escrow, &payload, nonce);
        let again = sign(&key(1), &message(0, "open", nonce, &payload));
        set_caller(creator(), 0);
        let replay = catch_unwind(AssertUnwindSafe(|| {
            escrow.open(payload, nonce.to_string(), again);
        }));
        assert!(replay.is_err());
        assert!(escrow.get_deal(2).is_none());
    }

    #[test]
    fn deal_release_on_client_accept() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        fund(&mut escrow, 1, PRICE, 1);
        deliver(&mut escrow, 1, 10, "noncedeliver000001");
        accept(&mut escrow, 1, 20, "nonceaccept0000001");
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Released);
        assert_eq!(escrow.get_balance(creator()).0, PRICE);
        assert_eq!(escrow.get_balance(client()).0, 0);
        assert_eq!(escrow.get_fee_bps(), 0);
    }

    #[test]
    fn client_cannot_accept_before_delivery() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        fund(&mut escrow, 1, PRICE, 1);
        let signature = sign(&key(2), &message(1, "accept", "nonceaccept0000001", ""));
        set_caller(client(), 10);
        let panicked = catch_unwind(AssertUnwindSafe(|| {
            escrow.accept(1, "nonceaccept0000001".to_string(), signature);
        }));
        assert!(panicked.is_err());
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Funded);
    }

    #[test]
    fn deal_release_after_review_timeout() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        fund(&mut escrow, 1, PRICE, 1);
        deliver(&mut escrow, 1, 10, "noncedeliver000001");
        set_caller("anyone.testnet".parse().unwrap(), 10 + WINDOW);
        let edge = catch_unwind(AssertUnwindSafe(|| escrow.release_after_timeout(1)));
        assert!(edge.is_err());
        set_caller("anyone.testnet".parse().unwrap(), 10 + WINDOW + 1);
        escrow.release_after_timeout(1);
        assert_eq!(escrow.get_balance(creator()).0, PRICE);
    }

    #[test]
    fn dispute_blocks_the_timeout_release() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        fund(&mut escrow, 1, PRICE, 1);
        deliver(&mut escrow, 1, 10, "noncedeliver000001");
        let signature = sign(&key(2), &message(1, "dispute", "noncedispute000001", ""));
        set_caller(client(), 20);
        escrow.dispute(1, "noncedispute000001".to_string(), signature);
        set_caller("anyone.testnet".parse().unwrap(), 5_000);
        let blocked = catch_unwind(AssertUnwindSafe(|| escrow.release_after_timeout(1)));
        assert!(blocked.is_err());
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Disputed);
    }

    #[test]
    fn dispute_resolved_by_arbiter() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        fund(&mut escrow, 1, PRICE, 1);
        deliver(&mut escrow, 1, 10, "noncedeliver000001");
        let signature = sign(&key(2), &message(1, "dispute", "noncedispute000001", ""));
        set_caller(client(), 20);
        escrow.dispute(1, "noncedispute000001".to_string(), signature);
        let ends = escrow.get_deal(1).unwrap().dispute_ends_ns.unwrap();
        set_caller_deposit(arbiter(), ends, ONE_YOCTO);
        escrow.resolve_dispute(1, 7_000);
        assert_eq!(escrow.get_balance(creator()).0, 700_000);
        assert_eq!(escrow.get_balance(client()).0, 300_000);
    }

    #[test]
    fn dispute_timeout_splits_50_50() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), 1_000_001);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        fund(&mut escrow, 1, 1_000_001, 1);
        deliver(&mut escrow, 1, 10, "noncedeliver000001");
        let signature = sign(&key(2), &message(1, "dispute", "noncedispute000001", ""));
        set_caller(client(), 20);
        escrow.dispute(1, "noncedispute000001".to_string(), signature);
        let ends = escrow.get_deal(1).unwrap().dispute_ends_ns.unwrap();
        set_caller("anyone.testnet".parse().unwrap(), ends - 1);
        let before = catch_unwind(AssertUnwindSafe(|| escrow.resolve_dispute_timeout(1)));
        assert!(before.is_err());
        set_caller("anyone.testnet".parse().unwrap(), ends);
        let at_deadline = catch_unwind(AssertUnwindSafe(|| escrow.resolve_dispute_timeout(1)));
        assert!(at_deadline.is_err());
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Disputed);
        assert_eq!(escrow.get_balance(creator()).0, 0);
        set_caller("anyone.testnet".parse().unwrap(), ends + 1);
        escrow.resolve_dispute_timeout(1);
        assert_eq!(escrow.get_balance(creator()).0, 500_000);
        assert_eq!(escrow.get_balance(client()).0, 500_001);
    }

    #[test]
    fn only_the_arbiter_resolves_a_dispute() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        fund(&mut escrow, 1, PRICE, 1);
        deliver(&mut escrow, 1, 10, "noncedeliver000001");
        let signature = sign(&key(2), &message(1, "dispute", "noncedispute000001", ""));
        set_caller(client(), 20);
        escrow.dispute(1, "noncedispute000001".to_string(), signature);
        set_caller(client(), 30);
        let rejected = catch_unwind(AssertUnwindSafe(|| escrow.resolve_dispute(1, 10_000)));
        assert!(rejected.is_err());
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Disputed);
        assert_eq!(escrow.get_balance(creator()).0, 0);
    }

    #[test]
    fn settle_pays_the_signed_split_and_cannot_be_replayed() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        fund(&mut escrow, 1, PRICE, 1);
        let nonce = "noncesettle0000001";
        let body = "4000";
        let creator_sig = sign(&key(1), &message(1, "settle", nonce, body));
        let client_sig = sign(&key(2), &message(1, "settle", nonce, body));
        set_caller("anyone.testnet".parse().unwrap(), 10);
        escrow.settle(
            1,
            nonce.to_string(),
            4_000,
            creator_sig.clone(),
            client_sig.clone(),
        );
        assert_eq!(escrow.get_balance(creator()).0, 400_000);
        assert_eq!(escrow.get_balance(client()).0, 600_000);
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Released);
        set_caller("anyone.testnet".parse().unwrap(), 11);
        let replay = catch_unwind(AssertUnwindSafe(|| {
            escrow.settle(1, nonce.to_string(), 4_000, creator_sig, client_sig);
        }));
        assert!(replay.is_err());
    }

    #[test]
    fn late_delivery_refunds_the_client() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        fund(&mut escrow, 1, PRICE, 1);
        let deadline = escrow.get_deal(1).unwrap().deliver_by_ns.unwrap();
        set_caller(client(), deadline - 1);
        let before = catch_unwind(AssertUnwindSafe(|| escrow.refund_late(1)));
        assert!(before.is_err());
        set_caller(client(), deadline);
        let at_deadline = catch_unwind(AssertUnwindSafe(|| escrow.refund_late(1)));
        assert!(at_deadline.is_err());
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Funded);
        assert_eq!(escrow.get_balance(client()).0, 0);
        set_caller(client(), deadline + 1);
        escrow.refund_late(1);
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Refunded);
        assert_eq!(escrow.get_balance(client()).0, PRICE);
    }

    #[test]
    fn deliver_at_the_deadline_is_accepted() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        fund(&mut escrow, 1, PRICE, 1);
        let deadline = escrow.get_deal(1).unwrap().deliver_by_ns.unwrap();
        deliver(&mut escrow, 1, deadline, "noncedeliver000001");
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Delivered);
        let ends = escrow.get_deal(1).unwrap().review_ends_ns.unwrap();
        accept(&mut escrow, 1, ends, "nonceaccept0000001");
        assert_eq!(escrow.get_balance(creator()).0, PRICE);
    }

    #[test]
    fn credit_panics_on_overflow() {
        let mut escrow = contract();
        escrow.balances.insert(creator(), u128::MAX);
        let overflowed = catch_unwind(AssertUnwindSafe(|| escrow.credit(&creator(), 1)));
        assert!(overflowed.is_err());
        assert_eq!(escrow.get_balance(creator()).0, u128::MAX);
    }

    #[test]
    fn failed_withdraw_puts_the_balance_back() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        fund(&mut escrow, 1, PRICE, 1);
        deliver(&mut escrow, 1, 10, "noncedeliver000001");
        accept(&mut escrow, 1, 20, "nonceaccept0000001");
        set_caller_deposit(creator(), 30, ONE_YOCTO);
        let _promise = escrow.withdraw();
        assert_eq!(escrow.get_balance(creator()).0, 0);
        assert!(!escrow.balances.contains_key(&creator()));
        set_callback(31, PromiseResult::Failed);
        escrow.on_withdraw_resolve(creator(), U128(PRICE));
        assert_eq!(escrow.get_balance(creator()).0, PRICE);
        set_callback(32, PromiseResult::Successful(Vec::new()));
        escrow.on_withdraw_resolve(creator(), U128(PRICE));
        assert_eq!(escrow.get_balance(creator()).0, PRICE);
    }

    #[test]
    fn a_payer_who_is_not_signed_by_the_client_key_is_refunded() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        let stranger: AccountId = "stranger.testnet".parse().unwrap();
        let wrong_key = fund_as(&mut escrow, stranger.clone(), 1, PRICE, 1, &key(9));
        assert_eq!(wrong_key, PRICE);
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Created);
        assert!(escrow.get_deal(1).unwrap().client.is_none());

        let nonce = "noncefundfront00001";
        let msg = fund_msg(1, &client(), nonce, &key(2));
        set_caller(token(), 2);
        let PromiseOrValue::Value(front_run) = escrow.ft_on_transfer(stranger, U128(PRICE), msg)
        else {
            panic!("value");
        };
        assert_eq!(front_run.0, PRICE);
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Created);
        assert_eq!(escrow.get_balance(client()).0, 0);
    }

    #[test]
    fn the_payer_signed_by_the_client_key_funds_the_deal() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        let refund = fund(&mut escrow, 1, PRICE, 1);
        assert_eq!(refund, 0);
        let deal = escrow.get_deal(1).unwrap();
        assert_eq!(deal.state, DealState::Funded);
        assert_eq!(deal.client, Some(client()));
        assert_eq!(escrow.accounted, PRICE);
    }

    #[test]
    fn resolve_dispute_rejects_a_call_with_no_deposit() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        fund(&mut escrow, 1, PRICE, 1);
        deliver(&mut escrow, 1, 10, "noncedeliver000001");
        let signature = sign(&key(2), &message(1, "dispute", "noncedispute000001", ""));
        set_caller(client(), 20);
        escrow.dispute(1, "noncedispute000001".to_string(), signature);
        let ends = escrow.get_deal(1).unwrap().dispute_ends_ns.unwrap();
        set_caller(arbiter(), ends);
        let rejected = catch_unwind(AssertUnwindSafe(|| escrow.resolve_dispute(1, 7_000)));
        assert!(rejected.is_err());
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Disputed);
        assert_eq!(escrow.get_balance(creator()).0, 0);
        assert_eq!(escrow.get_balance(client()).0, 0);
    }

    #[test]
    fn a_second_new_panics() {
        let escrow = contract();
        near_sdk::env::storage_write(b"STATE", &[1]);
        set_caller(arbiter(), 1);
        let caught = catch_unwind(AssertUnwindSafe(|| {
            Escrow::new(
                token(),
                arbiter(),
                creator(),
                key(1).public_hex,
                "testnet".into(),
                WINDOW,
            );
        }));
        near_sdk::env::storage_remove(b"STATE");
        assert!(caught.is_err());
        assert_eq!(escrow.get_creator_pk(), key(1).public_hex);
    }

    #[test]
    fn init_rejects_creator_or_arbiter_equal_to_the_contract() {
        set_caller(arbiter(), 0);
        let creator_is_contract = catch_unwind(AssertUnwindSafe(|| {
            Escrow::new(
                token(),
                arbiter(),
                escrow_id(),
                key(1).public_hex,
                "testnet".into(),
                WINDOW,
            );
        }));
        assert!(creator_is_contract.is_err());
        set_caller(arbiter(), 0);
        let arbiter_is_contract = catch_unwind(AssertUnwindSafe(|| {
            Escrow::new(
                token(),
                escrow_id(),
                creator(),
                key(1).public_hex,
                "testnet".into(),
                WINDOW,
            );
        }));
        assert!(arbiter_is_contract.is_err());
    }

    #[test]
    fn open_without_a_storage_deposit_is_rejected() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        let nonce = "nonceopen00000001";
        let signature = sign(&key(1), &message(0, "open", nonce, &payload));
        set_caller(creator(), 0);
        let rejected = catch_unwind(AssertUnwindSafe(|| {
            escrow.open(payload, nonce.to_string(), signature);
        }));
        assert!(rejected.is_err());
    }

    fn balance_result(amount: u128) -> PromiseResult {
        PromiseResult::Successful(near_sdk::serde_json::to_vec(&U128(amount)).expect("json"))
    }

    #[test]
    fn settle_restores_a_stuck_pending_once() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        fund(&mut escrow, 1, PRICE, 1);
        deliver(&mut escrow, 1, 10, "noncedeliver000001");
        accept(&mut escrow, 1, 20, "nonceaccept0000001");
        set_caller_deposit(creator(), 30, ONE_YOCTO);
        let _promise = escrow.withdraw();
        assert_eq!(escrow.get_balance(creator()).0, 0);
        let pending = escrow.get_pending(creator()).expect("pending");
        assert_eq!(pending.amount, PRICE);
        assert_eq!(pending.stage, PendingStage::Outgoing);
        assert_eq!(pending.account, creator());

        set_caller_deposit(creator(), 40, ONE_YOCTO);
        let _settle = escrow.settle_pending();
        set_callback(41, balance_result(PRICE));
        escrow.on_settle(creator());
        assert_eq!(escrow.get_balance(creator()).0, PRICE);
        assert!(escrow.get_pending(creator()).is_none());

        set_callback(42, balance_result(PRICE));
        escrow.on_settle(creator());
        assert_eq!(escrow.get_balance(creator()).0, PRICE);

        set_caller_deposit(creator(), 43, ONE_YOCTO);
        let again = catch_unwind(AssertUnwindSafe(|| escrow.settle_pending()));
        assert!(again.is_err());
        assert_eq!(escrow.get_balance(creator()).0, PRICE);
        assert_eq!(escrow.accounted, PRICE);
    }

    #[test]
    fn settle_does_not_credit_when_the_tokens_already_left() {
        let mut escrow = contract();
        let payload = open_payload(&key(2), PRICE);
        open_deal(&mut escrow, &payload, "nonceopen00000001");
        fund(&mut escrow, 1, PRICE, 1);
        deliver(&mut escrow, 1, 10, "noncedeliver000001");
        accept(&mut escrow, 1, 20, "nonceaccept0000001");
        set_caller_deposit(creator(), 30, ONE_YOCTO);
        let _promise = escrow.withdraw();
        set_caller_deposit(creator(), 40, ONE_YOCTO);
        let _settle = escrow.settle_pending();
        set_callback(41, balance_result(0));
        escrow.on_settle(creator());
        assert_eq!(escrow.get_balance(creator()).0, 0);
        assert!(escrow.get_pending(creator()).is_none());
        assert_eq!(escrow.accounted, 0);
        set_callback(42, balance_result(PRICE));
        escrow.on_settle(creator());
        assert_eq!(escrow.get_balance(creator()).0, 0);
    }
}
