/** The kit version. Keep in step with package.json. */
export const KIT_VERSION = "0.1.1" as const;
/** User-Agent on every request the kit makes. Registered as an external package UA; never change the shape. */
export const KIT_USER_AGENT = `@satohub/kit/${KIT_VERSION}` as const;
