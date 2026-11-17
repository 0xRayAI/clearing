# NEAR testnet walk

Network: NEAR testnet. No mainnet call.

| Role | Account |
| --- | --- |
| Treasury payee | clearing-treasury-0xray.testnet |
| Payer | clearing-payer-0xray.testnet |
| Relayer | clearing-treasury-0xray.testnet |

| Step | Tx |
| --- | --- |
| Account create, treasury | [2awFnLKQj9s1WV1LHwwJnJ6gVrcmT7HfMVPwqefkVT43](https://testnet.nearblocks.io/txns/2awFnLKQj9s1WV1LHwwJnJ6gVrcmT7HfMVPwqefkVT43) |
| Account create, payer | [3uUdXH4Ckm1NbLEqf7FdrBZ7ksucPpFuhnqmmmh8s4gD](https://testnet.nearblocks.io/txns/3uUdXH4Ckm1NbLEqf7FdrBZ7ksucPpFuhnqmmmh8s4gD) |
| USDC storage, payer | [4WRNHyo66k4WnQhwf9Y6E3fTPMNSdeG97PcMzQ1wqNCF](https://testnet.nearblocks.io/txns/4WRNHyo66k4WnQhwf9Y6E3fTPMNSdeG97PcMzQ1wqNCF) |
| USDC storage, treasury | [Fm1dVnXhg8h7fgAkEXTFxmR53why632qa2oFxVWqNxz7](https://testnet.nearblocks.io/txns/Fm1dVnXhg8h7fgAkEXTFxmR53why632qa2oFxVWqNxz7) |
| Circle faucet 20 USDC | [B47vXLavqFc5ib22oA8uN23WsmpnWkPv7p6C7cUk7jYa](https://testnet.nearblocks.io/txns/B47vXLavqFc5ib22oA8uN23WsmpnWkPv7p6C7cUk7jYa) |
| First settle ft_transfer 10000 | [2G5FwbkebkhmS8kBQWqihFmu143yLECtW27x8kkAivMM](https://testnet.nearblocks.io/txns/2G5FwbkebkhmS8kBQWqihFmu143yLECtW27x8kkAivMM) |
| Second settle ft_transfer 10000 memo walk39-1794939103515 | [5U4KmxSLo9McyijDuV71pMGM2RL6t1wSmP3rKsPdfko7](https://testnet.nearblocks.io/txns/5U4KmxSLo9McyijDuV71pMGM2RL6t1wSmP3rKsPdfko7) |

Treasury USDC: 10000 -> 20000.
Payer USDC: 19990000 -> 19980000.
Relay count: 1. A second settle returned the same hash and did not relay again.
