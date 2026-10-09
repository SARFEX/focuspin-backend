import { describe, expect, test } from 'bun:test';
import { loadConfig } from './config.ts';

/** Минимальный валидный набор: тестовое окружение + все обязательные числа. */
const BASE_ENV: Record<string, string> = {
  APP_ENV: 'test',
  GLOBAL_MAX_INFLIGHT: '8',
  GLOBAL_DAILY_REQUEST_CAP: '1000',
  GLOBAL_DAILY_TOKEN_CAP: '1000000',
  LIMIT_IP_MINUTE: '15',
  LIMIT_IP_HOUR: '60',
  LIMIT_IP_DAY: '300',
  LIMIT_SUBNET_DAY: '1200',
  LIMIT_IP_DISTINCT_DEVICES_DAY: '6',
  LIMIT_DEVICE_MINUTE: '6',
  LIMIT_DEVICE_HOUR: '15',
  LIMIT_DEVICE_DAY: '50',
  LIMIT_FRESH_DEVICE_HOURS: '24',
  LIMIT_FRESH_DEVICE_DAY: '15',
  LIMIT_CONTRACT_FAILS_PER_HOUR: '10',
  LIMIT_REFERRAL_DEVICE_DAY: '10',
  LIMIT_REFERRAL_IP_DAY: '30',
  LIMIT_INSTALL_IP_DAY: '200',
  LIMIT_POST_CLAIM_EMAIL_DAY: '3',
  IP_RETENTION_DAYS: '90',
};

describe('config: рефералы и установки', () => {
  test('минимальный набор: дефолты пакета Play, админка выключена', () => {
    const config = loadConfig(BASE_ENV);
    expect(config.referral.playPackageId).toBe('dev.sarfex.focuspin');
    expect(config.referral.adminToken).toBe('');
    expect(config.referral.publicBaseUrl).toBe('');
    expect(config.referral.ipRetentionDays).toBe(90);
    expect(config.limits.referralDeviceDay).toBe(10);
    expect(config.limits.postClaimEmailDay).toBe(3);
  });

  test.each([
    'LIMIT_REFERRAL_DEVICE_DAY',
    'LIMIT_REFERRAL_IP_DAY',
    'LIMIT_INSTALL_IP_DAY',
    'LIMIT_POST_CLAIM_EMAIL_DAY',
    'IP_RETENTION_DAYS',
  ])('%s обязателен: без значения конфиг не собирается', (name) => {
    const env = { ...BASE_ENV };
    delete env[name];
    expect(() => loadConfig(env)).toThrow(`${name} is required (no default)`);
  });

  test('ADMIN_TOKEN короче 32 символов отвергается, длинный принимается', () => {
    expect(() => loadConfig({ ...BASE_ENV, ADMIN_TOKEN: 'short' })).toThrow('ADMIN_TOKEN');
    const token = 'x'.repeat(32);
    expect(loadConfig({ ...BASE_ENV, ADMIN_TOKEN: token }).referral.adminToken).toBe(token);
  });

  test('PLAY_PACKAGE_ID: override и валидация формата', () => {
    expect(loadConfig({ ...BASE_ENV, PLAY_PACKAGE_ID: 'com.example.app' }).referral.playPackageId).toBe('com.example.app');
    expect(() => loadConfig({ ...BASE_ENV, PLAY_PACKAGE_ID: 'no spaces&evil=1' })).toThrow('PLAY_PACKAGE_ID');
  });

  test('PUBLIC_BASE_URL: нормализуется до origin; путь отвергается; в production обязателен и только https', () => {
    expect(loadConfig({ ...BASE_ENV, PUBLIC_BASE_URL: 'https://api.example.com/' }).referral.publicBaseUrl).toBe(
      'https://api.example.com',
    );
    expect(() => loadConfig({ ...BASE_ENV, PUBLIC_BASE_URL: 'https://api.example.com/path' })).toThrow('PUBLIC_BASE_URL');
    expect(() => loadConfig({ ...BASE_ENV, PUBLIC_BASE_URL: 'not a url' })).toThrow('PUBLIC_BASE_URL');

    const prod = { ...BASE_ENV, APP_ENV: 'production', HMAC_SECRET: 'h'.repeat(32), DEEPSEEK_API_KEY: 'k' };
    expect(() => loadConfig(prod)).toThrow('PUBLIC_BASE_URL is required in production');
    expect(() => loadConfig({ ...prod, PUBLIC_BASE_URL: 'http://api.example.com' })).toThrow('PUBLIC_BASE_URL');
    expect(loadConfig({ ...prod, PUBLIC_BASE_URL: 'https://api.example.com' }).referral.publicBaseUrl).toBe(
      'https://api.example.com',
    );
  });
});
