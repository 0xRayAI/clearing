//! Testnet USDC escrow. The buyer locks a price. The creator is paid after the
//! buyer accepts the work, or when the review window ends with no dispute.
//!
//! Pattern, not a copy: Basssoman/pinky@c94cb144 `contract/src/lib.rs`
//! (`ft_on_transfer` funding, deliver, client `accept`, `release_after_timeout`,
//! arbiter `resolve_dispute`, 50/50 after the dispute window).
//!
//! Unused-amount refund idea, path and sha only, nothing copied:
//! Balloon-DefAI/balloons-contracts@eb1f045 `src/ft_receiver.rs`.
//! A bad message, or any tokens above the price, are returned from
//! `ft_on_transfer` so the token's `ft_resolve_transfer` sends them back.
//!
//! Standards checked against the docs, not against those repos:
//! - NEP-141 `ft_on_transfer` return value is the refund:
//!   https://nomicon.io/Standards/Tokens/FungibleToken/Core
//! - `ft_transfer` attaches 1 yoctoNEAR:
//!   https://docs.near.org/primitives/ft
//! - Contract API is near-sdk 5 (`#[near]`, `PromiseOrValue`, `require`):
//!   https://docs.near.org/smart-contracts/anatomy/near-bindgen
//!
//! Init accepts only Circle USDC on NEAR testnet.
#![deny(unused)]

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};

/// Circle USDC on NEAR testnet (ft_metadata: symbol USDC, decimals 6).
pub const CIRCLE_USDC_NEAR_TESTNET: &str =
    "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(20);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const MAX_BPS: u128 = 10_000;
