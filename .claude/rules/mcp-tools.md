---
description: Rules for MCP server tools and API
globs: packages/mcp/src/**
---

# MCP Tools Standards

- Tool descriptions are prompt engineering — optimize wording for LLM trigger accuracy
- Validate ALL input parameters before processing — return clear error messages
- Return structured JSON responses, not prose
- Include attribution fields (provider, model_id, model_name, agent) on memory_store operations
- Respect tier parameter for knowledge tier scoping (working, episodic, semantic, procedural, reference)
- Session-orient hook must complete within 3s timeout — fail gracefully if slow
- Use compact: true for search previews to save tokens
