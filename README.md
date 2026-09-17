<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="Switch to web models. Stay in Codex. Your ChatGPT plan. Your workflow. Maximum capabilities.">
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.9/codex-web-gpt-5.0.9-win-x64.exe"><img src="assets/readme/download-windows.svg" width="224" height="64" alt="Windows · x64"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.9/codex-web-gpt-5.0.9-mac-arm64.dmg"><img src="assets/readme/download-macos.svg" width="224" height="64" alt="macOS · Apple silicon"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.9/codex-web-gpt-5.0.9-linux-x64.AppImage"><img src="assets/readme/download-linux.svg" width="224" height="64" alt="Linux · x64"></a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.9/codex-web-gpt-5.0.9-mac-x64.dmg">macOS Intel</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/latest">All releases</a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="assets/demo.gif" width="960" alt="A live ChatGPT Web turn using the native Codex harness">
</p>

<p align="center">
  <a href="#get-started">Get started</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases">What’s new</a> · <a href="docs/architecture.md">Architecture</a> · <a href="TROUBLESHOOTING.md">Troubleshooting</a>
</p>

Use the ChatGPT Web models available on your account, including Pro, from Codex’s native model picker—with ChatGPT Web’s separate usage limits, without spending your Work or Codex quota. Keep the same interface, tasks, images, and streaming.

Full harness mode connects ChatGPT to the current task’s files, terminal, tools, and approvals through MCP. Conversations stay tied to your Codex task, so you can keep working as the context grows.

<div id="get-started"><a id="quick-start"></a></div>

## Get started

**Available models:** Free/Go → **Luna / Think**. Accounts with reasoning controls → **Instant–High**, plus **Extra High** and **Pro** when available. The launcher detects what your account can use.

1. **Install the launcher** using the download for your system above.
2. **Sign in to ChatGPT** in the embedded browser and run the browser smoke test.
3. **Install models**, restart Codex once, and choose a **ChatGPT Web — …** model.
4. **For coding with tools**, open **MCP** in the launcher and complete the Full harness setup below.

The app includes its browser and runtime. No separate Chrome, Node, or Bun installation is needed.

<details>
<summary><strong>Terminal install, updates & repair</strong></summary>

Quit the launcher before updating. These installers select the platform and architecture, verify the published checksums, and preserve your ChatGPT profile and launcher settings.

**macOS / Linux**

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

**Windows friendly installer (checks the machine first)**

`scripts/install-friendly.ps1` inspects the machine before anything is installed and prints an
OK / WARN / FAIL report with a fix for each problem: 64-bit Windows, disk space, Bun, git, ripgrep,
the Codex CLI and desktop app, HTTPS inspection and certificate trust (see "Corporate networks &
TLS inspection" below), the Responses port, the launcher, the CLI wrappers, the
Codex model route, and — with `-Workspace <folder>` — a project `.codex/config.toml` that pins
`model` and makes the Codex desktop picker snap back.

- Check only (changes nothing): `powershell -ExecutionPolicy Bypass -File scripts\install-friendly.ps1`
- Apply the safe user-level fixes it offers: add `-Fix`
- Install the launcher: add `-Install -Repository <owner/repo> [-Tag <tag>]` to download the
  installer from that repository's GitHub Release (through `gh` when available, which also works
  for private repositories), or `-InstallerPath <codex-web-gpt-<version>-win-x64.exe>` for a local
  file; either way the installer is verified against the release's `checksums.txt` first

Maintainers prepare the release with `scripts/package-friendly-release.ps1 -Build`. No archive is
made: the release carries the NSIS installer itself, `install-friendly.ps1`, and a `checksums.txt`
covering both, and is uploaded only when `-Publish -Repository <owner/repo> -Tag <tag>` is given
(`-Target <branch>` sets where a new tag points).

After installing, the launcher's **Setup** page walks through the rest: 1. sign in to ChatGPT,
2. run the browser smoke test, 3. **Add models** to Codex (quit every Codex window first; start
Codex yourself if it does not open), and 4. on Windows browser-only mode, **Start the HITL
terminal** for a project folder, or copy the shown
`codex-chatgpt-web serve --hitl --workspace <folder> --hitl-auto-approve` command into a terminal.

