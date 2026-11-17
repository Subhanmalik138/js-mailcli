#!/usr/bin/env node
// mailcli — a zero-dependency CLI email client.
// Commands: config, folders, list, read, search, sync, send, cache.
// Run `mailcli --help` for usage. Accounts live in ~/.config/mailcli/.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ImapClient } from './imap/client.js';
import { SmtpClient } from './smtp/client.js';
import { parseMessage, buildMessage, snippet } from './mime.js';
import { MessageCache } from './cache.js';
import { loadAccounts, saveAccounts, getAccount, DEFAULT_PORTS } from './config.js';

const VERSION = '1.0.0';

const HELP = `mailcli ${VERSION} — zero-dependency CLI email client (IMAP + SMTP)

Usage:
  mailcli config                              add an account interactively
  mailcli folders [--account NAME]            list mail folders
  mailcli list [--account NAME] [--folder INBOX] [--limit N] [--offline]
  mailcli read UID [--account NAME] [--folder INBOX] [--offline]
  mailcli search QUERY [--account NAME] [--folder INBOX] [--offline]
  mailcli sync [--account NAME] [--folder INBOX]
  mailcli send --to a@b.com [--cc c@d.com] --subject S --body T
               [--account NAME] [--file body.txt] [--attach file.pdf]
  mailcli cache clear [--account NAME] [--folder INBOX]
  mailcli --help | --version

Accounts are stored in ~/.config/mailcli/accounts.json (0600).
Use an app-specific password, not your real account password.
`;

/** Parse argv into { command, positional, options }. */
export function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        options[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        options[arg.slice(2)] = argv[++i];
      } else {
        options[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], positional: positional.slice(1), options };
}

