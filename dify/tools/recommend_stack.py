from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from tools.satohub_api import PREFLIGHT_NOTE, SCORE_NOTE, SatoHubError, get_json, score_text


def _item(raw: dict[str, Any]) -> dict[str, Any]:
    spec = raw.get("deploy_spec") or {}
    summary = raw.get("preflight_summary") or {}
    return {
        "slot": raw.get("slot_label") or raw.get("slot"),
        "name": raw.get("name"),
        "slug": raw.get("slug"),
        "category": raw.get("category"),
        "sato_score": raw.get("trust_score"),
        "sato_score_tier": raw.get("trust_tier"),
        "why": raw.get("why"),
        "chains": raw.get("chains") or [],
        "install_reproduced_by_sato_hub": raw.get("install_verified"),
        "install": spec.get("install") or [],
        "requires": spec.get("requires") or [],
        "preflight": {
            "verdict": summary.get("verdict"),
            "rule": summary.get("rule"),
            "rule_means": summary.get("rule_means"),
            "evidence": summary.get("evidence") or [],
            "checked_at": summary.get("checked_at"),
        },
        "github_url": raw.get("github_url"),
        "sato_url": raw.get("sato_url"),
    }


def _text(plan: dict[str, Any], items: list[dict[str, Any]]) -> str:
    lines = [plan.get("restatement") or f"Goal: {plan.get('goal')}", ""]
    if not items:
        lines.append("Sato Hub found no listing to recommend for this goal. Try naming the chain or what the agent does.")
    for it in items:
        verdict = it["preflight"]["verdict"] or "unknown"
        lines.append(
            f"- {it['slot']}: {it['name']} ({score_text(it['sato_score'], it['sato_score_tier'])}; "
            f"Preflight {verdict}) {it['sato_url']}"
        )
        if it["why"]:
            lines.append(f"  why: {it['why']}")
        if it["install"]:
            lines.append(f"  install: {it['install'][0]}")
    gaps = plan.get("gaps") or []
    if gaps:
        lines += ["", "Gaps: " + "; ".join(str(g) for g in gaps)]
    questions = plan.get("open_questions") or []
    if questions:
        lines += ["", "Still to decide:"] + [f"- {q}" for q in questions]
    lines += ["", SCORE_NOTE, PREFLIGHT_NOTE, "Cite each pick's sato_url so a reader can check the live record."]
    return "\n".join(lines)


class RecommendStackTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        goal = str(tool_parameters.get("goal") or "").strip()
        if not goal:
            yield self.create_text_message("Describe what the agent should do, in plain words.")
            return
        try:
            plan = get_json(
                "/api/satobot/plan",
                {
                    "goal": goal[:600],
                    "chain": str(tool_parameters.get("chain") or "").strip()[:40],
                    "constraints": str(tool_parameters.get("constraints") or "").strip()[:300],
                },
            )
        except SatoHubError as err:
            yield self.create_text_message(str(err))
            return

        items = [_item(raw) for raw in plan.get("stack") or [] if isinstance(raw, dict)]
        result = {
            "goal": plan.get("goal"),
            "restatement": plan.get("restatement"),
            "intent": plan.get("intent"),
            "chain": plan.get("chain"),
            "chain_source": plan.get("chain_source"),
            "stack": items,
            "constraint_check": plan.get("constraint_check"),
            "gaps": plan.get("gaps") or [],
            "open_questions": plan.get("open_questions") or [],
            "next_steps": plan.get("next_steps") or [],
            "checked_at": plan.get("checked_at"),
            "about_sato_score": SCORE_NOTE,
            "about_preflight": PREFLIGHT_NOTE,
            "caveat": plan.get("caveat"),
            "source": "https://satohub.ai",
        }
        yield self.create_text_message(_text(plan, items))
        yield self.create_json_message(result)
