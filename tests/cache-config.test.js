import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageCache } from '../src/cache.js';
import { loadAccounts, saveAccounts, getAccount } from '../src/config.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcli-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sample = [
  { uid: 1, subject: 'Hello world', from: { name: 'Alice', email: 'a@x.com' }, text: 'first message', snippet: 'first message' },
  { uid: 2, subject: 'Meeting notes', from: { name: 'Bob', email: 'b@y.com' }, text: 'second message about lunch', snippet: 'second message' },
];

test('MessageCache saves, loads, merges by UID and searches', (t) => {
  const dir = tmpDir(t);
  const cache = new MessageCache('work', dir);
  assert.deepEqual(cache.load('INBOX'), []);

  cache.save('INBOX', sample);
  const loaded = cache.load('INBOX');
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].subject, 'Hello world');

  // Re-saving with an updated copy of UID 1 merges instead of duplicating.
  cache.save('INBOX', [{ uid: 1, subject: 'Hello world (edited)', flags: ['\\Seen'] }]);
  const merged = cache.load('INBOX');
  assert.equal(merged.length, 2);
  assert.equal(merged[0].subject, 'Hello world (edited)');
  assert.deepEqual(merged[0].flags, ['\\Seen']);
  assert.equal(merged[0].from.email, 'a@x.com'); // untouched fields survive

  assert.equal(cache.get('INBOX', 2).subject, 'Meeting notes');
  assert.equal(cache.get('INBOX', 99), null);

  assert.deepEqual(cache.search('INBOX', 'lunch').map((m) => m.uid), [2]);
  assert.deepEqual(cache.search('INBOX', 'ALICE').map((m) => m.uid), [1]);
  assert.deepEqual(cache.search('INBOX', 'nope'), []);

  assert.equal(cache.clear('INBOX'), true);
  assert.deepEqual(cache.load('INBOX'), []);
  assert.equal(cache.clear('INBOX'), false);
});

test('accounts round-trip through load/save with 0600 permissions', (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(loadAccounts(dir), {});
  const accounts = {
    work: {
      email: 'me@x.com',
      imap: { host: 'imap.x.com', port: 993, tls: true, user: 'me@x.com', pass: 'secret' },
      smtp: { host: 'smtp.x.com', port: 587, tls: false, starttls: true, user: 'me@x.com', pass: 'secret' },
    },
  };
  saveAccounts(accounts, dir);
  assert.equal((fs.statSync(path.join(dir, 'accounts.json')).mode & 0o777), 0o600);
  assert.deepEqual(loadAccounts(dir), accounts);
});

test('getAccount picks the only account, or demands a name', () => {
  const one = { work: { email: 'a@b.com' } };
  assert.equal(getAccount(one).name, 'work');
  assert.throws(() => getAccount({}), /no accounts configured/);
  assert.throws(() => getAccount({ a: {}, b: {} }), /multiple accounts/);
  assert.throws(() => getAccount(one, 'nope'), /unknown account/);
  assert.equal(getAccount(one, 'work').email, 'a@b.com');
});
