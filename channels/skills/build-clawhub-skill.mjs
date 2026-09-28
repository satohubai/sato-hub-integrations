// Builds channels/skills/clawhub/sato-kit/SKILL.md from packages/kit/skill/SKILL.md.
// ClawHub rejects a SKILL.md with a `license:` line and needs a top-level `version:`;
// skills.sh and the other hosts read the kit's own file unchanged. The body is copied
// byte for byte, so there is one skill text, not two.
//   node channels/skills/build-clawhub-skill.mjs          write the file
//   node channels/skills/build-clawhub-skill.mjs --check  exit 1 if it is stale
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SOURCE = join(here, "..", "..", "packages", "kit", "skill", "SKILL.md");
export const TARGET = join(here, "clawhub", "sato-kit", "SKILL.md");

export function toClawhub(src) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(src);
  if (!m) throw new Error("SKILL.md has no frontmatter");
  const lines = m[1].split("\n");
  const ver = /^\s+version:\s*"?([0-9]+\.[0-9]+\.[0-9]+)"?\s*$/m.exec(m[1]);
  if (!ver) throw new Error("SKILL.md has no metadata.version");
  const out = [];
  for (const l of lines) {
    if (/^license:/.test(l)) continue;
    out.push(l);
    if (/^description:/.test(l)) out.push(`version: ${ver[1]}`);
  }
  return `---\n${out.join("\n")}\n---\n${src.slice(m[0].length)}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const want = toClawhub(readFileSync(SOURCE, "utf8"));
  if (process.argv.includes("--check")) {
    let have = "";
    try { have = readFileSync(TARGET, "utf8"); } catch {}
    if (have !== want) { console.error(`${TARGET} is stale; run node channels/skills/build-clawhub-skill.mjs`); process.exit(1); }
  } else {
    mkdirSync(dirname(TARGET), { recursive: true });
    writeFileSync(TARGET, want);
  }
}
