/**
 * Lisk Redstone Oracle Price Feed Keeper
 *
 * Cron-triggered task that checks Redstone oracle price feeds on Lisk mainnet
 * and pushes updates when deviation >= 0.5% or staleness >= 6 hours.
 *
 * Replaces the original Gelato Web3 Function with equivalent logic running
 * on Goldsky Compose.
 */

import { Contract, providers, BigNumber } from "ethers";
import {
  arrayify,
  formatBytes32String,
  defaultAbiCoder,
} from "ethers/lib/utils";
import { WrapperBuilder } from "@redstone-finance/evm-connector";
import { RedstonePayload, SignedDataPackage } from "@redstone-finance/protocol";
import { getSignersForDataServiceId } from "@redstone-finance/sdk";

// -- Types (imported from Compose task-types at deploy time) --

type TaskContext = {
  env: Record<string, string>;
  callTask: <Args = Record<string, unknown>, T = unknown>(
    taskName: string,
    args: Args,
  ) => Promise<T>;
  fetch: <T = unknown>(url: string, config?: unknown) => Promise<T | undefined>;
  logEvent: (event: {
    code: string;
    message: string;
    data: string;
  }) => Promise<void>;
  evm: {
    chains: Record<string, { id: number; name: string; rpcUrls: { default: { http: string[] } }; nativeCurrency: { name: string; symbol: string; decimals: number } }>;
    wallet: (config: {
      name?: string;
      privateKey?: string;
      sponsorGas?: boolean;
    }) => Promise<{
      name: string;
      address: `0x${string}`;
      sendTransaction: (
        config: {
          to: `0x${string}`;
          data: `0x${string}`;
          chain: unknown;
          value?: bigint;
          gas?: bigint;
        },
        confirmation?: unknown,
      ) => Promise<{ hash: string; receipt: unknown }>;
      readContract: <T = unknown>(
        chain: unknown,
        contractAddress: `0x${string}`,
        functionSig: string,
        args: unknown[],
      ) => Promise<T>;
      getBalance: (chain: unknown) => Promise<string>;
    }>;
  };
  collection: <T>(name: string) => Promise<{
    insertOne: (doc: T) => Promise<{ id: string }>;
    findOne: (filter: Record<string, unknown>) => Promise<(T & { id: string }) | null>;
    findMany: (filter: Record<string, unknown>) => Promise<Array<T & { id: string }>>;
    setById: (id: string, doc: T) => Promise<unknown>;
  }>;
};

// -- Constants --

const ORACLE_ABI = [
  "function updateDataFeedsValuesPartial(bytes32[]) public",
  "function getLastUpdateDetails(bytes32) public view returns (uint256, uint256, uint256)",
  "function getLivePricesAndTimestamp(bytes32[]) public view returns (uint256[], uint256)",
];

const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) public payable returns ((bool success, bytes returnData)[] returnData)",
];

// -- Custom ethers provider that routes RPC calls through context.fetch() --
// The task process has no --allow-net, so ethers can't make direct HTTP calls.
class ComposeFetchProvider extends providers.JsonRpcProvider {
  private contextFetch: TaskContext["fetch"];
  private _networkPromise: Promise<any> | null = null;

  constructor(url: string, contextFetch: TaskContext["fetch"]) {
    super(url);
    this.contextFetch = contextFetch;
  }

