// Account configuration — a single JSON file at ~/.config/mailcli/accounts.json.
// Passwords are stored in plain text in that file (same trade-off as
// mutt/msmtp); the file is created with 0600 permissions. App-specific
// passwords are recommended over real account passwords.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function configPath(baseDir) {
  return path.join(baseDir ?? path.join(os.homedir(), '.config', 'mailcli'), 'accounts.json');
}

/** Load the accounts object { name: account } — {} when no file exists yet. */
export function loadAccounts(baseDir) {
  try {
    const data = JSON.parse(fs.readFileSync(configPath(baseDir), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** Persist accounts; creates the directory with 0700 and the file with 0600. */
export function saveAccounts(accounts, baseDir) {
  const file = configPath(baseDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(accounts, null, 2), { mode: 0o600 });
}

/** Look up one account by name; throws a helpful error when missing. */
export function getAccount(accounts, name) {
  const names = Object.keys(accounts);
  if (!name) {
    if (names.length === 1) return { name: names[0], ...accounts[names[0]] };
    throw new Error(
      names.length === 0
        ? 'no accounts configured — run `mailcli config` first'
        : `multiple accounts (${names.join(', ')}) — pass --account <name>`,
    );
  }
  if (!accounts[name]) throw new Error(`unknown account "${name}" (have: ${names.join(', ') || 'none'})`);
  return { name, ...accounts[name] };
}

export const DEFAULT_PORTS = { imapTls: 993, imapPlain: 143, smtpTls: 465, smtpStarttls: 587 };
