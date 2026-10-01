from typing import Any

from dify_plugin import ToolProvider


class SatohubProvider(ToolProvider):
    """Sato Hub's public API is keyless, so there is nothing to validate."""

    def _validate_credentials(self, credentials: dict[str, Any]) -> None:
        return None
