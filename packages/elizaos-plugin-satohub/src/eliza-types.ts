/**
 * The slice of the elizaOS plugin contract this package uses, declared
 * structurally rather than imported.
 *
 * WHY NOT IMPORT `@elizaos/core`. A plugin that hard-depends on the runtime it
 * plugs into cannot be installed to look at, cannot be unit-tested without
 * pulling the whole agent in, and pins a version its user may not be on. These
 * shapes are structural, so the exported plugin is assignable to
 * `@elizaos/core`'s own `Plugin` type wherever a consumer imports it — and
 * `@elizaos/core` is declared as a peer dependency, which is the honest way to
 * say "you bring the runtime".
 *
 * Source of the shapes: https://docs.elizaos.ai/plugins/reference
 */

export type ElizaRuntime = {
  /** Settings come from the character file, the env, or the runtime's store. */
  getSetting?: (key: string) => string | undefined | null;
};

export type ElizaMemory = {
  content?: { text?: string; [k: string]: unknown };
  [k: string]: unknown;
};

export type ElizaState = Record<string, unknown>;

export type ElizaHandlerCallback = (response: {
  text: string;
  [k: string]: unknown;
}) => Promise<unknown> | unknown;

export type ElizaActionResult = {
  success: boolean;
  text: string;
  data?: Record<string, unknown>;
  error?: string;
};

export type ElizaAction = {
  name: string;
  similes?: string[];
  description: string;
  examples?: unknown[][];
  validate: (runtime: ElizaRuntime, message: ElizaMemory, state?: ElizaState) => Promise<boolean>;
  handler: (
    runtime: ElizaRuntime,
    message: ElizaMemory,
    state?: ElizaState,
    options?: Record<string, unknown>,
    callback?: ElizaHandlerCallback,
  ) => Promise<ElizaActionResult>;
};

export type ElizaPlugin = {
  name: string;
  description: string;
  actions?: ElizaAction[];
};
