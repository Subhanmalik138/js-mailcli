import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.js';

test('parseArgs splits command, positionals and --key value / --key=value', () => {
  const r = parseArgs(['list', '--account', 'work', '--folder=INBOX', '--limit', '5', '--offline']);
  assert.equal(r.command, 'list');
  assert.deepEqual(r.positional, []);
  assert.equal(r.options.account, 'work');
  assert.equal(r.options.folder, 'INBOX');
  assert.equal(r.options.limit, '5');
  assert.equal(r.options.offline, true);
});

test('parseArgs keeps positionals for read/search/send', () => {
  assert.deepEqual(parseArgs(['read', '42', '--offline']).positional, ['42']);
  const s = parseArgs(['search', 'hello', 'world']);
  assert.deepEqual(s.positional, ['hello', 'world']);
  const send = parseArgs(['send', '--to', 'a@b.com', '--subject', 'Hi there', '--body', 'x']);
  assert.equal(send.options.to, 'a@b.com');
  assert.equal(send.options.subject, 'Hi there');
});

test('parseArgs handles flags with no value and empty argv', () => {
  assert.equal(parseArgs(['--help']).options.help, true);
  assert.equal(parseArgs([]).command, undefined);
});
