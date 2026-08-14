/**
 * WalletAllocationPanel
 *
 * Coordinated multi-wallet BUY/SELL panel. Reuses:
 *  - the tested allocation logic (`useWalletAllocation` -> `utils/allocation`),
 *  - the existing wallet/group abstractions (AppContext + useWalletGroups),
 *  - the existing trade submission path (`handleTradeSubmit`),
 *  - the existing styling tokens (`app-primary-color`, etc.) and the pencil
 *    edit pattern (Edit3 / Check) already used elsewhere in the trading UI.
 *
 * It adds NO new trading/submission logic of its own: selection and amounts come
 * from the pure allocation module, and execution goes through the same
 * `handleTradeSubmit` the rest of the app uses (with its optional per-wallet
 * allocation override).
 */

import React, { useMemo, useState } from "react";
import { Edit3, Check, Loader2, RefreshCw } from "lucide-react";
import { useAppContext } from "../../contexts/AppContext";
import { useWalletGroups, useActiveWalletGroup } from "../../utils/hooks/useWalletGroups";
import { useWalletAllocation } from "../../utils/hooks/useWalletAllocation";
import { filterActiveWallets } from "../../utils/wallet";
import {
  allocateBuyAmounts,
  buildPendingStatuses,
  summarizeExecution,
  type SellMode,
  type WalletExecutionResult,
} from "../../utils/allocation";
import type { WalletType } from "../../utils/types";
import type { InputMode } from "../../utils/trading";

type TradeSubmit = (
  wallets: WalletType[],
  isBuyMode: boolean,
  dex?: string,
  buyAmount?: string,
  sellAmount?: string,
  tokenAddressParam?: string,
  sellInputMode?: InputMode,
  allocation?: {
    amounts?: number[];
    tokensAmount?: number | number[];
    sellPercent?: number;
    onResult?: (result: {
      success: boolean;
      error?: string;
      walletResults?: WalletExecutionResult[];
    }) => void;
  },
) => void;

interface WalletAllocationPanelProps {
  tokenAddress: string;
  selectedDex: string;
  handleTradeSubmit: TradeSubmit;
  isLoading: boolean;
}

const short = (addr: string): string => `${addr.slice(0, 4)}…${addr.slice(-4)}`;

