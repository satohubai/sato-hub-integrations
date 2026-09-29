/** The kit version. Keep in step with package.json. */
export const KIT_VERSION = "0.1.0" as const;
/** User-Agent on every request the kit makes. Registered as an external package UA; never change the shape. */
export const KIT_USER_AGENT = `@satohub/kit/${KIT_VERSION}` as const;
/**
 * The User-Agent the kit actually sends: `SATO_USER_AGENT` verbatim when set
 * (for Sato Hub's own CI runs, so they are not counted as outside use), else
 * KIT_USER_AGENT. For testing; leave unset.
 */
export function kitUserAgent(env: Record<string, string | undefined> | undefined =
  typeof process !== "undefined" ? process.env : undefined): string {
  const v = env?.SATO_USER_AGENT;
  return v && v.trim() ? v : KIT_USER_AGENT;
}
