// Stage B: fixed CLI input profiles and input-text rules.
//
// A profile pins how input is encoded for ONE CLI family and input mode (single line, text and
// Enter as separate writes, the submit delay). The versions it was actually measured with are kept
// separately in `verified_versions`; a profile is NOT verified for a whole major version. The user
// picks a profile per pane; the name is the user's statement, not proof of what runs in the
// foreground. Profiles are compiled in: nothing over MCP can add or edit one. Only `verified`
// profiles (at least one measured version) are selectable or advertised. Profile IDs are stable
// (the "2.1" / "0.160" in an ID is the first measured version, kept for compatibility).
//
// Version policy for the CLI actually running in a pane (see versionStatus):
//   - a verified version                      -> usable,
//   - same major, not verified                -> usable only after the user approved compatible
//                                                behaviour for that exact version (remembered),
//   - other major, other CLI, or unknown      -> not usable until resolved (no automatic compat).
//
// Text is never normalized, trimmed, quoted, escaped, or newline-converted. Raw ESC / bracketed
// paste / ANSI from callers is rejected; only the profile adds framing and key bytes.

const MAX_TEXT_BYTES = 8192;
const CANDIDATE_KEYS = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace'];
const KEY_BYTES = {
  Enter: '\r',
  Tab: '\t',
  Escape: '\x1b',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Backspace: '\x7f'
};

const PROFILES = [
  {
    id: 'codex.0.160.composer.single-line',
    revision: '1',
    cli_name: 'codex',
    cli_family: 'codex',
    cli_version: '0.160.0', // first measured version (kept for compatibility)
    verified_versions: ['0.160.0'],
    // Startup banner as it appears in the pane's (normalized) output.
    banner: /OpenAI Codex\s*\(v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\)/,
    // Observation after Enter (advisory): the CLI's busy line; no reliable reply marker known.
    acceptMarker: /esc to interrupt/i,
    responseMarker: null,
    mode: 'interactive-composer',
    multiline: false,
    paste_mode: 'plain',
    submit_key: 'Enter',
    supported_keys: ['Enter'],
    submitDelayMs: 600,
    verified: true,
    // B06 measurement, 2026-10-02, WSL2 Ubuntu, node-pty 1.x, 120x40, empty temp dir, new PTY:
    //  - text written as UTF-8, then 600 ms, then "\r" -> submitted (composer cleared, reply "OK").
    //  - text + "\r" in ONE write -> NOT submitted (stays in the composer: paste-burst handling).
    //  Only Enter-as-submit was measured; other keys are unverified and not offered.
    evidence: ['B06:codex-0.160.0:2026-10-02:text+600ms+CR=submit', 'B06:codex-0.160.0:2026-10-02:text+CR-one-write=not-submitted']
  },
  {
    id: 'claude-code.2.1.prompt.single-line',
    revision: '1',
    cli_name: 'claude-code',
    cli_family: 'claude-code',
    cli_version: '2.1.287', // first measured version (kept for compatibility)
    verified_versions: ['2.1.287'],
    // The version must be followed by a non-version character, so a banner split inside its
    // number (".../v2.1.28" + "7") is not taken early; the scan tail then sees it complete.
    // The whole version, prerelease / build suffix included (2.1.287-beta.1 is NOT 2.1.287).
    banner: /Claude Code\s*v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=[^\w.+-])/,
    acceptMarker: /esc to interrupt/i,
    responseMarker: /[⏺●]\s*\S/,
    mode: 'interactive-prompt',
    multiline: false,
    paste_mode: 'plain',
    submit_key: 'Enter',
    supported_keys: ['Enter'],
    submitDelayMs: 600,
    verified: true,
    // B06 measurement, 2026-10-03, Windows ConPTY -> wsl.exe (as Workbench), WSL2 Ubuntu, 120x40,
    // node-pty 1.x, empty temp dir that the user trusted in Claude Code themselves (no prompt was
    // answered by the measurement), new PTY, prompt 「ツールを使わず、OKとだけ返してください」:
    //  - text written as UTF-8, then 600 ms, then "\r" -> submitted (prompt moved to the transcript,
    //    input cleared, reply "OK").
    //  - text + "\r" in ONE write -> also submitted (reply "OK"); Workbench still sends them as
    //    separate writes with a confirmation in between.
    //  Only Enter-as-submit was measured; other keys and multi-line input are unverified, not offered.
    evidence: ['B06:claude-code-2.1.287:2026-10-03:text+600ms+CR=submit', 'B06:claude-code-2.1.287:2026-10-03:text+CR-one-write=submit']
  }
];

function verifiedProfiles() { return PROFILES.filter((p) => p.verified && p.verified_versions.length > 0); }

