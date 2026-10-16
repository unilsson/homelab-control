import { readFileSync } from 'node:fs';
import { InfisicalSDK } from '@infisical/sdk';

/**
 * Server-side secret provider for read-only integrations.
 * Infisical API responses and machine credentials are never logged or sent to clients.
 */
const refreshMs = 5 * 60_000;
const maxStaleMs = 60 * 60_000;

type CachedValue = { value: string; fetchedAt: number };
type PublicState = 'disabled' | 'idle' | 'online' | 'degraded' | 'error';

export type SecretProviderStatus = {
  provider: 'infisical';
  configured: boolean;
  state: PublicState;
  lastCheckedAt: string | null;
  message?: string;
};

const cache = new Map<string, CachedValue>();
const pending = new Map<string, Promise<string>>();
let state: PublicState = 'disabled';
let lastCheckedAt: string | null = null;
let message: string | undefined;

function bootstrapSecret(): string {
  const file = process.env.INFISICAL_CLIENT_SECRET_FILE?.trim();
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      throw new Error('Infisical bootstrap secret file cannot be read.');
    }
  }
  return process.env.INFISICAL_CLIENT_SECRET?.trim() ?? '';
}

type InfisicalConfig = {
  siteUrl: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  secretPath: string;
};

function readConfig(): InfisicalConfig {
  const siteUrl = process.env.INFISICAL_SITE_URL?.trim() ?? '';
  const clientId = process.env.INFISICAL_CLIENT_ID?.trim() ?? '';
  const clientSecret = bootstrapSecret();
  const projectId = process.env.INFISICAL_PROJECT_ID?.trim() ?? '';
  const environment = process.env.INFISICAL_ENV?.trim() || 'dev';
  const secretPath = process.env.INFISICAL_SECRET_PATH?.trim() || '/';
  if (!siteUrl || !clientId || !clientSecret || !projectId) {
    throw new Error('Infisical requires site URL, project ID, machine client ID and client secret.');
  }
  try {
    const url = new URL(siteUrl);
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error('bad url');
  } catch {
    throw new Error('Infisical SITE_URL must be a trusted HTTPS origin.');
  }
  if (!secretPath.startsWith('/')) {
    throw new Error('Infisical secret path must begin with /.');
  }
  return { siteUrl, clientId, clientSecret, projectId, environment, secretPath };
}

export function getInfisicalStatus(): SecretProviderStatus {
  const configured = Boolean(
    process.env.INFISICAL_SITE_URL?.trim() &&
    process.env.INFISICAL_PROJECT_ID?.trim() &&
    process.env.INFISICAL_CLIENT_ID?.trim() &&
    (process.env.INFISICAL_CLIENT_SECRET_FILE?.trim() ||
      process.env.INFISICAL_CLIENT_SECRET?.trim())
  );
  return {
    provider: 'infisical',
    configured,
    state: !configured ? 'disabled' : state === 'disabled' ? 'idle' : state,
    lastCheckedAt,
    ...(message ? { message } : {})
  };
}

/**
 * Retrieve one named secret. Cache 5 minutes; on a brief Infisical outage
 * continue to use a previously validated value in memory for up to 1 hour.
 * Nothing is written to disk, SQLite, or browser responses.
 */
export function getInfisicalSecret(secretName: string): Promise<string> {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(secretName)) {
    return Promise.reject(new Error('Invalid Infisical secret reference.'));
  }
  const existing = cache.get(secretName);
  if (existing && Date.now() - existing.fetchedAt < refreshMs) {
    return Promise.resolve(existing.value);
  }

  const inflight = pending.get(secretName);
  if (inflight) return inflight;

  const run = (async (): Promise<string> => {
    try {
      const config = readConfig();
      const client = new InfisicalSDK({ siteUrl: config.siteUrl });
      await client.auth().universalAuth.login({
        clientId: config.clientId,
        clientSecret: config.clientSecret
      });
      const response = await client.secrets().getSecret({
        projectId: config.projectId,
        environment: config.environment,
        secretPath: config.secretPath,
        secretName,
        type: 'shared',
        viewSecretValue: true
      });
      const value = response.secretValue;
      if (typeof value !== 'string' || !value.length) {
        throw new Error('Empty secret');
      }
      cache.set(secretName, { value, fetchedAt: Date.now() });
      state = 'online';
      message = undefined;
      lastCheckedAt = new Date().toISOString();
      return value;
    } catch {
      lastCheckedAt = new Date().toISOString();
      const lastGood = cache.get(secretName);
      if (lastGood && Date.now() - lastGood.fetchedAt < maxStaleMs) {
        state = 'degraded';
        message = 'Infisical is unavailable; using a recent in-memory value.';
        return lastGood.value;
      }
      state = 'error';
      message = 'Cannot retrieve required secrets from Infisical.';
      throw new Error('Required secret unavailable from Infisical.');
    }
  })().finally(() => { pending.delete(secretName); });

  pending.set(secretName, run);
  return run;
}
