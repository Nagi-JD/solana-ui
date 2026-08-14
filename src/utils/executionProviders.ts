/**
 * Execution Provider Abstraction
 *
 * Decouples "how a signed transaction is landed" from the trading logic. An
 * execution provider takes already-signed, base64-encoded transactions and
 * submits them to the network via a specific landing service:
 *
 *   - "raze"          — the existing Raze send node (JSON-RPC, default)
 *   - "helius-sender" — Helius Sender (multi-path routing, per-tx sendTransaction)
 *   - "jito"          — Jito block engine (atomic bundles / single tx)
 *   - "fury"          — Fury Bot relay (preserved as an optional fallback)
 *
 * Providers do NOT build swap transactions — that remains the job of the
 * prepare step (Fury/Raze). This module is only the submit/land layer.
 *
 * Design: request PLANNING is pure and fully unit-tested (`planRequests`,
 * `resolveProviderChain`); only `sendViaProviders` performs I/O, and it takes an
 * injected `sender` so it is testable without a network. No secrets are
 * hardcoded — API keys and endpoints come from config passed in by the caller.
 */

export type ExecutionProviderName = "raze" | "helius-sender" | "jito" | "fury";

export const DEFAULT_HELIUS_SENDER_ENDPOINT = "https://sender.helius-rpc.com/fast";
export const DEFAULT_JITO_ENDPOINT = "https://mainnet.block-engine.jito.wtf";

/** Provider selection + endpoints. All fields optional; sensible defaults apply. */
export interface ExecutionProviderConfig {
  /** Primary provider. Defaults to "raze" to preserve existing behaviour. */
  provider?: ExecutionProviderName;
  /**
   * Ordered fallbacks tried when the primary fails. Fury is preserved as an
   * optional fallback — include "fury" here (and set `furyEndpoint`) to keep it.
   */
  fallbackProviders?: ExecutionProviderName[];
  /** Raze send-node endpoint (the app's existing `sendEndpoint`). */
  razeEndpoint?: string;
  /** Helius API key (optional for Sender). NEVER hardcode — supply from config/env. */
  heliusApiKey?: string;
  /** Override for the Helius Sender endpoint. */
  heliusSenderEndpoint?: string;
  /** Jito block-engine base URL (region-specific hosts allowed). */
  jitoEndpoint?: string;
  /** Fury relay base URL (e.g. https://de.fury.bot or a self-hosted server). */
  furyEndpoint?: string;
}

/** A single planned HTTP request for a provider. */
export interface ProviderRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Injected transport: performs one request, returns parsed JSON (throws on network/HTTP error). */
export type ProviderSender = (req: ProviderRequest) => Promise<unknown>;

export interface SendOutcome {
  provider: ExecutionProviderName;
  results: unknown[];
}

// ============================================================================
// Provider chain resolution
// ============================================================================

/**
 * Resolve the ordered provider chain: [primary, ...fallbacks], de-duplicated.
 * Defaults to ["raze"] so existing deployments are unaffected. Deterministic.
 */
export const resolveProviderChain = (
  config: ExecutionProviderConfig,
): ExecutionProviderName[] => {
  const primary = config.provider ?? "raze";
  const chain = [primary, ...(config.fallbackProviders ?? [])];
  const seen = new Set<ExecutionProviderName>();
  const deduped: ExecutionProviderName[] = [];
  for (const p of chain) {
    if (!seen.has(p)) {
      seen.add(p);
      deduped.push(p);
    }
  }
  return deduped;
};

// ============================================================================
// Request planning (pure)
// ============================================================================

const jsonRpc = (method: string, params: unknown[]): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});

const withApiKey = (endpoint: string, apiKey?: string): string =>
  apiKey ? `${endpoint}${endpoint.includes("?") ? "&" : "?"}api-key=${apiKey}` : endpoint;

/**
 * Plan the HTTP request(s) for a provider given the signed base64 transactions.
 *
 * Returns one or more requests:
 *  - raze / fury: a single request (sendTransaction for 1 tx, sendBundle for N).
 *  - helius-sender: ONE request PER transaction (Sender lands single txs fast).
 *  - jito: a single bundle request (or single-tx request for 1 tx).
 *
 * Pure — no I/O. Throws if a required endpoint is missing.
 */
