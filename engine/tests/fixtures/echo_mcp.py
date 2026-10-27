"""A tiny MCP server for the tests (runs on this computer over stdio, no network)."""
from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

server = MCPServer("echo")


@server.tool(annotations=ToolAnnotations(read_only_hint=True))
def echo(text: str) -> str:
    """Repeats the text."""
    return f"echo: {text}"


@server.tool()
def shout(text: str) -> str:
    """Repeats the text loudly."""
    return text.upper()


if __name__ == "__main__":
    server.run("stdio")
