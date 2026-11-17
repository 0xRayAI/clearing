/**
 * Embeddable Base x402 exact settler. A foundry imports this and runs it in
 * its own process. Hosted Clearing is optional. The foundry supplies allowPayTo.
 *
 * Success is a confirmed chain receipt for the exact amount, asset, and
 * network the foundry advertised. A signer hash alone is not a settlement.
 */
import { encodeFunctionData } from 'viem';
import { isHexAddress, isHexBytes32, normalizeAddress } from './bytes.js';

export const BASE_MAINNET = 'eip155:8453';
export const BASE_SEPOLIA = 'eip155:84532';
export const BASE_NETWORKS = [BASE_MAINNET, BASE_SEPOLIA] as const;
export const VALIDITY_CAP_SECONDS = 60n;

const TRANSFER_WITH_AUTHORIZATION = [
  {
    name: 'transferWithAuthorization',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

export type BaseNetwork = (typeof BASE_NETWORKS)[number];

export type AdvertisedExact = {
  scheme: 'exact';
  network: BaseNetwork;
  asset: `0x${string}`;
  amount: string;
  payTo: `0x${string}`;
  maxTimeoutSeconds?: number;
};

export type Eip3009Authorization = {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
  signature: `0x${string}`;
};

export type BaseSignerKind = 'self' | 'zigzag' | 'cdp';

export type TransferCall = {
  kind: 'self';
  to: `0x${string}`;
  data: `0x${string}`;
  authorization: Eip3009Authorization;
};

export type BaseSigner = {
  kind: BaseSignerKind;
  submit(auth: Eip3009Authorization, call?: TransferCall): Promise<`0x${string}`>;
};

export type TxReceipt = {
  status: 'success' | 'reverted' | 'missing';
  token?: `0x${string}`;
  from?: `0x${string}`;
  to?: `0x${string}`;
  value?: string;
};

export type BaseChain = {
  receipt(txHash: `0x${string}`): Promise<TxReceipt>;
};

export type BookedBasePayment = {
  txHash: `0x${string}`;
  amount: string;
  payTo: `0x${string}`;
  from: `0x${string}`;
  asset: `0x${string}`;
  network: BaseNetwork;
};

export type BaseSettleDeps = {
  allowPayTo: readonly string[];
  advertised: AdvertisedExact;
  nowSec: () => bigint;
  signer: BaseSigner;
  chain: BaseChain;
  book?: Map<string, BookedBasePayment>;
};

export type BaseVerifyResult = { isValid: true } | { isValid: false; invalidReason: string };
export type BaseSettleResult =
  | { success: true; transaction: `0x${string}`; replayed?: boolean }
  | { success: false; errorReason: string };

type Accepted = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as Record<string, unknown>;
}

function decimal(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  return value;
}

export function isEvmTxHash(value: string): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

export function encodeTransferWithAuthorization(auth: Eip3009Authorization): `0x${string}` {
  return encodeFunctionData({
    abi: TRANSFER_WITH_AUTHORIZATION,
    functionName: 'transferWithAuthorization',
    args: [
      auth.from,
      auth.to,
      BigInt(auth.value),
      BigInt(auth.validAfter),
      BigInt(auth.validBefore),
      auth.nonce,
      auth.signature,
    ],
  });
}

export function createSelfSigner(
  token: `0x${string}`,
  submit: (call: TransferCall) => Promise<`0x${string}`>,
): BaseSigner {
  return {
    kind: 'self',
    async submit(auth) {
      const call: TransferCall = {
        kind: 'self',
        to: token,
        data: encodeTransferWithAuthorization(auth),
        authorization: auth,
      };
      return submit(call);
    },
  };
}

export function createZigzagSigner(opts: {
  settleUrl: string;
  fetchFn?: typeof fetch;
  token?: string;
}): BaseSigner {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    kind: 'zigzag',
    async submit(auth) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      const res = await fetchFn(opts.settleUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ eip3009: auth }),
      });
      if (!res.ok) throw new Error(`zigzag settle ${res.status}`);
      const json = (await res.json()) as { txHash?: string };
      if (!json.txHash || !isEvmTxHash(json.txHash)) throw new Error('zigzag settle missing txHash');
      return json.txHash;
    },
  };
}