export const planRequests = (
  provider: ExecutionProviderName,
  base64Txs: string[],
  config: ExecutionProviderConfig,
): ProviderRequest[] => {
  if (base64Txs.length === 0) {
    throw new Error("planRequests: no transactions to send");
  }

  const jsonHeaders = { "Content-Type": "application/json" };

  switch (provider) {
    case "raze": {
      const endpoint = config.razeEndpoint;
      if (!endpoint) throw new Error("raze provider requires razeEndpoint");
      const body =
        base64Txs.length === 1
          ? jsonRpc("sendTransaction", [base64Txs[0], { encoding: "base64" }])
          : jsonRpc("sendBundle", [base64Txs, { encoding: "base64" }]);
      return [{ endpoint, headers: jsonHeaders, body }];
    }

    case "helius-sender": {
      const base = config.heliusSenderEndpoint || DEFAULT_HELIUS_SENDER_ENDPOINT;
      const endpoint = withApiKey(base, config.heliusApiKey);
      // Sender lands single transactions — one request per tx.
      return base64Txs.map((tx) => ({
        endpoint,
        headers: jsonHeaders,
        body: jsonRpc("sendTransaction", [
          tx,
          { encoding: "base64", skipPreflight: true, maxRetries: 0 },
        ]),
      }));
    }

    case "jito": {
      const base = config.jitoEndpoint || DEFAULT_JITO_ENDPOINT;
      if (base64Txs.length === 1) {
        return [
          {
            endpoint: `${base}/api/v1/transactions`,
            headers: jsonHeaders,
            body: jsonRpc("sendTransaction", [base64Txs[0], { encoding: "base64" }]),
          },
        ];
      }
      // Jito bundles are atomic (max 5 txs per bundle enforced upstream).
      return [
        {
          endpoint: `${base}/api/v1/bundles`,
          headers: jsonHeaders,
          body: jsonRpc("sendBundle", [base64Txs, { encoding: "base64" }]),
        },
      ];
    }

    case "fury": {
      const base = config.furyEndpoint;
      if (!base) throw new Error("fury provider requires furyEndpoint");
      // Matches the Fury relay contract: { transactions: [...] }.
      return [
        {
          endpoint: `${base}/api/transactions/send`,
          headers: jsonHeaders,
          body: { transactions: base64Txs },
        },
      ];
    }

    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown execution provider: ${String(exhaustive)}`);
    }
  }
};

// ============================================================================
// Response interpretation (pure)
// ============================================================================

/**
 * Inspect a provider's parsed JSON response and return an error string if it
 * indicates failure, else null. Handles JSON-RPC `error` objects and Fury's
 * `{ success: false }` / `{ error }` shapes.
 */
export const interpretResponse = (json: unknown): string | null => {
  if (json == null || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;

  const rpcError = obj["error"];
  if (rpcError) {
    if (typeof rpcError === "string") return rpcError;
    if (typeof rpcError === "object") {
      const msg = (rpcError as Record<string, unknown>)["message"];
      return typeof msg === "string" ? msg : "Provider returned an error";
    }
    return "Provider returned an error";
  }
  if (obj["success"] === false) {
    return typeof obj["error"] === "string" ? obj["error"] : "Provider reported failure";
  }
  return null;
};

// ============================================================================
// Orchestration (I/O via injected sender)
// ============================================================================

/**
 * Submit signed transactions, trying each provider in the resolved chain until
 * one succeeds. On a provider failure (thrown transport error OR an error in the
 * parsed response) it records the reason and falls through to the next provider;
 * if all providers fail it throws an aggregated error naming each attempt.
 *
 * `sender` is injected so this is testable without a network.
 */
export const sendViaProviders = async (
  base64Txs: string[],
  config: ExecutionProviderConfig,
  sender: ProviderSender,
): Promise<SendOutcome> => {
  const chain = resolveProviderChain(config);
  const failures: string[] = [];

  for (const provider of chain) {
    try {
      const requests = planRequests(provider, base64Txs, config);
      const results: unknown[] = [];
      for (const req of requests) {
        const json = await sender(req);
        const err = interpretResponse(json);
        if (err) throw new Error(err);
        results.push(json);
      }
      return { provider, results };
    } catch (err) {
      failures.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    `All execution providers failed (${chain.join(" -> ")}): ${failures.join("; ")}`,
  );
};