</details>

<details>
<summary><strong>Models, modes & MCP setup</strong></summary>

<a id="modes"></a>

Automatic modes offer Luna/Think when the account has no reasoning selector; otherwise Instant–High, with Extra High and Pro available independently when exposed by the account.

| Mode | Sending messages | Local Codex tools |
| --- | --- | --- |
| **Browser-only** | Automatic | No |
| **Full harness (With Automation)** | Automatic | Yes, through MCP |
| **Zero Risk** | Paste and send manually | Yes, through a separate MCP connector |

Zero Risk does not read or operate the ChatGPT page. Choose the model and `Codex Zero Risk` connector yourself, paste and send the prepared prompt, then confirm **Sent** in the launcher. Automatic model entries each select a fixed ChatGPT mode; Codex’s Effort and Speed rows do not override it.

<a id="full-harness"></a>

### Full harness

Full mode connects ChatGPT's tool calls back to the current Codex task through the official
[OpenAI tunnel-client](https://github.com/openai/tunnel-client). The tunnel is outbound: it does
not expose a public IP, open an inbound port, or require router forwarding.

The launcher's **MCP** page guides the complete setup. For the exact clicks, see the
[video walkthroughs](TROUBLESHOOTING.md).

> **Limits**
>
> See [Limits](https://github.com/miuuyy/codex-chatgpt-web/discussions/309) for the current
> ChatGPT message allowances for **GPT-5.6 Sol Pro** and **GPT-6 Astra**. Context limits depend on
> the account type and selected effort. Plus Medium/High uses a measured 90,000-token window, or
> up to 270,000 tokens with experimental **3× context** enabled, with native Codex compaction
> supported throughout.

1. Finish the required setup, open **MCP**, create the Tunnel and regular API key, then press
   **Connect harness**.
2. Enable ChatGPT **Developer Mode** and create a new Tunnel connector named exactly
   **Codex Native2**, with **Authentication: None** and **Allow all actions**.
3. Run **Verify runtime** to confirm that **Codex Native2** is attached and available.

Write/modify actions also require the ChatGPT workspace and its administrator policy to permit
them. See
[developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Unexpected approval prompts fail closed unless `--auto-approve-tool-calls` is explicitly enabled;
that option clicks **Allow once**, never a permanent grant.

</details>

<details>
<summary><strong>Browser-only local exec (HITL)</strong></summary>

<a id="hitl"></a>

When the MCP tunnel isn't an option (e.g. it's blocked on your network), `--hitl` lets a
browser-only session run local shell commands directly from the terminal instead, gated by your
explicit approval on every single command:

```bash
codex-chatgpt-web setup --browser-only --acknowledge-unofficial
codex-chatgpt-web serve --hitl
```

`--hitl` requires `--browser-only` (full mode already has real tool calls through MCP) and only
activates in the foreground with an attached TTY — it fails closed (no exec) under any other
condition, such as running as a background service.

Commands are confined to a **workspace root**: the directory you run `serve` from, or the one given
with `--workspace` (Codex does not tell the daemon which project it has open, so point this at the
same project):

```bash
codex-chatgpt-web serve --hitl --workspace D:\path\to\your\project
```

If you accept the risk, `--hitl-auto-approve` skips the per-command prompt entirely: every command
the model requests runs immediately (still confined to the workspace root and echoed to the
terminal), including destructive ones.

On Windows the launcher can do this for you: **Settings → Local exec (HITL)** lets you pick the
workspace folder and opens a terminal window running the server. Close that window to stop it, and
use **Leave HITL mode** to hand the port back to the launcher's background runtime.

The model is told this root and asked for relative `cwd` values. A request whose `cwd` resolves
outside it is blocked without prompting, logged as `[hitl] blocked EXEC_REQUEST ...`, and the model
is told why so it can retry with a relative path.

Once active, the model can ask to run a command by emitting an `[EXEC_REQUEST]` block; the
terminal shows an **AI EXECUTION PROPOSAL** and waits for you to press Enter/`y` to run it, `n`/Esc
to reject, or `c` to edit the command first. Nothing executes without that per-command approval.

There is no MCP subagent tool available over this transport, so the model is instead instructed to
delegate independent sub-tasks by running `codex exec` non-interactively as an approved shell
command (e.g. a scoped code review of one file), reading the result back with a second
`[EXEC_REQUEST]`.

If you're working from this repo (e.g. testing a fork with local changes not yet in an official
release), build and install both pieces from source instead of downloading the prebuilt release
binaries above, so the installed `codex-chatgpt-web` and **Codex Web GPT** actually reflect your
changes:

```bash
./scripts/install-local.sh
./scripts/install-launcher-local.sh
```

Skip this and use an official release if you don't have local changes to test; everything below
applies either way.

**Quick start, running the launcher app alongside `--hitl`:**

1. Make sure the setup command above has run at least once. If this machine's config already uses
   the launcher's own browser (the case if you've used the packaged app before), run it with the
   launcher open — setup inspects the launcher's account/model capabilities and fails if it isn't
   running. This is a one-time step; skip it if you've already completed it.
