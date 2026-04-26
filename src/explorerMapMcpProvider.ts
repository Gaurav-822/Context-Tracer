import * as vscode from 'vscode';

const PROVIDER_ID = 'apiGraphVisualizer.explorerMapMd';

let definitionsChanged: vscode.EventEmitter<void> | undefined;

/** True when the host exposes VS Code’s programmatic MCP server API (no mcp.json required). */
export function canUseMcpServerDefinitionProvider(): boolean {
  return typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function';
}

export function fireExplorerMapMcpDefinitionsChanged(): void {
  definitionsChanged?.fire();
}

type ProvideMcp = () => vscode.ProviderResult<vscode.McpServerDefinition[]>;

/**
 * Registers the Explorer Map stdio MCP with the editor. When the definition list
 * is empty, the server is off; when it contains the stdio definition, the editor
 * starts the process and exposes tools to the agent.
 */
export function registerExplorerMapMcpDefinitionProvider(
  context: vscode.ExtensionContext,
  provideDefinitions: ProvideMcp
): vscode.Disposable | undefined {
  if (!canUseMcpServerDefinitionProvider()) {
    return undefined;
  }
  if (!definitionsChanged) {
    definitionsChanged = new vscode.EventEmitter<void>();
  }
  const d = vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
    onDidChangeMcpServerDefinitions: definitionsChanged.event,
    provideMcpServerDefinitions: (token) => provideDefinitions() ?? Promise.resolve([]),
  });
  context.subscriptions.push(d);
  return d;
}
