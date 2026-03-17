"""
server_base.py — FastMCP factory + bounds suspension decorator.
Port of mcp-server-base.js using the Python MCP SDK's FastMCP.

Usage in each server module:
    from servers.server_base import create_server, suspended_when_revoked

    mcp = create_server("aml-server")

    @mcp.tool()
    @suspended_when_revoked("screen_client")
    async def screen_client(flow_id: str, request_id: str, ...) -> dict:
        ...

    if __name__ == "__main__":
        import sys
        port = int(sys.argv[1]) if len(sys.argv) > 1 else 8010
        mcp.run(transport="streamable-http", host="0.0.0.0", port=port)
"""

from __future__ import annotations

import functools
import logging
from typing import Callable

from mcp.server.fastmcp import FastMCP

from shared.bounds_monitor_client import is_tool_suspended

logger = logging.getLogger(__name__)


def create_server(name: str, **kwargs) -> FastMCP:
    """
    Create a FastMCP server instance.

    The server exposes a POST /mcp endpoint (streamable-http transport)
    compatible with both the Node.js bridge callMcpTool() helper and
    the Python bridge_base.call_mcp_tool() helper.
    """
    return FastMCP(name, **kwargs)


def suspended_when_revoked(tool_name: str) -> Callable:
    """
    Decorator that checks bounds-state.json before executing a tool handler.
    If the tool is suspended by the autonomy bounds monitor, raises a
    ValueError which FastMCP converts to a JSON-RPC error response.

    Usage:
        @mcp.tool()
        @suspended_when_revoked("screen_client")
        async def screen_client(...): ...
    """
    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            suspended, reason = is_tool_suspended(tool_name)
            if suspended:
                raise ValueError(f"Tool suspended: {reason}")
            return await func(*args, **kwargs)
        return wrapper
    return decorator
