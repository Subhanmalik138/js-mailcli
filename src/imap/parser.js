// IMAP response parsing (RFC 3501).
//
// The wire format mixes atoms, quoted strings, parenthesised lists and
// byte-count literals ({n}\r\n<bytes>). The reader below turns a socket
// stream into complete responses; the tokenizer turns each response into a
// nested token tree where literals become { literal: Buffer } nodes.

/** A literal payload read from the wire. */
export class Literal {
  constructor(buffer) {
    this.buffer = buffer;
  }
  toString(encoding = 'utf8') {
    return this.buffer.toString(encoding);
  }
}

/**
 * Tokenize one response line. Literals must already have been substituted
 * by the reader (see ResponseReader) as Literal instances.
 */
export function tokenize(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') {
      i++;
    } else if (ch === '(' || ch === ')') {
      tokens.push(ch);
      i++;
    } else if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length) {
          out += line[j + 1];
          j += 2;
        } else {
          out += line[j];
          j++;
        }
      }
      tokens.push(out);
      i = j + 1;
    } else if (ch === '{') {
      // A literal marker that slipped through (reader normally consumes
      // these); treat as an atom so parsing can continue.
      const end = line.indexOf('}', i);
      tokens.push(line.slice(i, end === -1 ? line.length : end + 1));
      i = end === -1 ? line.length : end + 1;
    } else {
      let j = i;
      while (j < line.length && !' \t()\"'.includes(line[j])) j++;
      tokens.push(line.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

/** Parse a token list into a nested tree (atoms stay strings). */
export function parseTokens(tokens) {
  let pos = 0;
  const parseOne = () => {
    const tok = tokens[pos++];
    if (tok === '(') {
      const list = [];
      while (pos < tokens.length && tokens[pos] !== ')') list.push(parseOne());
      pos++; // consume ')'
      return list;
    }
    return tok;
  };
  const out = [];
  while (pos < tokens.length) out.push(parseOne());
  return out;
}

/**
 * Streaming reader for IMAP responses. `readResponse(tag)` resolves with
 * `{ tagged, untagged }` where each entry is a parsed token tree; literal
 * payloads appear as Literal nodes inside the trees.
 */
export class ResponseReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.error = null;
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on('error', (err) => {
      this.error = err;
      for (const w of this.waiters.splice(0)) w.reject(err);
    });
    socket.on('close', () => {
      if (!this.error) this.error = new Error('connection closed');
      for (const w of this.waiters.splice(0)) w.reject(this.error);
    });
  }

  drain() {
    for (const w of [...this.waiters]) {
      const res = this.tryReadLine();
      if (res === null) break;
      this.waiters.splice(this.waiters.indexOf(w), 1);
      w.resolve(res);
    }
  }

  /** Read one raw line, consuming a following literal if the line ends with {n}. */
  tryReadLine() {
    const eol = this.buffer.indexOf('\r\n');
    if (eol === -1) return null;
    const line = this.buffer.subarray(0, eol).toString('latin1');
    const literalMatch = line.match(/\{(\d+)\}\s*$/);
    if (!literalMatch) {
      this.buffer = this.buffer.subarray(eol + 2);
      return { line, literal: null };
    }
    const size = parseInt(literalMatch[1], 10);
    const literalStart = eol + 2;
    if (this.buffer.length < literalStart + size + 2) return null;
    const literal = this.buffer.subarray(literalStart, literalStart + size);
    this.buffer = this.buffer.subarray(literalStart + size + 2);
    return { line, literal: Buffer.from(literal) };
  }

  /** Read a single line (with literal), as a promise. */
  readLine() {
    const immediate = this.tryReadLine();
    if (immediate) return Promise.resolve(immediate);
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /**
   * Read responses until the tagged response for `tag` arrives.
   * Returns { status, text, untagged } — untagged entries are token trees.
   */
  async readResponse(tag) {
    const untagged = [];
    for (;;) {
      const { line, literal } = await this.readLine();
      const tokens = tokenize(line);
      if (literal) {
        // Attach the literal where the {n} marker was: the marker is the
        // last token of the line, so replace it in place.
        tokens[tokens.length - 1] = new Literal(literal);
      }
      const tree = parseTokens(tokens);
      const first = tree[0];
      if (first === '*') {
        untagged.push(tree.slice(1));
      } else if (first === tag) {
        return { status: (tree[1] || '').toUpperCase(), text: tree.slice(2), untagged };
      } else if (first === '+') {
        // Continuation request — caller handles it via sendContinuation.
        untagged.push(['+', ...tree.slice(1)]);
      } else {
        untagged.push(tree);
      }
    }
  }
}

/** Find the value after a key inside a FETCH response list. */
export function fetchValue(list, key) {
  const want = String(key).toUpperCase();
  for (let i = 0; i < list.length - 1; i += 2) {
    if (typeof list[i] === 'string' && list[i].toUpperCase() === want) return list[i + 1];
  }
  return undefined;
}

/** Parse an ENVELOPE address list into { name, email } objects. */
export function parseEnvelopeAddresses(list) {
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    if (!Array.isArray(entry)) return null;
    const [name, , mailbox, host] = entry;
    return {
      name: name === 'NIL' ? '' : String(name ?? ''),
      email: mailbox === 'NIL' || host === 'NIL' ? '' : `${mailbox}@${host}`,
    };
  }).filter(Boolean);
}
