/**
 * x402 Micropayment Middleware for Exocortex
 * Alternative auth path — agents pay per operation with USDC.
 * Falls back to standard token auth if x402 not configured.
 */

import type { Context } from "hono";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

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

// Replay protection — persist spent signatures across restarts
const SPENT_FILE = join(process.env.EXOCORTEX_DATA_DIR ?? ".", ".spent-signatures.json");
const MAX_SPENT_CACHE = 10_000;
const TX_MAX_AGE_S = 300; // reject transactions older than 5 minutes

function loadSpentSignatures(): Set<string> {
  try {
    const data = readFileSync(SPENT_FILE, "utf-8");
    const arr = JSON.parse(data);
    if (Array.isArray(arr)) return new Set<string>(arr.slice(-MAX_SPENT_CACHE));
  } catch {
    // File doesn't exist yet or is corrupt — start fresh
  }
  return new Set<string>();
}

function persistSpentSignature(sig: string): void {
  try {
    mkdirSync(dirname(SPENT_FILE), { recursive: true });
    const arr = [...spentSignatures];
    writeFileSync(SPENT_FILE, JSON.stringify(arr), "utf-8");
  } catch (err) {
    console.warn(`[x402] Failed to persist spent signature: ${(err as Error).message}`);
  }
}

const spentSignatures = loadSpentSignatures();

function getPaymentWallet(): string {
  return process.env.EXOCORTEX_PAYMENT_WALLET || "";
}

export function getPrice(method: string, path: string): number {
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
 * Includes replay protection (each tx signature can only be used once)
 * and transaction age check (rejects txs older than 5 minutes).
 */
export async function verifyX402Payment(
  txSignature: string,
  expectedWallet: string,
  expectedAmount: number,
): Promise<boolean> {
  // Replay protection — reject already-spent signatures
  if (spentSignatures.has(txSignature)) return false;

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

    // Transaction age check — reject old transactions
    const blockTime = tx.blockTime;
    if (blockTime) {
      const ageS = Math.floor(Date.now() / 1000) - blockTime;
      if (ageS > TX_MAX_AGE_S) return false;
    }

    // Check USDC transfer to payment wallet
    const postBalances = tx.meta?.postTokenBalances || [];
    const preBalances = tx.meta?.preTokenBalances || [];

    for (const post of postBalances) {
      if (post.mint !== USDC_MINT || post.owner !== expectedWallet) continue;

      const postAmt = parseInt(post.uiTokenAmount?.amount || "0", 10);
      const pre = preBalances.find(
        (p: any) => p.accountIndex === post.accountIndex && p.mint === USDC_MINT,
      );
      const preAmt = parseInt(pre?.uiTokenAmount?.amount || "0", 10);

      if (postAmt - preAmt >= expectedAmount) {
        // Mark as spent — evict oldest if cache is full
        if (spentSignatures.size >= MAX_SPENT_CACHE) {
          const oldest = spentSignatures.values().next().value;
          if (oldest) spentSignatures.delete(oldest);
        }
        spentSignatures.add(txSignature);
        persistSpentSignature(txSignature);
        return true;
      }
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
