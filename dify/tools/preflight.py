from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from tools.satohub_api import PREFLIGHT_NOTE, SatoHubError, get_json

TARGET_TYPES = ("repo", "package", "endpoint")

VERDICT_MEANS = {
    "go": "Every part of the rule cited in `rule` held on the records checked. It describes the record; it is not a safety verdict.",
    "caution": "The target resolved, but not every part of the go rule held. Read the evidence lines before relying on it.",
    "no": "A recorded fact decided it (for example the listing is retired, or a probed endpoint did not answer). Read the evidence lines.",
    "unknown": "Sato Hub holds no record of this target. That is not a finding against it.",
}


class PreflightTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        target_type = str(tool_parameters.get("target_type") or "").strip().lower()
        target = str(tool_parameters.get("target") or "").strip()[:300]
        if target_type not in TARGET_TYPES:
            yield self.create_text_message("target_type must be one of: repo, package, endpoint.")
            return
        if not target:
            yield self.create_text_message("Give the repo (owner/name or GitHub URL), package name, or https MCP endpoint URL.")
            return
        if target_type == "endpoint" and not target.lower().startswith("https://"):
            yield self.create_text_message("An endpoint must be an https:// MCP endpoint URL.")
            return

        try:
            data = get_json("/api/preflight", {target_type: target})
        except SatoHubError as err:
            yield self.create_text_message(str(err))
            return

        verdict = data.get("verdict") or "unknown"
        evidence = [e for e in data.get("evidence") or [] if isinstance(e, dict)]
        tgt = data.get("target") or {}
        result = {
            "verdict": verdict,
            "verdict_means": VERDICT_MEANS.get(verdict, ""),
            "rule": data.get("rule"),
            "reason": data.get("reason"),
            "target": {
                "kind": tgt.get("kind") or target_type,
                "value": tgt.get("value") or target,
                "listing_name": tgt.get("name"),
                "slug": tgt.get("slug"),
                "sato_url": tgt.get("sato_url"),
                "verify_url": tgt.get("verify_url"),
            },
            "evidence": [
                {
                    "check": e.get("check"),
                    "result": e.get("result"),
                    "source_field": e.get("source_field"),
                    "checked_at": e.get("checked_at"),
                }
                for e in evidence
            ],
            "checked_at": data.get("checked_at"),
            "about_preflight": PREFLIGHT_NOTE,
            "caveat": data.get("caveat"),
        }

        name = tgt.get("name") or target
        lines = [f"Preflight for {name}: {verdict} (rule {data.get('rule') or 'n/a'}). {VERDICT_MEANS.get(verdict, '')}"]
        for e in evidence:
            when = str(e.get("checked_at") or "")[:10] or "no date"
            lines.append(f"- {e.get('check')}: {e.get('result')} ({e.get('source_field')}, {when})")
        if tgt.get("sato_url"):
            lines.append(f"Record: {tgt.get('sato_url')}")
        lines += ["", PREFLIGHT_NOTE]
        yield self.create_text_message("\n".join(lines))
        yield self.create_json_message(result)
