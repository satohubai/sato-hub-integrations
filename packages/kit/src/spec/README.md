<!-- Vendored verbatim into @satohub/kit (packages/kit/src/spec). Edit here, then re-vendor. -->
# Onchain Action Descriptor (ODA) — `sato.action/v1`

**Draft 0 — not a standard; @satohub/kit is the reference implementation.** Draft date: 2026-09-26. "ODA" is a working name.

ODA describes one onchain action an agent can call: what it is named, what it touches, what it can do with a key and with money, which pre-flight rules it runs, and what it records. A host reads the descriptor to wire its approval hook. A verifier reads it to run conformance checks.

## 1. The descriptor

| Field | Type | Rule |
|---|---|---|
| `schema` | `"sato.action/v1"` | constant |
| `id` | string | dotted lowercase segments, e.g. `swap.prepare` |
| `name` | string | the tool name every host sees; equals `odaIdToToolName(id)` |
| `version` | string | `MAJOR.MINOR.PATCH` of the descriptor |
| `title` | string | 1–120 characters |
| `description` | string | ≤1000 characters; see §4 |
| `effects` | array | non-empty subset of `read`, `quote`, `simulate`, `sign`, `broadcast`, `pay` |
| `custody` | object | `reads_key` (bool), `sends_key` (bool), `moves_funds` (`never` \| `with_approval` \| `autonomous`) |
| `chains` | array | chain names from the ODA chain list |
| `input_schema` | JSON Schema | must pass the portable-schema lint (§3) |
| `output_schema` | JSON Schema | **required**; must pass the lint |
| `policy.rules` | array | the `sato.policy/v1` rule ids this action checks before returning an intent |
| `receipt` | bool | whether the action writes a `sato.receipt/v1` line |
| `fixtures` | array | relative paths replayed by conformance runs |
| `upstream` | object | package → **exact** version wrapped; no ranges |
| `sponsored` | object \| null | `{ by, since }`; data only, never copy, no effect on resolution |

`custody` answers, for one action and as a declaration, the first three questions of `sato.custody/v1`: does it take your key, does your key leave, can it move funds on its own. A declaration is the author's statement. Independent readings of the published artifact are a separate profile.

## 2. Names

`id` → `name`: replace every `.` with `_`. The result is lowercase snake_case, at most 40 characters. An invalid id or an over-long name is an error. The inverse (`name` → `id`) is defined only when unambiguous: a name with exactly one underscore, or a unique match among known ids.

## 3. Portable schemas

A schema that loads in every host: an object at the root; no `oneOf`/`anyOf`/`allOf`/`not` at the root; no `$ref`, `$defs` or `definitions` anywhere; one `type` per node. Onchain values: properties named `amount`, `amount_*`, `value`, `*_wei`, `*_base_units` or `uint256` are strings with a decimal `pattern`; properties named `address`, `*_address`, `to`, `from`, `token` or `recipient` are strings with a `pattern`; `chain` and `chain_id` are enums.

## 4. Descriptions

Front-loaded with what the tool does, when to use it, when not to, and its effect. A description never contains a date, a count, a price or fee, sponsorship, or a claim that the action is safe, secure, best or guaranteed. Those change or mislead; they belong in structured output and `_meta`.

## 5. Approval mapping

From `effects`: only `read`/`quote`/`simulate` → `readOnlyHint` and `idempotentHint`. Any `sign`/`broadcast`/`pay` → `destructiveHint` and `requiresUserInteraction` (mapped to each host's approval mechanism). An empty list gets the cautious answer.

## 6. Prepare → execute

A write action is two calls. `prepare` returns a `PreparedIntent`: `intent_id`, `action`, `expires_at`, a one-sentence `summary`, `policy: { ok, refusals[] }`, `simulation`, `fee_disclosure`, and the `unsigned` payload. `execute` accepts `{ intent_id }` and **no other key**.

`intent_id = "si_" + base64url(HMAC-SHA256(secret, canonicalJson({ action, params_digest, expires_at, nonce })))`, where `params_digest = "sha256:" + hex(sha256(canonicalJson(params)))`. The implementation refuses an id it did not mint, an expired id, and an id already executed.

The `unsigned` payload is one of four kinds; any other kind is refused:
- `evm_tx` — `chain, chain_id, from|null, to, data, value` (wei, decimal string).
- `x402_payment` — `network, resource, pay_to, asset, amount` (base units). Signing has no on-chain effect by itself, so the intent states why no simulation applies.
- `typed_data` (additive in Phase 2 wave 2) — EIP-712 `chain, chain_id, signer, domain, types, primaryType, message`, and `submit`: `null` (return the signature) or `{ kind: "safe_tx_service", url, safe_address }` (POST it to the Safe Transaction Service). Nothing moves until the Safe's owners execute, so `simulation_required` does not apply; the intent states that reason and never reports a simulation it did not run.
- `solana_tx` (additive in Phase 2 wave 2) — `chain` (`solana` \| `solana-devnet`), `fee_payer`, `transaction_base64` (the serialized UNSIGNED transaction), `recent_blockhash`, `last_valid_block_height`. Simulated with the RPC's `simulateTransaction` (sigVerify false) and must succeed, like `evm_tx`. Executing it needs the signer's optional `signSolanaTransaction` / `sendSolanaTransaction`; without them execute fails naming the capability.

A refusal is `{ rule, limit, observed, message }`. `limit` and `observed` are always strings; `"unknown"` when unreadable. Unknown readings refuse by default.

## 7. Receipts

One JSON line per state change, `schema: "sato.receipt/v1"`: `seq` (from 0, no gaps), `prev_hash` (`sha256:` + 64 zeros for seq 0), `hash = "sha256:" + hex(sha256(canonicalJson(receipt without hash)))`, `intent_id`, `action`, `chain`, `params_digest`, `policy`, `simulation`, `fee_disclosure`, `tx_hash`, `status` (`prepared` \| `refused` \| `executed` \| `failed` \| `expired`), `created_at`, `mandate`.

Optional, additive in Phase 2 wave 2 (absent is always valid): `safe_tx_hash` — a typed_data proposal's safeTxHash at the Safe Transaction Service (not an on-chain transaction; `tx_hash` stays null) — and `signature` — a solana_tx's base58 transaction signature. `tx_hash` always means an EVM transaction hash.

The `mandate` block (`kind: "intent"`, `intent_id`, `action`, `policy_digest`, `expires_at`, `approval`) is aligned with the AP2 v0.2 / Verifiable Intent vocabulary. It is not a certified implementation of either.

## 8. Canonical JSON

Object keys sorted, arrays in order, no whitespace, `undefined` properties omitted; non-finite numbers are an error. Amounts are strings, so number formatting never matters.

## 9. Not in this draft

Nightly verification (a separate profile), signer policy compilation, and the pre-flight evaluator's algorithm. Before 1.0 the draft needs two outside co-editors; it is not called a standard before independent implementations exist.