/// Half, rounding the odd unit to the client.
const TIMEOUT_SPLIT_BPS: u128 = 5_000;
const MAX_HASH_LEN: usize = 128;
/// 90 days. Tests use a much shorter window.
const MAX_WINDOW_NS: u64 = 90 * 24 * 3600 * 1_000_000_000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Prefix {
    Deals,
    Balances,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DealState {
    Funded,
    Delivered,
    Disputed,
    Released,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Deal {
    pub id: u64,
    pub client: AccountId,
    pub creator: AccountId,
    pub price: u128,
    pub state: DealState,
    pub deliver_by_ns: u64,
    pub review_ns: u64,
    pub review_ends_ns: Option<u64>,
    pub dispute_ends_ns: Option<u64>,
    pub deliverable_hash: Option<String>,
}

#[near(serializers = [json])]
struct OpenMsg {
    creator: AccountId,
    price: U128,
    deliver_ns: U64ish,
    review_ns: U64ish,
}

/// Accepts a JSON number or a decimal string. Callers should send strings.
#[near(serializers = [json])]
#[serde(untagged)]
enum U64ish {
    Num(u64),
    Str(String),
}

impl U64ish {
    fn get(&self) -> Option<u64> {
        match self {
            Self::Num(n) => Some(*n),
            Self::Str(s) => s.parse().ok(),
        }
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Escrow {
    token_id: AccountId,
    arbiter_id: AccountId,
    next_id: u64,
    deals: LookupMap<u64, Deal>,
    /// Withdrawable token units, for creators and for clients after a refund.
    balances: LookupMap<AccountId, u128>,
}

#[near]
impl Escrow {
    /// `token_id` must be Circle USDC on testnet. `arbiter_id` decides disputes.
    #[init]
    pub fn new(token_id: AccountId, arbiter_id: AccountId) -> Self {
        require!(
            token_id.as_str() == CIRCLE_USDC_NEAR_TESTNET,
            "token_id must be Circle USDC on NEAR testnet"
        );
        require!(
            arbiter_id.as_str() != token_id.as_str(),
            "arbiter must not be the token"
        );
        Self {
            token_id,
            arbiter_id,
            next_id: 1,
            deals: LookupMap::new(Prefix::Deals),
            balances: LookupMap::new(Prefix::Balances),
        }
    }

    /// NEP-141 receiver. A valid open message locks `price` and returns the
    /// rest. Anything we will not lock is returned so the token refunds it.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.token_id {
            return PromiseOrValue::Value(amount);
        }
        let Some(open) = parse_open(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        if open.creator == sender_id || open.price == 0 || amount.0 < open.price {
            return PromiseOrValue::Value(amount);
        }
        if open.deliver_ns == 0
            || open.review_ns == 0
            || open.deliver_ns > MAX_WINDOW_NS
            || open.review_ns > MAX_WINDOW_NS
        {
            return PromiseOrValue::Value(amount);
        }
        let id = self.next_id;
        self.next_id += 1;
        let now = env::block_timestamp();
        self.deals.insert(
            id,
            Deal {
                id,
                client: sender_id,
                creator: open.creator,
                price: open.price,
                state: DealState::Funded,
                deliver_by_ns: now.saturating_add(open.deliver_ns),
                review_ns: open.review_ns,
                review_ends_ns: None,
                dispute_ends_ns: None,
                deliverable_hash: None,
            },
        );
        env::log_str(&format!("escrow:opened|id={id}|price={}", open.price));
        PromiseOrValue::Value(U128(amount.0 - open.price))
    }

    /// Creator marks the work done, before the delivery deadline.
    pub fn deliver(&mut self, deal_id: u64, deliverable_hash: String) {
        let mut deal = self.deal_or_panic(deal_id);
        require!(
            env::predecessor_account_id() == deal.creator,
            "only the creator delivers"
        );
        require!(deal.state == DealState::Funded, "deal is not funded");
        let now = env::block_timestamp();
        require!(now <= deal.deliver_by_ns, "delivery deadline has passed");
        require!(
            !deliverable_hash.is_empty() && deliverable_hash.len() <= MAX_HASH_LEN,
            "bad deliverable_hash"
        );
        deal.state = DealState::Delivered;
        deal.deliverable_hash = Some(deliverable_hash);
        deal.review_ends_ns = Some(now.saturating_add(deal.review_ns));
        self.deals.insert(deal_id, deal);
    }

    /// Client confirms the work. The price becomes withdrawable by the creator.
    pub fn accept(&mut self, deal_id: u64) {
        let mut deal = self.deal_or_panic(deal_id);
        require!(
            env::predecessor_account_id() == deal.client,
            "only the client accepts"
        );
        require!(deal.state == DealState::Delivered, "deal is not delivered");
        let now = env::block_timestamp();
        let ends = deal.review_ends_ns.unwrap_or(0);
        require!(now <= ends, "review period is over");
        self.credit(&deal.creator, deal.price);
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
        self.credit(&deal.creator, deal.price);
        deal.state = DealState::Released;
        self.deals.insert(deal_id, deal);
    }

    /// Client, during review. Stops the auto-release.
    pub fn dispute(&mut self, deal_id: u64) {
        let mut deal = self.deal_or_panic(deal_id);
        require!(
            env::predecessor_account_id() == deal.client,
            "only the client disputes"
        );
        require!(deal.state == DealState::Delivered, "deal is not delivered");
        let now = env::block_timestamp();
        let ends = deal.review_ends_ns.unwrap_or(0);
        require!(now <= ends, "review period is over");
        deal.state = DealState::Disputed;
        deal.dispute_ends_ns = Some(now.saturating_add(deal.review_ns));
        self.deals.insert(deal_id, deal);
    }

    /// Arbiter, while the dispute window is open. `creator_bps` is 0..=10000.
    /// The client receives the rest.
    pub fn resolve_dispute(&mut self, deal_id: u64, creator_bps: u16) {
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

    /// Client, after the delivery deadline, if nothing was delivered.
    pub fn refund_late(&mut self, deal_id: u64) {
        let mut deal = self.deal_or_panic(deal_id);
        require!(
            env::predecessor_account_id() == deal.client,
            "only the client refunds"
        );
        require!(deal.state == DealState::Funded, "deal is not still funded");
        require!(
            env::block_timestamp() > deal.deliver_by_ns,
            "delivery deadline has not passed"
        );
        self.credit(&deal.client, deal.price);
        deal.state = DealState::Refunded;
        self.deals.insert(deal_id, deal);
    }

    /// Pay the caller's withdrawable balance out through `ft_transfer`.
    pub fn withdraw(&mut self) -> Promise {
        let caller = env::predecessor_account_id();
        let amount = self.balances.get(&caller).copied().unwrap_or(0);
        require!(amount > 0, "nothing to withdraw");
        self.balances.insert(caller.clone(), 0);
        ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(caller, U128(amount), Some("escrow withdraw".to_string()))
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
}

#[near_sdk::ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

struct Open {
    creator: AccountId,
    price: u128,
    deliver_ns: u64,
    review_ns: u64,
}

fn parse_open(msg: &str) -> Option<Open> {
    let parsed: OpenMsg = near_sdk::serde_json::from_str(msg).ok()?;
    Some(Open {
        creator: parsed.creator,
        price: parsed.price.0,
        deliver_ns: parsed.deliver_ns.get()?,
        review_ns: parsed.review_ns.get()?,
    })
}

impl Escrow {
    fn deal_or_panic(&self, deal_id: u64) -> Deal {
        self.deals
            .get(&deal_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown deal"))
    }

    fn credit(&mut self, account: &AccountId, amount: u128) {
        let next = self
            .balances
            .get(account)
            .copied()
            .unwrap_or(0)
            .saturating_add(amount);
        self.balances.insert(account.clone(), next);
    }

    fn split(&mut self, deal: &mut Deal, creator_bps: u128) {
        let to_creator = deal.price * creator_bps / MAX_BPS;
        let to_client = deal.price - to_creator;
        if to_creator > 0 {
            self.credit(&deal.creator, to_creator);
        }
        if to_client > 0 {
            self.credit(&deal.client, to_client);
        }
        deal.state = DealState::Released;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn token() -> AccountId {
        CIRCLE_USDC_NEAR_TESTNET.parse().unwrap()
    }
    fn escrow() -> AccountId {
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
        let ctx = VMContextBuilder::new()
            .current_account_id(escrow())
            .predecessor_account_id(predecessor.clone())
            .signer_account_id(predecessor)
            .block_timestamp(now)
            .account_balance(NearToken::from_near(50))
            .build();
        testing_env!(ctx);
    }

    fn contract() -> Escrow {
        set_caller(arbiter(), 0);
        Escrow::new(token(), arbiter())
    }

    fn open_msg(price: u128) -> String {
        format!(
            r#"{{"creator":"{}","price":"{}","deliver_ns":"1000","review_ns":"1000"}}"#,
            creator(),
            price
        )
    }

    fn fund(escrow: &mut Escrow, amount: u128, msg: &str) -> u128 {
        set_caller(token(), 0);
        let PromiseOrValue::Value(refund) =
            escrow.ft_on_transfer(client(), U128(amount), msg.to_string())
        else {
            panic!("refund must be a value, not a promise");
        };
        refund.0
    }

    #[test]
    fn init_rejects_a_token_that_is_not_circle_testnet_usdc() {
        set_caller(arbiter(), 0);
        let caught = std::panic::catch_unwind(|| {
            Escrow::new("usdc.fakes.testnet".parse().unwrap(), arbiter());
        });
        assert!(caught.is_err());
    }

    #[test]
    fn bad_msg_is_refunded_in_full() {
        let mut escrow = contract();
        let refund = fund(&mut escrow, 50_000, "not-json");
        assert_eq!(refund, 50_000);
        assert!(escrow.get_deal(1).is_none());
    }

    #[test]
    fn wrong_token_is_refunded_in_full() {
        let mut escrow = contract();
        set_caller("other.token.testnet".parse().unwrap(), 0);
        let PromiseOrValue::Value(refund) =
            escrow.ft_on_transfer(client(), U128(50_000), open_msg(50_000))
        else {
            panic!("value");
        };
        assert_eq!(refund.0, 50_000);
        assert!(escrow.get_deal(1).is_none());
    }

    #[test]
    fn underpay_is_refunded_and_overpay_returns_only_the_unused_amount() {
        let mut escrow = contract();
        let under = fund(&mut escrow, 40_000, &open_msg(50_000));
        assert_eq!(under, 40_000);
        assert!(escrow.get_deal(1).is_none());

        let unused = fund(&mut escrow, 80_000, &open_msg(50_000));
        assert_eq!(unused, 30_000);
        let deal = escrow.get_deal(1).unwrap();
        assert_eq!(deal.price, 50_000);
        assert_eq!(deal.state, DealState::Funded);
        assert_eq!(deal.client, client());
        assert_eq!(deal.creator, creator());
    }

    #[test]
    fn accept_after_deliver_credits_the_creator() {
        let mut escrow = contract();
        fund(&mut escrow, 50_000, &open_msg(50_000));
        set_caller(creator(), 10);
        escrow.deliver(1, "hash-1".to_string());
        set_caller(client(), 20);
        escrow.accept(1);
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Released);
        assert_eq!(escrow.get_balance(creator()).0, 50_000);
        assert_eq!(escrow.get_balance(client()).0, 0);
    }

    #[test]
    fn client_cannot_accept_before_delivery() {
        let mut escrow = contract();
        fund(&mut escrow, 50_000, &open_msg(50_000));
        set_caller(client(), 10);
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            escrow.accept(1);
        }));
        assert!(panicked.is_err());
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Funded);
    }

    #[test]
    fn review_timeout_pays_the_creator_and_dispute_blocks_it() {
        let mut escrow = contract();
        fund(&mut escrow, 50_000, &open_msg(50_000));
        set_caller(creator(), 10);
        escrow.deliver(1, "hash-1".to_string());
        set_caller(client(), 2_000);
        escrow.release_after_timeout(1);
        assert_eq!(escrow.get_balance(creator()).0, 50_000);

        let mut escrow = contract();
        fund(&mut escrow, 50_000, &open_msg(50_000));
        set_caller(creator(), 10);
        escrow.deliver(1, "hash-1".to_string());
        set_caller(client(), 20);
        escrow.dispute(1);
        set_caller("anyone.testnet".parse().unwrap(), 5_000);
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            escrow.release_after_timeout(1);
        }));
        assert!(blocked.is_err());
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Disputed);
    }

    #[test]
    fn arbiter_split_and_timeout_half() {
        let mut escrow = contract();
        fund(&mut escrow, 100, &open_msg(100));
        set_caller(creator(), 10);
        escrow.deliver(1, "hash-1".to_string());
        set_caller(client(), 20);
        escrow.dispute(1);
        set_caller(arbiter(), 30);
        escrow.resolve_dispute(1, 7_000);
        assert_eq!(escrow.get_balance(creator()).0, 70);
        assert_eq!(escrow.get_balance(client()).0, 30);

        let mut escrow = contract();
        fund(&mut escrow, 101, &open_msg(101));
        set_caller(creator(), 10);
        escrow.deliver(1, "hash-1".to_string());
        set_caller(client(), 20);
        escrow.dispute(1);
        set_caller("anyone.testnet".parse().unwrap(), 2_000);
        escrow.resolve_dispute_timeout(1);
        // 50/50, odd unit stays with the client.
        assert_eq!(escrow.get_balance(creator()).0, 50);
        assert_eq!(escrow.get_balance(client()).0, 51);
    }

    #[test]
    fn only_the_arbiter_resolves_a_dispute() {
        let mut escrow = contract();
        fund(&mut escrow, 100, &open_msg(100));
        set_caller(creator(), 10);
        escrow.deliver(1, "hash-1".to_string());
        set_caller(client(), 20);
        escrow.dispute(1);
        set_caller(client(), 30);
        let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            escrow.resolve_dispute(1, 10_000);
        }));
        assert!(rejected.is_err());
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Disputed);
        assert_eq!(escrow.get_balance(creator()).0, 0);
    }

    #[test]
    fn late_delivery_refunds_the_client() {
        let mut escrow = contract();
        fund(&mut escrow, 50_000, &open_msg(50_000));
        set_caller(client(), 1_001);
        escrow.refund_late(1);
        assert_eq!(escrow.get_deal(1).unwrap().state, DealState::Refunded);
        assert_eq!(escrow.get_balance(client()).0, 50_000);
    }
}
