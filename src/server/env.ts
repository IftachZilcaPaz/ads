/**
 * Runtime-neutral env access: Netlify exposes `Netlify.env` in both Node
 * functions and Deno edge functions; `process.env` covers local tests.
 */
declare const Netlify: { env: { get(name: string): string | undefined } } | undefined;

export function readEnv(name: string): string | undefined {
  const fromNetlify = typeof Netlify !== 'undefined' ? Netlify.env.get(name) : undefined;
  if (fromNetlify !== undefined && fromNetlify !== '') return fromNetlify;
  const fromProcess = typeof process !== 'undefined' ? process.env[name] : undefined;
  return fromProcess === '' ? undefined : fromProcess;
}

export function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) throw new ConfigError(`Missing environment variable ${name}`);
  return value;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}
