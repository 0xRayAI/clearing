# Base self-settle walk

No funded Base Sepolia key is present in this environment. Mainnet spend was not approved. This is a verified dry path, not a chain transaction.

`createBaseSettler` with the self signer encodes `transferWithAuthorization` for the advertised USDC amount and payTo. The EIP-712 name and version come from the per-chain table: Base Sepolia USDC is name `USDC`, and Base mainnet USDC is name `USD Coin`. Both are version `2`. Before that send it recovers the signer and requires that address to equal `from`, reads `authorizationState(from, nonce)`, and holds an in-process lock on that pair. The lock and the nonce book are process memory only. If a transaction hash went out, the lock stays pending and the next call checks that hash again. The self signer requires native balance of at least gas times the EIP-1559 max fee (latest base fee plus priority fee), plus the Base L1 fee from the GasPriceOracle, plus a 20% margin. It refuses when those fees cannot be read. Success requires a USDC `Transfer` log from `from` to `payTo` for the exact amount, emitted by the advertised asset. A missing receipt returns `chain has not confirmed the transfer`. A signer hash alone is not a settlement. `eip155:8453` stays off unless `allowMainnet` is set. The validity window cannot exceed 60 seconds.

There is no transaction hash.
