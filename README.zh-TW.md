<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="切換到網頁版模型，繼續使用 Codex。你的 ChatGPT 訂閱。你的工作流程。充分發揮模型能力。">
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.9/codex-web-gpt-5.0.9-win-x64.exe"><img src="assets/readme/download-windows.svg" width="224" height="64" alt="Windows · x64"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.9/codex-web-gpt-5.0.9-mac-arm64.dmg"><img src="assets/readme/download-macos.svg" width="224" height="64" alt="macOS · Apple silicon"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.9/codex-web-gpt-5.0.9-linux-x64.AppImage"><img src="assets/readme/download-linux.svg" width="224" height="64" alt="Linux · x64"></a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.9/codex-web-gpt-5.0.9-mac-x64.dmg">macOS Intel</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/latest">所有版本</a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="assets/demo.gif" width="960" alt="ChatGPT Web 即時回合正在使用原生 Codex harness">
</p>

<p align="center">
  <a href="#get-started">開始使用</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases">更新內容</a> · <a href="docs/architecture.md">架構</a> · <a href="TROUBLESHOOTING.md">疑難排解</a>
</p>

在 Codex 原生模型選擇器中使用帳戶可用的 ChatGPT 網頁版模型，包括 Pro。使用 ChatGPT 網頁版的獨立額度，不消耗 Work 或 Codex 額度。保留原有的介面、任務、圖片與串流輸出。

完整 harness 模式透過 MCP 將 ChatGPT 連接回目前任務的檔案、終端機、工具與審核流程。對話始終關聯到你的 Codex 任務，即使上下文持續增長也能繼續運作。

<div id="get-started"><a id="quick-start"></a></div>

## 開始使用

**可用模型：** Free/Go → **Luna / Think**；具有推理控制選項的帳戶 → **Instant–High**，並依實際可用狀態提供 **Extra High** 與 **Pro**。啟動器會自動偵測帳戶可用的模型。

1. **安裝啟動器**：點擊上方對應系統的下載按鈕。
2. **登入 ChatGPT**：在內建瀏覽器中登入並執行瀏覽器煙霧測試。
3. **安裝模型**：重新啟動一次 Codex，然後選擇 **ChatGPT Web — …** 模型。
4. **需要讓模型使用工具寫程式時**：打開啟動器中的 **MCP**，完成下方的完整 harness 設定。

應用程式已內建瀏覽器與執行環境，不需要另外安裝 Chrome、Node 或 Bun。

<details>
<summary><strong>命令列安裝、更新與修復</strong></summary>

更新前請先退出啟動器。以下安裝腳本會選擇正確的平台與架構、驗證發行版的雜湊值，並保留 ChatGPT 設定檔與啟動器設定。

**macOS / Linux**

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

</details>

<details>
<summary><strong>模型、模式與 MCP 設定</strong></summary>

<a id="modes"></a>

自動模式在帳戶沒有推理選擇器時提供 Luna/Think；否則提供 Instant–High，並依帳戶實際可用狀態分別顯示 Extra High 與 Pro。

| 模式 | 發送訊息 | 本機 Codex 工具 |
| --- | --- | --- |
| **Browser-only** | 自動 | 不支援 |
| **Full harness (With Automation)** | 自動 | 支援，透過 MCP |
| **Zero Risk** | 手動貼上並發送 | 支援，透過獨立 MCP 連接器 |

Zero Risk 不會讀取或操作 ChatGPT 頁面。請自行選擇模型與 `Codex Zero Risk` 連接器，貼上並發送準備好的提示詞，再於啟動器中確認 **Sent**。自動模式的每個模型項目對應固定的 ChatGPT 模式；Codex 的 Effort 與 Speed 選項不會覆寫它。

<a id="full-harness"></a>

### 完整 harness