export function createCdpSigner(post: (body: unknown) => Promise<{ success?: boolean; transaction?: string }>): BaseSigner {
  return {
    kind: 'cdp',
    async submit(auth) {
      const out = await post({
        x402Version: 2,
        payload: { signature: auth.signature, authorization: auth },
      });
      if (out.success !== true || !out.transaction || !isEvmTxHash(out.transaction)) {
        throw new Error('cdp settle missing txHash');
      }
      return out.transaction;
    },
  };
}

function readAuth(raw: Record<string, unknown>): { ok: true; auth: Eip3009Authorization } | { ok: false; reason: string } {
  const payload = asRecord(raw.payload);
  const authorization = asRecord(payload?.authorization);
  const signature = typeof payload?.signature === 'string' ? payload.signature : '';
  const from = typeof authorization?.from === 'string' ? authorization.from : '';
  const to = typeof authorization?.to === 'string' ? authorization.to : '';
  const value = decimal(authorization?.value);
  const nonce = typeof authorization?.nonce === 'string' ? authorization.nonce : '';
  if (!isHexAddress(from) || !isHexAddress(to) || !value || !isHexBytes32(nonce) || !signature.startsWith('0x')) {
    return { ok: false, reason: 'missing eip3009 authorization' };
  }
  return {
    ok: true,
    auth: {
      from: normalizeAddress(from),
      to: normalizeAddress(to),
      value,
      validAfter: String(authorization?.validAfter ?? '0'),
      validBefore: String(authorization?.validBefore ?? '0'),
      nonce,
      signature: signature as `0x${string}`,
    },
  };
}

function readAccepted(raw: Record<string, unknown>): Accepted | undefined {
  const accepted = asRecord(raw.accepted) ?? asRecord(raw.paymentRequirements);
  if (!accepted) return undefined;
  const amount = decimal(accepted.amount ?? accepted.maxAmountRequired);
  const payTo = typeof accepted.payTo === 'string' ? accepted.payTo : '';
  const asset = typeof accepted.asset === 'string' ? accepted.asset : '';
  const network = typeof accepted.network === 'string' ? accepted.network : '';
  const scheme = typeof accepted.scheme === 'string' ? accepted.scheme : '';
  if (!amount || !isHexAddress(payTo) || !isHexAddress(asset) || !network || scheme !== 'exact') return undefined;
  const maxTimeoutSeconds = typeof accepted.maxTimeoutSeconds === 'number' ? accepted.maxTimeoutSeconds : undefined;
  return { scheme, network, asset, amount, payTo, maxTimeoutSeconds };
}

function sameAddress(left: string, right: string): boolean {
  return normalizeAddress(left) === normalizeAddress(right);
}

function windowOk(auth: Eip3009Authorization, now: bigint, cap: bigint): string | undefined {
  let after: bigint;
  let before: bigint;
  try {
    after = BigInt(auth.validAfter);
    before = BigInt(auth.validBefore);
  } catch {
    return 'authorization window is not a number';
  }
  if (now < after || now >= before) return 'authorization is outside its validity window';
  if (before - after > cap) return 'authorization window is longer than the advertised timeout';
  return undefined;
}

