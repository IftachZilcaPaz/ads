export function loadEnv(root: string): Record<string, string | undefined>;
export function localValues(env: Record<string, string | undefined>): { values: Record<string, string>; missing: string[] };
export function localize<T>(workflow: T, values: Record<string, string>): T;