const WalletAllocationPanel: React.FC<WalletAllocationPanelProps> = ({
  tokenAddress,
  selectedDex,
  handleTradeSubmit,
  isLoading,
}) => {
  const { wallets, setWallets, tokenBalances, refreshBalances, isRefreshing } =
    useAppContext();
  const { groups } = useWalletGroups(wallets, setWallets);
  const [activeGroup] = useActiveWalletGroup();
  const allocation = useWalletAllocation();

  const [side, setSide] = useState<"buy" | "sell">("buy");
  // Scope: "count" = auto-select N by supply priority; "group" = whole group.
  const [scope, setScope] = useState<"count" | "group">("count");
  const [count, setCount] = useState(2);
  const [groupId, setGroupId] = useState<string>("");
  const [totalSol, setTotalSol] = useState("");
  const [sellMode, setSellMode] = useState<SellMode>("percentage");
  const [sellValue, setSellValue] = useState("");
  const [customAmounts, setCustomAmounts] = useState<Map<string, number>>(new Map());
  const [editing, setEditing] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<WalletExecutionResult[]>([]);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  const supplyOf = (address: string): number => tokenBalances.get(address) ?? 0;

  const resolvedGroupId = scope === "group" ? groupId || activeGroup : undefined;

  // Preview the wallets this operation would use, without mutating state.
  const preview = useMemo(() => {
    if (scope === "group") {
      const gid = groupId || activeGroup;
      if (!gid || gid === "all") return allocation.getCandidates();
      return side === "buy"
        ? allocation.previewBuySelection(undefined, gid)
        : allocation.previewSellSelection(undefined, gid);
    }
    return side === "buy"
      ? allocation.previewBuySelection(count)
      : allocation.previewSellSelection(count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, groupId, activeGroup, side, count, wallets, tokenBalances]);

  // Per-wallet BUY amounts for the current preview (even split + edits).
  const buyAmounts = useMemo(
    () => allocateBuyAmounts(preview, parseFloat(totalSol || "0"), customAmounts),
    [preview, totalSol, customAmounts],
  );

  const applySelection = (): void => {
    const chosen =
      scope === "group"
        ? side === "buy"
          ? allocation.applyBuySelection(undefined, groupId || activeGroup)
          : allocation.applySellSelection(undefined, groupId || activeGroup)
        : side === "buy"
          ? allocation.applyBuySelection(count)
          : allocation.applySellSelection(count);
    setStatuses(buildPendingStatuses(chosen.map((w) => w.address)));
    setResultMsg(null);
  };

  const setWalletAmount = (address: string, value: string): void => {
    setCustomAmounts((prev) => {
      const next = new Map(prev);
      const num = parseFloat(value);
      if (value === "" || Number.isNaN(num)) next.delete(address);
      else next.set(address, num);
      return next;
    });
  };

  const execute = (): void => {
    // Align amounts to the order executeTrade uses internally.
    const activeOrdered = filterActiveWallets(wallets);
    if (activeOrdered.length === 0) {
      setResultMsg("No wallets selected — run Select first.");
      return;
    }
    setStatuses(
      buildPendingStatuses(activeOrdered.map((w) => w.address)).map((s) => ({
        ...s,
        status: "pending",
      })),
    );
    setResultMsg("Submitting…");

    // Reflect the executor's real per-wallet outcomes when they arrive.
    const onResult = (result: {
      success: boolean;
      error?: string;
      walletResults?: WalletExecutionResult[];
    }): void => {
      if (result.walletResults && result.walletResults.length > 0) {
        setStatuses(result.walletResults);
        const summary = summarizeExecution(result.walletResults);
        setResultMsg(
          summary.allSucceeded
            ? `All ${summary.successCount} wallets succeeded.`
            : `${summary.successCount} succeeded, ${summary.failedCount} failed` +
                (summary.failedAddresses.length
                  ? ` (${summary.failedAddresses.map(short).join(", ")})`
                  : ""),
        );
      } else {
        // Executor returned no per-wallet detail — report the aggregate faithfully.
        setResultMsg(
          result.success
            ? result.error || "Operation completed."
            : `Failed: ${result.error || "unknown error"}`,
        );
      }
    };

    if (side === "buy") {
      const amounts = allocateBuyAmounts(
        activeOrdered,
        parseFloat(totalSol || "0"),
        customAmounts,
      );
      handleTradeSubmit(
        wallets,
        true,
        selectedDex,
        totalSol,
        undefined,
        tokenAddress,
        undefined,
        { amounts, onResult },
      );
    } else {
      const value = parseFloat(sellValue || "0");
      const sellAlloc = allocation.buildSellAllocation(activeOrdered, sellMode, value);
      handleTradeSubmit(
        wallets,
        false,
        selectedDex,
        undefined,
        sellValue,
        tokenAddress,
        undefined,
        { ...sellAlloc, onResult },
      );
    }
  };

  const totalAllocated = buyAmounts.reduce((s, a) => s + a, 0);
  const seg = (active: boolean): string =>
    active
      ? "bg-app-primary-color text-black"
      : "bg-transparent text-app-primary-color";

  return (
    <div className="border border-app-primary-color/30 rounded-lg p-3 mt-3 text-sm">
      <div className="flex items-center justify-between mb-3">
        <span className="font-semibold text-app-primary-color">
          Coordinated Allocation
        </span>
        <button
          type="button"
          onClick={() => void refreshBalances(tokenAddress)}
          className="p-1 text-app-primary-color hover:opacity-80"
          title="Refresh balances"
          disabled={isRefreshing}
        >
          <RefreshCw size={14} className={isRefreshing ? "animate-spin" : ""} />
        </button>
      </div>

      {/* BUY / SELL */}
      <div className="flex rounded-md overflow-hidden border border-app-primary-color/40 mb-3">
        <button
          type="button"
          className={`flex-1 py-1 ${seg(side === "buy")}`}
          onClick={() => setSide("buy")}
        >
          BUY
        </button>
        <button
          type="button"
          className={`flex-1 py-1 ${seg(side === "sell")}`}
          onClick={() => setSide("sell")}
        >
          SELL
        </button>
      </div>

      {/* Scope: count vs group */}
      <div className="flex items-center gap-2 mb-2">
        <button
          type="button"
          className={`px-2 py-1 rounded ${seg(scope === "count")}`}
          onClick={() => setScope("count")}
        >
          # WALLETS
        </button>
        <button
          type="button"
          className={`px-2 py-1 rounded ${seg(scope === "group")}`}
          onClick={() => setScope("group")}
        >
          GROUP
        </button>
        {scope === "count" ? (
          <input
            type="number"
            min={1}
            value={count}
            onChange={(e) => setCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
            className="w-16 bg-transparent border border-app-primary-color/40 rounded px-2 py-1"
            aria-label="wallet count"
          />
        ) : (
          <select
            value={groupId || activeGroup}
            onChange={(e) => setGroupId(e.target.value)}
            className="bg-transparent border border-app-primary-color/40 rounded px-2 py-1"
            aria-label="group"
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="ml-auto px-3 py-1 rounded bg-app-primary-color text-black"
          onClick={applySelection}
        >
          Select
        </button>
      </div>

      {/* Amount inputs */}
      {side === "buy" ? (
        <div className="mb-2">
          <label className="block text-xs opacity-70 mb-1">Total SOL</label>
          <input
            type="text"
            inputMode="decimal"
            value={totalSol}
            onChange={(e) =>
              /^\d*\.?\d*$/.test(e.target.value) && setTotalSol(e.target.value)
            }
            placeholder="0.00"
            className="w-full bg-transparent border border-app-primary-color/40 rounded px-2 py-1"
          />
        </div>
      ) : (
        <div className="mb-2">
          <div className="flex rounded-md overflow-hidden border border-app-primary-color/40 mb-2">
            <button
              type="button"
              className={`flex-1 py-1 ${seg(sellMode === "percentage")}`}
              onClick={() => setSellMode("percentage")}
            >
              PERCENTAGE
            </button>
            <button
              type="button"
              className={`flex-1 py-1 ${seg(sellMode === "amount")}`}
              onClick={() => setSellMode("amount")}
            >
              AMOUNT
            </button>
          </div>
          <input
            type="text"
            inputMode="decimal"
            value={sellValue}
            onChange={(e) =>
              /^\d*\.?\d*$/.test(e.target.value) && setSellValue(e.target.value)
            }
            placeholder={sellMode === "percentage" ? "% per wallet" : "tokens per wallet"}
            className="w-full bg-transparent border border-app-primary-color/40 rounded px-2 py-1"
          />
        </div>
      )}

      {/* Preview list with per-wallet amount (buy) / supply (sell) */}
      <div className="max-h-48 overflow-y-auto mt-2 space-y-1">
        {preview.length === 0 && (
          <div className="text-xs opacity-60 py-2">
            No eligible wallets for this {side}.
          </div>
        )}
        {preview.map((w, i) => {
          const status = statuses.find((s) => s.address === w.address);
          return (
            <div
              key={w.id}
              className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-app-primary-color/5"
            >
              <span className="truncate">
                {w.label || short(w.address)}
                <span className="opacity-50 ml-1 text-xs">
                  supply {supplyOf(w.address)}
                </span>
              </span>
              {side === "buy" ? (
                editing === w.address ? (
                  <span className="flex items-center gap-1">
                    <input
                      autoFocus
                      type="text"
                      inputMode="decimal"
                      defaultValue={String(buyAmounts[i] ?? 0)}
                      onChange={(e) => setWalletAmount(w.address, e.target.value)}
                      className="w-20 bg-transparent border border-app-primary-color/40 rounded px-1 py-0.5"
                    />
                    <button type="button" onClick={() => setEditing(null)}>
                      <Check size={14} className="text-app-primary-color" />
                    </button>
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <span>{(buyAmounts[i] ?? 0).toFixed(4)} SOL</span>
                    <button
                      type="button"
                      onClick={() => setEditing(w.address)}
                      title="Edit amount"
                    >
                      <Edit3 size={12} className="opacity-70 hover:opacity-100" />
                    </button>
                  </span>
                )
              ) : null}
              {status && (
                <span
                  className={`text-xs ${
                    status.status === "success"
                      ? "text-green-400"
                      : status.status === "failed"
                        ? "text-red-400"
                        : "opacity-60"
                  }`}
                >
                  {status.status}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {side === "buy" && preview.length > 0 && (
        <div className="text-xs opacity-70 mt-1">
          Allocated: {totalAllocated.toFixed(4)} SOL across {preview.length} wallet
          {preview.length === 1 ? "" : "s"}
        </div>
      )}

      <button
        type="button"
        onClick={execute}
        disabled={isLoading}
        className="w-full mt-3 py-2 rounded bg-app-primary-color text-black font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {isLoading && <Loader2 size={14} className="animate-spin" />}
        {side === "buy" ? "Execute Buy" : "Execute Sell"}
      </button>

      {resultMsg && <div className="text-xs mt-2 opacity-80">{resultMsg}</div>}
      {resolvedGroupId && (
        <div className="text-[10px] opacity-40 mt-1">group: {resolvedGroupId}</div>
      )}
    </div>
  );
};

export default WalletAllocationPanel;
