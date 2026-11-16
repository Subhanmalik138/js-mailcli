// MIME message model: parsing, building, and transfer-encoding helpers.
// Zero dependencies — everything here is hand-rolled against RFC 5322,
// RFC 2045/2046 (MIME), RFC 2047 (encoded-words) and RFC 2231 basics.

/** Decode a quoted-printable body (RFC 2045 §6.7). */
export function decodeQuotedPrintable(input) {
  // Soft line breaks ("=\r\n" or "=\n") are removed first.
  const withoutSoftBreaks = input.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < withoutSoftBreaks.length; i++) {
    const ch = withoutSoftBreaks[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(withoutSoftBreaks.slice(i + 1, i + 3))) {
      bytes.push(parseInt(withoutSoftBreaks.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** Encode a string as quoted-printable, keeping lines under 76 chars. */
export function encodeQuotedPrintable(text) {
  const bytes = Buffer.from(text, 'utf8');
  let out = '';
  let lineLen = 0;
  const push = (chunk) => {
    if (lineLen + chunk.length > 75) {
      out += '=\r\n';
      lineLen = 0;
    }
    out += chunk;
    lineLen += chunk.length;
  };
  for (const b of bytes) {
    if (b === 0x0a) {
      out += '\r\n';
      lineLen = 0;
    } else if (b === 0x0d) {
      // Bare CR is encoded; CRLF is produced by the LF branch above.
      push('=0D');
    } else if ((b >= 33 && b <= 60) || (b >= 62 && b <= 126)) {
      push(String.fromCharCode(b));
    } else if (b === 9 || b === 32) {
      push('=' + b.toString(16).toUpperCase().padStart(2, '0'));
    } else {
      push('=' + b.toString(16).toUpperCase().padStart(2, '0'));
    }
  }
  return out;
}

/**
 * Decode RFC 2047 encoded-words such as =?UTF-8?B?...?= or =?UTF-8?Q?...?=.
 * Unknown charsets fall back to UTF-8; malformed words are left untouched.
 */
export function decodeEncodedWords(value) {
  // Whitespace between adjacent encoded-words is ignored (RFC 2047 §6.2).
  const collapsed = value.replace(/(\?=[ \t\r\n]+)(?==\?)/g, '?=');
  return collapsed.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset, enc, text) => {
    try {
      let buf;
      if (enc.toUpperCase() === 'B') {
        buf = Buffer.from(text, 'base64');
      } else {
        buf = decodeQuotedPrintable(text.replace(/_/g, ' '));
      }
      return buf.toString(charset.toLowerCase() === 'utf-8' ? 'utf8' : charset);
    } catch {
      return _m;
    }
  });
}

/** Split raw message text into header block and body, unfolding headers. */
export function splitHeaders(raw) {
  const idx = raw.search(/\r?\n\r?\n/);
  const head = idx === -1 ? raw : raw.slice(0, idx);
  const body = idx === -1 ? '' : raw.slice(idx).replace(/^\r?\n\r?\n/, '');
  const headers = new Map();
  let current = null;
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      headers.set(current, headers.get(current) + ' ' + line.trim());
    } else {
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (m) {
        current = m[1].toLowerCase();
        headers.set(current, m[2].trim());
      }
    }
  }
  return { headers, body };
}

/** Parse a `Content-Type: type/subtype; key=value; ...` header value. */
export function parseContentType(value = 'text/plain') {
  const [typePart, ...paramParts] = value.split(';');
  const [type, subtype] = typePart.trim().toLowerCase().split('/');
  const params = {};
  for (const part of paramParts) {
    const m = part.trim().match(/^([^=]+)=(?:"([^"]*)"|([^;]*))$/);
    if (m) params[m[1].toLowerCase()] = (m[2] ?? m[3] ?? '').trim();
  }
  return { type: type || 'text', subtype: subtype || 'plain', params };
}

/** Parse an address header ("Alice <a@x.com>, bob@x.com") into objects. */
export function parseAddresses(value = '') {
  if (!value) return [];
  const out = [];
  // Split on commas that are not inside quotes or angle brackets.
  const parts = [];
  let depth = 0;
  let inQuote = false;
  let cur = '';
  for (const ch of value) {
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote && ch === '<') depth++;
    if (!inQuote && ch === '>') depth--;
    if (ch === ',' && !inQuote && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const angled = trimmed.match(/^(?:"([^"]*)"|([^<]*?))\s*<([^>]+)>$/);
    if (angled) {
      const name = (angled[1] ?? angled[2] ?? '').trim();
      out.push({ name: decodeEncodedWords(name), email: angled[3].trim() });
    } else {
      out.push({ name: '', email: trimmed });
    }
  }
  return out;
}

/** Decode a body part according to its Content-Transfer-Encoding. */
export function decodeBody(content, encoding = '7bit', charset = 'utf-8') {
  let buf;
  switch ((encoding || '7bit').toLowerCase()) {
    case 'base64':
      buf = Buffer.from(content.replace(/\s/g, ''), 'base64');
      break;
    case 'quoted-printable':
      buf = decodeQuotedPrintable(content);
      break;
    default:
      buf = Buffer.from(content, 'latin1');
  }
  return buf.toString(charset.toLowerCase() === 'utf-8' ? 'utf8' : charset);
}

