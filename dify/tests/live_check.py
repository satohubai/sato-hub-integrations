"""Run each tool once against production, outside Dify.

    python -m tests.live_check          (from the plugin directory)

Not packaged (.difyignore). The tools' own code runs unchanged; only the Dify
runtime is replaced by a stand-in, since none of the tools read credentials.
"""

from __future__ import annotations

import json
import sys

from dify_plugin.entities.tool import ToolInvokeMessage

from tools.preflight import PreflightTool
from tools.recommend_stack import RecommendStackTool
from tools.search_listings import SearchListingsTool


def run(tool_cls, params):
    tool = tool_cls.__new__(tool_cls)  # no Dify session needed for these tools
    tool.response_type = ToolInvokeMessage
    text, payload = None, None
    for msg in tool._invoke(params):
        if msg.type == ToolInvokeMessage.MessageType.TEXT:
            text = msg.message.text
        elif msg.type == ToolInvokeMessage.MessageType.JSON:
            payload = msg.message.json_object
    return text, payload


CASES = [
    (RecommendStackTool, {"goal": "an agent on Base that buys API data over x402"}),
    (SearchListingsTool, {"query": "x402 python", "limit": 3}),
    (PreflightTool, {"target_type": "repo", "target": "coinbase/agentkit"}),
    (PreflightTool, {"target_type": "package", "target": "not-a-real-package-sato-check"}),
]

if __name__ == "__main__":
    failed = 0
    for cls, params in CASES:
        text, payload = run(cls, params)
        ok = bool(text) and isinstance(payload, dict)
        failed += 0 if ok else 1
        print(f"=== {cls.__name__} {json.dumps(params)} -> {'ok' if ok else 'FAILED'}")
        print(text)
        print()
    sys.exit(1 if failed else 0)
