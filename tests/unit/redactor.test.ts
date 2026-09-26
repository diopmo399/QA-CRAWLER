import { describe, expect, it } from 'vitest';
import { REDACTED, redactText, redactUrl } from '../../src/security/redactor.js';

describe('redactUrl', () => {
  it('hides sensitive query parameters and embedded credentials', () => {
    expect(redactUrl('https://x.test/api?access_token=abc&page=2')).toBe(
      `https://x.test/api?access_token=${REDACTED}&page=2`,
    );
    expect(redactUrl('https://user:pass@x.test/')).toBe(`https://${REDACTED}:${REDACTED}@x.test/`);
    expect(redactUrl('https://x.test/#/reset?token=abc')).toBe(`https://x.test/#/reset?token=${REDACTED}`);
  });

  it('leaves harmless URLs untouched', () => {
    expect(redactUrl('https://x.test/users?page=2&sort=name')).toBe('https://x.test/users?page=2&sort=name');
    expect(redactUrl('not a url')).toBe('not a url');
  });
});

describe('redactText', () => {
  it('hides bearer tokens, JWTs, headers and password assignments', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const text = `Authorization: Bearer abcdef123456 token=${jwt} password=hunter2 cookie: SESSION=xyz; "apiKey": "k-123"`;
    const redacted = redactText(text);
    for (const secret of ['abcdef123456', jwt, 'hunter2', 'SESSION=xyz', 'k-123']) {
      expect(redacted).not.toContain(secret);
    }
  });

  it('redacts URLs inside messages', () => {
    expect(redactText('GET https://x.test/api?api_key=zzz failed')).toBe(
      `GET https://x.test/api?api_key=${REDACTED} failed`,
    );
  });

  it('keeps ordinary messages readable', () => {
    expect(redactText('TypeError: cannot read properties of undefined')).toBe(
      'TypeError: cannot read properties of undefined',
    );
  });
});