function fail(message) {
  console.error(`mailcli: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function prompt(rl, question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    if (!hidden) {
      rl.question(question, (answer) => resolve(answer.trim()));
      return;
    }
    // Hidden input: read a line without echoing it back.
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    process.stdout.write(question);
    const onData = (chunk) => {
      const ch = chunk.toString('utf8');
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(buf.trim());
      } else if (ch === '\u0003') {
        process.exit(130);
      } else if (ch === '\u007f') {
        buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function cmdConfig() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const accounts = loadAccounts();
    const name = await prompt(rl, 'Account name: ');
    if (!name) fail('account name is required');
    const email = await prompt(rl, 'Your email address: ');
    const imapHost = await prompt(rl, 'IMAP host (e.g. imap.gmail.com): ');
    const imapPort = Number(await prompt(rl, `IMAP port [${DEFAULT_PORTS.imapTls}]: `) || DEFAULT_PORTS.imapTls);
    const imapTls = (await prompt(rl, 'IMAP over TLS? [Y/n]: ')).toLowerCase() !== 'n';
    const user = (await prompt(rl, `IMAP username [${email}]: `)) || email;
    const pass = await prompt(rl, 'IMAP password / app password: ', { hidden: true });
    const smtpHost = await prompt(rl, 'SMTP host (e.g. smtp.gmail.com): ');
    const smtpPort = Number(await prompt(rl, `SMTP port [${DEFAULT_PORTS.smtpStarttls}]: `) || DEFAULT_PORTS.smtpStarttls);
    const smtpTls = smtpPort === DEFAULT_PORTS.smtpTls;
    const smtpUser = (await prompt(rl, `SMTP username [${user}]: `)) || user;
    const smtpPass = await prompt(rl, 'SMTP password / app password: ', { hidden: true });
    accounts[name] = {
      email,
      imap: { host: imapHost, port: imapPort, tls: imapTls, user, pass },
      smtp: { host: smtpHost, port: smtpPort, tls: smtpTls, starttls: !smtpTls, user: smtpUser, pass: smtpPass || pass },
    };
    saveAccounts(accounts);
    console.log(`Saved account "${name}". Try: mailcli folders --account ${name}`);
  } finally {
    rl.close();
  }
}

async function withImap(account, fn) {
  const client = new ImapClient(account.imap);
  await client.connect();
  try {
    await client.login();
    return await fn(client);
  } finally {
    await client.logout();
  }
}

function printList(messages) {
  if (!messages.length) {
    console.log('No messages.');
    return;
  }
  for (const m of messages) {
    const from = m.from ? `${m.from.name ? m.from.name + ' ' : ''}<${m.from.email}>` : '(unknown)';
    const date = (m.date || '').slice(0, 25);
    console.log(`[${m.uid}] ${date}  ${from}`);
    console.log(`     ${m.subject || '(no subject)'}`);
    if (m.snippet) console.log(`     ${m.snippet}`);
  }
}

function toSummary(envelope, text = '') {
  return {
    uid: envelope.uid,
    flags: envelope.flags,
    date: envelope.date,
    subject: envelope.subject,
    from: envelope.from,
    to: envelope.to,
    messageId: envelope.messageId,
    snippet: snippet(text),
  };
}

async function cmdFolders(options) {
  const account = getAccount(loadAccounts(), options.account);
  const folders = await withImap(account, (c) => c.listFolders());
  for (const f of folders) {
    console.log(`${f.flags.includes('\\HasChildren') ? '+' : '-'} ${f.name}`);
  }
}

async function cmdList(options) {
  const account = getAccount(loadAccounts(), options.account);
  const folder = options.folder || 'INBOX';
  const limit = Number(options.limit || 20);
  if (options.offline) {
    const cached = new MessageCache(account.name).load(folder);
    printList(cached.slice(-limit));
    return;
  }
  const messages = await withImap(account, async (client) => {
    const info = await client.select(folder);
    const total = info.exists;
    const from = Math.max(1, total - limit + 1);
    const envelopes = total ? await client.fetchEnvelopes(from, total) : [];
    const cache = new MessageCache(account.name);
    cache.save(folder, envelopes.map((e) => toSummary(e)));
    return envelopes;
  });
  printList(messages);
}

async function cmdRead(positional, options) {
  const uid = Number(positional[0]);
  if (!uid) fail('usage: mailcli read UID [--folder INBOX] [--offline]');
  const account = getAccount(loadAccounts(), options.account);
  const folder = options.folder || 'INBOX';
  const cache = new MessageCache(account.name);
  if (options.offline) {
    const cached = cache.get(folder, uid);
    if (!cached) fail(`UID ${uid} is not in the offline cache — run \`mailcli sync\` first`);
    if (cached.text) {
      console.log(cached.text);
      return;
    }
    // Cached summary only; fall through to the live fetch below.
  }
  const raw = await withImap(account, async (client) => {
    await client.select(folder);
    return client.fetchBody(uid);
  });
  const msg = parseMessage(raw);
  console.log(`From: ${msg.from ? `${msg.from.name} <${msg.from.email}>` : '(unknown)'}`);
  console.log(`To: ${msg.to.map((a) => a.email).join(', ')}`);
  console.log(`Subject: ${msg.subject}`);
  console.log(`Date: ${msg.date}`);
  console.log('');
  console.log(msg.text || '(no plain-text body)');
  if (msg.attachments.length) {
    console.log('');
    console.log('Attachments:');
    for (const a of msg.attachments) console.log(`  - ${a.filename} (${a.contentType}, ${a.data.length} bytes)`);
  }
  cache.save(folder, [{ uid, text: msg.text, ...toSummary({ uid, date: msg.date, subject: msg.subject, from: msg.from, to: msg.to, messageId: msg.messageId, flags: [] }, msg.text) }]);
}

async function cmdSearch(positional, options) {
  const query = positional.join(' ');
  if (!query) fail('usage: mailcli search QUERY [--folder INBOX] [--offline]');
  const account = getAccount(loadAccounts(), options.account);
  const folder = options.folder || 'INBOX';
  const cache = new MessageCache(account.name);
  if (options.offline) {
    printList(cache.search(folder, query));
    return;
  }
  const uids = await withImap(account, async (client) => {
    await client.select(folder);
    return client.search(`SUBJECT "${query.replace(/"/g, '')}" OR FROM "${query.replace(/"/g, '')}"`);
  });
  if (!uids.length) {
    console.log('No matches.');
    return;
  }
  const messages = await withImap(account, async (client) => {
    await client.select(folder);
    return client.fetchEnvelopes(Math.min(...uids), Math.max(...uids));
  });
  printList(messages.filter((m) => uids.includes(m.uid)));
}