2. In the launcher's Preferences, turn off **Open at login** and quit it, so it can't silently
   start its own background daemon (which can't do HITL — it has no attached TTY) before you get
   a chance to start your own.
3. With the launcher closed, open a terminal in this repo and run `codex-chatgpt-web serve --hitl`,
   leaving it running in the foreground; run it again from the repo directory at the start of every
   session.
4. Start **Codex Web GPT** as usual: sign in, let the browser smoke test finish, and install
   models. It detects that a runtime is already listening and won't start a conflicting one of its
   own — any warning about that is expected and can be ignored. Keep it running alongside the
   worker.
5. Open the Codex CLI, pick a ChatGPT Web model, and its tool calls now arrive as
   `[EXEC_REQUEST]` prompts in the terminal running `serve --hitl`.

**Current limitations:**

- **Write-capable, not sandboxed by content.** The exec channel runs whatever command you approve
  — including destructive ones (`rm`, `git commit`, `sed -i`, …) — with real effects on your
  filesystem. The only built-in restrictions are that commands are confined to the configured
  workspace directory, and every single command needs your explicit approval; there is no
  automatic read-only enforcement or command blocklist.
- **10-minute timeout, 10KB output cap per command.** Long-running or chatty commands are cut off
  and truncated; scope delegated sub-tasks narrowly (one file or question, not a full audit).
- **Single-line commands only.** The `command:` field is parsed as one line, so a delegated task
  prompt must be single-quoted and free of embedded newlines or single quotes.
- **Unverified signal propagation.** The timeout sends SIGTERM to the command's shell process; whether
  that reliably reaches everything a nested `codex exec` spawns hasn't been independently confirmed.

</details>

<details>
<summary><strong>Diagnostics & subagents</strong></summary>

<a id="operations"></a>

Use **Activity** for safe local diagnostics and **Settings → Run doctor** for end-to-end health.
Settings can also cancel a retained browser turn or remove the Codex integration before uninstall.
Set `CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` only when every browser checkpoint needs a screenshot.

New installs use **Compatibility V1** for cross-backend subagents. **Native** preserves Codex's own
feature settings and enables plaintext Web-to-Web V2 delegation. Restart Codex and start a new task
after changing the protocol:

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

</details>

<details>
<summary><strong>Requirements & security</strong></summary>

<a id="limitations-and-security"></a>

- This is unofficial browser automation, not an OpenAI API. ChatGPT UI changes can break selectors;
  drift fails explicitly instead of silently switching model or transport.
- Browser state is a sensitive login artifact, and the loopback listener is reachable by processes
  running as the same local user. Never share the launcher profile; use a trusted workstation.
- Release packages currently target macOS 13+ (arm64/x64), Windows x64, and Linux x64. Runtime,
  tests, and packaging are gated on all three in CI; account-bound browser and MCP flows use the
  separate [release validation](docs/release-validation.md).
- Builds are not yet platform-signed, so Gatekeeper or SmartScreen may warn. The installers verify
  the published SHA-256 manifest before installation.

Read the complete [architecture](docs/architecture.md) and
[security model](docs/security-model.md) before enabling full mode. Report vulnerabilities through
[SECURITY.md](SECURITY.md).

Temporary Chat is a [ChatGPT privacy mode](https://help.openai.com/en/articles/8914046-temporary-chat-faq); prompts are still processed by OpenAI.

Validation coverage: [release validation](docs/release-validation.md).

This is independent software and is not affiliated with or endorsed by OpenAI. Use it only with
your own account and in accordance with applicable [Terms of Use](https://openai.com/policies/terms-of-use/)
and workspace policies; it does not bypass authentication or access controls.

</details>

<details>
<summary><strong>Corporate networks & TLS inspection</strong></summary>

<a id="corporate-tls"></a>

On a network that intercepts HTTPS with its own certificate authority, the Bun runtime rejects
`chatgpt.com` and `api.openai.com` with `SELF_SIGNED_CERT_IN_CHAIN` or
`unable to get local issuer certificate`, while the launcher's ChatGPT page, Codex, and the
tunnel client keep working because they use the operating system's trust store. Bun does not use
that store by default; choose one of the two settings below and set it as a user-level environment
variable so the launcher-started runtime inherits it too.

**Option 1 — `NODE_USE_SYSTEM_CA=1` (recommended).** Bun trusts the operating system's certificate
store (Windows certificate store, macOS Keychain, or the Linux system bundle), so a corporate root
CA that IT already deployed is picked up automatically and certificate rotations need no local
changes.

- Windows (PowerShell): `[Environment]::SetEnvironmentVariable('NODE_USE_SYSTEM_CA', '1', 'User')`
- macOS / Linux: add `export NODE_USE_SYSTEM_CA=1` to your shell profile.
- The same behavior is available per process as `bun --use-system-ca`.
- Prerequisite: the corporate root CA must be in the system store. On Windows, check with
  `Get-ChildItem Cert:\LocalMachine\Root, Cert:\CurrentUser\Root | Where-Object Subject -like '*<CA name>*'`.

**Option 2 — `NODE_EXTRA_CA_CERTS=<path to PEM>`.** Bun keeps its bundled roots and additionally
trusts the certificates in one PEM file. Use it when the corporate CA is not in the system store,
or on a machine where Option 1 is unavailable.

- The file must contain the corporate root CA, plus any intermediate CA the network does not send.
  Export them from your browser's certificate viewer or ask IT; a server's own (leaf) certificate is
  not needed.
- Windows (PowerShell): `[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'C:\path\corp-ca.pem', 'User')`
- macOS / Linux: `export NODE_EXTRA_CA_CERTS=/path/corp-ca.pem`
- The variable is read once at process start and must point to an existing file; update the PEM
  whenever IT rotates the CA or intercepting intermediate.

The two options can be combined: the PEM certificates are added on top of the system store.

After changing either variable, restart everything that starts Bun so it inherits the new value:
open a new terminal before `codex-chatgpt-web serve`, quit and reopen the launcher, and fully
restart Codex. If you launch through a custom `codex-chatgpt-web.cmd` or shell wrapper that sets
these variables itself, update the wrapper as well, and re-check it after reinstalling.

To verify, run
`bun -e "for (const u of ['https://chatgpt.com/','https://api.openai.com/v1/models']) console.log(u, (await fetch(u, {method:'HEAD'})).status)"`
— both URLs should print an HTTP status (a `401` from `api.openai.com` without a key is expected)
instead of a certificate error.

</details>

<details>
<summary><strong>Run from source & develop</strong></summary>

<a id="development"></a>

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

This source path requires Bun 1.4.0. The command installs locked dependencies and opens the app.

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` uses a separate profile and account under `~/.codex-chatgpt-web-dev`. `dev:chat` exercises the real browser and compaction paths with explicit simulated tool results, without changing your normal Codex route. See the [DEV chat harness](docs/dev-chat.md) for setup and commands.

</details>

## Star History

<a href="https://www.star-history.com/?repos=miuuyy%2Fcodex-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

---

[Troubleshooting](TROUBLESHOOTING.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE) · [CI](https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml)

Also by me: <img src="assets/readme/persona-voice.svg" width="20" height="20" alt=""> [ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice) — local, near-real-time custom voices for ChatGPT and Codex.
