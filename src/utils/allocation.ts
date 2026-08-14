/**
 * Wallet Allocation Logic
 *
 * Framework-free, side-effect-free, deterministic logic for coordinated
 * multi-wallet trading. This module intentionally has NO imports from React,
 * web3.js, or app state so it can be unit-tested in isolation and reused by
 * both the buy and sell paths.
 *
 * Responsibilities:
 *  - Select which wallets participate in a BUY (supply-priority + fairness).
 *  - Select which wallets participate in a SELL (highest-supply first).
 *  - Split a total amount across selected wallets (even, remainder-exact).
 *  - Compute per-wallet SELL amounts for percentage and exact modes.
 *  - Expand a wallet group into its coordinated member set.
 *  - Map coordinated bundle results back to per-wallet execution status.
 *
 * Alignment invariant: every function that returns amounts returns them in the
 * SAME order as the wallet array it was given, so callers can zip
 * `wallets[i] <-> amounts[i]` safely.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal wallet shape the allocation logic needs. Any object carrying an
 * `address` works; `id`, `privateKey`, `groupId`, `isArchived` are optional and
 * used only when present. This keeps the module decoupled from `WalletType`.
 */
export interface AllocatableWallet {
  address: string;
  id?: number;
  privateKey?: string;
  groupId?: string;
  isArchived?: boolean;
}

/** Accessor that returns a wallet's current holdings of the target token. */
export type SupplyLookup = (address: string) => number;

/** SELL amount modes exposed in the UI. */
export type SellMode = "percentage" | "amount";

export type WalletExecStatus = "pending" | "success" | "failed";

export interface WalletExecutionResult {
  address: string;
  status: WalletExecStatus;
  error?: string;
  signature?: string;
}

export interface ExecutionSummary {
  total: number;
  successCount: number;
  failedCount: number;
  pendingCount: number;
  /** True only when every wallet succeeded. Never report success on any failure. */
  allSucceeded: boolean;
  anyFailed: boolean;
  failedAddresses: string[];
}

// ============================================================================
// Constants
// ============================================================================

/** Lamports per SOL. Amount splitting is done in integer lamports for exactness. */
export const LAMPORTS_PER_SOL = 1_000_000_000;

// ============================================================================
// Supply-based wallet selection
// ============================================================================

/**
 * Build a stable, deterministic sort key tuple for a wallet so equal supplies
 * resolve in a repeatable order (input index first, then id, then address).
 */
const stableTiebreak = (
  a: AllocatableWallet,
  b: AllocatableWallet,
  indexA: number,
  indexB: number,
): number => {
  if (indexA !== indexB) return indexA - indexB;
  if (a.id !== undefined && b.id !== undefined && a.id !== b.id) {
    return a.id - b.id;
  }
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
};

/**
 * Select wallets for a BUY, in priority order.
 *
 * Priority 1: wallets whose current supply is exactly 0.
 * Priority 2: if not enough zero-supply wallets, fill from the lowest-supply
 *             wallets next.
 *
 * Fairness: because wallets are ordered by ascending supply, a wallet that has
 * already bought (supply > 0) is never chosen ahead of a wallet that has not
 * bought yet (supply === 0). This guarantees a wallet does not repeatedly
 * receive BUY allocations while other eligible wallets have not bought at least
 * once. Supply is the fairness proxy.
 *
 * Deterministic: equal supplies resolve by original input order, then id, then
 * address. Archived wallets are excluded.
 *
 * @param wallets   candidate pool (e.g. a group, or all wallets)
 * @param getSupply current token holdings accessor
 * @param count     how many wallets to select; when omitted, selects all eligible
 */
export const selectBuyWallets = <T extends AllocatableWallet>(
  wallets: T[],
  getSupply: SupplyLookup,
  count?: number,
): T[] => {
  const eligible = wallets.filter((w) => !w.isArchived);
  const ordered = eligible
    .map((wallet, index) => ({ wallet, index, supply: getSupply(wallet.address) }))
    .sort((a, b) => {
      if (a.supply !== b.supply) return a.supply - b.supply; // ascending: 0 first
      return stableTiebreak(a.wallet, b.wallet, a.index, b.index);
    })
    .map((entry) => entry.wallet);

  if (count === undefined) return ordered;
  return ordered.slice(0, Math.max(0, count));
};

