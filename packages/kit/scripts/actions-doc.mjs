// Pure renderer for the README action reference. No I/O: the caller passes the
// registered actions and the tool surface, so the generator and the drift test
// render from the same inputs and cannot disagree.
export const BEGIN = "<!-- BEGIN GENERATED: actions (scripts/gen-actions-doc.mjs) -->";
export const END = "<!-- END GENERATED: actions -->";

const esc = (s) => String(s).replace(/\|/g, "\\|");

function custody(c) {
  return `reads key: ${c.reads_key ? "yes" : "no"}; key leaves: ${c.sends_key ? "yes" : "no"}; moves funds: ${c.moves_funds}`;
}

/**
 * @param {{ actions: readonly any[], defaultDefs: readonly any[], allDefs: readonly any[] }} input
 * @returns {string} the block between the markers (markers included)
 */
export function renderActionsDoc({ actions, defaultDefs, allDefs }) {
  const inDefault = new Set(defaultDefs.map((d) => d.name));
  const lines = [BEGIN, "", "### Registered actions", ""];
  lines.push("| action id | tool name | kind | effects | custody | chains | toolset |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  const byName = new Map(allDefs.map((d) => [d.name, d]));
  for (const a of actions) {
    const d = a.descriptor;
    const def = byName.get(d.name);
    lines.push(
      `| \`${esc(d.id)}\` | \`${esc(d.name)}\` | ${def ? def.kind : "?"} | ${d.effects.map((e) => `\`${e}\``).join(", ")} | ${esc(custody(d.custody))} | ${d.chains.join(", ")} | ${inDefault.has(d.name) ? "default, all" : "all"} |`,
    );
  }
  lines.push("", "### Meta tools", "");
  lines.push("| tool name | kind | effects | toolset |");
  lines.push("| --- | --- | --- | --- |");
  for (const def of allDefs.filter((x) => x.oda_id === null)) {
    lines.push(`| \`${def.name}\` | ${def.kind} | ${def._meta["sato/effects"].map((e) => `\`${e}\``).join(", ")} | ${inDefault.has(def.name) ? "default, all" : "all"} |`);
  }
  lines.push("", `Default MCP profile, in order: ${defaultDefs.map((d) => `\`${d.name}\``).join(", ")}.`, "", END);
  return lines.join("\n");
}

/** Replaces the marked block in `readme`; throws when the markers are missing. */
export function spliceReadme(readme, block) {
  const i = readme.indexOf(BEGIN);
  const j = readme.indexOf(END);
  if (i < 0 || j < i) throw new Error("README is missing the generated-actions markers");
  return readme.slice(0, i) + block + readme.slice(j + END.length);
}
