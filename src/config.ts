export type AppEnv = 'development' | 'test' | 'production';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LimitsConfig {
  ipMinute: number;
  ipHour: number;
  ipDay: number;
  subnetDay: number;
  ipDistinctDevicesDay: number;
  deviceMinute: number;
  deviceHour: number;
  deviceDay: number;
  freshDeviceHours: number;
  freshDeviceDay: number;
  contractFailsPerHour: number;
}

export interface Config {
  env: AppEnv;
  port: number;
  logLevel: LogLevel;
  databasePath: string;
  /** HMAC-секрет: все идентификаторы (device id, ip) попадают в БД только в виде hmac(secret, value). */
  hmacSecret: string;
  /** Доверять X-Forwarded-For (только за собственным реверс-прокси). */
  trustProxy: boolean;
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  upstreamModel: string;
  upstreamTimeoutMs: number;
  requestBudgetMs: number;
  correctiveRetry: boolean;
  maxBodyBytes: number;
  maxSystemChars: number;
  maxUserChars: number;
  globalMaxInflight: number;
  globalDailyRequestCap: number;
  globalDailyTokenCap: number;
  limits: LimitsConfig;
}

function readString(env: Record<string, string | undefined>, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

function readInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Config: ${name} must be a positive number, got "${raw}"`);
  }
  return Math.floor(value);
}

/**
 * Целое без дефолта: все лимиты и глобальные предохранители оператор задаёт
 * явно — фактические пороги деплоя не должны быть публичной константой кода.
 */
function readRequiredInt(env: Record<string, string | undefined>, name: string): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`Config: ${name} is required (no default) — set it in the environment`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Config: ${name} must be a positive number, got "${raw}"`);
  }
  return Math.floor(value);
}

function readBool(env: Record<string, string | undefined>, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim() === 'true' || raw.trim() === '1';
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const APP_ENVS: readonly AppEnv[] = ['development', 'test', 'production'];

export function loadConfig(env: Record<string, string | undefined>): Config {
  const appEnvRaw = readString(env, 'APP_ENV', 'development');
  if (!APP_ENVS.includes(appEnvRaw as AppEnv)) {
    throw new Error(`Config: APP_ENV must be one of ${APP_ENVS.join('|')}, got "${appEnvRaw}"`);
  }
  const appEnv = appEnvRaw as AppEnv;
  const production = appEnv === 'production';

  const hmacSecret = readString(env, 'HMAC_SECRET', '');
  if (production && hmacSecret.length < 32) {
    throw new Error('Config: HMAC_SECRET is required in production (openssl rand -hex 32)');
  }

  const upstreamApiKey = readString(env, 'DEEPSEEK_API_KEY', '');
  if (production && upstreamApiKey === '') {
    throw new Error('Config: DEEPSEEK_API_KEY is required in production');
  }

  const logLevelRaw = readString(env, 'LOG_LEVEL', 'info');
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) {
    throw new Error(`Config: LOG_LEVEL must be one of ${LOG_LEVELS.join('|')}, got "${logLevelRaw}"`);
  }

  return {
    env: appEnv,
    port: readInt(env, 'PORT', 8080),
    logLevel: logLevelRaw as LogLevel,
    databasePath: readString(env, 'DATABASE_PATH', './data/focuspin.db'),
    hmacSecret: hmacSecret === '' ? 'dev-insecure-hmac-secret' : hmacSecret,
    trustProxy: readBool(env, 'TRUST_PROXY', false),
    upstreamBaseUrl: readString(env, 'DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
    upstreamApiKey: upstreamApiKey === '' ? 'dev-missing-key' : upstreamApiKey,
    upstreamModel: readString(env, 'DEEPSEEK_MODEL', 'deepseek-flash'),
    upstreamTimeoutMs: readInt(env, 'UPSTREAM_TIMEOUT_MS', 40_000),
    requestBudgetMs: readInt(env, 'REQUEST_BUDGET_MS', 42_000),
    correctiveRetry: readBool(env, 'CORRECTIVE_RETRY', true),
    maxBodyBytes: readInt(env, 'MAX_BODY_BYTES', 65_536),
    maxSystemChars: readInt(env, 'MAX_SYSTEM_CHARS', 8_000),
    maxUserChars: readInt(env, 'MAX_USER_CHARS', 48_000),
    globalMaxInflight: readRequiredInt(env, 'GLOBAL_MAX_INFLIGHT'),
    globalDailyRequestCap: readRequiredInt(env, 'GLOBAL_DAILY_REQUEST_CAP'),
    globalDailyTokenCap: readRequiredInt(env, 'GLOBAL_DAILY_TOKEN_CAP'),
    limits: {
      ipMinute: readRequiredInt(env, 'LIMIT_IP_MINUTE'),
      ipHour: readRequiredInt(env, 'LIMIT_IP_HOUR'),
      ipDay: readRequiredInt(env, 'LIMIT_IP_DAY'),
      subnetDay: readRequiredInt(env, 'LIMIT_SUBNET_DAY'),
      ipDistinctDevicesDay: readRequiredInt(env, 'LIMIT_IP_DISTINCT_DEVICES_DAY'),
      deviceMinute: readRequiredInt(env, 'LIMIT_DEVICE_MINUTE'),
      deviceHour: readRequiredInt(env, 'LIMIT_DEVICE_HOUR'),
      deviceDay: readRequiredInt(env, 'LIMIT_DEVICE_DAY'),
      freshDeviceHours: readRequiredInt(env, 'LIMIT_FRESH_DEVICE_HOURS'),
      freshDeviceDay: readRequiredInt(env, 'LIMIT_FRESH_DEVICE_DAY'),
      contractFailsPerHour: readRequiredInt(env, 'LIMIT_CONTRACT_FAILS_PER_HOUR'),
    },
  };
}
