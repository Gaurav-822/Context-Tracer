# Context-Tracer

Context-Tracer is a VS Code extension for poking around large backends without getting lost. You point it at dependency data for your API routes, and it draws an interactive graph: which files talk to which, where controllers sit, and where things get circular. Handy when onboarding, refactoring, or trying to remember how a route actually reaches the database.

## What you actually see

The main view is a force-directed graph built with [vis-network](https://visjs.org/). Nodes are files (paths as labels); edges are imports / dependency edges from your data. A small stats line shows how many files and connections you’re looking at.

Colors are meant to be scannable:

- **Green** — API route entry  
- **Purple** — Controller  
- **Blue** — Ordinary file in the dependency tree  
- **Red** — Marked as a circular dependency in the graph data  
- **Yellow** — Part of the trace you’re currently following  

There’s a **Center** control to pull the layout back when you’ve zoomed or panned into nowhere.

On the left, the **API Graph** activity bar holds two pieces: **Build From File** (queue TS/JS files, optional “Use AI” path) and **Trace Graph** (filters, find file, node size slider, auto-follow, and details for whatever node you selected—packages, open in editor, etc.).

## How graphs get into the tool

You need JSON that describes routes and their dependency trees. The extension looks for `api_graph_output.json` in either:

- `visualizer/api_graph_output.json`, or  
- the workspace root as `api_graph_output.json`

If that file shows up or changes, the extension can pick it up and refresh.

From the Trace sidebar you can kick off a **mapper** run: it opens a terminal and runs the bundled `makeMap.ts` script with `npx ts-node`, using your workspace root as `PROJECT_ROOT`. There’s an optional LLM flag on that flow when you want summaries or analysis that goes beyond static parsing (you’ll need whatever API keys or setup that script expects).

Separately, you can build smaller **import graphs** from individual files—via the tree, editor title actions, or the explorer context menu on `.ts` / `.js` files. Output can land in paths like `file_graph_output.json` or under `visualizer/files_named/`, which the extension also watches.

If you already have JSON from another pipeline, as long as it matches the shape the extension expects (`apis` with routes, `dependencies`, file names, optional circular flags, etc.), you can still open it through the command palette.

## Useful commands

Open the Command Palette and search for **API Graph** to find actions like:

- Open the visualizer  
- Select a JSON file manually  
- Build graph from the current editor file  
- Focus the current file’s node in the graph (when it exists in the loaded data)

Editor title buttons appear when relevant so you’re not living in the palette.

## Developing the extension

Clone the repo, then from this directory:

```bash
npm install
npm run build
```

Use **Run Extension** from the Debug view (or F5) with this folder open in VS Code. `npm run watch` keeps `esbuild` rebuilding while you hack.

Publishing still goes through the usual `vsce` flow; bump `version` in `package.json` when you cut a release.

## Requirements

- VS Code **1.85** or newer  
- For mapper / file-graph scripts: Node on your machine, and `ts-node` available where the terminal can run it (`npx` is used in the shipped commands)  
- A git repo in the workspace if you want optional “recently touched” style metadata computed locally (fails quietly if not)

---

If something’s confusing in the UI, that’s worth fixing—file an issue or patch the webview in `media/`. Pull requests welcome.
