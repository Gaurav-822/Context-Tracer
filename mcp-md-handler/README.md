# Explorer Map — MCP server (md notes + workflow graph)

Stdio [Model Context Protocol](https://modelcontextprotocol.io) server. Main tools:

- **`read_md_handler_file`** — read the same Markdown files as the **Explorer Map → Features → md handler**.
- **`write_flow_file_graph`** (recommended) — `title` + `files` with optional **`order`** (1-based flow order; if omitted, array/index order is used), **`fileName`**, **`filePath`** (string: path relative to the workspace root, e.g. `src/middleware/x.ts`), and **`role`**. The step sequence goes in **`order`**; **`filePath`** is only the real file path. **Do not** copy the *other* tool’s habit of using `"1"`, `"2"` as **graph ids** and put a number in **`filePath`**—`write_workflow_graph` uses `id` for internal keys, while this tool uses **order** + **filePath** separately. Node ids in the saved graph are those paths. **`openInMap`** (default) opens Map View via `visualizer/mcp/open_map.json` when the extension is running; there is no separate MCP “open graph” tool.
- **`write_workflow_graph`** (advanced) — `steps` are `{ id, label, detail? }`. **`id` is the graph node key** (for optional **edges** `from` / `to`). Many examples use short strings like `"1"`, `"2"` so edges can say `1→2`; those are **not** file paths. If you need each node to be a file and double-click to open, either use **repo-relative paths as `id`** (if you use this advanced tool) or prefer **`write_flow_file_graph`**, which uses **`filePath`** and **`order`** so the model does not mix up keys and paths.

Files are read from:

`{EXPLORER_MAP_WORKSPACE_ROOT}/md/{skills|learnings|architecture|mistakes|working}.md`

If a file is missing, create it once from the Map View (md handler) or add the `md/` folder and files under your workspace.

### `write_flow_file_graph` parameters

- **`title`** — flow title (route and filename).
- **`files`** — JSON array of `{ "order"?, "fileName", "filePath", "role" }` (or the same coercions as `steps`: numeric map or single object). The server **sorts by `order`** (then by input order).  
  **`filePath` must be a string:** the path from the workspace root to the file (e.g. `src/routes/index.ts`). Do not put a step index in `filePath`—use `order` for that—so the node id is a real path and **double-click opens** the file. Avoid short paths that miss a parent folder (e.g. `routes/x.ts` when the file is under `src/`).
- **`openInMap`** (optional) — default `true`: writes **`visualizer/mcp/open_map.json`**. A running **File Graph / Explorer Map** host loads the graph, focuses Map View, then deletes the file.

### `write_workflow_graph` parameters (advanced)

- **`title`**, **`steps`**, optional **`edges`**, optional **`openInMap`** — see server tool descriptions. **Why numeric `id`s?** In this tool, `"1"`, `"2"` are only **unique key strings** for the node list and for **edges**—they are *not* “the file at address 1” and must not be confused with **`filePath` in `write_flow_file_graph`**. Prefer **`write_flow_file_graph`** for normal file flows so the agent uses **order** + **filePath** explicitly.

## Build

From this directory:

```bash
npm install
npm run build
```

This produces `dist/index.js` (bundled; no `node_modules` required at runtime).

## Run manually (debug)

The process reads/writes JSON-RPC on stdin/stdout. In a normal shell it will appear idle until an MCP client connects.

```bash
export EXPLORER_MAP_WORKSPACE_ROOT="/path/to/your/cursor-workspace"
node dist/index.js
```

You can also use **Explorer Map → Features → MCP (md notes) → Open MCP server in terminal** (if enabled in settings).

## Register from Explorer Map (toggle)

Use the checkmark in **Explorer Map → Features → MCP (md notes)**. It always **merges** the `explorer-map-md` stdio block into **`.cursor/mcp.json`** (and, by default, **`~/.cursor/mcp.json`**) with absolute paths to the bundled `dist/index.js` and `EXPLORER_MAP_WORKSPACE_ROOT` — that is what **Cursor’s chat Agent** uses to discover `read_md_handler_file`. The extension may also use **`registerMcpServerDefinitionProvider`**, but you should not rely on that alone. The extension can **reload the window automatically** after a successful toggle (default: `apiGraphVisualizer.mcp.autoReloadWindowOnToggle`). After reload, start a **new** chat. Do not hand-edit the files for the default flow.

## Cursor Agent configuration (manual, optional)

In Cursor’s MCP settings, add a `stdio` server, for example:

```json
{
  "mcpServers": {
    "explorer-map-md": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-md-handler/dist/index.js"],
      "env": {
        "EXPLORER_MAP_WORKSPACE_ROOT": "/absolute/path/to/your-workspace"
      }
    }
  }
}
```

When the extension is installed from a VSIX, get the path to the bundled `mcp-md-handler/dist/index.js` from the extension’s install directory, or use **Copy Cursor MCP config** in **Explorer Map → Features** (uses your current workspace and extension paths).

`EXPLORER_MAP_WORKSPACE_ROOT` must be the folder you opened in VS Code/Cursor (the one that contains the `md/` directory), not the `md` folder itself.

## Agent does not list Explorer Map MCP tools?

The **Chat / Agent** only sees tools for MCP servers that **Cursor** starts from your **`mcp.json`**. The Explorer Map **“Open MCP server in terminal”** button is for **debug only**; it does **not** connect that process to the Agent.

Do this if the **Explorer Map checkmark** did not register the server (e.g. you need the JSON for another machine):

1. Prefer the checkmark, or **Copy Cursor MCP config** in Explorer Map → Features → MCP.
2. Save into **`~/.cursor/mcp.json`** and/or **`<your-workspace>/.cursor/mcp.json`** as needed.
3. In **Cursor → Settings → MCP**, make sure the **`explorer-map-md` server is enabled** (toggle on).
4. **Fully quit and restart Cursor** (reload window is sometimes not enough for MCP to pick up changes).
5. Open a **new** Agent / chat that supports tools.
6. If the server still fails, open **Output** and select **MCP** (or similar) in the dropdown and read the error. Common issues:
   - **`node` not found**: Cursor’s environment may not see nvm. In VS Code/Explorer Map settings, set **`apiGraphVisualizer.mcp.nodeExecutable`** to the full path from `which node` (or e.g. `/opt/homebrew/bin/node` on macOS), then **Copy** the config again.
   - **Invalid JSON**: a trailing comma or bad merge can make Cursor ignore the whole file.
   - **Many MCP servers**: Cursor can hit a high tool count; try temporarily **disabling** other servers to confirm `explorer-map-md` loads.
   - **Browser / other tool names**: the Agent not listing `browser_tabs` is a **different** server (`cursor-ide-browser`); enable that server in MCP settings separately.

## Notes

- The Cursor / VS Code process that runs this server for the Agent is **separate** from any terminal the extension opens for visibility; you may have two `node` processes if both are running. That is expected while debugging.
- The extension does not replace Cursor’s MCP process manager; it only helps with paths, copying config, and (optionally) a visible terminal.
