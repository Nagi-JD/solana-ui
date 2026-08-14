import { describe, it, expect } from "vitest";
import {
  selectBuyWallets,
  selectSellWallets,
  splitAmountEvenly,
  allocateBuyAmounts,
  allocateSell,
  getGroupWallets,
  buildPendingStatuses,
  applyBundleResult,
  summarizeExecution,
  LAMPORTS_PER_SOL,
  type AllocatableWallet,
  type WalletExecutionResult,
} from "./allocation";

/** Build a wallet with a friendly label as address for readable assertions. */
const w = (
  address: string,
  extra: Partial<AllocatableWallet> = {},
): AllocatableWallet => ({ address, ...extra });

/** Turn a {address: supply} record into a SupplyLookup. */
const supplyOf =
  (map: Record<string, number>) =>
  (address: string): number =>
    map[address] ?? 0;

describe("selectBuyWallets", () => {
  it("prioritises zero-supply wallets (spec example 1)", () => {
    const wallets = [w("W1"), w("W2"), w("W3"), w("W4")];
    const supply = supplyOf({ W1: 0, W2: 0, W3: 500, W4: 1000 });
    const selected = selectBuyWallets(wallets, supply, 2);
    expect(selected.map((x) => x.address)).toEqual(["W1", "W2"]);
  });

  it("falls back to lowest-supply wallets when all have bought (spec example 2)", () => {
    const wallets = [w("W1"), w("W2"), w("W3"), w("W4")];
    const supply = supplyOf({ W1: 1000, W2: 5000, W3: 2000, W4: 5000 });
    const selected = selectBuyWallets(wallets, supply, 2);
    expect(selected.map((x) => x.address)).toEqual(["W1", "W3"]);
  });

  it("never gives a bought wallet a second allocation while a zero-supply wallet waits (fairness)", () => {
    // W1 already bought; W2/W3 have not. Selecting 2 must include both zeros, not W1 twice.
    const wallets = [w("W1"), w("W2"), w("W3")];
    const supply = supplyOf({ W1: 1000, W2: 0, W3: 0 });
    const selected = selectBuyWallets(wallets, supply, 2);
    expect(selected.map((x) => x.address)).toEqual(["W2", "W3"]);
    expect(selected.map((x) => x.address)).not.toContain("W1");
  });

  it("is deterministic across repeated calls with equal supplies", () => {
    const wallets = [w("A"), w("B"), w("C"), w("D")];
    const supply = supplyOf({ A: 0, B: 0, C: 0, D: 0 });
    const first = selectBuyWallets(wallets, supply, 2).map((x) => x.address);
    const second = selectBuyWallets(wallets, supply, 2).map((x) => x.address);
    expect(first).toEqual(second);
    expect(first).toEqual(["A", "B"]); // stable input order for ties
  });

  it("breaks ties by id then address when input order is ambiguous", () => {
    const wallets = [w("Zeta", { id: 2 }), w("Alpha", { id: 1 })];
    const supply = supplyOf({ Zeta: 0, Alpha: 0 });
    // Same supply -> input index decides first; index of Zeta(0) < Alpha(1)
    expect(selectBuyWallets(wallets, supply, 1).map((x) => x.address)).toEqual(["Zeta"]);
  });

  it("excludes archived wallets", () => {
    const wallets = [w("W1", { isArchived: true }), w("W2"), w("W3")];
    const supply = supplyOf({ W1: 0, W2: 5, W3: 10 });
    const selected = selectBuyWallets(wallets, supply, 3);
    expect(selected.map((x) => x.address)).toEqual(["W2", "W3"]);
  });

  it("returns all eligible wallets in priority order when count is omitted", () => {
    const wallets = [w("W1"), w("W2"), w("W3")];
    const supply = supplyOf({ W1: 100, W2: 0, W3: 50 });
    expect(selectBuyWallets(wallets, supply).map((x) => x.address)).toEqual([
      "W2",
      "W3",
      "W1",
    ]);
  });
});

describe("selectSellWallets", () => {
  it("selects highest-supply wallets first (spec example)", () => {
    const wallets = [w("W1"), w("W2"), w("W3")];
    const supply = supplyOf({ W1: 1000, W2: 5000, W3: 2000 });
    const selected = selectSellWallets(wallets, supply, 2);
    expect(selected.map((x) => x.address)).toEqual(["W2", "W3"]);
  });

  it("excludes zero-supply wallets (nothing to sell)", () => {
    const wallets = [w("W1"), w("W2"), w("W3")];
    const supply = supplyOf({ W1: 0, W2: 5000, W3: 0 });
    const selected = selectSellWallets(wallets, supply, 3);
    expect(selected.map((x) => x.address)).toEqual(["W2"]);
  });

  it("returns all wallets with supply when count omitted, highest first", () => {
    const wallets = [w("W1"), w("W2"), w("W3")];
    const supply = supplyOf({ W1: 300, W2: 100, W3: 200 });
    expect(selectSellWallets(wallets, supply).map((x) => x.address)).toEqual([
      "W1",
      "W3",
      "W2",
    ]);
  });
});

