// A Cloudflare Agent that pays for x402 resources only inside a budget.
//
// Same shape as the Agents SDK x402 example (cloudflare/agents, examples/x402):
// a Hono Worker, an Agent with a @callable method, @x402/fetch for payment.
// The difference is the gate: before the agent signs anything, the Sato Kit
// pre-flight checks the payment against src/policy.json, and the x402 client
// is limited to the one requirement that pre-flight approved.
import { Hono } from "hono";
import { Agent, callable, routeAgentRequest } from "agents";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import policy from "./policy.json";
import { buildX402Kit, onlyApprovedRequirement, preflightPayment } from "./guard";

type Env = { PAY_AGENT: DurableObjectNamespace; CLIENT_TEST_PK?: string };

export class PayAgent extends Agent<Env> {
  @callable()
  async fetchPaid(url: string, maxAmountBaseUnits: string) {
    const kit = buildX402Kit({ policy });
    const pre = await preflightPayment(kit, { url, maxAmountBaseUnits });
    if (!pre.ok) {
      // Nothing was signed. Each refusal names its rule, limit and observed value.
      return { paid: false, error: pre.error, refusals: pre.refusals };
    }

    const pk = this.env.CLIENT_TEST_PK;
    if (!pk) return { paid: false, error: "CLIENT_TEST_PK is not set (use a test key on Base Sepolia only)", intent: pre.intent };

    const client = new x402Client();
    registerExactEvmScheme(client, { signer: toClientEvmSigner(privateKeyToAccount(pk as `0x${string}`)) });
    client.registerPolicy(onlyApprovedRequirement(pre.approved));
    const fetchWithPay = wrapFetchWithPayment(fetch, client);

    const res = await fetchWithPay(url, {});
    return { paid: res.ok, status: res.status, summary: pre.intent.summary, body: await res.text() };
  }
}

const app = new Hono<{ Bindings: Env }>();

app.all("/agents/*", async (c) => {
  const res = await routeAgentRequest(c.req.raw, c.env);
  return res || c.json({ error: "Not found" }, 404);
});

export default app;