  async send(method: string, params: any[]): Promise<any> {
    const result = await this.contextFetch<{
      jsonrpc: string;
      id: number;
      result?: any;
      error?: { code: number; message: string };
    }>(this.connection.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

    if (!result) throw new Error(`RPC call ${method} returned undefined`);
    if (result.error) throw new Error(result.error.message);
    return result.result;
  }

  async detectNetwork(): Promise<any> {
    if (!this._networkPromise) {
      this._networkPromise = this.send("eth_chainId", []).then((chainIdHex: string) => {
        const chainId = parseInt(chainIdHex, 16);
        return { name: "lisk", chainId };
      });
    }
    return this._networkPromise;
  }
}

// -- Redstone gateway URLs (same as SDK defaults) --
const REDSTONE_GATEWAY_URLS = [
  "https://oracle-gateway-1.a.redstone.vip",
  "https://oracle-gateway-1.a.redstone.finance",
  "https://oracle-gateway-2.a.redstone.finance",
];

/**
 * Fetch Redstone data packages via context.fetch() (IPC to host process).
 * Bypasses the SDK's internal axios calls which fail due to no --allow-net.
 */
async function fetchDataPackages(
  contextFetch: TaskContext["fetch"],
  dataServiceId: string,
  dataPackagesIds: string[],
  authorizedSigners: string[],
  uniqueSignersCount: number,
): Promise<Record<string, SignedDataPackage[]>> {
  let rawResponse: Record<string, any[]> | undefined;
  const errors: string[] = [];

  for (const baseUrl of REDSTONE_GATEWAY_URLS) {
    const url = `${baseUrl}/v2/data-packages/latest/${dataServiceId}`;
    try {
      const resp = await contextFetch<Record<string, any[]>>(url);
      if (resp) {
        rawResponse = resp;
        break;
      }
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!rawResponse) {
    throw new Error(`All Redstone gateways failed: ${errors.join("; ")}`);
  }

  // Filter and convert to SignedDataPackage instances
  const result: Record<string, SignedDataPackage[]> = {};
  const authorizedSet = new Set(authorizedSigners.map((s) => s.toLowerCase()));

  for (const feedId of dataPackagesIds) {
    const packages = rawResponse[feedId];
    if (!packages || !Array.length) {
      result[feedId] = [];
      continue;
    }

    // Filter to authorized signers only
    const authorized = packages.filter(
      (p: any) => p.signerAddress && authorizedSet.has(p.signerAddress.toLowerCase()),
    );

    // Convert to SignedDataPackage class instances and take uniqueSignersCount
    result[feedId] = authorized
      .slice(0, uniqueSignersCount)
      .map((p: any) => SignedDataPackage.fromObj(p));
  }

  return result;
}

// -- Helpers --

/**
 * Convert a symbol string to its bytes32 representation.
 * Handles the special "wstETH/ETH" case and standard symbols.
 */
function symbolToBytes32(symbol: string): string {
  // formatBytes32String works for symbols <= 31 bytes
  return formatBytes32String(symbol);
}

/**
 * Calculate the percentage deviation between two prices.
 * Returns the absolute deviation as a percentage.
 */
function calculateDeviation(
  livePrice: BigNumber,
  storedPrice: BigNumber,
): number {
  if (storedPrice.isZero()) return 100; // treat zero stored price as 100% deviation (always update)
  const diff = livePrice.sub(storedPrice).abs();
  // Use high precision: multiply by 10000 then divide to get percentage with 2 decimal places
  const deviationBps = diff.mul(10000).div(storedPrice);
  return deviationBps.toNumber() / 100;
}

/**
 * Parse Redstone payload from calldata to extract live prices.
 * The Redstone payload is appended to the end of the calldata.
 */
function extractLivePricesFromPayload(
  calldataHex: string,
  symbols: string[],
): Map<string, BigNumber> {
  const prices = new Map<string, BigNumber>();

  try {
    // The Redstone payload is appended after the standard ABI-encoded calldata.
    // RedstonePayload.parse extracts signed data packages from the raw bytes.
    const calldataBytes = arrayify(calldataHex);
    const redstonePayload = RedstonePayload.parse(calldataBytes);

    // Extract prices from signed data packages
    for (const signedPackage of redstonePayload.signedDataPackages) {
      const dataPackage = signedPackage.dataPackage;
      for (const dataPoint of dataPackage.dataPoints) {
        const feedId = dataPoint.dataFeedId;
        // Try to match feed ID to our symbols
        for (const symbol of symbols) {
          const symbolBytes32 = symbolToBytes32(symbol);
          // Compare feed IDs - Redstone uses the same bytes32 encoding
          const feedIdHex =
            "0x" +
            Array.from(
              typeof feedId === "string" ? new TextEncoder().encode(feedId) : feedId,
            )
              .map((b: number) => b.toString(16).padStart(2, "0"))
              .join("")
              .padEnd(64, "0");

          if (feedIdHex.toLowerCase() === symbolBytes32.toLowerCase()) {
            // dataPoint.toObj().value is base64-encoded 32-byte big-endian uint
            const objValue = dataPoint.toObj().value;
            let value: BigNumber;
            if (typeof objValue === "number" || typeof objValue === "bigint") {
              value = BigNumber.from(objValue);
            } else if (typeof objValue === "string") {
              // base64 → bytes → BigNumber
              const bytes = Uint8Array.from(atob(objValue), (c) => c.charCodeAt(0));
              value = BigNumber.from(bytes);
            } else {
              value = BigNumber.from(objValue);
            }
            prices.set(symbol, value);
            break;
          }
        }
      }
    }
  } catch (err) {
    // If RedstonePayload.parse fails, fall back to simpler extraction
    console.error("Failed to parse Redstone payload:", err);
  }

  return prices;
}

// -- Main Task Handler --

export async function main(
  context: TaskContext,
  _params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { env, evm, logEvent, collection } = context;

  // ---------------------------------------------------------------
  // Step A: Setup
  // ---------------------------------------------------------------

  const oracleAddress = env.ORACLE_ADDRESS;
  const multicall3Address = env.MULTICALL3_ADDRESS;
  const symbolsCsv = env.SYMBOLS;
  const dataServiceId = env.DATA_SERVICE_ID;
  const uniqueSignersCount = parseInt(env.UNIQUE_SIGNERS_COUNT, 10);
  const minDeviationPercent = parseFloat(env.MIN_DEVIATION_PERCENT);
  const minTimeElapsedHours = parseFloat(env.MIN_TIME_ELAPSED_HOURS);
  const chainName = env.CHAIN;
  const rpcUrl = env.LISK_RPC_URL;

  const symbols = symbolsCsv.split(",").map((s) => s.trim());
  const symbolsBytes32 = symbols.map(symbolToBytes32);

  const minTimeElapsedSeconds = minTimeElapsedHours * 3600;

  await logEvent({
    code: "keeper.check_started",
    message: `Price feed check started for ${symbols.length} feeds`,
    data: JSON.stringify({
      symbols,
      oracleAddress,
      chainName,
      minDeviationPercent,
      minTimeElapsedHours,
      timestamp: Date.now(),
    }),
  });

  // Custom provider that routes RPC calls through context.fetch() (IPC to host)
  // since the task process has no --allow-net permission.
  const provider = new ComposeFetchProvider(rpcUrl, context.fetch);

  // Create oracle contract instance (ethers v5 -- needed for WrapperBuilder)
  const oracle = new Contract(oracleAddress, ORACLE_ABI, provider);

  // Create Compose wallet from private key
  const chain = evm.chains[chainName];
  if (!chain) {
    await logEvent({
      code: "keeper.error",
      message: `Chain "${chainName}" not found in evm.chains`,
      data: JSON.stringify({ availableChains: Object.keys(evm.chains) }),
    });
    throw new Error(`Chain "${chainName}" not found in evm.chains`);
  }

  const wallet = await evm.wallet({
    name: "lisk-keeper",
  });

  await logEvent({
    code: "keeper.wallet_ready",
    message: `Keeper wallet ready: ${wallet.address}`,
    data: JSON.stringify({ address: wallet.address }),
  });

  // ---------------------------------------------------------------
  // Step B: Fetch live prices from Redstone
  // ---------------------------------------------------------------

  let livePrices: Map<string, BigNumber>;

  try {
    // Get authorized signers for the data service
    const authorizedSigners = getSignersForDataServiceId(dataServiceId as "redstone-primary-prod");

    // Fetch data packages via context.fetch() (bypasses SDK's axios calls
    // which fail in the sandboxed task process with no --allow-net)
    const dataPackages = await fetchDataPackages(
      context.fetch,
      dataServiceId,
      symbols,
      authorizedSigners,
      uniqueSignersCount,
    );

    // Wrap the oracle contract with pre-fetched data packages
    const wrappedOracle = WrapperBuilder.wrap(oracle).usingDataPackages(dataPackages);

    // Populate a transaction to get calldata with Redstone payload attached
    const tx = await wrappedOracle.populateTransaction.getLivePricesAndTimestamp(
      symbolsBytes32,
    );

    if (!tx.data) {
      throw new Error("populateTransaction returned no calldata");
    }

    // Parse the Redstone payload from the calldata to extract live prices
    livePrices = extractLivePricesFromPayload(tx.data, symbols);

    // If direct parsing didn't get all prices, try calling the wrapped contract
    if (livePrices.size < symbols.length) {
      try {
        const result = await wrappedOracle.callStatic.getLivePricesAndTimestamp(
          symbolsBytes32,
        );
        const pricesArray: BigNumber[] = result[0];
        for (let i = 0; i < symbols.length; i++) {
          if (!livePrices.has(symbols[i])) {
            livePrices.set(symbols[i], pricesArray[i]);
          }
        }
      } catch (callErr) {
        console.error("callStatic.getLivePricesAndTimestamp failed:", callErr);
        // Continue with whatever prices we have from payload parsing
      }
    }

    await logEvent({
      code: "keeper.live_prices_fetched",
      message: `Fetched live prices for ${livePrices.size}/${symbols.length} feeds`,
      data: JSON.stringify({
        prices: Object.fromEntries(
          Array.from(livePrices.entries()).map(([k, v]) => [k, v.toString()]),
        ),
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logEvent({
      code: "keeper.redstone_error",
      message: `Failed to fetch live prices from Redstone: ${message}`,
      data: JSON.stringify({ error: message }),
    });
    throw new Error(`Redstone price fetch failed: ${message}`);
  }

  // ---------------------------------------------------------------
  // Step C: Fetch stored prices via Multicall3
  // ---------------------------------------------------------------

  const storedPrices = new Map<string, { price: BigNumber; timestamp: number }>();

  try {
    const multicall3 = new Contract(multicall3Address, MULTICALL3_ABI, provider);

    // Build batch of getLastUpdateDetails(bytes32) calls
    const oracleIface = new Contract(oracleAddress, ORACLE_ABI, provider).interface;

    const calls = symbolsBytes32.map((symbolBytes32) => ({
      target: oracleAddress,
      allowFailure: true,
      callData: oracleIface.encodeFunctionData("getLastUpdateDetails", [
        symbolBytes32,
      ]),
    }));

    const results = await multicall3.callStatic.aggregate3(calls);

    for (let i = 0; i < symbols.length; i++) {
      const result = results[i];
      if (result.success) {
        // Decode: returns (uint256 price, uint256 timestamp, uint256 blockNumber)
        const decoded = defaultAbiCoder.decode(
          ["uint256", "uint256", "uint256"],
          result.returnData,
        );
        storedPrices.set(symbols[i], {
          price: decoded[0] as BigNumber,
          timestamp: (decoded[1] as BigNumber).toNumber(),
        });
      } else {
        await logEvent({
          code: "keeper.stored_price_error",
          message: `Failed to read stored price for ${symbols[i]}`,
          data: JSON.stringify({ symbol: symbols[i], index: i }),
        });
        // Set a zero price and zero timestamp so it triggers an update
        storedPrices.set(symbols[i], {
          price: BigNumber.from(0),
          timestamp: 0,
        });
      }
    }

    await logEvent({
      code: "keeper.stored_prices_fetched",
      message: `Fetched stored prices for ${storedPrices.size} feeds`,
      data: JSON.stringify({
        prices: Object.fromEntries(
          Array.from(storedPrices.entries()).map(([k, v]) => [
            k,
            { price: v.price.toString(), timestamp: v.timestamp },
          ]),
        ),
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logEvent({
      code: "keeper.multicall_error",
      message: `Failed to fetch stored prices via Multicall3: ${message}`,
      data: JSON.stringify({ error: message }),
    });
    throw new Error(`Multicall3 stored price fetch failed: ${message}`);
  }

  // ---------------------------------------------------------------
  // Step D: Compare and decide which feeds need updating
  // ---------------------------------------------------------------

  const feedsToUpdate: string[] = [];
  const feedsToUpdateBytes32: string[] = [];
  const comparisons: Array<{
    symbol: string;
    livePrice: string;
    storedPrice: string;
    deviationPercent: number;
    timeElapsedSeconds: number;
    needsUpdate: boolean;
    reason: string;
  }> = [];

  const nowSeconds = Math.floor(Date.now() / 1000);

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const livePrice = livePrices.get(symbol);
    const stored = storedPrices.get(symbol);

    if (!livePrice) {
      comparisons.push({
        symbol,
        livePrice: "N/A",
        storedPrice: stored?.price.toString() ?? "N/A",
        deviationPercent: 0,
        timeElapsedSeconds: 0,
        needsUpdate: false,
        reason: "no live price available",
      });
      continue;
    }

    if (!stored) {
      comparisons.push({
        symbol,
        livePrice: livePrice.toString(),
        storedPrice: "N/A",
        deviationPercent: 100,
        timeElapsedSeconds: 0,
        needsUpdate: true,
        reason: "no stored price",
      });
      feedsToUpdate.push(symbol);
      feedsToUpdateBytes32.push(symbolsBytes32[i]);
      continue;
    }

    const deviation = calculateDeviation(livePrice, stored.price);
    const timeElapsed = nowSeconds - stored.timestamp;

    const deviationTriggered = deviation >= minDeviationPercent;
    const stalenessTriggered = timeElapsed >= minTimeElapsedSeconds;
    const needsUpdate = deviationTriggered || stalenessTriggered;

    const reasons: string[] = [];
    if (deviationTriggered) reasons.push(`deviation ${deviation.toFixed(2)}% >= ${minDeviationPercent}%`);
    if (stalenessTriggered)
      reasons.push(
        `stale ${(timeElapsed / 3600).toFixed(2)}h >= ${minTimeElapsedHours}h`,
      );
    if (!needsUpdate) reasons.push("within thresholds");

    comparisons.push({
      symbol,
      livePrice: livePrice.toString(),
      storedPrice: stored.price.toString(),
      deviationPercent: deviation,
      timeElapsedSeconds: timeElapsed,
      needsUpdate,
      reason: reasons.join("; "),
    });

    if (needsUpdate) {
      feedsToUpdate.push(symbol);
      feedsToUpdateBytes32.push(symbolsBytes32[i]);
    }
  }

  await logEvent({
    code: "keeper.comparison_complete",
    message: `Compared ${symbols.length} feeds, ${feedsToUpdate.length} need updates`,
    data: JSON.stringify({ comparisons }),
  });

  // ---------------------------------------------------------------
  // Step E: Update if needed
  // ---------------------------------------------------------------

  if (feedsToUpdate.length === 0) {
    await logEvent({
      code: "keeper.no_update_needed",
      message: "All feeds within thresholds, no update needed",
      data: JSON.stringify({ timestamp: Date.now() }),
    });

    return {
      status: "no_update",
      feedsChecked: symbols.length,
      feedsUpdated: 0,
      comparisons,
    };
  }

  // Build the update transaction with fresh Redstone payload
  try {
    const authorizedSigners = getSignersForDataServiceId(dataServiceId as "redstone-primary-prod");

    // Fetch fresh data packages for the feeds that need updating
    const updateDataPackages = await fetchDataPackages(
      context.fetch,
      dataServiceId,
      feedsToUpdate,
      authorizedSigners,
      uniqueSignersCount,
    );

    const wrappedOracle = WrapperBuilder.wrap(oracle).usingDataPackages(updateDataPackages);

    // Get calldata with Redstone-signed payload for the feeds that need updating
    const updateTx =
      await wrappedOracle.populateTransaction.updateDataFeedsValuesPartial(
        feedsToUpdateBytes32,
      );

    await logEvent({
      code: "keeper.sending_update",
      message: `Sending update for ${feedsToUpdate.length} feeds: ${feedsToUpdate.join(", ")}`,
      data: JSON.stringify({
        feeds: feedsToUpdate,
        calldataLength: updateTx.data?.length ?? 0,
      }),
    });

    // Send the raw calldata transaction via Compose wallet
    const result = await wallet.sendTransaction({
      to: oracleAddress as `0x${string}`,
      data: updateTx.data as `0x${string}`,
      chain,
    });

    await logEvent({
      code: "keeper.update_sent",
      message: `Update transaction sent successfully`,
      data: JSON.stringify({
        txHash: result.hash,
        feeds: feedsToUpdate,
        feedCount: feedsToUpdate.length,
      }),
    });

    // Store result in a collection for history/observability
    try {
      const history = await collection<{
        timestamp: number;
        feedsUpdated: string[];
        txHash: string;
        feedCount: number;
        comparisons: typeof comparisons;
      }>("update_history");

      await history.insertOne({
        timestamp: Date.now(),
        feedsUpdated: feedsToUpdate,
        txHash: result.hash,
        feedCount: feedsToUpdate.length,
        comparisons,
      });
    } catch (colErr) {
      // Non-critical: log but don't fail the task
      const message = colErr instanceof Error ? colErr.message : String(colErr);
      await logEvent({
        code: "keeper.collection_error",
        message: `Failed to save update history: ${message}`,
        data: JSON.stringify({ error: message }),
      });
    }

    return {
      status: "updated",
      feedsChecked: symbols.length,
      feedsUpdated: feedsToUpdate.length,
      feeds: feedsToUpdate,
      txHash: result.hash,
      comparisons,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logEvent({
      code: "keeper.update_error",
      message: `Failed to send update transaction: ${message}`,
      data: JSON.stringify({
        error: message,
        feeds: feedsToUpdate,
      }),
    });
    throw new Error(`Update transaction failed: ${message}`);
  }
}
