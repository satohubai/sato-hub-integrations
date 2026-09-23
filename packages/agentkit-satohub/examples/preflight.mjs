// npm install agentkit-satohub @coinbase/agentkit && node preflight.mjs
// No API key, no CDP account: the wallet is a throwaway key the actions never use.
import { AgentKit, ViemWalletProvider } from "@coinbase/agentkit";
import { satohubActionProvider } from "agentkit-satohub";
import { createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const walletProvider = new ViemWalletProvider(
  createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: base, transport: http() }),
);
const agentkit = await AgentKit.from({ walletProvider, actionProviders: [satohubActionProvider({ userAgent: "my-agent/1.0" })] });
const preflight = agentkit.getActions().find((a) => a.name === "SatohubActionProvider_preflight");
console.log(await preflight.invoke({ targetType: "repo", target: process.argv[2] ?? "coinbase/agentkit", chain: null }));
