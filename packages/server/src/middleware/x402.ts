/**
 * x402 Micropayment Middleware for Exocortex
 * Alternative auth path — agents pay per operation with USDC.
 * Falls back to standard token auth if x402 not configured.
 */

import type { Context, Next } from "hono";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Per-operation pricing in USDC atomic units (6 decimals)
const PRICES: Record<string, number> = {
  "POST /api/memories": 1_000,         // 0.001 USDC — store
  "POST /api/memories/search": 500,    // 0.0005 USDC — search
  "GET /api/memories": 500,            // browse
  "POST /api/consolidate": 5_000,      // 0.005 — heavy operation
  "POST /api/contradictions/detect": 3_000,
  "GET /api/context/export": 2_000,    // context sync
};

function getPaymentWallet(): string {
  return process.env.EXOCORTEX_PAYMENT_WALLET || "";
}

function getPrice(method: string, path: string): number {
  return PRICES[`${method} ${path}`] ?? 1_000;
}

export interface X402PaymentInfo {
  payTo: string;
  amount: number;
  token: string;
  network: "solana";
  resource: string;
}

/**
 * Build 402 response headers and body for x402 protocol.
 */
export function build402Response(c: Context): Response {
  const wallet = getPaymentWallet();
  const method = c.req.method;
  const path = c.req.path;
  const amount = getPrice(method, path);

  const info: X402PaymentInfo = {
    payTo: wallet,
    amount,
    token: USDC_MINT,
    network: "solana",
    resource: `${method} ${path}`,
  };

  return c.json(
    {
      error: "Payment required. Authenticate with a Bearer token, or pay via x402 (X-Payment header with Solana tx signature).",
      x402: info,
    },
    {
      status: 402,
      headers: {
        "X-Payment-Required": "true",
        "X-Payment-Network": "solana",
        "X-Payment-Token": USDC_MINT,
        "X-Payment-Amount": amount.toString(),
        "X-Payment-Address": wallet,
      },
    },
  );
}

/**
 * Verify an x402 payment on-chain.
 */
export async function verifyX402Payment(
  txSignature: string,
  expectedWallet: string,
  expectedAmount: number,
): Promise<boolean> {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [txSignature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return false;

    const json = (await res.json()) as any;
    const tx = json?.result;
    if (!tx || tx.meta?.err) return false;

    // Check USDC transfer to payment wallet
    const postBalances = tx.meta?.postTokenBalances || [];
    const preBalances = tx.meta?.preTokenBalances || [];

    for (const post of postBalances) {
      if (post.mint !== USDC_MINT || post.owner !== expectedWallet) continue;

      const postAmt = parseInt(post.uiTokenAmount?.amount || "0");
      const pre = preBalances.find(
        (p: any) => p.accountIndex === post.accountIndex && p.mint === USDC_MINT,
      );
      const preAmt = parseInt(pre?.uiTokenAmount?.amount || "0");

      if (postAmt - preAmt >= expectedAmount) return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if x402 is configured (payment wallet set).
 */
export function isX402Enabled(): boolean {
  return !!getPaymentWallet();
}
