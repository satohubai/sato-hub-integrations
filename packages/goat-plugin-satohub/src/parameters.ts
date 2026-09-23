/**
 * GOAT tool parameters. GOAT reads a tool's schema off the CLASS its method
 * takes (via `emitDecoratorMetadata`), so each schema is wrapped with
 * `createToolParameters` — and these must stay value imports wherever they are
 * used, never `import type`, or the metadata GOAT reads is erased.
 *
 * The schemas themselves are satohub-core's, verbatim, so this package cannot
 * describe an argument differently from the other framework packages.
 */

import { createToolParameters } from "@goat-sdk/core";
import { preflightSchema, searchResourcesSchema } from "satohub-core/schemas";

export class PreflightParameters extends createToolParameters(preflightSchema) {}

export class SearchResourcesParameters extends createToolParameters(searchResourcesSchema) {}