// X.Y.Z with an optional prerelease / build suffix. Only an exact entry in verified_versions is
// verified; a suffixed version of a verified one is an unverified version of the same major.
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// The compatibility line of a version: its major, or for 0.x the minor too (semver: 0.y changes
// may break), so codex 0.160 -> 0.161 counts like a major change.
function majorOf(version) {
  const m = VERSION_RE.exec(String(version || ''));
  if (!m) return null;
  return m[1] === '0' ? `0.${m[2]}` : m[1];
}

// The CLIs (family + version) seen in a pane's own output: every startup banner in the text, in
// stream order, with where each ends. Advisory: any program could print the same text.
function detectClis(text) {
  const found = [];
  for (const p of verifiedProfiles()) {
    const re = new RegExp(p.banner.source, 'g');
    let m;
    while ((m = re.exec(text))) found.push({ family: p.cli_family, version: m[1], index: m.index, end: m.index + m[0].length });
  }
  return found.sort((a, b) => a.index - b.index).map(({ family, version, index, end }) => ({ family, version, start: index, end }));
}

// The last banner (or null).
function detectCli(text) {
  const all = detectClis(text);
  if (!all.length) return null;
  const { family, version, end } = all[all.length - 1];
  return { family, version, end };
}

// cli: { family, version, source } | null. approvals: versions the user allowed compat for.
// status: verified | compat_approved | compat_pending | major_changed | family_mismatch | unknown
function versionStatus(profile, cli, approvals = []) {
  if (!profile) return { status: 'unknown', usable: false };
  if (!cli || !cli.version || !VERSION_RE.test(cli.version)) return { status: 'unknown', usable: false };
  if (cli.family && cli.family !== profile.cli_family) return { status: 'family_mismatch', usable: false };
  if (profile.verified_versions.includes(cli.version)) return { status: 'verified', usable: true };
  const majors = new Set(profile.verified_versions.map(majorOf));
  if (!majors.has(majorOf(cli.version))) return { status: 'major_changed', usable: false };
  if (approvals.includes(cli.version)) return { status: 'compat_approved', usable: true };
  return { status: 'compat_pending', usable: false };
}

function findProfile(id, revision) {
  return PROFILES.find((p) => p.verified && p.id === id && (revision === undefined || p.revision === revision)) || null;
}

// Fields advertised in capabilities.extensions.write_input_actions_v1.profiles.
function publicProfile(p) {
  return {
    id: p.id, revision: p.revision, cli_name: p.cli_name, cli_version: p.cli_version, mode: p.mode,
    verified_versions: [...p.verified_versions],
    version_policy: 'verified versions; other versions of the same major only after the user approves compatible behaviour in Workbench',
    multiline: p.multiline, paste_mode: p.paste_mode, submit_key: p.submit_key,
    supported_keys: p.supported_keys.filter((k) => CANDIDATE_KEYS.includes(k))
  };
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Validate caller text. legacy=true keeps Stage A's single-line rule; actions-v1 text may contain
// LF only with a multiline profile. Returns { ok, bytes } or { ok:false, code, message }.
function checkText(text, { profile, legacy }) {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, code: 'INPUT_INVALID', message: 'text must be a non-empty string.' };
  if (LONE_SURROGATE.test(text)) return { ok: false, code: 'INPUT_INVALID', message: 'text contains an unpaired surrogate.' };
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_TEXT_BYTES) return { ok: false, code: 'INPUT_TOO_LARGE', message: `text is ${bytes} UTF-8 bytes; the limit is ${MAX_TEXT_BYTES}.` };
  for (const ch of text) {
    const c = ch.codePointAt(0);
    const control = c < 0x20 || (c >= 0x7f && c <= 0x9f);
    if (!control) continue;
    if (ch === '\n' && !legacy && profile && profile.multiline) continue;
    if (ch === '\n') return { ok: false, code: 'INPUT_INVALID', message: 'Line feeds are not supported by the selected profile (single-line). Send one line, then submit.' };
    if (ch === '\r') return { ok: false, code: 'INPUT_INVALID', message: 'CR is not accepted; it is never converted implicitly.' };
    return { ok: false, code: 'INPUT_INVALID', message: 'text contains a control character (Tab, ESC, NUL, DEL, C0/C1 are rejected; send Tab as a named key).' };
  }
  return { ok: true, bytes };
}

function encodeText(profile, text) {
  if (profile.paste_mode !== 'plain') throw new Error('Unsupported paste mode.');
  return text;
}

function keyBytes(profile, key) {
  if (!profile.supported_keys.includes(key) || !Object.prototype.hasOwnProperty.call(KEY_BYTES, key)) return null;
  return KEY_BYTES[key];
}

module.exports = { PROFILES, MAX_TEXT_BYTES, CANDIDATE_KEYS, verifiedProfiles, findProfile, publicProfile, checkText, encodeText, keyBytes, detectCli, detectClis, versionStatus, majorOf };