function splitMultipart(body, boundary) {
  const delimiter = '--' + boundary;
  const close = delimiter + '--';
  const lines = body.split(/\r?\n/);
  const parts = [];
  let current = null;
  for (const line of lines) {
    if (line === delimiter) {
      if (current !== null) parts.push(current.join('\r\n'));
      current = [];
    } else if (line === close) {
      if (current !== null) parts.push(current.join('\r\n'));
      current = null;
      break;
    } else if (current !== null) {
      current.push(line);
    }
  }
  return parts.filter((p) => p.trim());
}

/**
 * Parse a full raw message into a structured object:
 * { headers, from, to, cc, subject, date, text, html, attachments }
 * Attachments are { filename, contentType, data: Buffer }.
 */
export function parseMessage(raw) {
  const { headers, body } = splitHeaders(raw);
  const ct = parseContentType(headers.get('content-type'));
  const msg = {
    headers,
    from: parseAddresses(headers.get('from'))[0] ?? null,
    to: parseAddresses(headers.get('to')),
    cc: parseAddresses(headers.get('cc')),
    subject: decodeEncodedWords(headers.get('subject') ?? ''),
    date: headers.get('date') ?? '',
    messageId: headers.get('message-id') ?? '',
    text: '',
    html: '',
    attachments: [],
  };

  const walk = (partBody, partCt, partHeaders) => {
    const encoding = partHeaders.get('content-transfer-encoding') ?? '7bit';
    const disposition = (partHeaders.get('content-disposition') ?? '').toLowerCase();
    if (partCt.type === 'multipart') {
      const boundary = partCt.params.boundary;
      if (!boundary) return;
      for (const chunk of splitMultipart(partBody, boundary)) {
        const { headers: h, body: b } = splitHeaders(chunk);
        walk(b, parseContentType(h.get('content-type')), h);
      }
      return;
    }
    const charset = partCt.params.charset ?? 'utf-8';
    if (disposition.startsWith('attachment') || partCt.params.name || partCt.params.filename) {
      const dispParams = {};
      for (const m of (partHeaders.get('content-disposition') ?? '').matchAll(/([a-z-]+)=(?:"([^"]*)"|([^; ]*))/gi)) {
        dispParams[m[1].toLowerCase()] = m[2] ?? m[3];
      }
      const filename = partCt.params.name ?? partCt.params.filename ?? dispParams.filename ?? 'attachment';
      let data;
      if (encoding.toLowerCase() === 'base64') {
        data = Buffer.from(partBody.replace(/\s/g, ''), 'base64');
      } else if (encoding.toLowerCase() === 'quoted-printable') {
        data = decodeQuotedPrintable(partBody);
      } else {
        data = Buffer.from(partBody, 'latin1');
      }
      msg.attachments.push({
        filename: decodeEncodedWords(filename),
        contentType: `${partCt.type}/${partCt.subtype}`,
        data,
      });
      return;
    }
    const decoded = decodeBody(partBody, encoding, charset);
    if (partCt.type === 'text' && partCt.subtype === 'html') {
      msg.html += decoded;
    } else {
      msg.text += decoded;
    }
  };

  walk(body, ct, headers);
  return msg;
}

/** Encode a display name for a header, using an encoded-word when needed. */
function encodeDisplayName(name) {
  if (!name) return '';
  if (/^[\x20-\x7E]*$/.test(name) && !/[",<>]/.test(name)) return name;
  return `"${name.replace(/"/g, '\\"')}"`;
}

/**
 * Build a raw RFC 5322 message. Attachments are
 * { filename, contentType, data: Buffer | string }.
 */
export function buildMessage({ from, to, cc = [], subject = '', text = '', html = '', attachments = [] }) {
  const boundary = 'mailcli-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const fmtAddr = (a) => (typeof a === 'string' ? a : a.name ? `${encodeDisplayName(a.name)} <${a.email}>` : a.email);
  const lines = [
    `From: ${fmtAddr(from)}`,
    `To: ${[to].flat().map(fmtAddr).join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.map(fmtAddr).join(', ')}`] : []),
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
  ];
  const hasAttachments = attachments.length > 0;
  const hasHtml = Boolean(html);
  if (!hasAttachments && !hasHtml) {
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('Content-Transfer-Encoding: quoted-printable');
    lines.push('', encodeQuotedPrintable(text));
    return lines.join('\r\n');
  }
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '');
  const altBoundary = boundary + '-alt';
  if (hasHtml) {
    lines.push(
      `--${boundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      `--${altBoundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      encodeQuotedPrintable(text),
      `--${altBoundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      encodeQuotedPrintable(html),
      `--${altBoundary}--`,
    );
  } else {
    lines.push(
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      encodeQuotedPrintable(text),
    );
  }
  for (const att of attachments) {
    const data = Buffer.isBuffer(att.data) ? att.data : Buffer.from(att.data);
    const b64 = data.toString('base64').replace(/(.{76})/g, '$1\r\n');
    lines.push(
      `--${boundary}`,
      `Content-Type: ${att.contentType || 'application/octet-stream'}; name="${att.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${att.filename}"`,
      '',
      b64,
    );
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

/** One-line preview of a message body for list views. */
export function snippet(text, length = 120) {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, length);
}