describe("splitAmountEvenly", () => {
  it("splits evenly when divisible (2 SOL / 2 = 1,1)", () => {
    expect(splitAmountEvenly(2, 2)).toEqual([1, 1]);
  });

  it("splits 3 SOL across 3 wallets as 1 each (spec)", () => {
    expect(splitAmountEvenly(3, 3)).toEqual([1, 1, 1]);
  });

  it("distributes remainder to earliest wallets, summing exactly to total (uneven)", () => {
    const parts = splitAmountEvenly(1, 3);
    // 1 SOL = 1e9 lamports; base 333333333, remainder 1
    expect(parts).toEqual([0.333333334, 0.333333333, 0.333333333]);
    const sumLamports = parts.reduce(
      (s, p) => s + Math.round(p * LAMPORTS_PER_SOL),
      0,
    );
    expect(sumLamports).toBe(LAMPORTS_PER_SOL); // no drift
  });

  it("handles zero total", () => {
    expect(splitAmountEvenly(0, 3)).toEqual([0, 0, 0]);
  });

  it("throws on invalid count", () => {
    expect(() => splitAmountEvenly(1, 0)).toThrow();
    expect(() => splitAmountEvenly(1, -1)).toThrow();
  });

  it("throws on negative total", () => {
    expect(() => splitAmountEvenly(-1, 2)).toThrow();
  });
});

describe("allocateBuyAmounts", () => {
  const wallets = [w("W1"), w("W2"), w("W3")];

  it("splits total evenly across selected wallets (3 SOL / 3 = 1 each, spec group example)", () => {
    expect(allocateBuyAmounts(wallets, 3)).toEqual([1, 1, 1]);
  });

  it("honours explicit custom amounts and shares the remainder among the rest (uneven)", () => {
    const custom = new Map([["W1", 1.5]]);
    // Total 3, W1 fixed at 1.5, remaining 1.5 split across W2,W3 -> 0.75 each
    expect(allocateBuyAmounts(wallets, 3, custom)).toEqual([1.5, 0.75, 0.75]);
  });

  it("supports fully-specified uneven amounts", () => {
    const custom = new Map([
      ["W1", 0.5],
      ["W2", 1.0],
      ["W3", 1.5],
    ]);
    expect(allocateBuyAmounts(wallets, 3, custom)).toEqual([0.5, 1.0, 1.5]);
  });

  it("returns empty for no wallets", () => {
    expect(allocateBuyAmounts([], 3)).toEqual([]);
  });
});

describe("allocateSell", () => {
  const wallets = [w("W1"), w("W2"), w("W3")];

  it("percentage mode with balances yields per-wallet token amounts (50% of each, spec group example)", () => {
    const supply = supplyOf({ W1: 2, W2: 2, W3: 2 }); // 2 SOL-worth each
    const result = allocateSell(wallets, "percentage", 50, supply);
    expect(result.tokensAmount).toEqual([1, 1, 1]); // sell 1 worth from each = 3 total
    expect(result.sellPercent).toBeUndefined();
  });

  it("percentage mode handles uneven balances proportionally", () => {
    const supply = supplyOf({ W1: 1000, W2: 5000, W3: 2000 });
    const result = allocateSell(wallets, "percentage", 50, supply);
    expect(result.tokensAmount).toEqual([500, 2500, 1000]);
  });

  it("percentage mode falls back to scalar when a wallet has no balance", () => {
    const supply = supplyOf({ W1: 1000, W2: 0, W3: 2000 });
    const result = allocateSell(wallets, "percentage", 50, supply);
    expect(result.sellPercent).toBe(50);
    expect(result.tokensAmount).toBeUndefined();
  });

  it("amount mode perWallet sells the same exact amount from each", () => {
    const supply = supplyOf({ W1: 1000, W2: 5000, W3: 2000 });
    const result = allocateSell(wallets, "amount", 100, supply, "perWallet");
    expect(result.tokensAmount).toEqual([100, 100, 100]);
  });

  it("amount mode total splits proportionally to supply", () => {
    const supply = supplyOf({ W1: 1000, W2: 3000, W3: 0 });
    // total 400 across supply 4000 -> W1 100, W2 300, W3 0
    const result = allocateSell(wallets, "amount", 400, supply, "total");
    expect(result.tokensAmount).toEqual([100, 300, 0]);
  });
});

