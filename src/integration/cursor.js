// Opaque, server-issued cursors (dots integration). A cursor is base64url(JSON) + "." + HMAC-SHA256
// tag under a key that lives only in this main-process instance, so a client can neither forge nor
// edit one: any change fails verification -> CURSOR_INVALID. The payload is bound to the format
// version, the app instance, the Target (session + generation), the stream, the buffer epoch, and
// the position; callers compare those fields to the request before using the position.

const crypto = require('crypto');

const CURSOR_VERSION = 1;

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

function createCursorCodec(key = crypto.randomBytes(32)) {
  const tag = (body) => crypto.createHmac('sha256', key).update('wswb-cursor-v1|').update(body).digest();

  function encode(fields) {
    const body = b64url(JSON.stringify({ v: CURSOR_VERSION, ...fields }));
    return `${body}.${b64url(tag(body))}`;
  }

  // Returns the payload object, or null for anything malformed / not ours.
  function decode(cursor) {
    if (typeof cursor !== 'string' || cursor.length > 2048) return null;
    const dot = cursor.indexOf('.');
    if (dot <= 0 || dot !== cursor.lastIndexOf('.')) return null;
    const body = cursor.slice(0, dot);
    let given;
    try { given = Buffer.from(cursor.slice(dot + 1), 'base64url'); } catch { return null; }
    const expected = tag(body);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!payload || typeof payload !== 'object' || payload.v !== CURSOR_VERSION) return null;
      return payload;
    } catch {
      return null;
    }
  }

  return { encode, decode };
}

module.exports = { createCursorCodec };