export function createBaseSettler(deps: BaseSettleDeps) {
  const allow = new Set(deps.allowPayTo.map((item) => normalizeAddress(item)));
  const book = deps.book ?? new Map<string, BookedBasePayment>();
  const advertised = deps.advertised;
  const cap = BigInt(advertised.maxTimeoutSeconds ?? Number(VALIDITY_CAP_SECONDS));

  function gate(raw: unknown): { ok: true; auth: Eip3009Authorization } | { ok: false; reason: string } {
    const record = asRecord(raw);
    if (!record || record.x402Version !== 2) return { ok: false, reason: 'payload is not x402 v2 exact' };
    const authRead = readAuth(record);
    if (!authRead.ok) return authRead;
    const accepted = readAccepted(record);
    if (!accepted) return { ok: false, reason: 'payload is not x402 v2 exact' };
    if (accepted.network !== advertised.network) return { ok: false, reason: 'network does not match the advertised 402' };
    if (!sameAddress(accepted.asset, advertised.asset)) return { ok: false, reason: 'asset does not match the advertised 402' };
    if (accepted.amount !== advertised.amount) return { ok: false, reason: 'amount does not match the advertised 402' };
    if (!sameAddress(accepted.payTo, advertised.payTo)) return { ok: false, reason: 'payTo does not match the advertised 402' };
    if (!allow.has(normalizeAddress(advertised.payTo))) return { ok: false, reason: 'payTo is not an allowed treasury' };
    if (!sameAddress(authRead.auth.to, advertised.payTo)) return { ok: false, reason: 'authorization does not match accepted payTo' };
    if (authRead.auth.value !== advertised.amount) return { ok: false, reason: 'authorization value does not match quote' };
    const timed = windowOk(authRead.auth, deps.nowSec(), cap);
    if (timed) return { ok: false, reason: timed };
    return { ok: true, auth: authRead.auth };
  }

  function receiptMatches(receipt: TxReceipt, auth: Eip3009Authorization): string | undefined {
    if (receipt.status === 'missing') return 'chain has not confirmed the transfer';
    if (receipt.status !== 'success') return 'chain reverted the transfer';
    if (!receipt.token || !sameAddress(receipt.token, advertised.asset)) return 'receipt asset does not match the advertised 402';
    if (!receipt.to || !sameAddress(receipt.to, advertised.payTo)) return 'receipt payTo does not match the advertised 402';
    if (!receipt.from || !sameAddress(receipt.from, auth.from)) return 'receipt sender does not match the authorization';
    if (receipt.value !== advertised.amount) return 'receipt amount does not match the advertised 402';
    return undefined;
  }

  return {
    async verify(raw: unknown): Promise<BaseVerifyResult> {
      const gated = gate(raw);
      if (!gated.ok) return { isValid: false, invalidReason: gated.reason };
      return { isValid: true };
    },

    async settle(raw: unknown): Promise<BaseSettleResult> {
      const gated = gate(raw);
      if (!gated.ok) return { success: false, errorReason: gated.reason };
      const prior = book.get(gated.auth.nonce);
      if (prior) {
        const same = prior.amount === advertised.amount
          && sameAddress(prior.payTo, advertised.payTo)
          && sameAddress(prior.from, gated.auth.from)
          && prior.network === advertised.network
          && sameAddress(prior.asset, advertised.asset);
        if (!same) return { success: false, errorReason: 'payment already used' };
        return { success: true, transaction: prior.txHash, replayed: true };
      }
      let txHash: `0x${string}`;
      try {
        txHash = await deps.signer.submit(gated.auth);
      } catch (err) {
        return { success: false, errorReason: err instanceof Error ? err.message : 'signer failed' };
      }
      if (!isEvmTxHash(txHash)) return { success: false, errorReason: 'signer did not return a 32-byte tx hash' };
      let receipt: TxReceipt;
      try {
        receipt = await deps.chain.receipt(txHash);
      } catch {
        return { success: false, errorReason: 'chain has not confirmed the transfer' };
      }
      const failed = receiptMatches(receipt, gated.auth);
      if (failed) return { success: false, errorReason: failed };
      const booked: BookedBasePayment = {
        txHash,
        amount: advertised.amount,
        payTo: normalizeAddress(advertised.payTo),
        from: gated.auth.from,
        asset: normalizeAddress(advertised.asset),
        network: advertised.network,
      };
      book.set(gated.auth.nonce, booked);
      return { success: true, transaction: txHash };
    },
  };
}
