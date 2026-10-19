@echo off
setlocal EnableExtensions DisableDelayedExpansion
if not defined CODEX_MCP_NODE_PATH exit /b 1
if not exist "%CODEX_MCP_NODE_PATH%" exit /b 1
"%CODEX_MCP_NODE_PATH%" "%~dp0kaiby-link-mcp.cjs"
exit /b %ERRORLEVEL%
