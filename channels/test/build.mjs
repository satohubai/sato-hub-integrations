// Compiles the typechecked channel files into .test-build/ and adds the ".js"
// suffix to their relative imports, so node --test can load them. The sources
// keep extensionless imports because their real homes (Next.js, Wrangler, tsx)
// resolve them that way.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".test-build");
rmSync(out, { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.json")], { stdio: "inherit" });

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js")) {
      const src = readFileSync(p, "utf8");
      const fixed = src.replace(/(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (m, a, spec, b) =>
        !spec.endsWith(".js") && existsSync(join(dirname(p), spec + ".js")) ? `${a}${spec}.js${b}` : m,
      );
      if (fixed !== src) writeFileSync(p, fixed);
    }
  }
}
walk(out);
