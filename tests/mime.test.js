import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeQuotedPrintable,
  encodeQuotedPrintable,
  decodeEncodedWords,
  splitHeaders,
  parseContentType,
  parseAddresses,
  decodeBody,
  parseMessage,
  buildMessage,
  snippet,
} from '../src/mime.js';

test('quoted-printable round-trips, including soft breaks and UTF-8', () => {
  const text = 'Hello wörld — a long line that keeps going and going and going and going and going!';
  const encoded = encodeQuotedPrintable(text);
  assert.equal(decodeQuotedPrintable(encoded).toString('utf8'), text);
  assert.ok(!encoded.split('\r\n').some((l) => l.length > 76));
  assert.equal(decodeQuotedPrintable('Hello=20World=21').toString(), 'Hello World!');
  assert.equal(decodeQuotedPrintable('soft=\r\nbreak').toString(), 'softbreak');
});

test('encoded-words decode B and Q forms, leave malformed words alone', () => {
  assert.equal(decodeEncodedWords('=?UTF-8?B?SGVsbG8=?='), 'Hello');
  assert.equal(decodeEncodedWords('=?UTF-8?Q?Hello_World?='), 'Hello World');
  assert.equal(decodeEncodedWords('Re: =?UTF-8?B?SGVsbG8=?= =?UTF-8?B?V29ybGQ=?='), 'Re: HelloWorld');
  assert.equal(decodeEncodedWords('not an =?broken?= word'), 'not an =?broken?= word');
});

test('splitHeaders unfolds continuation lines and lowercases names', () => {
  const { headers, body } = splitHeaders('Subject: Hello\r\n  World\r\nFrom: a@b.com\r\n\r\nBody here');
  assert.equal(headers.get('subject'), 'Hello World');
  assert.equal(headers.get('from'), 'a@b.com');
  assert.equal(body, 'Body here');
});

test('parseContentType pulls type, subtype and params', () => {
  const ct = parseContentType('multipart/mixed; boundary="abc"; charset=UTF-8');
  assert.equal(ct.type, 'multipart');
  assert.equal(ct.subtype, 'mixed');
  assert.equal(ct.params.boundary, 'abc');
  assert.equal(parseContentType('text/plain').subtype, 'plain');
});

test('parseAddresses handles display names, groups and bare addresses', () => {
  const addrs = parseAddresses('"Alice A" <alice@x.com>, bob@y.com, "C, D" <c@d.com>');
  assert.deepEqual(addrs, [
    { name: 'Alice A', email: 'alice@x.com' },
    { name: '', email: 'bob@y.com' },
    { name: 'C, D', email: 'c@d.com' },
  ]);
  assert.deepEqual(parseAddresses(''), []);
});

test('decodeBody handles base64, quoted-printable and 7bit', () => {
  assert.equal(decodeBody('aGVsbG8=', 'base64'), 'hello');
  assert.equal(decodeBody('Hello=20World', 'quoted-printable'), 'Hello World');
  assert.equal(decodeBody('plain text', '7bit'), 'plain text');
});

test('parseMessage handles a plain message', () => {
  const raw = [
    'From: Alice <alice@x.com>',
    'To: bob@y.com',
    'Subject: =?UTF-8?B?SGVsbG8=?=',
    'Date: Mon, 16 Nov 2026 10:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hi Bob,',
    'see you soon.',
  ].join('\r\n');
  const msg = parseMessage(raw);
  assert.equal(msg.from.email, 'alice@x.com');
  assert.equal(msg.subject, 'Hello');
  assert.equal(msg.date, 'Mon, 16 Nov 2026 10:00:00 +0000');
  assert.match(msg.text, /Hi Bob/);
});

test('parseMessage walks multipart/alternative and extracts attachments', () => {
  const raw = [
    'From: a@x.com',
    'Subject: With parts',
    'Content-Type: multipart/mixed; boundary="B1"',
    '',
    '--B1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'plain body',
    '--B1',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>html body</p>',
    '--B1',
    'Content-Type: application/pdf; name="doc.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="doc.pdf"',
    '',
    'aGVsbG8=',
    '--B1--',
    '',
  ].join('\r\n');
  const msg = parseMessage(raw);
  assert.equal(msg.text.trim(), 'plain body');
  assert.equal(msg.html.trim(), '<p>html body</p>');
  assert.equal(msg.attachments.length, 1);
  assert.equal(msg.attachments[0].filename, 'doc.pdf');
  assert.equal(msg.attachments[0].data.toString(), 'hello');
});

test('buildMessage then parseMessage round-trips text, html and attachment', () => {
  const raw = buildMessage({
    from: { name: 'Alice', email: 'alice@x.com' },
    to: ['bob@y.com'],
    cc: ['carol@z.com'],
    subject: 'Round trip',
    text: 'Hello there',
    html: '<b>Hello there</b>',
    attachments: [{ filename: 'note.txt', contentType: 'text/plain', data: Buffer.from('file contents') }],
  });
  const msg = parseMessage(raw);
  assert.equal(msg.from.email, 'alice@x.com');
  assert.equal(msg.to[0].email, 'bob@y.com');
  assert.equal(msg.cc[0].email, 'carol@z.com');
  assert.equal(msg.subject, 'Round trip');
  assert.match(msg.text, /Hello there/);
  assert.match(msg.html, /Hello there/);
  assert.equal(msg.attachments.length, 1);
  assert.equal(msg.attachments[0].data.toString(), 'file contents');
});

test('snippet collapses whitespace and truncates', () => {
  assert.equal(snippet('  hello\n\n world  '), 'hello world');
  assert.equal(snippet('x'.repeat(200), 10), 'x'.repeat(10));
});
