#!/usr/bin/env node

// Minimal, MCP filesystem server for Claude Desktop.
// - Allowed roots passed via `--allowed <dir1> <dir2> ...`
// - Tools:
//     * move_files: move multiple files
//     * list_dir: list directory contents
//     * make_dir: create directory
//     * get_allowed_roots: list configured roots
//     * search_paths: search for files/directories under a root
//     * delete_path: delete a file or directory (recursive for dirs)

import path from "node:path";
import fs from "fs-extra";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

// ---------- CLI: allowed roots ----------

const args = process.argv.slice(2);
const allowedIndex = args.indexOf("--allowed");

if (allowedIndex === -1) {
  console.error(
    "ERROR: You must pass --allowed <dir1> <dir2> ...\n" +
      "Example: node server.mjs --allowed /Users/matt/Desktop /Users/matt/Downloads"
  );
  process.exit(1);
}

const ALLOWED_ROOTS = args.slice(allowedIndex + 1).map((p) => path.resolve(p));

if (ALLOWED_ROOTS.length === 0) {
  console.error("ERROR: No allowed roots specified after --allowed.");
  process.exit(1);
}

console.error("Allowed roots:", ALLOWED_ROOTS);

// ---------- Path helpers ----------

function isWithinAllowed(absPath) {
  const normalised = path.resolve(absPath);

  return ALLOWED_ROOTS.some((root) => {
    const absRoot = path.resolve(root);
    return (
      normalised === absRoot ||
      normalised.startsWith(absRoot + path.sep)
    );
  });
}

function normaliseAndCheck(p) {
  if (!p || typeof p !== "string") {
    throw new Error("Invalid path (empty or non-string)");
  }

  const abs = path.resolve(p);

  if (!isWithinAllowed(abs)) {
    throw new Error(`Path is outside allowed roots: ${abs}`);
  }

  return abs;
}

// ---------- MCP server setup ----------

const server = new McpServer({
  name: "friendly-fs",
  version: "1.0.0",
});

// ---------- Tools ----------

// 1) Move multiple files
server.tool(
  "move_files",
  {
    moves: z
      .array(
        z.object({
          from: z
            .string()
            .describe("Source file path (absolute or under allowed roots)"),
          to: z
            .string()
            .describe("Destination file path (absolute or under allowed roots)")
        })
      )
      .nonempty()
      .describe("List of file moves to perform")
  },
  async ({ moves }) => {
    const results = [];

    for (const { from, to } of moves) {
      try {
        const src = normaliseAndCheck(from);
        const dst = normaliseAndCheck(to);

        await fs.ensureDir(path.dirname(dst));
        await fs.move(src, dst, { overwrite: true });

        results.push({
          from,
          to,
          status: "ok"
        });
      } catch (err) {
        results.push({
          from,
          to,
          status: "error",
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const summary = {
      moved: results.filter((r) => r.status === "ok").length,
      failed: results.filter((r) => r.status === "error").length,
      details: results
    };

    return {
      // Text output for Claude to read
      content: [
        {
          type: "text",
          text: JSON.stringify(summary, null, 2)
        }
      ],
      // Structured output for tools-aware clients
      structuredContent: summary
    };
  }
);

// 2) List directory contents
server.tool(
  "list_dir",
  {
    path: z
      .string()
      .describe("Directory to list (absolute or relative under allowed roots)")
  },
  async ({ path: dirPath }) => {
    const abs = normaliseAndCheck(dirPath);
    let entries;

    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: `Error reading directory ${abs}: ${message}`
          }
        ]
      };
    }

    const items = entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile()
    }));

    const result = { path: abs, entries: items };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ],
      structuredContent: result
    };
  }
);

// 3) Create a directory
server.tool(
  "make_dir",
  {
    path: z
      .string()
      .describe("Directory to create (absolute or relative under allowed roots)")
  },
  async ({ path: dirPath }) => {
    try {
      const abs = normaliseAndCheck(dirPath);
      await fs.ensureDir(abs);

      const result = { created: abs };

      return {
        content: [
          {
            type: "text",
            text: `Created directory: ${abs}`
          }
        ],
        structuredContent: result
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: `Error creating directory: ${message}`
          }
        ]
      };
    }
  }
);

