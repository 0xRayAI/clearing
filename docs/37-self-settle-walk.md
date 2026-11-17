# Base self-settle walk

No funded Base Sepolia key is present in this environment. Mainnet spend was not approved. This is a verified dry path, not a chain transaction.

`createBaseSettler` with the self signer encodes `transferWithAuthorization` for the advertised USDC amount and payTo. `settle` returns success only when `chain.receipt` is `success` for that exact asset, receiver, sender, and amount. A missing receipt returns `chain has not confirmed the transfer`. A signer hash alone is not a settlement.

There is no transaction hash.
