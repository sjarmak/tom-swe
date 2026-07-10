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

  it('preserves the host of a credentialed connection string whose host has an email-shaped TLD', () => {
    // Regression: the email pattern must run after (and not re-match) the
    // '[REDACTED]@host' span the url-credential pattern leaves behind. The host
    // here (mail.corp.example.io) is deliberately email-shaped to isolate that
    // interaction; if the email pattern ran first or matched the redacted span,
    // the host would be lost.
    expect(sanitizeValue('mysql://root:hunter2@mail.corp.example.io:3306/db')).toBe(
      `mysql://${REDACTED}@mail.corp.example.io:3306/db`
    )
  })
})

describe('AWS secret access key', () => {
  it('redacts a labelled key=value form (whole token)', () => {
    // The embedded AWS pattern redacts the value first; the resulting single
    // token `aws_secret_access_key=[REDACTED]` then also matches the existing
    // `/[A-Z_]+_KEY=[^\s]+/i` whole-token pattern during tokenization, so it
    // collapses to a bare [REDACTED]. Either mechanism alone prevents the leak.
    const result = redactEmbeddedSecrets(
      'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    )
    expect(result).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
    expect(result).toBe(REDACTED)
  })

  it('redacts a quoted JSON/YAML labelled form, preserving label and quotes', () => {
    const result = redactEmbeddedSecrets(
      '"aws_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'
    )
    expect(result).toBe(`"aws_secret_access_key": "${REDACTED}"`)
  })

  it('redacts the space-delimited CLI form, preserving the command and label', () => {
    const result = redactEmbeddedSecrets(
      'aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    )
    expect(result).toBe(`aws configure set aws_secret_access_key ${REDACTED}`)
  })

  it('does NOT redact a bare 40-char identifier with no secret_access_key label', () => {
    // FP-safety: a bare 40-char base64-ish token is ambiguous (git hashes,
    // resource IDs). Only the labelled form is redacted.
    const bare = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    expect(redactEmbeddedSecrets(`resource ${bare} done`)).toBe(`resource ${bare} done`)
  })

  it('does not fire on prose mentioning the key name without a value', () => {
    const prose = 'set the aws_secret_access_key in your environment'
    expect(redactEmbeddedSecrets(prose)).toBe(prose)
  })
})

describe('Pwd= / ODBC connection-string passwords', () => {
  it('redacts a Pwd= value in a semicolon-delimited connection string, preserving structure', () => {
    const result = redactEmbeddedSecrets('Server=h;Database=prod;Pwd=hunter2;')
    expect(result).toBe(`Server=h;Database=prod;Pwd=${REDACTED};`)
  })

  it('redacts an uppercase PWD= form', () => {
    const result = redactEmbeddedSecrets('DRIVER={ODBC};UID=admin;PWD=s3cr3t')
    expect(result).not.toContain('s3cr3t')
    expect(result).toContain('UID=admin')
  })

  it('redacts a brace-quoted value that embeds a semicolon, as a whole unit', () => {
    // ODBC brace-quoting lets a value contain a literal ';'. The value must be
    // consumed as a whole {...} unit or the tail ('word}') leaks in cleartext.
    const result = redactEmbeddedSecrets(
      'Driver={SQL Server};Server=h;Pwd={p@ss;word};UID=admin'
    )
    expect(result).not.toContain('word')
    expect(result).toBe(`Driver={SQL Server};Server=h;Pwd=${REDACTED};UID=admin`)
  })

  it('does not fire on the OLDPWD shell env var', () => {
    const value = 'OLDPWD=/home/user/project'
    expect(redactEmbeddedSecrets(value)).toBe(value)
  })

  it('does not fire on a bare pwd command', () => {
    expect(redactEmbeddedSecrets('cd /tmp && pwd')).toBe('cd /tmp && pwd')
  })
})

describe('email / PII redaction', () => {
  it('redacts a bare email value', () => {
    expect(sanitizeValue('steph@example.com')).toBe(REDACTED)
  })

  it('redacts an email embedded in a command, preserving surrounding text', () => {
    const result = redactEmbeddedSecrets('git config user.email steph@example.com')
    expect(result).not.toContain('steph@example.com')
    expect(result).toContain('git config user.email')
  })

  it('redacts every email occurrence', () => {
    const result = redactEmbeddedSecrets('cc a@x.io and b@y.org')
    expect(result).toBe(`cc ${REDACTED} and ${REDACTED}`)
  })

  it('leaves a bare @host with no TLD unchanged', () => {
    expect(redactEmbeddedSecrets('run on user@localhost now')).toBe(
      'run on user@localhost now'
    )
  })

  it.each([
    ['scp-style SSH remote', 'git clone git@github.com:org/repo.git'],
    ['SSH remote with a numeric-leading org path', 'git@github.com:2fa/repo.git'],
  ])('leaves an SSH/scp git remote host readable (not treated as email PII): %s', (_l, value) => {
    // Dev-syntax FP: `user@host:path` is an scp-style git remote, not an email.
    // The email pattern must not fire when the TLD is immediately followed by
    // `:` + a path (host:path), so the whole remote stays readable in telemetry.
    expect(redactEmbeddedSecrets(value)).toBe(value)
  })

  it.each([
    ['retina PNG', 'logo@2x.png'],
    ['retina JPG', 'icon@3x.jpg'],
    ['retina WEBP', 'sprite@2x.webp'],
  ])('leaves a retina asset filename unchanged (asset extension is not a TLD): %s', (_l, value) => {
    // Dev-syntax FP: `name@2x.png` is a retina asset, not an email. Known image
    // extensions (png/jpg/jpeg/svg/webp/gif/ico) are excluded as the TLD.
    expect(redactEmbeddedSecrets(value)).toBe(value)
  })

  it('still redacts a real email that happens to sit next to a git remote', () => {
    // Guard against over-scoping the SSH exclusion: a genuine email in the same
    // string must still redact while the remote host stays readable.
    const result = redactEmbeddedSecrets('git@github.com:org/repo.git cc steph@example.com')
    expect(result).toBe('git@github.com:org/repo.git cc [REDACTED]')
  })

  it('still redacts an email in a user:secret / user@host:port shape (no path)', () => {
    // The SSH-remote exclusion requires a PATH ('/') after the colon. A bare
    // colon (credential pair or port, no path) must NOT spare the email, or a
    // combolist/Basic-auth pair leaks. Regression for the too-broad `(?!:\S)`.
    expect(redactEmbeddedSecrets('curl -u steph@example.com:hunter2 https://x')).toBe(
      'curl -u [REDACTED]:hunter2 https://x'
    )
    expect(redactEmbeddedSecrets('user@example.com:5432')).toBe('[REDACTED]:5432')
  })

  it('handles a large @-free input in linear time (ReDoS guard)', () => {
    // The bounded quantifiers keep the pattern linear; on unbounded call sites
    // (redactPrompt, truncateDetail) an @-free paste must not stall. Assert both
    // correctness (unchanged) and that it completes well under a generous bound.
    const large = 'a'.repeat(200_000)
    const start = performance.now()
    const result = redactEmbeddedSecrets(large)
    const elapsedMs = performance.now() - start
    expect(result).toBe(large)
    expect(elapsedMs).toBeLessThan(500)
  })

  it('handles a large @-heavy no-TLD input in linear time (ReDoS guard)', () => {
    // The added asset-extension and SSH-remote lookaheads must not reintroduce
    // quadratic backtracking: an @-dense paste with no dotted TLD must fail fast
    // at every `@` rather than re-scanning the domain run.
    const large = 'a@'.repeat(100_000)
    const start = performance.now()
    const result = redactEmbeddedSecrets(large)
    const elapsedMs = performance.now() - start
    expect(result).toBe(large)
    expect(elapsedMs).toBeLessThan(500)
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
