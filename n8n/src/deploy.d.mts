export const DEPLOY_ORDER: string[];
export class N8nApiError extends Error {
  status: number;
}
export type Api = (method: string, path: string, body?: object) => Promise<any>;
export function toPayload(workflow: object, errorWorkflowId?: string): Record<string, any>;
export function createClient(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }): Api;
export interface DeployResult {
  key: string;
  id: string;
  action: string;
  active?: boolean;
  activationError?: string;
  dryRun?: boolean;
}
export function deployWorkflows(opts: {
  workflows: Record<string, any>;
  api: Api;
  only?: string[];
  activate?: boolean;
  dryRun?: boolean;
  backup?: (key: string, existing: any) => void;
  log?: (msg: string) => void;
}): Promise<DeployResult[]>;
export function restoreWorkflow(opts: { api: Api; backupJson: any }): Promise<string>;
