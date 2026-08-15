import { describe, it, expect } from "vitest";
import {
  resolveProviderChain,
  planRequests,
  interpretResponse,
  sendViaProviders,
  DEFAULT_HELIUS_SENDER_ENDPOINT,
  DEFAULT_JITO_ENDPOINT,
  DEFAULT_JUPITER_ENDPOINT,
  type ExecutionProviderConfig,
  type ProviderRequest,
} from "./executionProviders";

const cfg = (over: Partial<ExecutionProviderConfig> = {}): ExecutionProviderConfig => ({
  razeEndpoint: "https://de.raze.sh",
  furyEndpoint: "https://de.fury.bot",
  ...over,
});

describe("resolveProviderChain", () => {
  it("defaults to [raze] when nothing is configured (backward compatible)", () => {
    expect(resolveProviderChain({})).toEqual(["raze"]);
  });

  it("puts the primary first, then fallbacks", () => {
    expect(
      resolveProviderChain({
        provider: "helius-sender",
        fallbackProviders: ["jito", "fury"],
      }),
    ).toEqual(["helius-sender", "jito", "fury"]);
  });

  it("de-duplicates providers", () => {
    expect(
      resolveProviderChain({
        provider: "jito",
        fallbackProviders: ["jito", "fury", "fury"],
      }),
    ).toEqual(["jito", "fury"]);
  });

  it("preserves Fury as an optional fallback", () => {
    const chain = resolveProviderChain({
      provider: "helius-sender",
      fallbackProviders: ["fury"],
    });
    expect(chain[chain.length - 1]).toBe("fury");
  });

  it("supports jupiter as primary or fallback", () => {
    expect(resolveProviderChain({ provider: "jupiter" })).toEqual(["jupiter"]);
    expect(
      resolveProviderChain({ provider: "helius-sender", fallbackProviders: ["jupiter", "fury"] }),
    ).toEqual(["helius-sender", "jupiter", "fury"]);
  });
});

