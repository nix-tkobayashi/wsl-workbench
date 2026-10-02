# dots integration Stage B — transport security gate record

Template: Stage B design handoff (v1.1, kept outside the repo), appendix D. Filling this in is not
itself a pass; the evidence and the decision below are.

- **Transport / peer identification adopted:** Windows named pipe created by a child helper of the
  Workbench main process (`src/integration/pipe-relay.js`; C# via Windows PowerShell `Add-Type`,
  Win32 `CreateNamedPipeW` + `ConvertStringSecurityDescriptorToSecurityDescriptorW`). DACL
  `D:P(D;;FA;;;NU)(A;;FA;;;<current user SID>)` (protected, deny NETWORK, allow only the current
  user), `PIPE_REJECT_REMOTE_CLIENTS`, `FILE_FLAG_FIRST_PIPE_INSTANCE`. The helper talks to main
  over its own stdio (anonymous pipes). Inside each connection the Stage A mutual HMAC handshake
  over the 256-bit pairing key still runs. The principal comes from that handshake, never from
  tool arguments.
- **Threat model / same-user processes:** protects against other Windows users, remote / network
  clients, and a process squatting the pipe name first. Does NOT protect against processes running
  as the same Windows user: they can open the pipe (the DACL allows the user) and can read the
  pairing key file (ACL = that user). Same-user compromise is out of scope (handoff §6 / §7).
- **DACL / remote rejection evidence (2026-10-02, Windows 11, Electron 42 in Node mode):**
  - helper-reported SDDL and an independent `NamedPipeClientStream.GetAccessControl()` from a
    separate PowerShell process both read `D:P(D;;FA;;;NU)(A;;FA;;;S-1-5-21-…)`;
  - main verifies that SDDL (protected, exactly those two ACEs, the user SID equals `whoami /user`)
    before accepting any client; any mismatch or helper failure keeps input blocked and falls back
    to the Stage A read-only pipe;
  - a second listener on the same name is refused (`FILE_FLAG_FIRST_PIPE_INSTANCE`, access denied);
  - wrong pairing key: rejected; concurrent connections and 100 KB messages: OK.
- **Key storage / revocation / re-pairing:** pairing key `integration\pairing.key` (ACL reset to
  the user SID and verified with `icacls`); Integration > Reset Pairing creates a new key (new
  principal, all grants end). The operation-journal HMAC key is encrypted with Electron
  `safeStorage` (DPAPI) in `integration\journal.key.enc`; without OS encryption the journal, and
  therefore input, stays unavailable.
- **Other-user / remote / other-instance tests:** NOT run (creating another Windows account or a
  remote client is outside what was authorized). Remote rejection rests on the verified NETWORK
  deny ACE plus `PIPE_REJECT_REMOTE_CLIENTS`; other-user rejection on the verified DACL.
  A second Workbench instance cannot start (single-instance lock); a squatter is refused as above.
- **Reviewer / date / commit:** implementation + Codex review loop, 2026-10-02, on top of
  `18da65a`, released as v0.26.0. The user chose this transport design (DACL pipe + keep
  mutual auth; input stays off if restriction / verification fails; enabling input is a separate
  user decision).
- **Open items:** other-user and remote connection tests; X03 (real dot → plugin → Secure MCP
  Tunnel); B11/B12 in the real app and real CLIs; Claude Code profile unmeasured.
- **Input release decision:** code path `reviewed` only when the runtime DACL verification passes;
  input itself stays OFF until the user turns it on (Integration > Allow Terminal Input).
