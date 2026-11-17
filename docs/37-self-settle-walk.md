# Base self-settle walk

No funded Base Sepolia key is present in this environment. Mainnet spend was not approved. This is a verified dry path, not a chain transaction.

`createBaseSettler` with the self signer encodes `transferWithAuthorization` for the advertised USDC amount and payTo. Before that send it recovers the EIP-712 `TransferWithAuthorization` signer and requires that address to equal `from`, reads `authorizationState(from, nonce)`, and holds an in-process lock on that pair. The self signer also estimates gas and refuses when the native balance is too low. Success requires a USDC `Transfer` log from `from` to `payTo` for the exact amount, emitted by the advertised asset. A missing receipt returns `chain has not confirmed the transfer`. A signer hash alone is not a settlement. `eip155:8453` stays off unless `allowMainnet` is set. The validity window cannot exceed 60 seconds.

There is no transaction hash.
