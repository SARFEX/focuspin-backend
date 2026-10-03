import { describe, expect, test } from 'bun:test';
import { hmacHex } from '../util/hmac.ts';
import { deriveIdentity, subnetOf, validateFocuspinDeviceId } from './device.ts';

const HEX32 = '0123456789abcdef0123456789abcdef';

describe('validateFocuspinDeviceId', () => {
  test('accepts 32 hex chars unchanged', () => {
    expect(validateFocuspinDeviceId(HEX32)).toBe(HEX32);
  });

  test('accepts 32 hex chars with rotation counter', () => {
    expect(validateFocuspinDeviceId(`${HEX32}_42`)).toBe(`${HEX32}_42`);
  });

  test('normalizes uppercase and surrounding whitespace', () => {
    expect(validateFocuspinDeviceId(`  ${HEX32.toUpperCase()} \n`)).toBe(HEX32);
  });

  test('accepts total length exactly 128', () => {
    const padded = `${HEX32}_${'9'.repeat(95)}`;
    expect(padded.length).toBe(128);
    expect(validateFocuspinDeviceId(padded)).toBe(padded);
  });

  test('rejects 31 chars', () => {
    expect(validateFocuspinDeviceId(HEX32.slice(1))).toBeNull();
  });

  test('rejects 33 chars', () => {
    expect(validateFocuspinDeviceId(`${HEX32}f`)).toBeNull();
  });

  test('rejects non-hex characters', () => {
    expect(validateFocuspinDeviceId('z123456789abcdef0123456789abcdef')).toBeNull();
    expect(validateFocuspinDeviceId(`${HEX32.slice(0, 31)}g`)).toBeNull();
  });

  test('rejects negative or non-numeric rotation counter', () => {
    expect(validateFocuspinDeviceId(`${HEX32}_-1`)).toBeNull();
    expect(validateFocuspinDeviceId(`${HEX32}_x`)).toBeNull();
  });

  test('rejects counter-only and underscore-suffixed junk', () => {
    expect(validateFocuspinDeviceId('_42')).toBeNull();
    expect(validateFocuspinDeviceId(`${HEX32}_`)).toBeNull();
  });

  test('rejects empty and whitespace-only input', () => {
    expect(validateFocuspinDeviceId('')).toBeNull();
    expect(validateFocuspinDeviceId('   ')).toBeNull();
  });

  test('rejects length over 128', () => {
    const tooLong = `${HEX32}_${'9'.repeat(96)}`;
    expect(tooLong.length).toBe(129);
    expect(validateFocuspinDeviceId(tooLong)).toBeNull();
  });
});

describe('subnetOf', () => {
  test('IPv4 groups by /24', () => {
    expect(subnetOf('192.168.10.55')).toBe('v4/24:192.168.10');
    expect(subnetOf('1.2.3.4')).toBe('v4/24:1.2.3');
  });

  test('IPv6 groups by first 4 hextets', () => {
    expect(subnetOf('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('v6/64:2001:0db8:85a3:0000');
    expect(subnetOf('2001:db8::1')).toBe('v6/64:2001:db8:1');
  });

  test('unknown input yields unknown', () => {
    expect(subnetOf('not-an-ip')).toBe('unknown');
    expect(subnetOf('')).toBe('unknown');
    expect(subnetOf('1.2.3')).toBe('unknown');
    expect(subnetOf('999.1.1.1')).toBe('unknown');
    expect(subnetOf('::')).toBe('unknown');
  });
});

describe('deriveIdentity', () => {
  const secret = 'test-secret';
  const device = 'device-1';
  const ip = '203.0.113.7';

  test('is stable across calls', () => {
    expect(deriveIdentity(secret, device, ip)).toEqual(deriveIdentity(secret, device, ip));
  });

  test('components are hmac of the corresponding inputs', () => {
    const keys = deriveIdentity(secret, device, ip);
    expect(keys.idkey).toBe(hmacHex(secret, device));
    expect(keys.ipkey).toBe(hmacHex(secret, ip));
    expect(keys.subnetkey).toBe(hmacHex(secret, subnetOf(ip)));
  });

  test('differs per secret, device and ip', () => {
    const base = deriveIdentity(secret, device, ip);
    expect(deriveIdentity('other-secret', device, ip).idkey).not.toBe(base.idkey);
    expect(deriveIdentity(secret, 'device-2', ip).idkey).not.toBe(base.idkey);
    expect(deriveIdentity(secret, device, '198.51.100.1').ipkey).not.toBe(base.ipkey);
  });

  test('hosts in one subnet share subnetkey, other subnets do not', () => {
    const a = deriveIdentity(secret, device, '10.1.2.3');
    const b = deriveIdentity(secret, device, '10.1.2.99');
    const c = deriveIdentity(secret, device, '10.1.3.3');
    expect(a.subnetkey).toBe(b.subnetkey);
    expect(a.subnetkey).not.toBe(c.subnetkey);
  });
});
