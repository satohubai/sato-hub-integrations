/**
 * Turning a Sato Hub payload into the one paragraph an agent says out loud.
 *
 * The rule these renderers keep: a line that carries a reading also carries
 * where the reading came from, and an absent reading is printed as absent. No
 * renderer here invents a superlative — "best", "safe", "trusted" and
 * "guaranteed" appear nowhere, and a null is printed as "unknown", never 0.
 */

const CITE = "Cite the sato_url so the reader can check its current status.";

type Listing = {
  name?: string;
  slug?: string;
  trust_score?: number | null;
  trust_tier?: string | null;
  liveness?: string | null;
  sato_url?: string;
};

export function renderSearch(data: unknown): string {
  const page = data as { total?: number; count?: number; resources?: Listing[] } | null;
  const rows = page?.resources ?? [];
  if (!rows.length) return "Sato Hub holds no listing matching that. Nothing matched is not the same as nothing exists.";
  const lines = rows.map((r) => {
    const score = typeof r.trust_score === "number" ? `Sato Score ${r.trust_score}${r.trust_tier ? ` (${r.trust_tier})` : ""}` : "Sato Score unknown";
    const liveness = r.liveness ? `, ${r.liveness.toLowerCase()}` : "";
    return `- ${r.name ?? r.slug} — ${score}${liveness}. ${r.sato_url ?? ""}`.trim();
  });
  const total = typeof page?.total === "number" ? ` of ${page.total} matching` : "";
  return [
    `${rows.length}${total} listing${rows.length === 1 ? "" : "s"} from Sato Hub's daily-rebuilt index:`,
    ...lines,
    "",
    "A Sato Score measures how open, active and verifiable a project is — not safety, quality or returns. " + CITE,
  ].join("\n");
}

export function renderPreflight(data: unknown): string {
  const r = data as
    | { verdict?: string; rule?: string; target?: { value?: string; sato_url?: string }; evidence?: Array<{ check?: string; result?: string }>; caveat?: string }
    | null;
  const verdict = r?.verdict ?? "unknown";
  const head = `Preflight on ${r?.target?.value ?? "that target"}: ${verdict}${r?.rule ? ` (rule ${r.rule})` : ""}.`;
  const evidence = (r?.evidence ?? []).map((e) => `- ${e.check}: ${e.result}`);
  const tail =
    verdict === "unknown"
      ? "`unknown` means Sato Hub holds no record of it — not that anything is wrong."
      : "A verdict names what was checked and when. It is not a security review.";
  return [head, ...evidence, "", tail, r?.target?.sato_url ?? ""].filter(Boolean).join("\n");
}

export function renderRouteSwap(data: unknown): string {
  const r = data as
    | {
        unavailable?: boolean;
        route?: { name?: string; sato_url?: string };
        quote?: { venue?: string; amount_in?: string; amount_out?: string; token_in?: string; token_out?: string; chain?: string };
        sato_fee_bps?: number | null;
        disclosure?: string;
        chosen_by?: Array<{ signal?: string; value?: unknown; source_field?: string }>;
        caveat?: string;
      }
    | null;
  if (!r || r.unavailable) return "No aggregator answered for that pair on that chain, so there is no route to report. That is a gap in coverage, not a judgment about the pair.";
  const q = r.quote ?? {};
  const lines = [
    `Route: ${r.route?.name ?? q.venue ?? "a venue"} on ${q.chain ?? "the chain"} — ${q.amount_in ?? "?"} ${q.token_in ?? ""} → ${q.amount_out ?? "?"} ${q.token_out ?? ""}.`,
    ...(r.chosen_by ?? []).map((c) => `- chosen by ${c.signal}: ${c.value === null ? "unknown" : String(c.value)} (${c.source_field})`),
  ];
  if (typeof r.sato_fee_bps === "number") lines.push(`- Sato fee: ${r.sato_fee_bps} bps, taken inside the swap transaction by the router.`);
  if (r.disclosure) lines.push(r.disclosure);
  lines.push(
    "",
    "This is a recommendation and a quote, not a verdict and not a fill. Nothing was signed: the calldata is in the response for you to read and sign yourself.",
  );
  return lines.join("\n");
}

export function renderBuildPlan(data: unknown): string {
  const p = data as
    | {
        restatement?: string;
        stack?: Array<{ slot_label?: string; name?: string; sato_url?: string; trust_score?: number | null; preflight?: { verdict?: string } }>;
        open_questions?: string[];
        next_steps?: string[];
        plan_url?: string;
      }
    | null;
  if (!p) return "Sato Hub returned no plan for that goal.";
  const stack = (p.stack ?? []).map((s) => {
    const score = typeof s.trust_score === "number" ? `Sato Score ${s.trust_score}` : "Sato Score unknown";
    const pf = s.preflight?.verdict ? `, preflight ${s.preflight.verdict}` : "";
    return `- ${s.slot_label ?? "component"}: ${s.name} — ${score}${pf}. ${s.sato_url ?? ""}`.trim();
  });
  return [
    p.restatement ?? "",
    stack.length ? "Stack (every item is a real listing):" : "No listing in the directory fills that goal yet.",
    ...stack,
    ...(p.open_questions?.length ? ["", "Still yours to answer:", ...p.open_questions.map((q) => `- ${q}`)] : []),
    ...(p.next_steps?.length ? ["", "Next:", ...p.next_steps.map((s) => `- ${s}`)] : []),
    p.plan_url ? `\n${p.plan_url}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