describe("getGroupWallets", () => {
  it("returns all members of a group (coordinated unit)", () => {
    const wallets = [
      w("W1", { groupId: "A" }),
      w("W2", { groupId: "A" }),
      w("W3", { groupId: "A" }),
      w("W4", { groupId: "B" }),
    ];
    expect(getGroupWallets(wallets, "A").map((x) => x.address)).toEqual([
      "W1",
      "W2",
      "W3",
    ]);
  });

  it("treats wallets with no groupId as members of the default group", () => {
    const wallets = [w("W1"), w("W2", { groupId: "default" }), w("W3", { groupId: "A" })];
    expect(getGroupWallets(wallets, "default").map((x) => x.address)).toEqual([
      "W1",
      "W2",
    ]);
  });

  it("excludes archived members", () => {
    const wallets = [
      w("W1", { groupId: "A" }),
      w("W2", { groupId: "A", isArchived: true }),
    ];
    expect(getGroupWallets(wallets, "A").map((x) => x.address)).toEqual(["W1"]);
  });

  it("end-to-end: a selected group buys 3 SOL split evenly (spec)", () => {
    const wallets = [
      w("W1", { groupId: "A" }),
      w("W2", { groupId: "A" }),
      w("W3", { groupId: "A" }),
    ];
    const members = getGroupWallets(wallets, "A");
    const amounts = allocateBuyAmounts(members, 3);
    expect(members.length).toBe(3);
    expect(amounts).toEqual([1, 1, 1]);
  });
});

describe("partial-failure handling", () => {
  it("reports each wallet's status and never marks a partial failure as fully successful (spec)", () => {
    let statuses = buildPendingStatuses(["W1", "W2", "W3"]);
    // W1 and W2 in a bundle that succeeds; W3 in a bundle that fails.
    statuses = applyBundleResult(statuses, ["W1", "W2"], true, { signature: "sigAB" });
    statuses = applyBundleResult(statuses, ["W3"], false, { error: "insufficient funds" });

    expect(statuses).toEqual([
      { address: "W1", status: "success", error: undefined, signature: "sigAB" },
      { address: "W2", status: "success", error: undefined, signature: "sigAB" },
      { address: "W3", status: "failed", error: "insufficient funds", signature: undefined },
    ]);

    const summary = summarizeExecution(statuses);
    expect(summary.successCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.allSucceeded).toBe(false); // MUST NOT report overall success
    expect(summary.anyFailed).toBe(true);
    expect(summary.failedAddresses).toEqual(["W3"]);
  });

  it("marks all wallets in a failed coordinated bundle as failed", () => {
    let statuses = buildPendingStatuses(["W1", "W2", "W3"]);
    statuses = applyBundleResult(statuses, ["W1", "W2", "W3"], false, {
      error: "bundle rejected",
    });
    const summary = summarizeExecution(statuses);
    expect(summary.failedCount).toBe(3);
    expect(summary.allSucceeded).toBe(false);
  });

  it("reports allSucceeded only when every wallet succeeds", () => {
    let statuses = buildPendingStatuses(["W1", "W2"]);
    statuses = applyBundleResult(statuses, ["W1", "W2"], true, { signature: "sig" });
    const summary = summarizeExecution(statuses);
    expect(summary.allSucceeded).toBe(true);
    expect(summary.anyFailed).toBe(false);
  });

  it("leftover pending wallets keep allSucceeded false", () => {
    let statuses = buildPendingStatuses(["W1", "W2"]);
    statuses = applyBundleResult(statuses, ["W1"], true, { signature: "sig" });
    const summary = summarizeExecution(statuses);
    expect(summary.pendingCount).toBe(1);
    expect(summary.allSucceeded).toBe(false);
  });

  it("does not mutate the input array (pure)", () => {
    const original = buildPendingStatuses(["W1"]);
    const copy: WalletExecutionResult[] = original.map((r) => ({ ...r }));
    applyBundleResult(original, ["W1"], true);
    expect(original).toEqual(copy);
  });
});

describe("executor status mapping (integration shape)", () => {
  it("batch mode: 6 wallets in 2 batches of 4/2, second batch fails", () => {
    // Mirrors executeBuyBatchMode: batchSize 4 -> [W1..W4], [W5,W6]
    const addrs = ["W1", "W2", "W3", "W4", "W5", "W6"];
    let statuses = buildPendingStatuses(addrs);
    statuses = applyBundleResult(statuses, ["W1", "W2", "W3", "W4"], true);
    statuses = applyBundleResult(statuses, ["W5", "W6"], false, { error: "batch failed" });

    const summary = summarizeExecution(statuses);
    expect(summary.successCount).toBe(4);
    expect(summary.failedCount).toBe(2);
    expect(summary.failedAddresses).toEqual(["W5", "W6"]);
    expect(summary.allSucceeded).toBe(false);
  });

  it("all-in-one: wallets beyond the 4-wallet cap are reported failed, not dropped", () => {
    // Mirrors executeBuyAllInOneMode: cap 4, W5 dropped -> failed
    const addrs = ["W1", "W2", "W3", "W4", "W5"];
    let statuses = buildPendingStatuses(addrs);
    statuses = applyBundleResult(statuses, ["W5"], false, {
      error: "Not executed: all-in-one mode caps at 4 wallets",
    });
    statuses = applyBundleResult(statuses, ["W1", "W2", "W3", "W4"], true);

    const summary = summarizeExecution(statuses);
    expect(summary.total).toBe(5);
    expect(summary.successCount).toBe(4);
    expect(summary.failedCount).toBe(1);
    expect(summary.failedAddresses).toEqual(["W5"]);
    expect(summary.allSucceeded).toBe(false);
  });
});
