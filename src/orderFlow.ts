// End-to-end order placement: quote → (wrap/approve) → sign → submit → poll.
// Mirrors the documented Flash flow for both EVM and SVM funders.

import { getChain } from "./chains.js";
import { FlashClient } from "./flashClient.js";
import { evmAddressFromPrivateKey, EvmSigner } from "./signing/evm.js";
import { svmAddressFromSecret, SvmSigner } from "./signing/svm.js";
import {
  TERMINAL_STATUSES,
  type FlashGetOrderResponse,
  type QuoteRequest,
  type QuoteResponse,
  type SubmitOrderRequest,
} from "./types.js";

export interface PlaceOrderInput extends QuoteRequest {
  privateKey: string;
  rpcUrl?: string;
  /** Poll until the order reaches a terminal status (recommended for market orders). */
  waitForFill?: boolean;
  /** Max seconds to poll before returning the last-seen status. */
  pollTimeoutSec?: number;
}

export interface PlaceOrderResult {
  quote: QuoteResponse;
  orderId: string;
  steps: string[];
  finalOrder?: FlashGetOrderResponse;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Serialize order placement per (chain, wallet). Same-wallet transactions are
// nonce-ordered on-chain anyway; without this, concurrent orders that each need
// a wrap/approve send would fetch the same nonce and collide. Keyed by chain so
// the same wallet can still trade on different chains in parallel. A failed
// order must not block the queue, so the stored tail swallows rejections —
// callers still see them via the returned promise.
const walletQueues = new Map<string, Promise<unknown>>();

export function withWalletLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = walletQueues.get(key) ?? Promise.resolve();
  const run = tail.then(fn);
  walletQueues.set(key, run.catch(() => {}));
  return run;
}

export async function placeOrder(client: FlashClient, input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const chain = getChain(input.targetChain);
  const steps: string[] = [];

  // The funder address must be present on the quote for it to return signing payloads.
  const { privateKey, rpcUrl, waitForFill, pollTimeoutSec, ...quoteFields } = input;

  const funder =
    chain.kind === "evm" ? evmAddressFromPrivateKey(privateKey) : svmAddressFromSecret(privateKey);
  return withWalletLock(`${chain.id}:${funder}`, () =>
    chain.kind === "evm"
      ? placeEvmOrder(client, quoteFields, privateKey, rpcUrl, waitForFill, pollTimeoutSec, steps)
      : placeSvmOrder(client, quoteFields, privateKey, rpcUrl, waitForFill, pollTimeoutSec, steps),
  );
}

async function placeEvmOrder(
  client: FlashClient,
  quoteFields: QuoteRequest,
  privateKey: string,
  rpcUrl: string | undefined,
  waitForFill: boolean | undefined,
  pollTimeoutSec: number | undefined,
  steps: string[],
): Promise<PlaceOrderResult> {
  const signer = new EvmSigner(privateKey, quoteFields.targetChain, rpcUrl);
  const req: QuoteRequest = { ...quoteFields, funderAddress: signer.address };

  const quote = await client.quote(req);
  steps.push(`Quoted ${quote.quoteId}: spend ${quote.from.amount} → receive ${quote.to.amount}`);

  const evm = quote.evm;
  if (!evm) throw new Error("Quote returned no EVM signing payload for an EVM chain.");

  // 1. Wrap native gas asset, if the quote priced against wrapped-native.
  if (quote.wrap?.evmTx) {
    const { hash } = await signer.sendAndWait(quote.wrap.evmTx, "wrap");
    steps.push(`Wrapped native asset (tx ${hash})`);
  }

  // 2. ERC-20 approval, only when allowance is insufficient.
  if (evm.approveTx) {
    const { hash } = await signer.sendAndWait(evm.approveTx, "approve");
    steps.push(`Approved token allowance (tx ${hash})`);
  }

  // 3. Permit2 signature, when the route uses Permit2.
  let evmPermitSignature: string | undefined;
  if (evm.permitTypedData) {
    evmPermitSignature = await signer.signTypedDataString(evm.permitTypedData);
    steps.push("Signed Permit2 payload");
  }

  // 4. Order signature.
  if (!evm.orderTypedData) throw new Error("Quote returned no orderTypedData to sign.");
  const userSignature = await signer.signTypedDataString(evm.orderTypedData);
  steps.push("Signed order payload");

  // 5. Submit.
  const submit: SubmitOrderRequest = {
    ...req,
    funderAddress: signer.address,
    quoteId: quote.quoteId,
    userSignature,
    evmOrderTypedData: evm.orderTypedData,
    ...(evm.permitTypedData && evmPermitSignature
      ? { evmPermitTypedData: evm.permitTypedData, evmPermitSignature }
      : {}),
  };
  const { orderId } = await client.submitOrder(submit);
  steps.push(`Submitted order ${orderId}`);

  const finalOrder = await maybePoll(client, orderId, quote, waitForFill, pollTimeoutSec, steps);
  return { quote, orderId, steps, finalOrder };
}