describe("planRequests", () => {
  it("raze: single tx uses sendTransaction", () => {
    const [req] = planRequests("raze", ["TX1"], cfg());
    expect(req.endpoint).toBe("https://de.raze.sh");
    expect(req.body).toMatchObject({ method: "sendTransaction", params: ["TX1", { encoding: "base64" }] });
  });

  it("raze: multiple txs use sendBundle", () => {
    const [req] = planRequests("raze", ["TX1", "TX2"], cfg());
    expect(req.body).toMatchObject({ method: "sendBundle" });
    expect((req.body as { params: unknown[] }).params[0]).toEqual(["TX1", "TX2"]);
  });

  it("helius-sender: one request per tx, default endpoint, skipPreflight", () => {
    const reqs = planRequests("helius-sender", ["TX1", "TX2"], cfg());
    expect(reqs).toHaveLength(2);
    expect(reqs[0].endpoint).toBe(DEFAULT_HELIUS_SENDER_ENDPOINT);
    expect(reqs[0].body).toMatchObject({
      method: "sendTransaction",
      params: ["TX1", { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
    });
  });

  it("helius-sender: appends api-key when provided, without hardcoding it", () => {
    const reqs = planRequests("helius-sender", ["TX1"], cfg({ heliusApiKey: "KEY123" }));
    expect(reqs[0].endpoint).toBe(`${DEFAULT_HELIUS_SENDER_ENDPOINT}?api-key=KEY123`);
  });

  it("jito: single tx -> /transactions, bundle -> /bundles", () => {
    const single = planRequests("jito", ["TX1"], cfg());
    expect(single[0].endpoint).toBe(`${DEFAULT_JITO_ENDPOINT}/api/v1/transactions`);

    const bundle = planRequests("jito", ["TX1", "TX2"], cfg());
    expect(bundle[0].endpoint).toBe(`${DEFAULT_JITO_ENDPOINT}/api/v1/bundles`);
    expect(bundle[0].body).toMatchObject({ method: "sendBundle" });
  });

  it("fury: posts to /api/transactions/send with { transactions }", () => {
    const [req] = planRequests("fury", ["TX1", "TX2"], cfg());
    expect(req.endpoint).toBe("https://de.fury.bot/api/transactions/send");
    expect(req.body).toEqual({ transactions: ["TX1", "TX2"] });
  });

  it("jupiter: one request per tx, default endpoint, x-api-key header, base64 skipPreflight", () => {
    const reqs = planRequests("jupiter", ["TX1", "TX2"], cfg({ jupiterApiKey: "JKEY" }));
    expect(reqs).toHaveLength(2);
    expect(reqs[0].endpoint).toBe(DEFAULT_JUPITER_ENDPOINT);
    expect(reqs[0].headers["x-api-key"]).toBe("JKEY");
    expect(reqs[0].body).toMatchObject({
      method: "sendTransaction",
      params: ["TX1", { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
    });
  });

  it("jupiter: respects a custom endpoint override", () => {
    const [req] = planRequests(
      "jupiter",
      ["TX1"],
      cfg({ jupiterApiKey: "JKEY", jupiterEndpoint: "https://custom.tx.jup.ag" }),
    );
    expect(req.endpoint).toBe("https://custom.tx.jup.ag");
  });

  it("throws when a required endpoint is missing", () => {
    expect(() => planRequests("fury", ["TX1"], {})).toThrow(/furyEndpoint/);
    expect(() => planRequests("raze", ["TX1"], {})).toThrow(/razeEndpoint/);
  });

  it("throws when jupiter's required api key is missing (never silently sent unauthenticated)", () => {
    expect(() => planRequests("jupiter", ["TX1"], cfg())).toThrow(/jupiterApiKey/);
  });

  it("throws on empty tx list", () => {
    expect(() => planRequests("raze", [], cfg())).toThrow();
  });
});

describe("interpretResponse", () => {
  it("returns null for success shapes", () => {
    expect(interpretResponse({ result: "sig" })).toBeNull();
    expect(interpretResponse({ success: true })).toBeNull();
  });

  it("extracts JSON-RPC error message", () => {
    expect(interpretResponse({ error: { message: "blockhash not found" } })).toBe(
      "blockhash not found",
    );
    expect(interpretResponse({ error: "rate limited" })).toBe("rate limited");
  });

  it("detects Fury-style failure", () => {
    expect(interpretResponse({ success: false, error: "bad tx" })).toBe("bad tx");
  });
});

describe("sendViaProviders (orchestration with fallback)", () => {
  /** Build a mock sender driven by `behaviour`, recording every request. */
  const makeSender = (
    behaviour: (req: ProviderRequest) => unknown,
  ): { sender: (req: ProviderRequest) => Promise<unknown>; calls: ProviderRequest[] } => {
    const calls: ProviderRequest[] = [];
    const sender = async (req: ProviderRequest): Promise<unknown> => {
      calls.push(req);
      return await Promise.resolve(behaviour(req));
    };
    return { sender, calls };
  };

  it("uses the primary provider when it succeeds", async () => {
    const { sender, calls } = makeSender(() => ({ result: "sig" }));
    const out = await sendViaProviders(["TX1"], cfg({ provider: "helius-sender" }), sender);
    expect(out.provider).toBe("helius-sender");
    expect(calls[0].endpoint).toContain("sender.helius-rpc.com");
  });

  it("falls back to the next provider when the primary throws (transport error)", async () => {
    const { sender } = makeSender((req) => {
      if (req.endpoint.includes("sender.helius-rpc.com")) throw new Error("503");
      return { result: "sig-from-fury" };
    });
    const out = await sendViaProviders(
      ["TX1"],
      cfg({ provider: "helius-sender", fallbackProviders: ["fury"] }),
      sender,
    );
    expect(out.provider).toBe("fury");
    expect(out.results).toEqual([{ result: "sig-from-fury" }]);
  });

  it("falls back when the primary returns a JSON-RPC error in a 200 response", async () => {
    const { sender } = makeSender((req) => {
      if (req.endpoint.includes("block-engine.jito.wtf")) {
        return { error: { message: "bundle rejected" } };
      }
      return { result: "sig-from-fury" };
    });
    const out = await sendViaProviders(
      ["TX1"],
      cfg({ provider: "jito", fallbackProviders: ["fury"] }),
      sender,
    );
    expect(out.provider).toBe("fury");
  });

  it("throws an aggregated error naming each provider when all fail", async () => {
    const { sender } = makeSender(() => {
      throw new Error("down");
    });
    await expect(
      sendViaProviders(
        ["TX1"],
        cfg({ provider: "helius-sender", fallbackProviders: ["jito", "fury"] }),
        sender,
      ),
    ).rejects.toThrow(/helius-sender.*jito.*fury/s);
  });

  it("helius-sender sends one request per transaction", async () => {
    const { sender, calls } = makeSender(() => ({ result: "sig" }));
    await sendViaProviders(["TX1", "TX2", "TX3"], cfg({ provider: "helius-sender" }), sender);
    expect(calls).toHaveLength(3);
  });

  it("falls back from jupiter to fury when jupiter rejects a tip-less transaction", async () => {
    const { sender, calls } = makeSender((req) => {
      if (req.endpoint.includes("tx.jup.ag")) {
        return { error: { message: "Transaction must include a Jupiter tip instruction" } };
      }
      return { result: "sig-from-fury" };
    });
    const out = await sendViaProviders(
      ["TX1"],
      cfg({ provider: "jupiter", fallbackProviders: ["fury"], jupiterApiKey: "JKEY" }),
      sender,
    );
    expect(out.provider).toBe("fury");
    expect(calls[0].headers["x-api-key"]).toBe("JKEY");
  });
});
