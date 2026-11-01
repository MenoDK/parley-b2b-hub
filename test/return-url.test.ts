import { describe, expect, it } from 'vitest';
import { allowedReturnUrl } from '../src/lib/return-url.js';

const allowed = ['https://shop.example.com', 'https://app.example.com:8443'];

describe('return URL allow-list', () => {
  it('accepts a listed origin, with any path', () => {
    expect(allowedReturnUrl('https://shop.example.com/orders/7?x=1', allowed)).toBe(
      'https://shop.example.com/orders/7?x=1',
    );
    expect(allowedReturnUrl('https://app.example.com:8443/', allowed)).toBe('https://app.example.com:8443/');
  });

  it.each([
    ['a look-alike that starts with the trusted host', 'https://shop.example.com.evil.test/login'],
    ['a trusted name as userinfo', 'https://shop.example.com@evil.test/'],
    ['credentials on a trusted origin', 'https://user:pass@shop.example.com/'],
    ['plain http', 'http://shop.example.com/'],
    ['another port', 'https://shop.example.com:4443/'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a protocol-relative URL', '//evil.test/'],
    ['text', 'not a url'],
    ['empty', ''],
  ])('refuses %s', (_name, url) => {
    expect(allowedReturnUrl(url, allowed)).toBeNull();
  });

  it('refuses everything when the list is empty (fail closed), and accepts loopback http only when asked', () => {
    expect(allowedReturnUrl('https://shop.example.com/', [])).toBeNull();
    expect(allowedReturnUrl('http://localhost:8000/back', ['http://localhost:8000'])).toBeNull();
    expect(allowedReturnUrl('http://localhost:8000/back', ['http://localhost:8000'], { allowLoopbackHttp: true })).toBe(
      'http://localhost:8000/back',
    );
    expect(
      allowedReturnUrl('http://shop.example.com/', ['http://shop.example.com'], { allowLoopbackHttp: true }),
    ).toBeNull();
  });
});
