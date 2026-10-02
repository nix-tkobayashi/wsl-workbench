# dots 接続: 通常ユーザーでのアダプター確認と Secure MCP Tunnel 設定手順

対象: WSL Workbench 0.26.1（インストール版）。pipe の権限は変更しない（本人 SID のみ許可、NETWORK 拒否のまま）。

## 1. 通常ユーザーでのアダプター確認手順（管理者権限不要）

前提:
- Workbench が起動中で、**Integration > Enable dots Integration** がオンになっている。
- 対象ペインで **⇪ > Share with dots (read-only, 30 min)** が有効になっている。
- サンドボックスの外で、本人ユーザーの通常の PowerShell を開く（「管理者として実行」は使わない）。

1. 権限を確認する。`whoami /groups | Select-String 'Mandatory Label'` の結果が `Medium Mandatory Level` であること（High の場合は管理者昇格中なので使わない）。
2. 読み取り専用のプローブでアダプターを起動する。プローブは次の順で呼び出す: initialize → tools/list → `workbench_capabilities` → `workbench_list_sessions` → 各セッションの `workbench_read_output`。表示するのはメタデータだけで、出力本文は表示しない。入力系のツールは呼ばない。
   ```powershell
   $env:ELECTRON_RUN_AS_NODE = '1'
   $app = "$env:LOCALAPPDATA\Programs\wsl-workbench"
   & "$app\WSL Workbench.exe" <probe.js のパス> "$app\resources\app.asar\src\mcp\adapter.js"
   ```
3. 判定方法:
   - アダプターの標準エラー出力に `pipe-open → hello-received → auth-sent → auth-ok → adapter_connected` が順に出れば認証成功。
   - `list_sessions` の件数が共有中のペインの数と一致すること。
   - `read_output` の結果は 3 通りに分けて記録する。
     - 「ok かつ N bytes」= 読み取り成功で、出力あり
     - 「ok かつ 0 bytes」= 読み取りは成功したが、共有後の出力がない（失敗ではない）
     - 「error」= 読み取り失敗
4. 失敗した場合は、同じ時刻のログを 3 か所で突き合わせる。
   - アダプター: 標準エラー出力と `%APPDATA%\wsl-workbench\integration\diag\adapter-*.jsonl`
   - broker と relay: `%APPDATA%\wsl-workbench\integration\audit\audit-*.jsonl`
   - 切り分けの目安:
     - `relay_accepted` が記録されていない → Windows のアクセス制御で拒否されている（アダプター側に `EPERM` が出る）
     - `relay_accepted` はあるが `hello_sent` がない → relay から broker への引き渡しで止まっている
     - `auth_failed` → ペアリング鍵が一致していない

## 2. 実測結果（2026-10-02 16:23 JST）

- 実行ユーザー: 本人（`Medium Mandatory Level`、管理者昇格なし）。実行ファイルはインストール版 0.26.1。
- アダプター: `pipe-open → hello-received → auth-sent → auth-ok → adapter_connected`（認証成功）。
- broker と relay（監査ログ、同じ試行）: `relay_accepted(relay_id 1) → connection_accepted → hello_sent → relay_handed_off → connected (2 ms)`。続いて `call capabilities / list_sessions / read_output` がすべて `allow`。最後に `relay_peer_closed`（受信 673 B、送信 8868 B）→ `disconnected`。
- `workbench_capabilities`: ok（`output_read: true`、`input_write: true`、`command_execution: false`）。
- `workbench_list_sessions`: ok、1 件（セッション 830b4ce8…、lifecycle alive）。
- `workbench_read_output`: ok、4095 bytes（max_bytes 4096、gap なし、続きあり）→ 出力ありの読み取り成功。
- 入力（`workbench_write_input`）と Enter の送信は行っていない。
- 結論: 同じ pipe 権限のまま、本人の通常プロセスからは接続、セッション一覧、出力取得まで成功した。サンドボックスからの `EPERM` は、サンドボックス側のトークンが pipe の権限チェックを通らないためと判断する。

## 3. tunnel-client と .cmd ラッパーの事前検証（2026-10-02 16:37 JST、API キーなし）

- 入手したもの: `tunnel-client-v0.0.15-windows-amd64.zip`（GitHub openai/tunnel-client の Releases）。
  - SHA256 は `SHA256SUMS.txt` と一致した。
  - ただし `tunnel-client.exe` には **Authenticode 署名がない**（NotSigned）。
  - バージョン: `0.0.15+a390c168`。同梱の `cloudflared.exe` は、標準の stdio 構成では使わない。
