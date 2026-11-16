//! Spend checks for one USDC payment.
//!
//! Check order, not the code, from soldanoandrea/allowance@74edffec
//! `src/policy.rs` `evaluate`: denylist, allowlist, per-tx cap
//! (`amount > cap` rejects; an equal amount is allowed), cooldown, budget
//! window, then approval. A bound on open approvals is the same idea as
//! near/core-contracts@1b0436c9 `multisig2/src/lib.rs` `ACTIVE_REQUESTS_LIMIT`
//! (a key must not queue without a ceiling). Rewritten here for 6-decimal
//! USDC integers.
use near_sdk::AccountId;

/// Open approval requests one agent key may have at once.
pub const DEFAULT_MAX_OPEN_APPROVALS: u32 = 4;

#[derive(Clone, Debug)]
pub struct Policy {
    pub per_tx_cap: u128,
    pub budget_limit: Option<u128>,
    pub budget_period_ns: Option<u64>,
    /// Empty means any payee that is not denied.
    pub allow: Vec<AccountId>,
    pub deny: Vec<AccountId>,
    pub cooldown_ns: u64,
    /// Pays strictly above this wait for the owner. `None` never asks.
    pub approval_threshold: Option<u128>,
    pub max_open_approvals: u32,
}

#[derive(Clone, Debug)]
pub struct SpendSnap {
    pub spent: u128,
    pub reserved: u128,
    pub window_start_ns: u64,
    pub last_payment_ns: u64,
    pub open_approvals: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Pay,
    NeedsApproval,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rejection {
    Denylisted,
    NotAllowlisted,
    OverPerTxCap,
    Cooldown,
    OverBudget,
    TooManyOpenApprovals,
}

/// Move `snap` into the window that contains `now_ns`. Spent resets.
/// Reserved stays, because an in-flight transfer still counts.
pub fn roll_window(policy: &Policy, snap: &mut SpendSnap, now_ns: u64) {
    let Some(period) = policy.budget_period_ns else {
        return;
    };
    if period == 0 {
        return;
    }
    let end = snap.window_start_ns.saturating_add(period);
    if now_ns >= end {
        snap.window_start_ns = now_ns - (now_ns % period);
        snap.spent = 0;
    }
}

pub fn evaluate(
    policy: &Policy,
    snap: &SpendSnap,
    receiver: &AccountId,
    amount: u128,
    now_ns: u64,
    approval_granted: bool,
) -> Result<Decision, Rejection> {
    if policy.deny.iter().any(|id| id == receiver) {
        return Err(Rejection::Denylisted);
    }
    if !policy.allow.is_empty() && !policy.allow.iter().any(|id| id == receiver) {
        return Err(Rejection::NotAllowlisted);
    }
    if amount > policy.per_tx_cap {
        return Err(Rejection::OverPerTxCap);
    }
    if policy.cooldown_ns > 0 && snap.last_payment_ns > 0 {
        let retry_at = snap.last_payment_ns.saturating_add(policy.cooldown_ns);
        if now_ns < retry_at {
            return Err(Rejection::Cooldown);
        }
    }
    if let Some(limit) = policy.budget_limit {
        let used = snap
            .spent
            .checked_add(snap.reserved)
            .and_then(|sum| sum.checked_add(amount))
            .ok_or(Rejection::OverBudget)?;
        if used > limit {
            return Err(Rejection::OverBudget);
        }
    }
    if !approval_granted {
        if let Some(threshold) = policy.approval_threshold {
            if amount > threshold {
                if snap.open_approvals >= policy.max_open_approvals {
                    return Err(Rejection::TooManyOpenApprovals);
                }
                return Ok(Decision::NeedsApproval);
            }
        }
    }
    Ok(Decision::Pay)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn policy() -> Policy {
        Policy {
            per_tx_cap: 1_000_000,
            budget_limit: Some(2_000_000),
            budget_period_ns: Some(1_000),
            allow: vec![],
            deny: vec![],
            cooldown_ns: 0,
            approval_threshold: None,
            max_open_approvals: DEFAULT_MAX_OPEN_APPROVALS,
        }
    }

    fn snap() -> SpendSnap {
        SpendSnap {
            spent: 0,
            reserved: 0,
            window_start_ns: 0,
            last_payment_ns: 0,
            open_approvals: 0,
        }
    }

    #[test]
    fn pay_at_cap_is_allowed_and_one_above_is_not() {
        let p = policy();
        let s = snap();
        let shop = id("shop.testnet");
        assert_eq!(evaluate(&p, &s, &shop, 1_000_000, 1, false), Ok(Decision::Pay));
        assert_eq!(
            evaluate(&p, &s, &shop, 1_000_001, 1, false),
            Err(Rejection::OverPerTxCap)
        );
    }

    #[test]
    fn budget_window_rejects_then_rolls_over() {
        let p = policy();
        let shop = id("shop.testnet");
        let mut s = snap();
        s.spent = 2_000_000;
        assert_eq!(evaluate(&p, &s, &shop, 1, 500, false), Err(Rejection::OverBudget));
        roll_window(&p, &mut s, 1_000);
        assert_eq!(s.spent, 0);
        assert_eq!(s.window_start_ns, 1_000);
        assert_eq!(evaluate(&p, &s, &shop, 1_000_000, 1_000, false), Ok(Decision::Pay));
    }

    #[test]
    fn denylist_beats_an_allowlist_entry() {
        let mut p = policy();
        let shop = id("shop.testnet");
        p.allow = vec![shop.clone()];
        p.deny = vec![shop.clone()];
        assert_eq!(evaluate(&p, &snap(), &shop, 1, 1, false), Err(Rejection::Denylisted));
    }

    #[test]
    fn cooldown_blocks_until_the_retry_instant() {
        let mut p = policy();
        p.cooldown_ns = 100;
        let mut s = snap();
        s.last_payment_ns = 50;
        let shop = id("shop.testnet");
        assert_eq!(evaluate(&p, &s, &shop, 1, 149, false), Err(Rejection::Cooldown));
        assert_eq!(evaluate(&p, &s, &shop, 1, 150, false), Ok(Decision::Pay));
    }

    #[test]
    fn an_open_approval_ceiling_rejects_one_more_request() {
        let mut p = policy();
        p.approval_threshold = Some(10);
        p.max_open_approvals = 1;
        let mut s = snap();
        let shop = id("shop.testnet");
        assert_eq!(evaluate(&p, &s, &shop, 11, 1, false), Ok(Decision::NeedsApproval));
        s.open_approvals = 1;
        assert_eq!(
            evaluate(&p, &s, &shop, 11, 1, false),
            Err(Rejection::TooManyOpenApprovals)
        );
        assert_eq!(evaluate(&p, &s, &shop, 11, 1, true), Ok(Decision::Pay));
    }
}
