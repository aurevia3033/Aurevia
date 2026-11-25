import 'server-only';
import {getServerConfiguration} from './config/env';

export const kycEvidenceBucket = 'kyc-evidence';

export type KycSupabaseClient = {
  url: string;
  bucket: typeof kycEvidenceBucket;
  request(path: string, init?: RequestInit): Promise<Response>;
};

export function createKycSupabaseClient(): KycSupabaseClient {
  const config = getServerConfiguration().kycStorage;
  if (!config.url || !config.serviceRoleKey) {
    throw new Error('KYC_STORAGE_CONFIGURATION_MISSING');
  }

  try {
    const parsed = new URL(config.url);
    const isLocalHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    if ((parsed.protocol !== 'https:' && !isLocalHttp)
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash) {
      throw new Error('KYC_STORAGE_URL_INVALID');
    }
  } catch {
    throw new Error('KYC_STORAGE_URL_INVALID');
  }

  const serviceRoleKey = config.serviceRoleKey;
  return {
    url: config.url,
    bucket: config.bucket,
    request(path, init = {}) {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${serviceRoleKey}`);
      headers.set('apikey', serviceRoleKey);
      return fetch(`${config.url}/storage/v1/${path}`, {...init, headers});
    },
  };
}
