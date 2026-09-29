export interface N8nNode {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  [key: string]: unknown;
}
export interface N8nWorkflow {
  name: string;
  id: string;
  nodes: N8nNode[];
  connections: Record<string, { main: { node: string }[][] }>;
  settings: Record<string, unknown>;
}
export const WORKFLOWS: Record<string, N8nWorkflow>;
