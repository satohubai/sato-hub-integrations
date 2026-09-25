// Read-only market data from Base: block, gas price and the Chainlink ETH/USD
// feed. Public RPC, no key. Nothing here writes to the chain.

import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { base } from "viem/chains";

// Chainlink ETH / USD on Base mainnet (description() reads "ETH / USD").
// https://docs.chain.link/data-feeds/price-feeds/addresses?network=base
const ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" as const;
const FEED_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export type MarketSnapshot = {
  chain_id: number;
  block: string;
  gas_price_gwei: string;
  eth_usd: number;
  eth_usd_feed: string;
  eth_usd_updated_at: string;
  eth_usd_age_s: number;
  rpc: string;
};

export async function readMarket(rpcUrl: string): Promise<MarketSnapshot> {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 20_000 }) });
  const [chainId, block, gasPrice, decimals, description, round] = await Promise.all([
    client.getChainId(),
    client.getBlockNumber(),
    client.getGasPrice(),
    client.readContract({ address: ETH_USD_FEED, abi: FEED_ABI, functionName: "decimals" }),
    client.readContract({ address: ETH_USD_FEED, abi: FEED_ABI, functionName: "description" }),
    client.readContract({ address: ETH_USD_FEED, abi: FEED_ABI, functionName: "latestRoundData" }),
  ]);
  const updatedAt = Number(round[3]);
  return {
    chain_id: chainId,
    block: block.toString(),
    gas_price_gwei: formatUnits(gasPrice, 9),
    eth_usd: Number(formatUnits(round[1], decimals)),
    eth_usd_feed: `${description} (${ETH_USD_FEED})`,
    eth_usd_updated_at: new Date(updatedAt * 1000).toISOString(),
    eth_usd_age_s: Math.round(Date.now() / 1000 - updatedAt),
    rpc: new URL(rpcUrl).host,
  };
}