async function placeSvmOrder(
  client: FlashClient,
  quoteFields: QuoteRequest,
  privateKey: string,
  rpcUrl: string | undefined,
  waitForFill: boolean | undefined,
  pollTimeoutSec: number | undefined,
  steps: string[],
): Promise<PlaceOrderResult> {
  const signer = new SvmSigner(privateKey, rpcUrl);
  const req: QuoteRequest = { ...quoteFields, funderAddress: signer.address };

  const quote = await client.quote(req);
  steps.push(`Quoted ${quote.quoteId}: spend ${quote.from.amount} → receive ${quote.to.amount}`);

  const svm = quote.svm;
  if (!svm) throw new Error("Quote returned no SVM signing payload for Solana.");

  // 1. Wrap native SOL, if requested via svmUseNativeSOL.
  if (quote.wrap?.svmInstructions?.length) {
    const { signature } = await signer.sendInstructions(quote.wrap.svmInstructions, "wrap SOL");
    steps.push(`Wrapped SOL (tx ${signature})`);
  }

  // 2. Delegate authority — prefer the sponsored tx when offered.
  let svmSponsoredDelegateTx: string | undefined;
  if (svm.sponsoredDelegateTx) {
    svmSponsoredDelegateTx = await signer.signSponsoredTxBase64(svm.sponsoredDelegateTx);
    steps.push("Co-signed sponsored delegate tx");
  } else if (svm.delegateIx) {
    const { signature } = await signer.sendInstructions([svm.delegateIx], "delegate");
    steps.push(`Granted delegate authority (tx ${signature})`);
  }

  // 3. Order signature over the UTF-8 orderMessage.
  if (!svm.orderMessage) throw new Error("Quote returned no orderMessage to sign.");
  const userSignature = signer.signMessageBase58(svm.orderMessage);
  steps.push("Signed order message");

  // 4. Submit.
  const submit: SubmitOrderRequest = {
    ...req,
    funderAddress: signer.address,
    quoteId: quote.quoteId,
    userSignature,
    ...(svm.nonce ? { svmNonce: svm.nonce } : {}),
    ...(svm.deadline ? { svmDeadline: svm.deadline } : {}),
    ...(svmSponsoredDelegateTx ? { svmSponsoredDelegateTx } : {}),
  };
  const { orderId } = await client.submitOrder(submit);
  steps.push(`Submitted order ${orderId}`);

  const finalOrder = await maybePoll(client, orderId, quote, waitForFill, pollTimeoutSec, steps);
  return { quote, orderId, steps, finalOrder };
}

async function maybePoll(
  client: FlashClient,
  orderId: string,
  quote: QuoteResponse,
  waitForFill: boolean | undefined,
  pollTimeoutSec: number | undefined,
  steps: string[],
): Promise<FlashGetOrderResponse | undefined> {
  // Only market orders fill promptly; resting orders (limit/twap/trigger) would
  // poll forever, so we never auto-poll those even if asked.
  if (!waitForFill || quote.orderType !== "market") return undefined;

  const deadline = Date.now() + (pollTimeoutSec ?? 120) * 1000;
  let last: FlashGetOrderResponse | undefined;
  while (Date.now() < deadline) {
    last = await client.getOrder(orderId);
    if (TERMINAL_STATUSES.has(last.order.status)) {
      steps.push(`Order reached ${last.order.status}`);
      return last;
    }
    await sleep(2000);
  }
  steps.push(`Stopped polling after timeout (last status ${last?.order.status ?? "unknown"})`);
  return last;
}

/** Sign and submit a cancel for an existing order. */
export async function cancelOrder(
  client: FlashClient,
  orderId: string,
  chainName: string,
  privateKey: string,
): Promise<void> {
  const cancelMessage = `Definitive Flash v1 — Cancel Order\nOrder: ${orderId}`;
  const chain = getChain(chainName);
  let userSignature: string;
  if (chain.kind === "evm") {
    userSignature = await new EvmSigner(privateKey, chainName).signMessage(cancelMessage);
  } else {
    userSignature = new SvmSigner(privateKey).signMessageBase58(cancelMessage);
  }
  await client.cancelOrder(orderId, { cancelMessage, userSignature });
}
