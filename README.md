# MailCLI

A zero-dependency CLI email client for Node.js — hand-rolled IMAP and SMTP,
a MIME message model, and an offline message cache. No libraries, no
frameworks: every protocol detail (IMAP literals, SMTP dot-stuffing,
quoted-printable, encoded-words, multipart bodies) is implemented in plain
JavaScript against the RFCs.

## Features

- **IMAP (RFC 3501)** — connect over implicit TLS or plain TCP, `LOGIN`,
  folder listing (`LIST`), `SELECT` with EXISTS/UNSEEN/UIDVALIDITY/UIDNEXT,
  envelope + full-body `FETCH`, and `UID SEARCH`.
- **SMTP (RFC 5321)** — `EHLO`, `STARTTLS` upgrade, `AUTH LOGIN` with
  `AUTH PLAIN` fallback, `MAIL FROM` / `RCPT TO` / `DATA`, dot-stuffing.
- **MIME (RFC 5322 / 2045–2047)** — parse and build messages, multipart
  bodies, base64 and quoted-printable, encoded-words, attachments.
- **Offline cache** — `sync` stores messages as JSON under
  `~/.config/mailcli/cache/`; `list`, `read` and `search` all work with
  `--offline` when you have no connection.
- **One binary** — `mailcli` runs anywhere Node 18+ runs.

## Install

```bash
git clone https://github.com/Subhanmalik138/js-mailcli.git
cd js-mailcli
npm link          # makes `mailcli` available on your PATH
# or run it directly:
node src/cli.js --help
```

## Setup

```bash
mailcli config
```

This asks for your email address, IMAP/SMTP hosts and ports, and
credentials, then saves one account to `~/.config/mailcli/accounts.json`
(created with `0600` permissions). **Use an app-specific password**, not
your real account password — Gmail, Outlook and most providers require one
for plain IMAP/SMTP login.

## Usage

```bash
mailcli folders                              # list mail folders
mailcli list --folder INBOX --limit 20       # newest 20 messages
mailcli read 42                              # read message UID 42
mailcli search "invoice"                     # server-side search
mailcli sync                                 # cache the whole inbox
mailcli list --offline                       # browse without a connection
mailcli read 42 --offline
mailcli search "invoice" --offline

mailcli send --to alice@example.com \
  --subject "Hello" --body "Hi Alice," \
  --cc bob@example.com --attach report.pdf

mailcli cache clear --folder INBOX           # drop the cached inbox
```

With several accounts, add `--account <name>` to any command; with one
account it is the default.

## Architecture

```
src/
  mime.js          MIME model: parse/build, QP, encoded-words, multipart
  imap/
    parser.js      IMAP tokenizer, token-tree parser, literal reader
    client.js      IMAP client: connect, LOGIN, LIST, SELECT, FETCH, SEARCH
  smtp/
    client.js      SMTP client: EHLO, STARTTLS, AUTH, MAIL/RCPT/DATA
  cache.js         JSON offline message cache (per account + folder)
  config.js        accounts.json storage (0600) and lookup
  cli.js           argument parsing and all subcommands
tests/             node:test suite — 28 tests, including fake IMAP/SMTP
                   servers on real localhost sockets
```

## Limitations

- Authentication is plain `LOGIN` / `AUTH LOGIN` / `AUTH PLAIN` only —
  **no OAuth2**. Providers that require OAuth (e.g. some Microsoft 365
  tenants) will not work; use an app password where your provider allows it.
- No IDLE/push — `sync` is a manual pull.
- No S/MIME or PGP.
- The cache stores message text and attachments' metadata, not attachment
  bodies (attachment bytes are fetched on `read`).

## Testing

```bash
npm test        # 28 tests, node --test
```

The IMAP and SMTP clients are tested against canned servers speaking the
real protocols over localhost sockets — no real mail account is needed.

## License

MIT
