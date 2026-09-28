import { CdpEvmWalletProvider } from "@coinbase/agentkit";
import { getLangChainTools } from "@coinbase/agentkit-langchain";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import * as dotenv from "dotenv";
import { readFileSync } from "fs";
import { createAgent } from "langchain";
import * as readline from "readline";
import { createAgentKitWithSato } from "./sato";

dotenv.config();

const REQUIRED = ["OPENAI_API_KEY", "CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"];

/**
 * Validates that required environment variables are set
 */
function validateEnvironment(): void {
  const missing = REQUIRED.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error("Error: Required environment variables are not set");
    missing.forEach(v => console.error(`${v}=your_${v.toLowerCase()}_here`));
    process.exit(1);
  }
}

validateEnvironment();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (prompt: string): Promise<string> => new Promise(resolve => rl.question(prompt, resolve));

/**
 * Asks the person at the terminal. Only an explicit "y" approves.
 *
 * @param summary - what is about to be signed or executed
 * @returns true only when the person typed y
 */
async function approve(summary: string): Promise<boolean> {
  console.log("\n--- Approval needed ---\n" + summary);
  return (await question("Approve? [y/N] ")).trim().toLowerCase() === "y";
}

/**
 * Initialize the agent with AgentKit and the Sato Kit tools
 *
 * @returns Agent and config
 */
async function initializeAgent() {
  const networkId = process.env.NETWORK_ID || "base-sepolia";
  const walletProvider = await CdpEvmWalletProvider.configureWithWallet({
    apiKeyId: process.env.CDP_API_KEY_ID,
    apiKeySecret: process.env.CDP_API_KEY_SECRET,
    walletSecret: process.env.CDP_WALLET_SECRET,
    idempotencyKey: process.env.IDEMPOTENCY_KEY,
    address: process.env.ADDRESS as `0x${string}` | undefined,
    networkId,
    rpcUrl: process.env.RPC_URL,
  });

  const agentkit = await createAgentKitWithSato({
    walletProvider,
    policy: JSON.parse(readFileSync("./policy.json", "utf8")),
    rpcUrl: chain =>
      process.env[`SATO_RPC_URL_${chain.toUpperCase().replace(/-/g, "_")}`] ??
      (chain === networkId ? process.env.RPC_URL : undefined),
    approve,
  });

  const tools = await getLangChainTools(agentkit);
  const agent = createAgent({
    model: new ChatOpenAI({ model: "gpt-4o-mini" }),
    tools,
    checkpointer: new MemorySaver(),
    systemPrompt: `
      You are an onchain agent using AgentKit with the Sato Kit tools. For any action that moves funds,
      call the prepare tool first, show the person the intent summary, the policy pre-flight result,
      the simulation and the fee disclosure exactly as returned, and call execute only with that
      intent_id after they approve. If the pre-flight refuses, report each rule, limit and observed
      value and stop; never retry with changed numbers to get around a rule. A USD value marked
      unknown stays unknown. Be concise.
      `,
  });
  return { agent, config: { configurable: { thread_id: "AgentKit + Sato Kit chatbot" } } };
}

/**
 * Run the agent interactively
 *
 * @param agent - The agent
 * @param config - Agent configuration
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runChatMode(agent: any, config: any) {
  console.log("Starting chat mode... Type 'exit' to end.");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const userInput = await question("\nPrompt: ");
    if (userInput.toLowerCase() === "exit") break;
    const stream = await agent.stream({ messages: [new HumanMessage(userInput)] }, config);
    for await (const chunk of stream) {
      if ("model_request" in chunk) {
        const response = chunk.model_request.messages[0].content;
        if (response !== "") console.log("\n Response: " + response);
      }
      if ("tools" in chunk) {
        for (const tool of chunk.tools.messages) console.log("Tool " + tool.name + ": " + tool.content);
      }
    }
    console.log("-------------------");
  }
  rl.close();
}

/**
 * Start the chatbot. There is no autonomous mode: every signature needs a person.
 */
async function main() {
  const { agent, config } = await initializeAgent();
  await runChatMode(agent, config);
}

console.log("Starting Agent...");
main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
