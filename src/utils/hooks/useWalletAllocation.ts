/**
 * useWalletAllocation
 *
 * Thin React integration layer that connects the pure, unit-tested allocation
 * logic in `../allocation.ts` to the app's live wallet / balance / group state.
 *
 * Design rule: this hook contains NO allocation math or selection logic itself —
 * it only reads app state and delegates to the tested `allocation` functions,
 * then maps results back onto `WalletType`. Keeping the logic in `allocation.ts`
 * is what makes the behaviour deterministic and testable without a DOM.
 */

import { useCallback } from "react";
import { useAppContext } from "../../contexts/AppContext";
import { filterActiveWallets } from "../wallet";
import { saveWalletsToCookies } from "../storage";
import type { WalletType } from "../types";
import {
  selectBuyWallets as selectBuyWalletsCore,
  selectSellWallets as selectSellWalletsCore,
  allocateBuyAmounts,
  allocateSell,
  getGroupWallets,
  type SellMode,
  type SellAllocation,
} from "../allocation";

export interface UseWalletAllocationResult {
  /** Candidate pool for an operation: a group's members, or all non-archived wallets. */
  getCandidates: (groupId?: string) => WalletType[];
  /** Ordered wallets a BUY would use (supply-priority), without mutating state. */
  previewBuySelection: (count?: number, groupId?: string) => WalletType[];
  /** Ordered wallets a SELL would use (highest-supply-first), without mutating state. */
  previewSellSelection: (count?: number, groupId?: string) => WalletType[];
  /**
   * Mark the supply-priority BUY wallets active (all others inactive within the
   * candidate pool) and persist. Returns the selected wallets in priority order.
   */
  applyBuySelection: (count?: number, groupId?: string) => WalletType[];
  /** Same as applyBuySelection but for SELL (highest-supply-first). */
  applySellSelection: (count?: number, groupId?: string) => WalletType[];
  /** Per-wallet SOL amounts for the given wallets (even split or custom overrides). */
  buildBuyAmounts: (
    wallets: WalletType[],
    totalSol: number,
    customAmounts?: Map<string, number>,
  ) => number[];
  /** SELL allocation (percentage or exact amount) for the given wallets. */
  buildSellAllocation: (
    wallets: WalletType[],
    mode: SellMode,
    value: number,
    distribution?: "perWallet" | "total",
  ) => SellAllocation;
}

export function useWalletAllocation(): UseWalletAllocationResult {
  const { wallets, setWallets, tokenBalances } = useAppContext();

  const supplyOf = useCallback(
    (address: string): number => tokenBalances.get(address) ?? 0,
    [tokenBalances],
  );

  const getCandidates = useCallback(
    (groupId?: string): WalletType[] =>
      groupId
        ? getGroupWallets(wallets, groupId)
        : wallets.filter((w) => !w.isArchived),
    [wallets],
  );

  const previewBuySelection = useCallback(
    (count?: number, groupId?: string): WalletType[] =>
      selectBuyWalletsCore(getCandidates(groupId), supplyOf, count),
    [getCandidates, supplyOf],
  );

  const previewSellSelection = useCallback(
    (count?: number, groupId?: string): WalletType[] =>
      selectSellWalletsCore(getCandidates(groupId), supplyOf, count),
    [getCandidates, supplyOf],
  );

  const applySelection = useCallback(
    (selected: WalletType[]): WalletType[] => {
      const selectedIds = new Set(selected.map((w) => w.id));
      const updated = wallets.map((w) => {
        if (w.isArchived) return w;
        return { ...w, isActive: selectedIds.has(w.id) };
      });
      setWallets(updated);
      saveWalletsToCookies(updated);
      // Return the selection in the ORIGINAL priority order (not app order).
      return selected;
    },
    [wallets, setWallets],
  );

  const applyBuySelection = useCallback(
    (count?: number, groupId?: string): WalletType[] =>
      applySelection(previewBuySelection(count, groupId)),
    [applySelection, previewBuySelection],
  );

  const applySellSelection = useCallback(
    (count?: number, groupId?: string): WalletType[] =>
      applySelection(previewSellSelection(count, groupId)),
    [applySelection, previewSellSelection],
  );

  const buildBuyAmounts = useCallback(
    (
      targetWallets: WalletType[],
      totalSol: number,
      customAmounts?: Map<string, number>,
    ): number[] => allocateBuyAmounts(targetWallets, totalSol, customAmounts),
    [],
  );

  const buildSellAllocation = useCallback(
    (
      targetWallets: WalletType[],
      mode: SellMode,
      value: number,
      distribution: "perWallet" | "total" = "perWallet",
    ): SellAllocation =>
      allocateSell(targetWallets, mode, value, supplyOf, distribution),
    [supplyOf],
  );

  return {
    getCandidates,
    previewBuySelection,
    previewSellSelection,
    applyBuySelection,
    applySellSelection,
    buildBuyAmounts,
    buildSellAllocation,
  };
}

/** Re-export for callers that also need to align amounts to the active set. */
export { filterActiveWallets };
