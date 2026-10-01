"""The one place this plugin talks to Sato Hub.

Every request goes to the fixed host below, carries no key and names this
plugin in its user-agent. Nothing is cached, stored or logged here. The plugin
selects fields from Sato Hub's answers; it never scores, ranks or judges
anything itself.
"""

from __future__ import annotations

import json
from typing import Any

import requests

PLUGIN_VERSION = "0.0.1"
BASE_URL = "https://satohub.ai"
USER_AGENT = f"dify-plugin-satohub/{PLUGIN_VERSION}"
# (connect, read). A Preflight of an MCP endpoint runs one live handshake on
# Sato Hub's side, so the read budget is generous.
TIMEOUT = (10, 45)

SCORE_NOTE = (
    "The Sato Score (0-100) measures how open, active and verifiable a project is. "
    "It is not a safety, security, quality or returns grade. Method: https://satohub.ai/sato-score"
)
PREFLIGHT_NOTE = (
    "A Preflight verdict names what Sato Hub checked and when, from its own records and probes. "
    "It is not a security review. `unknown` means Sato Hub holds no record of the target, "
    "not that anything is wrong with it. Rules: https://satohub.ai/preflight/methodology"
)


class SatoHubError(Exception):
    """A request that did not produce a usable answer, with a message safe to show."""


def get_json(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    clean = {k: v for k, v in (params or {}).items() if v not in (None, "")}
    try:
        response = requests.get(
            f"{BASE_URL}{path}",
            params=clean,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=TIMEOUT,
        )
    except requests.Timeout as err:
        raise SatoHubError(f"Sato Hub did not answer in time ({path}).") from err
    except requests.RequestException as err:
        raise SatoHubError(f"Could not reach Sato Hub ({path}): {type(err).__name__}.") from err

    try:
        body = response.json()
    except ValueError:
        body = None

    if response.status_code >= 400:
        detail = ""
        if isinstance(body, dict):
            detail = str(body.get("error") or body.get("message") or "")[:300]
        raise SatoHubError(f"Sato Hub answered HTTP {response.status_code} for {path}. {detail}".strip())
    if not isinstance(body, dict):
        raise SatoHubError(f"Sato Hub returned a response that is not a JSON object ({path}).")
    return body


def call_mcp_tool(name: str, arguments: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """One stateless JSON-RPC `tools/call` against Sato Hub's MCP endpoint.

    Free-text search lives on the MCP surface (the bulk export is a filtered
    mirror of the catalogue, not a search). Returns Sato Hub's own text render
    and its structured payload, both unchanged.
    """
    args = {k: v for k, v in arguments.items() if v not in (None, "")}
    try:
        response = requests.post(
            f"{BASE_URL}/api/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}},
            headers={
                "User-Agent": USER_AGENT,
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
            timeout=TIMEOUT,
        )
    except requests.Timeout as err:
        raise SatoHubError("Sato Hub did not answer in time (/api/mcp).") from err
    except requests.RequestException as err:
        raise SatoHubError(f"Could not reach Sato Hub (/api/mcp): {type(err).__name__}.") from err
    if response.status_code >= 400:
        raise SatoHubError(f"Sato Hub answered HTTP {response.status_code} for /api/mcp.")

    # The SSE frame is UTF-8 whatever the header says; decode it as such.
    envelope = _jsonrpc_envelope(response.content.decode("utf-8", errors="replace"))
    if envelope.get("error"):
        message = str((envelope["error"] or {}).get("message") or "unknown error")[:300]
        raise SatoHubError(f"Sato Hub could not run {name}: {message}")
    result = envelope.get("result") or {}
    text = "\n".join(
        str(part.get("text") or "") for part in result.get("content") or [] if isinstance(part, dict) and part.get("type") == "text"
    ).strip()
    if result.get("isError"):
        raise SatoHubError(text[:500] or f"Sato Hub could not run {name}.")
    structured = result.get("structuredContent")
    return text, structured if isinstance(structured, dict) else {}


def _jsonrpc_envelope(body: str) -> dict[str, Any]:
    """The server answers with plain JSON or a single SSE frame; read either."""
    candidates = [line[5:].strip() for line in body.split("\n") if line.startswith("data:")] or [body]
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise SatoHubError("Sato Hub returned a response that is not JSON-RPC (/api/mcp).")


def score_text(score: Any, tier: Any) -> str:
    if score is None:
        return "no Sato Score"
    return f"Sato Score {score}/100 ({tier})" if tier else f"Sato Score {score}/100"
