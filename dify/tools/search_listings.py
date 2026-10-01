from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from tools.satohub_api import SCORE_NOTE, SatoHubError, call_mcp_tool

MAX_LIMIT = 25
NOTE = (
    "A listing is a record, not an endorsement. A project missing here is not evidence against it: "
    "Sato Hub may not list it yet. Cite each listing's page on satohub.ai."
)


def _limit(value: Any) -> int:
    try:
        n = int(float(value))
    except (TypeError, ValueError):
        n = 10
    return max(1, min(MAX_LIMIT, n))


class SearchListingsTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        query = str(tool_parameters.get("query") or "").strip()[:200]
        chain = str(tool_parameters.get("chain") or "").strip()[:40]
        category = str(tool_parameters.get("category") or "").strip()[:60]
        if not query and not chain and not category:
            yield self.create_text_message("Give a few words to search for, e.g. 'x402 python' or 'wallet mcp'.")
            return

        try:
            text, data = call_mcp_tool(
                "onchain_agent_search_resources",
                {
                    "query": query,
                    "chain": chain,
                    "category": category,
                    "limit": _limit(tool_parameters.get("limit")),
                },
            )
        except SatoHubError as err:
            yield self.create_text_message(str(err))
            return

        data = dict(data)
        data["about_sato_score"] = SCORE_NOTE
        data["note"] = NOTE
        yield self.create_text_message("\n\n".join(part for part in (text, SCORE_NOTE, NOTE) if part))
        yield self.create_json_message(data)
