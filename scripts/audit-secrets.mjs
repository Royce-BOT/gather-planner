import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const placeholder = value => /^(?:YOUR_|REPLACE_|PASTE_|<)|^(?:example|placeholder|password|test|secret)$/i.test(value);
const fixturePath = path => /^(?:tests\/|sql\/(?:.*tests\.sql|test-local\.ps1)$)/.test(path);
const highConfidenceSecret = /^(?:supabase-secret-key|supabase-service-role-jwt|google-client-secret|github-token|aws-access-key|private-key-material|privileged-api-token|database-password-url)$/;

// Findings contain only locations, classifications and counts. Never keep matched values.
export function scanText(source, path = '') {
  const findings = new Map();
  function record(classification, index, sample = false) {
    const line = source.slice(0, index).split('\n').length;
    const key = `${classification}:${line}`;
    if (!findings.has(key)) findings.set(key, { classification, line, occurrences: 0, fixture: sample || fixturePath(path) });
    findings.get(key).occurrences++;
  }
  const patterns = [
    ['supabase-secret-key', /\bsb_secret_[A-Za-z0-9_-]{12,}/g],
    ['google-client-secret', /\bGOCSPX-[A-Za-z0-9_-]{16,}/g],
    ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})/g],
    ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
    ['private-key-material', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
    ['privileged-api-token', /\b(?:sk_live_[A-Za-z0-9]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|xox[baprs]-[A-Za-z0-9-]{20,})/g],
    ['database-password-url', /\bpostgres(?:ql)?:\/\/[^\s/:]+:[^\s/@]+@[^\s'"<>]+/g]
  ];
  for (const [classification, pattern] of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (classification === 'database-password-url' && /\$\{|\{\{|YOUR_|REPLACE_/.test(match[0])) continue;
      record(classification, match.index);
    }
  }
  for (const match of source.matchAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)) {
    try {
      const claims = JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url').toString('utf8'));
      record(claims.role === 'anon' ? 'public-supabase-anon-key' : claims.role === 'service_role' ? 'supabase-service-role-jwt' : 'authentication-jwt-candidate', match.index);
    } catch { record('unclassified-jwt-candidate', match.index); }
  }
  for (const match of source.matchAll(/\bsb_publishable_[A-Za-z0-9_-]{12,}/g)) record('public-supabase-publishable-key', match.index);
  const credentialName = '(?:SUPABASE_?SERVICE_?ROLE_?KEY|SERVICE_?ROLE_?KEY|GOOGLE_?CLIENT_?SECRET|CLIENT_?SECRET|DATABASE_?PASSWORD|DB_?PASSWORD|SMTP_?PASSWORD|AWS_?SECRET_?ACCESS_?KEY|ACCESS_?TOKEN|REFRESH_?TOKEN|API_?SECRET|PASSWORD)';
  const assignments = [
    [new RegExp(`(?<![A-Za-z0-9_-])${credentialName}(?![A-Za-z0-9_-])\\s*["']?\\s*[:=]\\s*(["'])([^"'\\r\\n]+)\\1`, 'gi'), 2],
    [new RegExp(`^\\s*${credentialName}\\s*=\\s*([^\\r\\n\\s"'#]+)`, 'gmi'), 1]
  ];
  for (const [pattern, valueIndex] of assignments) {
    for (const match of source.matchAll(pattern)) {
      const value = match[valueIndex];
      if (value.length >= 8 && !placeholder(value) && !/^(?:process\.|Deno\.|getenv\(|null|undefined)/.test(value)) record('secret-assignment-candidate', match.index);
    }
  }
  for (const match of source.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    const domain = match[0].split('@')[1].toLowerCase();
    const sample = /(^|\.)(?:example\.(?:com|org|net|test)|test|invalid|localhost)$/.test(domain);
    record(sample ? 'synthetic-email-fixture' : 'personal-email-candidate', match.index, sample);
  }
  for (const match of source.matchAll(/\b(?:contact|notes|person)\s*["']?\s*:\s*["']([^"'\r\n]{2,})["']/g)) {
    if (!placeholder(match[1])) record('embedded-private-record-candidate', match.index);
  }
  return [...findings.values()];
}

const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const isText = content => !content.slice(0, 4096).includes('\0');

export function scanRepository({ history = true } = {}) {
  const findings = [];
  let workingFiles = 0, historyBlobs = 0;
  const paths = new Set([...git(['ls-files', '-z']).split('\0'), ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean));
  for (const path of paths) {
    let source;
    try { source = readFileSync(resolve(root, path), 'utf8'); } catch { continue; }
    workingFiles++;
    if (isText(source)) for (const item of scanText(source, path)) findings.push({ scope: 'working-tree', path, ...item });
  }
  if (history) {
    // Unique reachable blobs cover every committed version, including deleted files.
    for (const object of git(['rev-list', '--objects', '--all']).split('\n').filter(Boolean)) {
      const space = object.indexOf(' ');
      if (space < 0) continue;
      const hash = object.slice(0, space), path = object.slice(space + 1);
      if (git(['cat-file', '-t', hash]).trim() !== 'blob') continue;
      historyBlobs++;
      const source = git(['cat-file', 'blob', hash]);
      if (isText(source)) for (const item of scanText(source, path)) findings.push({ scope: 'git-history', object: hash.slice(0, 12), path, ...item });
    }
    const messages = git(['log', '--all', '--format=%H%x00%B%x00']).split('\0');
    for (let index = 0; index + 1 < messages.length; index += 2) {
      const commit = messages[index].trim();
      for (const item of scanText(messages[index + 1], '(commit message)')) findings.push({ scope: 'git-message', commit: commit.slice(0, 12), path: '(commit message)', ...item });
    }
  }
  const actionable = findings.filter(item => (!item.fixture || highConfidenceSecret.test(item.classification)) && !item.classification.startsWith('public-'));
  return {
    workingFiles, historyBlobs,
    reachableCommits: Number(git(['rev-list', '--all', '--count']).trim()),
    secretCandidates: actionable.filter(item => !/email|private-record/.test(item.classification)).length,
    privateRecordCandidates: actionable.filter(item => /email|private-record/.test(item.classification)).length,
    findings,
    limitations: 'Pattern review only; matches require human classification. Ignored files, remote-only and unreachable Git objects, encoded/encrypted data and Git author metadata are outside this scan.'
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = scanRepository({ history: !process.argv.includes('--no-history') });
    const shown = report.findings.filter(item => !item.fixture || highConfidenceSecret.test(item.classification));
    const output = process.argv.includes('--include-fixtures') ? report : { ...report, omittedFixtureLocations: report.findings.length - shown.length, findings: shown };
    console.log(JSON.stringify(output, null, 2));
    if (report.secretCandidates) process.exitCode = 1;
  } catch {
    console.error('Audit could not read the repository. No source contents were logged.');
    process.exitCode = 2;
  }
}
