"""Connections to the user's own accounts (Slack, GitHub, Notion, Google Calendar, Gmail, Google Drive,
MCP servers). Each is verified with the service itself before it's marked connected, and anything that
changes something in them runs only after the user approves it (see ../actions.py)."""
