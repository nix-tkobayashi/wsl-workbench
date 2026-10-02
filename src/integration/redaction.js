// Best-effort masking of well-known secret shapes in output returned to a client. This is a helper,
// NOT a guarantee: secrets split across reads, encoded, echoed in pieces, or in unknown formats pass
// through. Results report redaction_applied so the client knows masking happened, never that the
// text is safe.

const MASK = '[REDACTED]';

const PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
];
// Keep the label, mask the value.
const LABELLED = [
  /(\bBearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi,
  /(\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\b\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi
];

function redact(text) {
  let out = text;
  let applied = false;
  for (const re of PATTERNS) {
    out = out.replace(re, () => { applied = true; return MASK; });
  }
  for (const re of LABELLED) {
    out = out.replace(re, (_m, label) => { applied = true; return `${label}${MASK}`; });
  }
  return { text: out, applied };
}

module.exports = { redact, MASK };