// Tool: get_allowed_roots
server.tool(
  "get_allowed_roots",
  {},
  async () => {
    const result = { allowedRoots: ALLOWED_ROOTS };
    return {
      content: [
        {
          type: "text",
          text: "Allowed roots:\n" + ALLOWED_ROOTS.join("\n")
        }
      ],
      structuredContent: result
    };
  }
);

// Tool: search_paths
server.tool(
  "search_paths",
  {
    root: z
      .string()
      .describe("Directory to search (must be within allowed roots)"),

    // What to search for:
    searchFiles: z
      .boolean()
      .default(true)
      .describe("Include files in search results"),

    searchDirectories: z
      .boolean()
      .default(false)
      .describe("Include directories in search results"),

    // Filters
    extensions: z
      .array(z.string())
      .default([])
      .describe("File extensions to filter by (e.g. ['.png', '.jpg']). Only used if searchFiles=true."),

    names: z
      .array(z.string())
      .default([])
      .describe("Directory names to match (case-insensitive). Only used if searchDirectories=true."),

    limit: z
      .number()
      .int()
      .positive()
      .default(100)
      .describe("Maximum number of results to return")
  },
  async ({ root, searchFiles, searchDirectories, extensions, names, limit }) => {
    try {
      const absRoot = normaliseAndCheck(root);

      const matches = [];
      const extFilters = extensions.map((e) => e.toLowerCase());
      const nameFilters = names.map((n) => n.toLowerCase());

      async function walk(dir) {
        if (matches.length >= limit) return;

        const items = await fs.readdir(dir, { withFileTypes: true });

        for (const item of items) {
          if (matches.length >= limit) return;

          const fullPath = path.join(dir, item.name);

          // --- directories ---
          if (item.isDirectory()) {
            if (searchDirectories) {
              const lower = item.name.toLowerCase();
              if (nameFilters.includes(lower) || nameFilters.length === 0) {
                matches.push({
                  path: fullPath,
                  type: "directory"
                });
              }
            }

            // recurse
            await walk(fullPath);
            continue;
          }

          // --- files ---
          if (item.isFile() && searchFiles) {
            const lower = item.name.toLowerCase();

            const extOK =
              extFilters.length === 0 ||
              extFilters.some((ext) => lower.endsWith(ext));

            if (extOK) {
              matches.push({
                path: fullPath,
                type: "file"
              });
            }
          }
        }
      }

      await walk(absRoot);

      const result = {
        root: absRoot,
        searchFiles,
        searchDirectories,
        extensions,
        names,
        count: matches.length,
        results: matches
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ],
        structuredContent: result
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error searching paths: ${err instanceof Error ? err.message : String(err)}`
          }
        ]
      };
    }
  }
);


// Tool: delete_path
server.tool(
  "delete_path",
  {
    path: z
      .string()
      .describe("Absolute or relative path to delete (file or directory; must be within allowed roots)")
  },
  async ({ path: p }) => {
    try {
      const abs = normaliseAndCheck(p);

      const stat = await fs.stat(abs).catch(() => null);
      if (!stat) {
        return {
          content: [
            {
              type: "text",
              text: `Path does not exist: ${abs}`
            }
          ],
          structuredContent: { deleted: false, reason: "not_found", path: abs }
        };
      }

      const type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";

      if (type === "other") {
        return {
          content: [
            {
              type: "text",
              text: `Path is not a file or directory: ${abs}`
            }
          ],
          structuredContent: { deleted: false, reason: "unsupported_type", path: abs }
        };
      }

      // Recursively delete files or directories
      await fs.remove(abs);

      return {
        content: [
          {
            type: "text",
            text: `Deleted ${type}: ${abs}`
          }
        ],
        structuredContent: { deleted: true, type, path: abs }
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: `Error deleting path: ${msg}`
          }
        ],
        structuredContent: { deleted: false, error: msg }
      };
    }
  }
);





// ---------- Connect via stdio (Claude Desktop) ----------

const transport = new StdioServerTransport();

// Top-level await is valid in ESM; this is the documented pattern for stdio. :contentReference[oaicite:4]{index=4}
await server.connect(transport);
