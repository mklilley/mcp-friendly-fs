# mcp-friendly-fs

A **safe, Claude Desktop–compatible filesystem MCP server** that replaces shell commands with explicit tools.

This server gives Claude controlled access to parts of your local filesystem using the **Model Context Protocol (MCP)**, while avoiding common problems such as:

- Claude trying to run `bash`, `find`, `rm -rf`, etc.
- Confusing or unsafe absolute paths
- Accidental access outside intended directories
- Repeated confirmation prompts for simple filesystem tasks

Instead, Claude interacts with your files **only through well-defined tools**.

---

## Features

- Stdio-based MCP server (**auto-started by Claude Desktop**)
- **Allowed roots** are configurable (passed via CLI args)
- Supports **absolute paths** (only within allowed roots)
- **No shell execution** — uses Node.js filesystem APIs only
- Designed to stop Claude falling back to bash commands
- Structured results so Claude can reason about outcomes

---

## What Claude can do with this server

This repo provides an MCP server that exposes filesystem tools to Claude Desktop (via stdio). Typical tools include:

- `get_allowed_roots` — return allowed directory roots (so Claude can self-calibrate)
- `list_dir` — list a directory
- `make_dir` — create a directory recursively (`mkdir -p`)
- `move_files` — move multiple files in one call
- `search_paths` — search for files and/or directories under a root
- `delete_path` — delete a file **or** directory (recursively for dirs)


---

## Why this exists

Claude Desktop does **not** provide a real shell. If you ask something like “what’s on my Desktop?”, Claude may try to run commands such as:

```sh
find /Users/matt/Desktop -type f -name "*.png"
rm -rf /Users/matt/Desktop/Screenshots
```

These will fail (and sometimes Claude invents sandbox paths like `/home/claude/Desktop`). This server prevents that by giving Claude proper, explicit filesystem tools.

---

## Requirements

- Node.js 18+ (works on Node 18 and Node 22)
- Claude Desktop with MCP enabled

---

## Installation

Clone and install dependencies:

```bash
git clone https://github.com/mklilley/mcp-friendly-fs.git
cd mcp-friendly-fs
npm install
```

## Running the server manually (sanity check)

You can run the server directly to confirm it starts:

```bash
node server.mjs --allowed /Users/you/Desktop /Users/you/Downloads
```

## Claude Desktop configuration

Edit Claude Desktop’s config:

**macOS**
```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Add an entry like:

```json
{
  "mcpServers": {
    "friendly-fs": {
      "command": "node",
      "args": [
        "/Users/you/Documents/GitHub/mcp-friendly-fs/server.mjs",
        "--allowed",
        "/Users/matt/Desktop",
        "/Users/matt/Downloads"
      ]
    }
  }
}
```

Restart Claude Desktop after editing.

---

## How access control works

Claude does **not** automatically know what it can access. The server enforces access by:

1. Normalising all requested paths to absolute paths
2. Checking the path is within one of the allowed roots supplied after `--allowed`
3. Rejecting requests outside allowed roots with a clear error message

Recommended instruction to Claude (helps prevent “bash mode”):

> Use only the filesystem tools. Do not attempt shell commands.  

---

## Examples

### Ask Claude what roots it can access
Claude should call `get_allowed_roots` and receive something like:

```json
{
  "allowedRoots": [
    "/Users/you/Desktop",
    "/Users/you/Downloads"
  ]
}
```

### List the Desktop
Tool call example:

```json
{ "path": "/Users/you/Desktop" }
```

### Search for image files under Desktop
Tool call example:

```json
{
  "root": "/Users/you/Desktop",
  "searchFiles": true,
  "searchDirectories": false,
  "extensions": [".png", ".jpg", ".jpeg"],
  "limit": 50
}
```

### Search for directories named “Screenshots” or “Images”
Tool call example:

```json
{
  "root": "/Users/you/Desktop",
  "searchFiles": false,
  "searchDirectories": true,
  "names": ["Screenshots", "Images"],
  "limit": 200
}
```

### Delete a directory (recursive)
Tool call example:

```json
{ "path": "/Users/you/Desktop/example" }
```



---

## License

MIT