- `--mcp-command` / `mcp.commands[].command` は、POSIX 風の区切り方で解釈される。
  - `C:\Users\...\adapter.cmd` のようにバックスラッシュで書くと、`\` が消えて起動に失敗する（`fork/exec C:Users<you>...: The system cannot find the file specified.`）。
  - **パスは `/` 区切りで書く**（例: `C:/Users/<you>/wswb-mcp/adapter.cmd`）。
  - `%VAR%` も展開されないので、絶対パスで書く。
  - `.cmd` はそのまま起動できる。ラッパーの中の `%LOCALAPPDATA%` は cmd.exe が展開するので問題ない。
- `tunnel-client dev proxy`（ローカルだけで動く疑似コントロールプレーン。API キーも外部通信も不要）で、通し試験をした。経路は `HTTP MCP → tunnel-client → adapter.cmd → adapter → pipe → Workbench`。
  - initialize → tools/list → capabilities → list_sessions（1 件）→ read_output（ok、4094 bytes）がすべて成功した。
  - 監査ログでは `relay_accepted(relay_id 2) → connected → call ×4 allow` だった。
  - 入力は送っていない。
- `tunnel-client init --mcp-command <.cmd>` は、自動で `sample_mcp_stdio_local` を選び、プロファイル YAML を生成した。中身は `api_key: "env:CONTROL_PLANE_API_KEY"`、`mcp.commands[0].command` = ラッパーのパス。
  - `doctor` の結果は、キー未設定（`control_plane_api_key FAIL`）以外はすべて PASS だった。
- 未確認: OpenAI の本番コントロールプレーンへの接続、ChatGPT からのツール検出、dot からの呼び出し。いずれも API キーと Tunnel が必要。

## 4. Secure MCP Tunnel 経由で dot に接続する手順（★ = 利用者の操作・承認が必要）

構成: `dot → ChatGPT の開発者モードのコネクター/プラグイン → Secure MCP Tunnel → tunnel-client（Windows 上で本人ユーザーの通常プロセス）→ adapter.cmd → adapter（stdio）→ pipe → Workbench`

### 必要条件
- tunnel-client は **サンドボックスの外で、本人ユーザーの通常の PowerShell から**起動する（Medium 整合性。「管理者として実行」は使わない）。
- 外向きの HTTPS 通信で `api.openai.com:443` に届くこと。待ち受けポート（listener）を公開する必要はない。
  - health と UI はローカルの `127.0.0.1` だけで動く。ポートの衝突を避けるため `--health-listen-addr 127.0.0.1:0` にする。
- 接続を検出するときも、毎回の呼び出しのときも、`tunnel-client run` を起動したままにしておく必要がある。Workbench も起動したままで、統合をオンにし、ペインを共有しておく。
- 権限:
  - Tunnel を作る人: Tunnels Read + Manage
  - 実行用キー: Tunnels Read + Use
  - ChatGPT 側: 開発者モード（ワークスペースの方針で使えない場合がある）

### 手順
1. 準備（本人ユーザー、管理者権限なし）
   - 恒久的に置く場所を作る（例: `%USERPROFILE%\wswb-mcp\`）。そこに検証済みの `tunnel-client.exe` と `cloudflared.exe` を置く。
   - 同じ場所に `adapter.cmd` を置く:
     ```bat
     @echo off
     set ELECTRON_RUN_AS_NODE=1
     "%LOCALAPPDATA%\Programs\wsl-workbench\WSL Workbench.exe" "%LOCALAPPDATA%\Programs\wsl-workbench\resources\app.asar\src\mcp\adapter.js"
     ```
   - 署名がないので、ダウンロード元と SHA256 が一致していることを、利用者自身で判断する。
2. ★ OpenAI Platform の組織オーナーまたは RBAC 管理者が権限を付与する（Tunnel を作る人に Read + Manage、実行用キーの所有者に Read + Use）。
3. ★ Tunnel を作る: https://platform.openai.com/settings/organization/tunnels
   - 作成したら、使う ChatGPT ワークスペースに関連付ける。
   - `tunnel_id`（`tunnel_` + 32 桁の 16 進数）を控える。これは秘密情報ではない。
4. ★ 実行用の API キーを発行する: https://platform.openai.com/settings/organization/api-keys（Tunnels の Read + Use だけ）。Admin キー（`OPENAI_ADMIN_KEY`）は不要。
5. プロファイルを作る（キーはまだ不要）:
   ```powershell
   cd $env:USERPROFILE\wswb-mcp
   .\tunnel-client.exe init --profile wsl-workbench --tunnel-id <tunnel_id> `
     --mcp-command "C:/Users/<you>/wswb-mcp/adapter.cmd" --health-listen-addr 127.0.0.1:0
   ```
