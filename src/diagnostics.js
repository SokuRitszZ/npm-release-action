// Keep subprocess diagnostics bounded and prevent credentials or workflow-command
// injection from being echoed to Actions. Never log process.env or command args.
export function sanitizeDiagnostic(value, env = process.env) {
  let text = String(value ?? '');
  const secrets = Object.entries(env)
    .filter(([name, value]) => /token|secret|password|authorization|api_?key/i.test(name) && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value).sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[URL REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"']+/gi, '[AUTH REDACTED]')
    .replace(/((?:[\w-]*(?:token|secret|password|authorization|api[_-]?key)[\w-]*)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:npm_[A-Za-z0-9]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[TOKEN REDACTED]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .slice(0, 12000);
}

export function commandDiagnostics(label, result, log = console.log) {
  const write = value => {
    for (const line of sanitizeDiagnostic(value).split('\n')) {
      if (line) log(`[npm-release] ${label}: ${line}`);
    }
  };
  write(`exit=${result.status ?? 'unknown'} signal=${result.signal ?? 'none'} spawnError=${result.error?.code ?? 'none'}`);
  write(result.stdout);
  write(result.stderr);
}
