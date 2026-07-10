import { describe, it, expect } from 'vitest'
import {
  looksLikeSecret,
  sanitizeValue,
  redactEmbeddedSecrets,
  REDACTED,
  MAX_VALUE_LENGTH,
} from './secrets'

describe('looksLikeSecret', () => {
  it.each([
    ['OpenAI-style key', 'sk-proj-abc123def456'],
    ['GitHub personal token', 'ghp_abc123def456'],
    ['GitHub OAuth token', 'gho_abc123'],
    ['GitHub server token', 'ghs_abc123'],
    ['GitHub fine-grained PAT', 'github_pat_abc_123'],
    ['Bearer token', 'Bearer eyJhbGciOiJIUzI1NiJ9'],
    ['Basic auth', 'Basic dXNlcjpwYXNz'],
    ['generic token prefix', 'token abc123'],
    ['Slack token', 'xoxb-123-456-abc'],
    ['AWS access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['JWT token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'],
    ['password= pattern', 'password=mysecret'],
    ['40-char hex token', 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'],
    ['npm token', 'npm_abc123def456'],
    ['PyPI token', 'pypi-AgEIcHlwaS5vcmc'],
    ['ENV_VAR=sk- pattern', 'OPENAI_API_KEY=sk-abc123'],
    ['_KEY=value pattern', 'STRIPE_KEY=whatever'],
  ])('detects %s', (_label, value) => {
    expect(looksLikeSecret(value)).toBe(true)
  })

  it('detects secrets with surrounding whitespace', () => {
    expect(looksLikeSecret('  sk-abc123  ')).toBe(true)
  })

  it.each([
    ['plain file path', 'src/index.ts'],
    ['ordinary command', 'npm install express'],
    ['short hex (not 40 chars)', 'deadbeef'],
    ['empty string', ''],
  ])('does not flag %s', (_label, value) => {
    expect(looksLikeSecret(value)).toBe(false)
  })
})

describe('sanitizeValue', () => {
  it('redacts secret values', () => {
    expect(sanitizeValue('ghp_abc123def456')).toBe(REDACTED)
  })

  it('redacts values longer than MAX_VALUE_LENGTH', () => {
    expect(sanitizeValue('a'.repeat(MAX_VALUE_LENGTH + 1))).toBe(REDACTED)
  })

  it('keeps values at exactly MAX_VALUE_LENGTH', () => {
    const value = 'a'.repeat(MAX_VALUE_LENGTH)
    expect(sanitizeValue(value)).toBe(value)
  })

  it('returns non-secret values unchanged', () => {
    expect(sanitizeValue('git push')).toBe('git push')
  })

  it('redacts a Bearer token embedded mid-command', () => {
    const value =
      "curl -H 'Authorization: Bearer sk-live-4eC39HqLyjWDarjtT1zdp' https://api.example.com/v1"
    const result = sanitizeValue(value)
    expect(result).not.toContain('sk-live-4eC39HqLyjWDarjtT1zdp')
    expect(result).toContain(REDACTED)
    expect(result).toContain("curl -H 'Authorization:")
    expect(result).toContain('https://api.example.com/v1')
  })

  it('redacts connection-string credentials, preserving scheme and host', () => {
    expect(sanitizeValue('postgres://user:password@host')).toBe(
      `postgres://${REDACTED}@host`
    )
  })

  it('redacts credentials in a connection string embedded in a command', () => {
    const result = sanitizeValue('psql postgres://admin:hunter2@db.example.com:5432/prod')
    expect(result).toBe(`psql postgres://${REDACTED}@db.example.com:5432/prod`)
  })

  it('redacts a JWT embedded mid-string', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N'
    const result = sanitizeValue(`curl -H "X-Auth: ${jwt}" https://api.example.com/v1`)
    expect(result).not.toContain(jwt)
    expect(result).toContain(REDACTED)
    expect(result).toContain('https://api.example.com/v1')
  })

  it('redacts an AWS access key inside an env-var assignment', () => {
    const result = sanitizeValue('export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE && ./deploy.sh')
    expect(result).toBe(`export AWS_ACCESS_KEY_ID=${REDACTED} && ./deploy.sh`)
  })

  it('redacts an embedded Basic auth header value', () => {
    const result = sanitizeValue(
      "curl -H 'Authorization: Basic dXNlcjpwYXNzd29yZDE=' https://x.example.com"
    )
    expect(result).not.toContain('dXNlcjpwYXNzd29yZDE=')
    expect(result).toContain(REDACTED)
  })

  it.each([
    ['plain command', 'npm install express'],
    ['curl without credentials', 'curl -s https://api.example.com/health'],
    ['prose mentioning basic auth', 'set up basic authentication for the admin panel'],
    ['git command', 'git push origin main'],
  ])('leaves benign strings unchanged: %s', (_label, value) => {
    expect(sanitizeValue(value)).toBe(value)
  })
})

describe('redactEmbeddedSecrets', () => {
  it('redacts every occurrence, not just the first', () => {
    const result = redactEmbeddedSecrets(
      'AKIAIOSFODNN7EXAMPLE then AKIAIOSFODNN7EXAMPL2'
    )
    expect(result).toBe(`${REDACTED} then ${REDACTED}`)
  })

  it('redacts whole whitespace-delimited tokens matching anchored patterns', () => {
    const result = redactEmbeddedSecrets('run with --password=hunter2 flag')
    expect(result).toBe(`run with ${REDACTED} flag`)
  })

  it('returns benign strings unchanged', () => {
    expect(redactEmbeddedSecrets('ls -la /home/user')).toBe('ls -la /home/user')
  })

  it('redacts a PEM private-key block wholesale, preserving surrounding text', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD\n90p1yl0Q\n-----END RSA PRIVATE KEY-----'
    const result = redactEmbeddedSecrets(`key is ${pem} done`)
    expect(result).toBe(`key is ${REDACTED} done`)
    expect(result).not.toContain('MIIBOgIBAAJBAKj34GkxFhD')
  })

  it('redacts a JSON-escaped PEM block (service-account key form)', () => {
    const escaped =
      '-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkq\\nhkiG9w0B\\n-----END PRIVATE KEY-----'
    const result = redactEmbeddedSecrets(escaped)
    expect(result).toBe(REDACTED)
  })
})