/**
 * Select wallets for a SELL, in priority order: highest current supply first.
 * Wallets with zero supply are excluded (nothing to sell). Deterministic
 * tiebreak for equal supplies. Archived wallets are excluded.
 *
 * @param count how many wallets to select; when omitted, selects all with supply > 0
 */
export const selectSellWallets = <T extends AllocatableWallet>(
  wallets: T[],
  getSupply: SupplyLookup,
  count?: number,
): T[] => {
  const eligible = wallets.filter((w) => !w.isArchived && getSupply(w.address) > 0);
  const ordered = eligible
    .map((wallet, index) => ({ wallet, index, supply: getSupply(wallet.address) }))
    .sort((a, b) => {
      if (a.supply !== b.supply) return b.supply - a.supply; // descending: highest first
      return stableTiebreak(a.wallet, b.wallet, a.index, b.index);
    })
    .map((entry) => entry.wallet);

  if (count === undefined) return ordered;
  return ordered.slice(0, Math.max(0, count));
};

// ============================================================================
// Amount splitting
// ============================================================================

/**
 * Split `total` across `count` recipients as evenly as possible, exactly.
 *
 * The split is computed in integer lamports so the returned SOL amounts sum
 * back to `total` with no floating-point drift. When `total` does not divide
 * evenly, the first `remainder` recipients each receive one extra lamport
 * (the "uneven when necessary" case). The returned array is in recipient order.
 *
 * @param total  total SOL to distribute (must be >= 0)
 * @param count  number of recipients (must be > 0)
 * @returns per-recipient SOL amounts, length === count, summing to `total`
 */
export const splitAmountEvenly = (total: number, count: number): number[] => {
  if (!Number.isFinite(total) || total < 0) {
    throw new Error(`splitAmountEvenly: total must be a non-negative number, got ${total}`);
  }
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`splitAmountEvenly: count must be a positive integer, got ${count}`);
  }

  const totalLamports = Math.round(total * LAMPORTS_PER_SOL);
  const base = Math.floor(totalLamports / count);
  const remainder = totalLamports - base * count;

  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    const lamports = base + (i < remainder ? 1 : 0);
    result.push(lamports / LAMPORTS_PER_SOL);
  }
  return result;
};

/**
 * Allocate a total BUY amount across the given (already-selected) wallets.
 *
 * By default the total is split evenly (remainder-exact). Callers may supply
 * `customAmounts` (keyed by address) to override any wallet's amount with an
 * explicit value — this is the "uneven amounts when necessary" / manual-edit
 * path. Wallets not present in `customAmounts` fall back to the even split of
 * the REMAINING total across the remaining wallets.
 *
 * @returns per-wallet SOL amounts aligned to `wallets` order
 */
export const allocateBuyAmounts = (
  wallets: AllocatableWallet[],
  total: number,
  customAmounts?: Map<string, number>,
): number[] => {
  if (wallets.length === 0) return [];

  if (!customAmounts || customAmounts.size === 0) {
    return splitAmountEvenly(total, wallets.length);
  }

  // Wallets with an explicit custom amount keep it; the rest share the remainder.
  const explicit = new Map<string, number>();
  let explicitTotal = 0;
  const remainingWallets: AllocatableWallet[] = [];
  for (const wallet of wallets) {
    const custom = customAmounts.get(wallet.address);
    if (custom !== undefined && Number.isFinite(custom) && custom >= 0) {
      explicit.set(wallet.address, custom);
      explicitTotal += custom;
    } else {
      remainingWallets.push(wallet);
    }
  }

  const remainingTotal = Math.max(0, total - explicitTotal);
  const remainderSplit =
    remainingWallets.length > 0
      ? splitAmountEvenly(remainingTotal, remainingWallets.length)
      : [];

  let splitIdx = 0;
  return wallets.map((wallet) => {
    const custom = explicit.get(wallet.address);
    if (custom !== undefined) return custom;
    return remainderSplit[splitIdx++] ?? 0;
  });
};

// ============================================================================
// Sell amount computation
// ============================================================================

/**
 * Result of resolving a SELL. Exactly one of `sellPercent` / `tokensAmount` is
 * set, matching the existing SellConfig contract:
 *  - percentage mode with no balances -> `sellPercent` scalar (server applies per wallet)
 *  - percentage mode with balances    -> per-wallet `tokensAmount` array
 *  - amount mode                      -> per-wallet `tokensAmount` array
 */
export interface SellAllocation {
  sellPercent?: number;
  tokensAmount?: number | number[];
}

