// POLICY builder. A pre-flight that explains refusals; enforcement lives in the signer.
import type { EvaluatePreflight } from "../types.js";

export const evaluatePreflight: EvaluatePreflight = () => {
  throw new Error("not implemented: evaluatePreflight");
};