async function cmdSync(options) {
  const account = getAccount(loadAccounts(), options.account);
  const folder = options.folder || 'INBOX';
  const cache = new MessageCache(account.name);
  const cached = cache.load(folder);
  const cachedUids = new Set(cached.map((m) => m.uid));
  const result = await withImap(account, async (client) => {
    const info = await client.select(folder);
    const envelopes = info.exists ? await client.fetchEnvelopes(1, info.exists) : [];
    const summaries = envelopes.map((e) => toSummary(e));
    const missing = envelopes.filter((e) => !cachedUids.has(e.uid));
    for (const env of missing) {
      try {
        const raw = await client.fetchBody(env.uid);
        const msg = parseMessage(raw);
        const s = summaries.find((x) => x.uid === env.uid);
        if (s) {
          s.text = msg.text;
          s.snippet = snippet(msg.text);
        }
      } catch {
        // A body that fails to fetch does not block the rest of the sync.
      }
    }
    return { total: info.exists, summaries, fetched: missing.length };
  });
  cache.save(folder, result.summaries);
  console.log(`Synced ${folder}: ${result.total} messages, ${result.fetched} new bodies cached.`);
}

async function cmdSend(options) {
  const to = options.to;
  const subject = options.subject ?? '';
  if (!to) fail('usage: mailcli send --to a@b.com --subject S --body T [--file body.txt] [--attach file]');
  let body = options.body ?? '';
  if (options.file) body = fs.readFileSync(options.file, 'utf8');
  const attachments = [];
  for (const file of [options.attach].flat().filter(Boolean)) {
    attachments.push({
      filename: path.basename(file),
      contentType: 'application/octet-stream',
      data: fs.readFileSync(file),
    });
  }
  const account = getAccount(loadAccounts(), options.account);
  const raw = buildMessage({
    from: { name: '', email: account.email },
    to: String(to).split(',').map((s) => s.trim()),
    cc: options.cc ? String(options.cc).split(',').map((s) => s.trim()) : [],
    subject,
    text: body,
    attachments,
  });
  const smtp = new SmtpClient(account.smtp);
  await smtp.connect();
  try {
    await smtp.sendMail({ from: account.email, to: String(to).split(',').map((s) => s.trim()), cc: options.cc ? String(options.cc).split(',').map((s) => s.trim()) : [], raw });
  } finally {
    await smtp.quit();
  }
  console.log(`Sent to ${to}.`);
}

async function cmdCache(positional, options) {
  if (positional[0] !== 'clear') fail('usage: mailcli cache clear [--folder INBOX]');
  const account = getAccount(loadAccounts(), options.account);
  const folder = options.folder || 'INBOX';
  const ok = new MessageCache(account.name).clear(folder);
  console.log(ok ? `Cleared cached ${folder}.` : `Nothing cached for ${folder}.`);
}

export async function main(argv) {
  const { command, positional, options } = parseArgs(argv);
  if (options.version || command === '--version') {
    console.log(`mailcli ${VERSION}`);
    return;
  }
  if (options.help || command === 'help' || !command) {
    console.log(HELP);
    return;
  }
  try {
    switch (command) {
      case 'config': await cmdConfig(); break;
      case 'folders': await cmdFolders(options); break;
      case 'list': await cmdList(options); break;
      case 'read': await cmdRead(positional, options); break;
      case 'search': await cmdSearch(positional, options); break;
      case 'sync': await cmdSync(options); break;
      case 'send': await cmdSend(options); break;
      case 'cache': await cmdCache(positional, options); break;
      default:
        console.error(`mailcli: unknown command "${command}"\n${HELP}`);
        process.exitCode = 1;
    }
  } catch (err) {
    if (process.exitCode !== 1) {
      console.error(`mailcli: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