/**
 * Compute a SELL allocation for the given (already-selected) wallets.
 *
 * Percentage mode: each wallet sells `supply * percent/100`. If supplies are
 * available for every wallet, a per-wallet token array is produced so amounts
 * are exact; otherwise the raw percentage is passed through for the server to
 * apply uniformly.
 *
 * Amount mode:
 *  - `distribution: "perWallet"` (default): every wallet sells `value` tokens.
 *  - `distribution: "total"`: `value` total tokens split proportionally to each
 *    wallet's supply (so wallets holding more sell more), remainder-exact-free
 *    (token amounts are fractional and summed to `value`).
 *
 * @returns SellAllocation whose array (when present) is aligned to `wallets` order
 */
export const allocateSell = (
  wallets: AllocatableWallet[],
  mode: SellMode,
  value: number,
  getSupply: SupplyLookup,
  distribution: "perWallet" | "total" = "perWallet",
): SellAllocation => {
  if (wallets.length === 0) {
    return mode === "percentage" ? { sellPercent: value } : { tokensAmount: [] };
  }

  if (mode === "percentage") {
    const supplies = wallets.map((w) => getSupply(w.address));
    const allHaveSupply = supplies.every((s) => s > 0);
    if (allHaveSupply) {
      return { tokensAmount: supplies.map((s) => s * (value / 100)) };
    }
    return { sellPercent: value };
  }

  // Exact amount mode
  if (distribution === "total") {
    const supplies = wallets.map((w) => getSupply(w.address));
    const supplyTotal = supplies.reduce((sum, s) => sum + s, 0);
    if (supplyTotal <= 0) {
      // No basis for proportional split; fall back to equal token split.
      const per = value / wallets.length;
      return { tokensAmount: wallets.map(() => per) };
    }
    return { tokensAmount: supplies.map((s) => value * (s / supplyTotal)) };
  }

  // perWallet: same exact token amount from each wallet
  return { tokensAmount: wallets.map(() => value) };
};

// ============================================================================
// Group coordination
// ============================================================================

export const DEFAULT_GROUP_ID = "default";

/**
 * Return all (non-archived) wallets belonging to `groupId`. Wallets with no
 * explicit groupId are treated as members of the default group, mirroring the
 * app's group model. When a group is selected, ALL of its members participate
 * in the coordinated operation.
 */
export const getGroupWallets = <T extends AllocatableWallet>(
  wallets: T[],
  groupId: string,
): T[] =>
  wallets.filter(
    (w) => !w.isArchived && (w.groupId || DEFAULT_GROUP_ID) === groupId,
  );

// ============================================================================
// Per-wallet execution status (partial-failure handling)
// ============================================================================

/** Initialise a pending status entry per wallet address, in order. */
export const buildPendingStatuses = (addresses: string[]): WalletExecutionResult[] =>
  addresses.map((address) => ({ address, status: "pending" as const }));

/**
 * Apply the outcome of a coordinated bundle to the wallets it contained.
 *
 * Bundles are atomic-ish: if the bundle failed, every wallet in it is marked
 * failed; if it succeeded, every wallet in it is marked success. Returns a NEW
 * array (pure) so it composes cleanly with React state updates.
 */
export const applyBundleResult = (
  statuses: WalletExecutionResult[],
  bundleAddresses: string[],
  ok: boolean,
  detail?: { error?: string; signature?: string },
): WalletExecutionResult[] => {
  const inBundle = new Set(bundleAddresses);
  return statuses.map((entry) => {
    if (!inBundle.has(entry.address)) return entry;
    return {
      ...entry,
      status: ok ? "success" : "failed",
      error: ok ? undefined : detail?.error,
      signature: ok ? detail?.signature : undefined,
    };
  });
};

/**
 * Summarise per-wallet execution results. `allSucceeded` is true ONLY when
 * every wallet succeeded; any failure (or leftover pending) keeps it false, so
 * callers can never report a partially-failed operation as fully successful.
 */
export const summarizeExecution = (
  results: WalletExecutionResult[],
): ExecutionSummary => {
  let successCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  const failedAddresses: string[] = [];

  for (const r of results) {
    if (r.status === "success") successCount++;
    else if (r.status === "failed") {
      failedCount++;
      failedAddresses.push(r.address);
    } else pendingCount++;
  }

  return {
    total: results.length,
    successCount,
    failedCount,
    pendingCount,
    allSucceeded: results.length > 0 && successCount === results.length,
    anyFailed: failedCount > 0,
    failedAddresses,
  };
};
