// CLI builder owns this file. Stub from the M1 skeleton.
// runCli(argv, io) → exit code: 0 ok, 2 refused by policy, 1 error.
// Commands: read | prepare | execute --intent <id> | mcp [--toolsets] | doctor; all take --json.
// Build the kit with loadKitFromEnv (src/config) and the tools with toolDefinitions (src/surface).
export type CliIo = {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  isTTY: boolean;
};

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_REFUSED = 2;

export async function runCli(_argv: readonly string[], _io: CliIo): Promise<number> {
  throw new Error("not implemented: runCli");
}