完整模式透過官方
[OpenAI tunnel-client](https://github.com/openai/tunnel-client)
將 ChatGPT 的工具呼叫連接回目前的 Codex 任務。該通道為出站連線：不會暴露公開 IP、開放入站連接埠，
也不需要設定路由器連接埠轉發。

> **限制**
>
> 關於 **GPT-5.6 Sol Pro** 與 **GPT-6 Astra** 目前的 ChatGPT 訊息額度，請參閱
> [Limits](https://github.com/miuuyy/codex-chatgpt-web/discussions/309)。Token 上下文上限取決於
> 帳戶類型與所選 effort。Plus 的 Medium/High 使用實測的 90,000-token 視窗；啟用實驗性的
> **3× context** 後最高可達 270,000 tokens，且全程支援原生 Codex compaction。

1. 完成啟動器中的必要設定。
2. 在啟動器中打開 **MCP**。請在將使用 ChatGPT 連接器的同一個 OpenAI 帳戶中建立 Tunnel
   與一般 API 金鑰；建立金鑰本身免費，也不會消耗模型 API 額度。
3. 貼上 Tunnel ID 與 API 金鑰，然後點擊 **連接 Harness**。
4. 在 ChatGPT 設定中啟用 **開發者模式**。新增連接器時選擇 **Tunnel**，選擇剛建立的
   Tunnel，將 **驗證方式** 設為 **無**，並將名稱準確設為 **Codex Native2**。
5. 在 **Codex Native2** 的 **權限** 中選擇 **允許所有動作**；**允許低風險動作** 會在指令與
   修補程式送達本機執行環境前先將其攔截。外層 Codex harness 仍會執行沙盒與審核規則。
6. 執行 **驗證執行環境**，確認 **Codex Native2** 已連接並可用。

寫入／修改動作還需要 ChatGPT 工作區及其管理員政策允許。請參閱
[開發者模式與 MCP 應用程式](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)。
除非明確啟用 `--auto-approve-tool-calls`，否則未預期的審核提示會直接失敗；該選項只會點擊
**Allow once**，絕不會授予永久權限。

</details>

<details>
<summary><strong>僅瀏覽器本機執行（HITL）</strong></summary>

<a id="hitl"></a>

當 MCP 通道不可用時（例如被網路封鎖），`--hitl` 可讓僅瀏覽器工作階段改為直接從終端機執行本機
shell 指令，並要求每一條指令都經過你的明確核准：

```bash
codex-chatgpt-web setup --browser-only --acknowledge-unofficial
codex-chatgpt-web serve --hitl
```

`--hitl` 需要同時使用 `--browser-only`（Full harness 模式已可透過 MCP 進行真正的工具呼叫），
且只有在前景執行並連接 TTY 時才會啟動——在其他任何情況下（例如作為背景服務執行）都會 fail-closed
（不執行任何指令）。

啟動後，模型可以透過發出 `[EXEC_REQUEST]` 區塊來要求執行一條指令；終端機會顯示
**AI EXECUTION PROPOSAL**，並等待你按下 Enter 或 `y` 來執行、按下 `n` 或 Esc 拒絕，或按下 `c` 先編輯該
指令。未經這一逐條指令的核准，任何動作都不會執行。

這種傳輸方式沒有 MCP 子代理工具，因此模型會被指示改為透過非互動方式執行已核准的 `codex exec`
shell 指令來委派獨立的子任務（例如針對單一檔案進行範圍受限的程式碼審查），並透過第二次
`[EXEC_REQUEST]` 讀回結果。

如果你正在這個儲存庫中進行開發（例如測試一個尚未併入官方發行版的分支上的本機修改），請從原始碼
建置並安裝這兩者，而不要下載上面預先建置好的二進位檔案，這樣安裝的 `codex-chatgpt-web` 與
**Codex Web GPT** 才會真正反映你的修改：

```bash
./scripts/install-local.sh
./scripts/install-launcher-local.sh
```

如果沒有需要測試的本機修改，可以跳過這一步，直接使用官方發行版；以下內容在兩種情況下都適用。

**快速開始（與啟動器應用程式一起使用 `--hitl`）：**

1. 請確認上面的 setup 指令已經至少執行過一次。如果這台機器的設定已經在使用啟動器自身的瀏覽器
   （若你之前用過封裝版應用程式，通常就是這種情況），請在啟動器開啟的狀態下執行——setup 會檢查
   啟動器的帳戶／模型能力，若啟動器沒有執行就會失敗。這是一次性步驟，若已完成過可以跳過。
2. 在啟動器的偏好設定中關閉**登入時開啟**並退出它，這樣它就不會在你啟動自己的 worker 之前，
   悄悄啟動自己的背景常駐程式（背景常駐程式沒有連接 TTY，無法進行 HITL）。
3. 關閉啟動器後，在本儲存庫目錄下開啟一個終端機，執行 `codex-chatgpt-web serve --hitl` 並讓它在
   前景持續執行；每次開始新工作階段時都要在儲存庫目錄下重新執行一次。
4. 照常啟動 **Codex Web GPT**：登入、等瀏覽器煙霧測試完成，然後安裝模型。它會偵測到已經有一個
   執行中的執行環境佔用了連接埠，因此不會再啟動一個互相衝突的常駐程式；出現相關警告是正常現象，
   可以放心忽略。讓它與 worker 一起保持執行。
5. 打開 Codex CLI，選擇一個 ChatGPT Web 模型，工具呼叫現在會以 `[EXEC_REQUEST]` 提示的形式出現在
   執行 `serve --hitl` 的終端機中。

**目前的限制：**

- **具有寫入能力，且不會依內容進行沙盒化。** 該執行通道會執行你核准的任何指令——包括具破壞性的
  指令（`rm`、`git commit`、`sed -i` 等）——並對檔案系統產生真實影響。唯一內建的限制是指令被限定在
  已設定的工作區目錄內，並且每一條指令都需要你的明確核准；沒有自動的唯讀強制或指令黑名單。
- **每條指令 10 分鐘逾時、10KB 輸出上限。** 執行時間過長或輸出較多的指令會被截斷；委派的子任務應
  將範圍限定得很窄（一個檔案或一個問題，而非完整稽核）。
- **僅支援單行指令。** `command:` 欄位會以單行解析，因此委派任務的提示詞必須以單引號包住，且
  不能包含換行符或單引號。
- **訊號傳遞尚未驗證。** 逾時會向指令的 shell 行程送出 SIGTERM，但這是否能可靠地傳達到巢狀的
  `codex exec` 所衍生的所有行程，尚未獲得獨立確認。

</details>

<details>
<summary><strong>診斷與子代理</strong></summary>

<a id="operations"></a>

使用 **活動** 頁面檢視安全的本機診斷，並透過 **設定 → 執行診斷** 執行端到端健康檢查。設定頁還可
取消保留的瀏覽器任務，或在解除安裝前移除 Codex 整合。僅在需要為每個瀏覽器檢查點儲存螢幕截圖時設定
`CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1`。

新安裝預設使用 **Compatibility V1** 以支援跨後端 subagent。**Native** 會保留 Codex 自身的
功能設定，並啟用明文 Web-to-Web V2 委派。切換協定後，請重新啟動 Codex 並建立新任務：

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

</details>

<details>
<summary><strong>系統需求與安全</strong></summary>

<a id="limitations-and-security"></a>

- 這是非官方瀏覽器自動化，並非 OpenAI API。ChatGPT UI 變更可能破壞選擇器；發生變化時會明確
  失敗，而不是靜默切換模型或傳輸方式。
- 瀏覽器狀態是敏感的登入憑證，loopback 監聽器也可能被同一本機使用者所執行的行程存取。切勿共用
  啟動器設定檔，並僅在可信任的工作站上使用。
- 發行版本目前支援 macOS 13+（arm64/x64）、Windows x64 與 Linux x64。執行環境、測試與封裝會在
  CI 中對三種系統進行檢查；依賴帳戶的瀏覽器與 MCP 流程使用獨立的
  [發布驗證](docs/release-validation.md)。
- 建置目前尚未進行平台簽署，因此 Gatekeeper 或 SmartScreen 可能會顯示警告。安裝程式會在安裝前
  驗證已發布的 SHA-256 清單。

啟用完整模式前，請閱讀完整的[架構說明](docs/architecture.md)與
[安全模型](docs/security-model.md)。安全漏洞請透過 [SECURITY.md](SECURITY.md) 回報。

臨時聊天是 [ChatGPT 隱私模式](https://help.openai.com/en/articles/8914046-temporary-chat-faq)，提示詞仍由 OpenAI 處理。

驗證範圍：[發布驗證](docs/release-validation.md)。

本專案是獨立軟體，與 OpenAI 無關聯，也未獲得 OpenAI 背書。請僅使用自己的帳戶，並遵守適用的
[使用條款](https://openai.com/policies/terms-of-use/)與工作區政策；本專案不會繞過身份驗證或
存取控制。

</details>

<details>
<summary><strong>從原始碼執行與開發</strong></summary>

<a id="development"></a>

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

原始碼方式需要 Bun 1.4.0。此指令會安裝鎖定版本的相依套件並開啟應用程式。

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` 會在 `~/.codex-chatgpt-web-dev` 下使用獨立設定與帳戶。`dev:chat` 使用真實瀏覽器與壓縮流程，並提供明確的模擬工具結果，不會改變正常的 Codex 路由。設定與指令請參閱 [DEV chat harness](docs/dev-chat.md)。

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

[疑難排解](TROUBLESHOOTING.md) · [安全](SECURITY.md) · [貢獻](CONTRIBUTING.md) · [MIT 授權條款](LICENSE) · [CI](https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml)

我的另一個專案：<img src="assets/readme/persona-voice.svg" width="20" height="20" alt=""> [ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice) — 為 ChatGPT 與 Codex 提供本機、近乎即時的自訂語音。
