# NEAR testnet walk

Network: NEAR testnet. No mainnet call.

Each walk is a new memo and its own relay. The in-process replay is a second settle of that same memo in the same process. It held on both walks: one relay, then the same hash. The two FINAL transactions are not a replay of each other.

`clearing-treasury-0xray.testnet` is the hosted payee and the relay-gas account for `near:testnet` only. The `near:mainnet` payee list and relay account are empty.

| Role | Account |
| --- | --- |
| Treasury payee | clearing-treasury-0xray.testnet |
| Payer | clearing-payer-0xray.testnet |
| Relayer | clearing-treasury-0xray.testnet |

| Setup | Tx |
| --- | --- |
| Account create, treasury | [2awFnLKQj9s1WV1LHwwJnJ6gVrcmT7HfMVPwqefkVT43](https://testnet.nearblocks.io/txns/2awFnLKQj9s1WV1LHwwJnJ6gVrcmT7HfMVPwqefkVT43) |
| Account create, payer | [3uUdXH4Ckm1NbLEqf7FdrBZ7ksucPpFuhnqmmmh8s4gD](https://testnet.nearblocks.io/txns/3uUdXH4Ckm1NbLEqf7FdrBZ7ksucPpFuhnqmmmh8s4gD) |
| USDC storage, payer | [4WRNHyo66k4WnQhwf9Y6E3fTPMNSdeG97PcMzQ1wqNCF](https://testnet.nearblocks.io/txns/4WRNHyo66k4WnQhwf9Y6E3fTPMNSdeG97PcMzQ1wqNCF) |
| USDC storage, treasury | [Fm1dVnXhg8h7fgAkEXTFxmR53why632qa2oFxVWqNxz7](https://testnet.nearblocks.io/txns/Fm1dVnXhg8h7fgAkEXTFxmR53why632qa2oFxVWqNxz7) |
| Circle faucet 20 USDC | [B47vXLavqFc5ib22oA8uN23WsmpnWkPv7p6C7cUk7jYa](https://testnet.nearblocks.io/txns/B47vXLavqFc5ib22oA8uN23WsmpnWkPv7p6C7cUk7jYa) |

## Walk walk39-1794939030572

Relay [2G5FwbkebkhmS8kBQWqihFmu143yLECtW27x8kkAivMM](https://testnet.nearblocks.io/txns/2G5FwbkebkhmS8kBQWqihFmu143yLECtW27x8kkAivMM) moved 10000 testnet USDC. FINAL. Memo `walk39-1794939030572`.

In-process replay held: the second settle of this memo returned `2G5FwbkebkhmS8kBQWqihFmu143yLECtW27x8kkAivMM` and the relay count stayed 1.

Treasury USDC before this relay: 0. After: 10000.

Payer USDC before this relay: 20000000. After: 19990000.

## Walk walk39-1794939103515

Relay [5U4KmxSLo9McyijDuV71pMGM2RL6t1wSmP3rKsPdfko7](https://testnet.nearblocks.io/txns/5U4KmxSLo9McyijDuV71pMGM2RL6t1wSmP3rKsPdfko7) moved 10000 testnet USDC. FINAL. Memo `walk39-1794939103515`.

In-process replay held: the second settle of this memo returned `5U4KmxSLo9McyijDuV71pMGM2RL6t1wSmP3rKsPdfko7` and the relay count stayed 1.

Treasury USDC before this relay: 10000. After: 20000.

Payer USDC before this relay: 19990000. After: 19980000.