6. ★ 読み取り専用で始めるため、Workbench の **Integration > Allow Terminal Input (dots)** をオフにする。オンのままだと、`workbench_write_input` と `workbench_get_operation` も ChatGPT に公開される。
7. ★ キーをその場で設定し、起動する。キーは画面、履歴、ファイルに残さない（PowerShell 5.1 用の書き方）:
   ```powershell
   $s = Read-Host -AsSecureString 'Runtime API key'
   $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)); Remove-Variable s
   .\tunnel-client.exe doctor --profile wsl-workbench    # RESULT pass になること
   .\tunnel-client.exe run --profile wsl-workbench       # 起動したままにする
   ```
   `--log.http-raw-unsafe` は使わない（本文が記録されてしまう）。
8. ★ ChatGPT で設定する。
   - Settings → Security and login → **Developer mode** をオンにする（ワークスペース管理者の許可が要る場合がある）。
   - https://chatgpt.com/plugins（または Settings → Connectors）で + → 名前と説明を入力 → Connection で **Tunnel** を選ぶ → `tunnel_id` を選ぶ → 作成する。
   - この操作は `run` を起動している間に行う。
9. ★ 検出されたツールが読み取り系の 4 つ（capabilities / list_sessions / get_session / read_output）だけであることを確認する。
10. ★ ペインを共有した状態で、dot から capabilities → list_sessions → read_output を呼ぶ（X03 の読み取り部分）。
    - 結果は「ok かつ N bytes」「ok かつ 0 bytes（読み取り成功だが空）」「error」の 3 通りに分けて記録する。
    - 失敗したら次の 3 か所を突き合わせる: tunnel-client のログ（`run` の出力、または `/ui`）、adapter の diag ログ、Workbench の監査ログ。

### 秘密情報の扱い
- 秘密情報は `CONTROL_PLANE_API_KEY`（PowerShell のそのセッションの環境変数だけ）と `pairing.key`（Workbench が管理、本人の ACL）の 2 つだけ。どちらもチャット、ログ、プロファイル YAML、永続的な環境変数に書かない（プロファイルには `env:` という参照だけが入る）。
- `tunnel_id`、pipe の名前、診断ログ（段階、理由、エラーコード、バイト数）は秘密情報ではない。
- 共有した出力は Tunnel を経由して ChatGPT 側に送られる。共有するペインと時間は最小限にする。

## 5. 実機での接続結果（X03 の読み取り部分、2026-10-02 18:25〜18:38 JST）

- 構成:
  - Tunnel `tunnel_<32 hex>`（Personal 組織、ChatGPT ワークスペースと関連付け済み）
  - tunnel-client v0.0.15。本人ユーザー（Medium 整合性）の PowerShell から `run --profile wsl-workbench` で起動した。プロファイルは `%APPDATA%\tunnel-client\wsl-workbench.yaml`、実行ファイルは `%USERPROFILE%\wswb-mcp\`。
  - Workbench 0.26.1。入力許可はオフ（`input_disabled` 18:06）。
- ChatGPT 側の UI（2026-10 時点）:
  - 「設定 → セキュリティとログイン」に Developer mode の項目はなかった。
  - 代わりに https://chatgpt.com/plugins の「追加 → カスタム MCP サーバーを作成」で作成した。入力内容は、接続タイプ「トンネル」、Tunnel ID、認証「認証なし」、リスク確認にチェック → 「プラグインとして作成」。
- 登録時: アダプターが `auth-ok` まで進み、Workbench 側で `relay_accepted(2) → connected → call capabilities allow` を確認した（18:25:10）。
- dot からの読み取り: `call workbench_list_sessions allow`（18:37:54）→ `call workbench_read_output allow bytes=1128`（18:38:03）。dot の報告（1,128 バイト）と一致した → **出力ありの読み取り成功**。
- 入力（write_input / Enter）は行っていない。

### 運用上の注意
- API キーは、その PowerShell セッションの中だけにある。tunnel-client を止める、またはウィンドウを閉じると、dot からは使えなくなる。再開するときは、ステップ 7 のキー設定と `run` をやり直す。
- 共有は 30 分で期限切れになる（`GRANT_EXPIRED`）。期限が切れたら、ペインの ⇪ メニューから共有し直す。
- 入力（Stage B）を dot から使う場合は、別途ユーザーが判断して「Allow Terminal Input (dots)」をオンにする必要がある（このとき CLI プロファイルとペイン単位の許可も必要）。
