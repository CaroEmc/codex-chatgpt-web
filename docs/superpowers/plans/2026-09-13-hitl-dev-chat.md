# HITL Local Exec for DEV Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `dev chat --hitl` sessions ask the model to run local shell commands via a
text protocol (`[EXEC_REQUEST]`/`[EXEC_RESULT]`), gated by an interactive terminal
approval prompt, without touching `full` mode, the MCP tunnel, or the production
browser-only daemon.

**Architecture:** `DevChatDriver.send()`'s existing bounded round-loop (`src/dev-chat/driver.ts`)
already drives one real ChatGPT browser turn per `dev chat` message and can run several
rounds under the same `turnId`. We add one more branch to that loop: when a round's final
text matches the `[EXEC_REQUEST]` protocol and HITL is enabled, prompt for approval, run the
command locally, and feed `[EXEC_RESULT]` back as the next round's user message instead of
returning. Detection/formatting lives in a new pure module; approval lives behind a small
interface so a TTY implementation is swappable later.

**Tech Stack:** TypeScript, Bun test runner, Node `child_process`/`node:readline/promises`.

**Spec:** `docs/superpowers/specs/2026-09-13-hitl-dev-chat-design.md`

## Global Constraints

- HITL only activates when `config.mode !== "full"` (browser-only DEV sessions only);
  requesting `--hitl` under `mode: "full"` fails explicitly.
- Command execution: `child_process.spawn(command, { cwd, shell: true, timeout: 60_000 })`;
  combined stdout+stderr truncated to the first 10KB.
- `cwd` defaults to the dev-chat's own `cwd`; a requested `cwd` outside that workspace root
  is rejected before reaching the approval prompt (fed back as a rejection message, not a
  thrown error).
- No-TTY (`!stdin.isTTY`) always resolves to `reject` without prompting.
- Rejection is fed back to the model as the literal text `User rejected execution.`
- The existing 64-round cap in `DevChatDriver.send()` is the only round-loop safety bound;
  no new counter is introduced.
- No changes to `full` mode, the MCP connector, the OpenAI Tunnel, or
  `browser-worker.ts`/the production Responses daemon.

---

## File Structure

- **Create** `src/dev-chat/hitl-protocol.ts` — pure parsing/formatting: `parseExecRequest`,
  `formatExecResult`, `EXEC_REJECTED_TEXT`. No I/O, fully unit-testable.
- **Create** `src/dev-chat/hitl-approval.ts` — `ApprovalGateway` interface,
  `ExecProposal`/`ApprovalDecision` types, `TtyApprovalGateway` implementation using
  `node:readline/promises`.
- **Create** `src/dev-chat/hitl-exec.ts` — `runApprovedCommand(gateway, proposal, workspaceCwd)`:
  resolves/validates `cwd`, calls the approval gateway, spawns the process on approval,
  captures/truncates output, and returns the formatted result text (or the rejection text).
  This is the one seam that talks to both the approval gateway and `child_process`, kept
  separate from the pure protocol module so it can be tested with a fake gateway and real
  (but trivial, deterministic) subprocesses.
- **Modify** `src/dev-chat/session.ts` — add `hitlEnabled: boolean` to `DevChatState`/`stateSchema`
  (default `false` for existing/new chats).
- **Modify** `src/dev-chat/driver.ts` — add `DEV_CHAT_HITL_INSTRUCTIONS`, wire `hitlEnabled` into
  `requestBody()`'s instruction selection, add the HITL branch inside `send()`'s round loop,
  add a `setHitl` method (mirroring `setModel`) and a constructor-injected `approvalGateway`
  (defaulting to `TtyApprovalGateway`) so tests can substitute a fake gateway.
- **Modify** `src/dev-chat/cli.ts` — add `--hitl` flag parsing, help text, mode-mismatch error,
  and `EventRenderer` support for a new `DevChatEvent` variant reporting exec
  proposals/results.
- **Test** `tests/hitl-protocol.test.ts` — new, for the pure module.
- **Test** `tests/hitl-approval.test.ts` — new, for the TTY gateway.
- **Test** `tests/dev-chat.test.ts` — extend with an end-to-end `send()` HITL round-trip test.

---

### Task 1: Protocol parsing and formatting

**Files:**
- Create: `src/dev-chat/hitl-protocol.ts`
- Test: `tests/hitl-protocol.test.ts`

**Interfaces:**
- Produces:
  - `interface ParsedExecRequest { command: string; cwd?: string; reason?: string }`
  - `function parseExecRequest(text: string): ParsedExecRequest | undefined`
  - `function formatExecResult(exitCode: number, output: string): string`
  - `const EXEC_REJECTED_TEXT = "User rejected execution."`
  - `const DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS: string` — the PRD §3.1 system-prompt block,
    exported here so `driver.ts` can compose it into its instructions constant without
    duplicating the literal text.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/hitl-protocol.test.ts
import { expect, test } from "bun:test";
import { EXEC_REJECTED_TEXT, formatExecResult, parseExecRequest } from "../src/dev-chat/hitl-protocol";

test("parses a well-formed EXEC_REQUEST block", () => {
  const text = [
    "Let me check the repo.",
    "[EXEC_REQUEST]",
    "command: git status -s",
    "cwd: /workspace/project",
    "reason: Check repository status",
    "[/EXEC_REQUEST]",
  ].join("\n");
  expect(parseExecRequest(text)).toEqual({
    command: "git status -s",
    cwd: "/workspace/project",
    reason: "Check repository status",
  });
});

test("parses a request with only the required command field", () => {
  const text = "[EXEC_REQUEST]\ncommand: ls\n[/EXEC_REQUEST]";
  expect(parseExecRequest(text)).toEqual({ command: "ls", cwd: undefined, reason: undefined });
});

test("returns undefined for plain text with no request block", () => {
  expect(parseExecRequest("Here is my answer, no command needed.")).toBeUndefined();
});

test("returns undefined for a malformed block missing the command field", () => {
  const text = "[EXEC_REQUEST]\nreason: no command given\n[/EXEC_REQUEST]";
  expect(parseExecRequest(text)).toBeUndefined();
});

test("returns undefined for an unclosed block", () => {
  const text = "[EXEC_REQUEST]\ncommand: ls\n";
  expect(parseExecRequest(text)).toBeUndefined();
});

test("only the first block is honored when multiple appear", () => {
  const text = [
    "[EXEC_REQUEST]",
    "command: first",
    "[/EXEC_REQUEST]",
    "[EXEC_REQUEST]",
    "command: second",
    "[/EXEC_REQUEST]",
  ].join("\n");
  expect(parseExecRequest(text)).toEqual({ command: "first", cwd: undefined, reason: undefined });
});

test("formats an EXEC_RESULT block", () => {
  expect(formatExecResult(0, "M src/index.ts\n?? src/interceptor.ts")).toBe(
    "[EXEC_RESULT]\nexit_code: 0\noutput:\nM src/index.ts\n?? src/interceptor.ts\n[/EXEC_RESULT]",
  );
});

test("the rejection text is the exact literal the model should see", () => {
  expect(EXEC_REJECTED_TEXT).toBe("User rejected execution.");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/hitl-protocol.test.ts`
Expected: FAIL — `Cannot find module '../src/dev-chat/hitl-protocol'`

- [ ] **Step 3: Implement the protocol module**

```typescript
// src/dev-chat/hitl-protocol.ts
export interface ParsedExecRequest {
  command: string;
  cwd?: string;
  reason?: string;
}

const EXEC_REQUEST_BLOCK = /\[EXEC_REQUEST\]\s*([\s\S]*?)\s*\[\/EXEC_REQUEST\]/;
const FIELD_LINE = /^\s*(command|cwd|reason)\s*:\s*(.*)$/i;

/** Only the first well-formed block is honored; a missing/incomplete block returns undefined
 * so the caller falls back to treating the text as an ordinary final answer. */
export function parseExecRequest(text: string): ParsedExecRequest | undefined {
  const match = EXEC_REQUEST_BLOCK.exec(text);
  if (!match) return undefined;
  const fields: Partial<Record<"command" | "cwd" | "reason", string>> = {};
  for (const line of match[1]!.split("\n")) {
    const fieldMatch = FIELD_LINE.exec(line);
    if (!fieldMatch) continue;
    const key = fieldMatch[1]!.toLowerCase() as "command" | "cwd" | "reason";
    if (fields[key] === undefined) fields[key] = fieldMatch[2]!.trim();
  }
  if (!fields.command) return undefined;
  return { command: fields.command, cwd: fields.cwd, reason: fields.reason };
}

export function formatExecResult(exitCode: number, output: string): string {
  return `[EXEC_RESULT]\nexit_code: ${exitCode}\noutput:\n${output}\n[/EXEC_RESULT]`;
}

export const EXEC_REJECTED_TEXT = "User rejected execution.";

export const DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS = [
  "When you need to execute shell commands, read files, or inspect project state,",
  "strictly output the following format and halt generation immediately:",
  "[EXEC_REQUEST]",
  "command: <command to execute>",
  "cwd: <target working directory, defaults to .>",
  "reason: <rationale for executing this command>",
  "[/EXEC_REQUEST]",
  "Do not fabricate outputs. Do not produce subsequent summaries until you receive [EXEC_RESULT].",
].join("\n");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/hitl-protocol.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/dev-chat/hitl-protocol.ts tests/hitl-protocol.test.ts
git commit -m "feat: add EXEC_REQUEST/EXEC_RESULT protocol parsing for dev chat HITL"
```

---

### Task 2: TTY approval gateway

**Files:**
- Create: `src/dev-chat/hitl-approval.ts`
- Test: `tests/hitl-approval.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 directly (approval decisions are protocol-agnostic).
- Produces:
  - `interface ExecProposal { command: string; cwd: string; reason?: string }`
  - `type ApprovalDecision = { action: "run"; command: string } | { action: "reject" }`
  - `interface ApprovalGateway { request(proposal: ExecProposal): Promise<ApprovalDecision> }`
  - `class TtyApprovalGateway implements ApprovalGateway` — constructor
    `(input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin, output: NodeJS.WritableStream = process.stdout)`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/hitl-approval.test.ts
import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { TtyApprovalGateway } from "../src/dev-chat/hitl-approval";

function fakeTty(isTTY: boolean): { input: PassThrough & { isTTY?: boolean }; output: PassThrough; written: () => string } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = isTTY;
  const output = new PassThrough();
  let buffer = "";
  output.on("data", chunk => { buffer += chunk.toString(); });
  return { input, output, written: () => buffer };
}

const proposal = { command: "git status -s", cwd: "/workspace/project", reason: "Check status" };

test("Enter/y runs the original command", async () => {
  const { input, output } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request(proposal);
  input.write("\n");
  await expect(decision).resolves.toEqual({ action: "run", command: "git status -s" });
});

test("y (explicit) runs the original command", async () => {
  const { input, output } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request(proposal);
  input.write("y\n");
  await expect(decision).resolves.toEqual({ action: "run", command: "git status -s" });
});

test("n rejects", async () => {
  const { input, output } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request(proposal);
  input.write("n\n");
  await expect(decision).resolves.toEqual({ action: "reject" });
});

test("c edits the command before running", async () => {
  const { input, output } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request(proposal);
  input.write("c\n");
  await new Promise(resolve => setTimeout(resolve, 10));
  input.write("git status --porcelain\n");
  await expect(decision).resolves.toEqual({ action: "run", command: "git status --porcelain" });
});

test("c with an empty replacement keeps the original command", async () => {
  const { input, output } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request(proposal);
  input.write("c\n");
  await new Promise(resolve => setTimeout(resolve, 10));
  input.write("\n");
  await expect(decision).resolves.toEqual({ action: "run", command: "git status -s" });
});

test("an unattended non-TTY stream rejects without prompting", async () => {
  const { input, output } = fakeTty(false);
  const gateway = new TtyApprovalGateway(input, output);
  await expect(gateway.request(proposal)).resolves.toEqual({ action: "reject" });
  expect(output.readableLength).toBe(0);
});

test("the proposal box is rendered before a decision arrives", async () => {
  const { input, output, written } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request(proposal);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(written()).toContain("git status -s");
  expect(written()).toContain("/workspace/project");
  expect(written()).toContain("Check status");
  input.write("n\n");
  await decision;
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/hitl-approval.test.ts`
Expected: FAIL — `Cannot find module '../src/dev-chat/hitl-approval'`

- [ ] **Step 3: Implement the gateway**

```typescript
// src/dev-chat/hitl-approval.ts
import { createInterface } from "node:readline/promises";

export interface ExecProposal {
  command: string;
  cwd: string;
  reason?: string;
}

export type ApprovalDecision =
  | { action: "run"; command: string }
  | { action: "reject" };

export interface ApprovalGateway {
  request(proposal: ExecProposal): Promise<ApprovalDecision>;
}

type TtyInput = NodeJS.ReadableStream & { isTTY?: boolean };

function renderProposal(proposal: ExecProposal): string {
  const lines = [
    "======================= [AI EXECUTION PROPOSAL] =======================",
    `Reason : ${proposal.reason ?? "(none given)"}`,
    `Dir    : ${proposal.cwd}`,
    `Command: ${proposal.command}`,
    "-----------------------------------------------------------------------",
    "[Enter / y] Run   [c] Edit command   [n / Esc] Reject",
  ];
  return `${lines.join("\n")}\n> `;
}

/** Fails closed (reject, no prompt) whenever the input stream is not an attached
 * terminal, so headless/non-interactive `dev chat` invocations never stall. */
export class TtyApprovalGateway implements ApprovalGateway {
  constructor(
    private readonly input: TtyInput = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {}

  async request(proposal: ExecProposal): Promise<ApprovalDecision> {
    if (!this.input.isTTY) return { action: "reject" };
    const reader = createInterface({ input: this.input, output: this.output });
    try {
      this.output.write(renderProposal(proposal));
      const answer = (await reader.question("")).trim().toLowerCase();
      if (answer === "n" || answer === "esc") return { action: "reject" };
      if (answer === "c") {
        this.output.write(`Edit command (Enter to keep):\n${proposal.command}\n> `);
        const edited = (await reader.question("")).trim();
        return { action: "run", command: edited || proposal.command };
      }
      return { action: "run", command: proposal.command };
    } finally {
      reader.close();
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/hitl-approval.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/dev-chat/hitl-approval.ts tests/hitl-approval.test.ts
git commit -m "feat: add TTY approval gateway for dev chat HITL"
```

---

### Task 3: Command execution + workspace-boundary enforcement

**Files:**
- Create: `src/dev-chat/hitl-exec.ts`
- Test: `tests/hitl-exec.test.ts`

**Interfaces:**
- Consumes:
  - `ApprovalGateway`, `ExecProposal`, `ApprovalDecision` from `src/dev-chat/hitl-approval.ts`
  - `formatExecResult`, `EXEC_REJECTED_TEXT` from `src/dev-chat/hitl-protocol.ts`
- Produces:
  - `interface RawExecRequest { command: string; cwd?: string; reason?: string }` (same
    shape as `ParsedExecRequest`, imported by `driver.ts` as that type)
  - `async function runApprovedCommand(gateway: ApprovalGateway, request: RawExecRequest, workspaceCwd: string): Promise<string>`
    — always resolves (never throws) with the exact text to feed back to the model as the
    next round's user message: either a `formatExecResult(...)` block or `EXEC_REJECTED_TEXT`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/hitl-exec.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalGateway, ApprovalDecision, ExecProposal } from "../src/dev-chat/hitl-approval";
import { EXEC_REJECTED_TEXT } from "../src/dev-chat/hitl-protocol";
import { runApprovedCommand } from "../src/dev-chat/hitl-exec";

class FixedGateway implements ApprovalGateway {
  seen: ExecProposal[] = [];
  constructor(private readonly decision: ApprovalDecision) {}
  async request(proposal: ExecProposal): Promise<ApprovalDecision> {
    this.seen.push(proposal);
    return this.decision;
  }
}

test("an approved command runs and its output is wrapped in EXEC_RESULT", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "printf hello" });
    const result = await runApprovedCommand(gateway, { command: "printf hello" }, workspace);
    expect(result).toBe("[EXEC_RESULT]\nexit_code: 0\noutput:\nhello\n[/EXEC_RESULT]");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a rejected command returns the literal rejection text and never spawns", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const gateway = new FixedGateway({ action: "reject" });
    const result = await runApprovedCommand(gateway, { command: "printf should-not-run" }, workspace);
    expect(result).toBe(EXEC_REJECTED_TEXT);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a nonzero exit code is reported in the EXEC_RESULT block", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "exit 3" });
    const result = await runApprovedCommand(gateway, { command: "exit 3" }, workspace);
    expect(result).toContain("exit_code: 3");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("output beyond 10KB is truncated", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "yes x | head -c 20000" });
    const result = await runApprovedCommand(gateway, { command: "yes x | head -c 20000" }, workspace);
    const output = result.slice(result.indexOf("output:\n") + "output:\n".length, -"\n[/EXEC_RESULT]".length);
    expect(output.length).toBeLessThanOrEqual(10 * 1024);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a relative cwd is resolved against the workspace and passed through to the gateway", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "pwd" });
    await runApprovedCommand(gateway, { command: "pwd", cwd: "." }, workspace);
    expect(gateway.seen[0]!.cwd).toBe(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a cwd escaping the workspace is rejected before reaching approval", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "pwd" });
    const result = await runApprovedCommand(gateway, { command: "pwd", cwd: "../../etc" }, workspace);
    expect(result).toBe(EXEC_REJECTED_TEXT);
    expect(gateway.seen).toHaveLength(0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an omitted cwd defaults to the workspace root", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "pwd" });
    await runApprovedCommand(gateway, { command: "pwd" }, workspace);
    expect(gateway.seen[0]!.cwd).toBe(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/hitl-exec.test.ts`
Expected: FAIL — `Cannot find module '../src/dev-chat/hitl-exec'`

- [ ] **Step 3: Implement execution**

```typescript
// src/dev-chat/hitl-exec.ts
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ApprovalGateway } from "./hitl-approval";
import { EXEC_REJECTED_TEXT, formatExecResult } from "./hitl-protocol";

export interface RawExecRequest {
  command: string;
  cwd?: string;
  reason?: string;
}

const OUTPUT_CAP_BYTES = 10 * 1024;
const TIMEOUT_MS = 60_000;

function resolveWorkspaceCwd(request: RawExecRequest, workspaceCwd: string): string | undefined {
  const resolved = resolve(workspaceCwd, request.cwd ?? ".");
  const boundary = resolved === workspaceCwd || resolved.startsWith(`${workspaceCwd}/`);
  return boundary ? resolved : undefined;
}

function spawnAndCapture(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  return new Promise(resolvePromise => {
    const child = spawn(command, { cwd, shell: true, timeout: TIMEOUT_MS });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (output.length >= OUTPUT_CAP_BYTES) return;
      output += chunk.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", error => resolvePromise({ exitCode: 1, output: `${output}\n${error.message}`.trim() }));
    child.on("close", (code, signal) => {
      if (signal === "SIGTERM" && code === null) timedOut = true;
      const truncated = output.slice(0, OUTPUT_CAP_BYTES);
      const note = timedOut ? `${truncated}\n[truncated: command timed out after ${TIMEOUT_MS}ms]` : truncated;
      resolvePromise({ exitCode: timedOut ? 124 : (code ?? 1), output: note });
    });
  });
}

/** Always resolves — never throws — with the exact text to feed back to the model. */
export async function runApprovedCommand(
  gateway: ApprovalGateway,
  request: RawExecRequest,
  workspaceCwd: string,
): Promise<string> {
  const resolvedCwd = resolveWorkspaceCwd(request, workspaceCwd);
  if (!resolvedCwd) return EXEC_REJECTED_TEXT;

  const decision = await gateway.request({
    command: request.command,
    cwd: resolvedCwd,
    reason: request.reason,
  });
  if (decision.action === "reject") return EXEC_REJECTED_TEXT;

  const { exitCode, output } = await spawnAndCapture(decision.command, resolvedCwd);
  return formatExecResult(exitCode, output);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/hitl-exec.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/dev-chat/hitl-exec.ts tests/hitl-exec.test.ts
git commit -m "feat: execute approved dev chat HITL commands within the workspace boundary"
```

---

### Task 4: Persist `hitlEnabled` on DevChatState

**Files:**
- Modify: `src/dev-chat/session.ts`
- Test: `tests/dev-chat.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `DevChatState.hitlEnabled: boolean` (defaults to `false` for chats created
  before this field existed, via a Zod default).

- [ ] **Step 1: Write the failing test**

Add to `tests/dev-chat.test.ts` (near the existing `"named DEV state and deterministic
context filler persist independently"` test):

```typescript
test("hitlEnabled defaults to false and persists once set", () => {
  const root = scratch("cgw-dev-hitl-state");
  const store = new DevChatStore(join(root, "chats"));
  const opened = store.loadOrCreate("hitl-lab", "chatgpt-web/high", root);
  expect(opened.state.hitlEnabled).toBe(false);
  opened.state.hitlEnabled = true;
  store.save(opened.state);
  expect(store.load("hitl-lab")).toMatchObject({ hitlEnabled: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/dev-chat.test.ts -t "hitlEnabled"`
Expected: FAIL — `expect(received).toBe(expected)` — `received` is `undefined`, not `false`
(the schema does not yet define the field)

- [ ] **Step 3: Add the field**

In `src/dev-chat/session.ts`, extend `stateSchema` and `DevChatState`:

```typescript
const stateSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  cwd: z.string(),
  threadId: z.string().min(1),
  model: z.enum(DEV_CHAT_MODELS),
  input: z.array(z.unknown()),
  turns: z.number().int().nonnegative(),
  compactions: z.number().int().nonnegative(),
  syntheticFills: z.number().int().nonnegative(),
  hitlEnabled: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsage: usageSchema.optional(),
});
```

```typescript
export interface DevChatState {
  version: 1;
  name: string;
  cwd: string;
  threadId: string;
  model: DevChatModel;
  input: unknown[];
  turns: number;
  compactions: number;
  syntheticFills: number;
  hitlEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsage?: DevChatUsage;
}
```

And in `DevChatStore.loadOrCreate`'s new-state literal, add `hitlEnabled: false,` alongside
`syntheticFills: 0,`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/dev-chat.test.ts -t "hitlEnabled"`
Expected: PASS

- [ ] **Step 5: Run the full dev-chat suite to confirm no regressions**

Run: `bun test tests/dev-chat.test.ts`
Expected: PASS (all tests, including the new one)

- [ ] **Step 6: Commit**

```bash
git add src/dev-chat/session.ts tests/dev-chat.test.ts
git commit -m "feat: persist hitlEnabled on DevChatState"
```

---

### Task 5: Wire HITL into DevChatDriver's instructions and round loop

**Files:**
- Modify: `src/dev-chat/driver.ts`
- Test: `tests/dev-chat.test.ts` (extend)

**Interfaces:**
- Consumes:
  - `parseExecRequest`, `DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS` from `src/dev-chat/hitl-protocol.ts`
  - `runApprovedCommand`, `RawExecRequest` from `src/dev-chat/hitl-exec.ts`
  - `ApprovalGateway`, `TtyApprovalGateway` from `src/dev-chat/hitl-approval.ts`
  - `DevChatState.hitlEnabled` from Task 4
- Produces:
  - `DevChatDriver` constructor gains an optional 6th parameter `approvalGateway:
    ApprovalGateway = new TtyApprovalGateway()`, stored as `private readonly
    approvalGateway`.
  - `DevChatDriver.setHitl(state: DevChatState, enabled: boolean): void` (mirrors `setModel`;
    throws if `enabled` and `this.config.mode === "full"`).
  - `send()`'s behavior: when `state.hitlEnabled` and a round's tool-free output matches
    `parseExecRequest`, the round loop continues instead of returning, and the resulting
    `EXEC_RESULT`/rejection text is appended as the next round's user message via
    `currentTurnItems`-shaped input.

- [ ] **Step 1: Write the failing test**

Add to `tests/dev-chat.test.ts`:

```typescript
test("hitlEnabled sessions run an approved EXEC_REQUEST and feed EXEC_RESULT back before the final answer", async () => {
  const root = scratch("cgw-dev-hitl-roundtrip");
  const config = {
    ...defaultConfig("browser-only"),
    purpose: "dev-harness" as const,
    solAvailable: true,
    proAvailable: true,
  };
  let round = 0;
  const factory = (): ProviderAdapter => ({
    name: "dev-hitl-test",
    async runTurn(parsed, _incoming, emit) {
      round += 1;
      if (round === 1) {
        emit({
          type: "text_delta",
          phase: "final_answer",
          text: "[EXEC_REQUEST]\ncommand: printf hello\nreason: greet\n[/EXEC_REQUEST]",
        });
      } else {
        const lastMessage = JSON.stringify(parsed.context).includes("[EXEC_RESULT]");
        expect(lastMessage).toBe(true);
        emit({ type: "text_delta", phase: "final_answer", text: "Done: hello" });
      }
      emit({
        type: "done", stopReason: "stop", endTurn: true,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: true },
      });
    },
  });
  const approvals: unknown[] = [];
  const gateway = { request: async (proposal: unknown) => { approvals.push(proposal); return { action: "run" as const, command: "printf hello" }; } };
  const driver = new DevChatDriver(
    config,
    new DevChatStore(join(root, "chats")),
    factory,
    root,
    undefined,
    gateway,
  );
  const state = driver.open("hitl-roundtrip", "chatgpt-web/extra-high").state;
  driver.setHitl(state, true);
  const result = await driver.send(state, "Please greet me.");
  expect(result.text).toBe("Done: hello");
  expect(approvals).toHaveLength(1);
});

test("setHitl rejects enabling HITL under full mode", () => {
  const root = scratch("cgw-dev-hitl-full-mode");
  const driver = new DevChatDriver(
    defaultConfig("full"),
    new DevChatStore(join(root, "chats")),
    (_provider: CodexProviderConfig): ProviderAdapter => {
      throw new Error("adapter is not needed for this assertion");
    },
    root,
  );
  const state = driver.open("hitl-full").state;
  expect(() => driver.setHitl(state, true)).toThrow("not available");
});
```

Note: the `DevChatDriver` constructor signature in the plan is
`(config, store, adapterFactory, cwd, features, approvalGateway)` — the existing 5th
positional parameter is `features` (already optional with a default), so the new
`approvalGateway` parameter is added after it, also optional.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/dev-chat.test.ts -t "hitlEnabled sessions|setHitl rejects"`
Expected: FAIL — `driver.setHitl is not a function`

- [ ] **Step 3: Implement the wiring**

In `src/dev-chat/driver.ts`, add imports:

```typescript
import { TtyApprovalGateway, type ApprovalGateway } from "./hitl-approval";
import { runApprovedCommand } from "./hitl-exec";
import { DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS, parseExecRequest } from "./hitl-protocol";
```

Add a HITL-flavored instructions constant next to `DEV_CHAT_BROWSER_ONLY_INSTRUCTIONS`:

```typescript
export const DEV_CHAT_HITL_INSTRUCTIONS = [
  "You are running inside the Codex Web GPT DEV outer-harness simulator.",
  "Behave like the normal Codex model backend.",
  "This browser-only DEV profile exposes no structured outer tools, but you may request",
  "local command execution using the protocol below; a human reviews every request before",
  "it runs.",
  DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS,
].join(" ");
```

Update `requestBody()`'s instructions selection (it currently takes `localToolsEnabled:
boolean`; add a `hitlEnabled: boolean` parameter):

```typescript
function requestBody(
  state: DevChatState,
  cwd: string,
  turnId: string,
  input: unknown[],
  stream: boolean,
  localToolsEnabled: boolean,
  hitlEnabled: boolean,
): Record<string, unknown> {
  return {
    model: state.model,
    instructions: localToolsEnabled
      ? DEV_CHAT_SYSTEM_INSTRUCTIONS
      : (hitlEnabled ? DEV_CHAT_HITL_INSTRUCTIONS : DEV_CHAT_BROWSER_ONLY_INSTRUCTIONS),
    input,
    tools: localToolsEnabled ? DEV_CHAT_TOOLS : [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { summary: "auto" },
    stream,
    store: false,
    prompt_cache_key: state.threadId,
    client_metadata: {
      "x-codex-turn-metadata": turnMetadata(state.threadId, turnId, cwd),
    },
    metadata: { codex_chatgpt_web_dev: true, chat_name: state.name },
  };
}
```

Update every existing call site of `requestBody` (`status`, `send`, `statusForInput`) to
pass `state.hitlEnabled` as the new final argument — e.g. in `send()`:

```typescript
const body = requestBody(state, this.cwd, turnId, workingInput, false, this.config.mode === "full", state.hitlEnabled);
```

Update the class constructor and add `setHitl`:

```typescript
export class DevChatDriver {
  constructor(
    readonly config: AppConfig,
    readonly store: DevChatStore,
    readonly adapterFactory: AdapterFactory,
    readonly cwd = process.cwd(),
    readonly features: DevChatFeatures = DEFAULT_DEV_CHAT_FEATURES,
    private readonly approvalGateway: ApprovalGateway = new TtyApprovalGateway(),
  ) {}

  setHitl(state: DevChatState, enabled: boolean): void {
    if (enabled && this.config.mode === "full") {
      throw new Error("HITL local execution is not available while full mode's real tool calls are active");
    }
    state.hitlEnabled = enabled;
    this.store.save(state);
  }
```

Add the HITL branch inside `send()`'s round loop, replacing the current
`if (calls.length === 0) { ... }` block:

```typescript
      const calls = toolCalls(output);
      if (calls.length === 0) {
        if (envelope.end_turn !== true) {
          throw new Error("DEV Responses turn completed without tool calls or end_turn=true");
        }
        const roundText = outputText(output);
        const execRequest = state.hitlEnabled ? parseExecRequest(roundText) : undefined;
        if (execRequest) {
          const resultText = await runApprovedCommand(this.approvalGateway, execRequest, this.cwd);
          const execTurnId = id("dev_hitl_turn");
          workingInput.push({
            type: "message",
            id: id("msg_dev_hitl"),
            role: "user",
            content: [{ type: "input_text", text: resultText }],
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          });
          void execTurnId;
          continue;
        }
        finalText = roundText;
        state.input = workingInput;
        state.turns += 1;
        state.compactions += pendingCompactions;
        state.lastUsage = usage;
        this.store.save(state);
        return {
          text: finalText,
          usage,
          toolCalls: totalToolCalls,
          compactions,
          status: this.status(state),
        };
      }
```

(`execTurnId`/`void execTurnId` is a placeholder scaffold left over from drafting and must
NOT appear in the final code — the follow-up message reuses the existing `turnId`, not a
new one, exactly as the design spec requires. Remove those two lines; they are called out
here only so the implementer notices and deletes them instead of leaving dead code.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/dev-chat.test.ts -t "hitlEnabled sessions|setHitl rejects"`
Expected: PASS

- [ ] **Step 5: Run the full dev-chat suite**

Run: `bun test tests/dev-chat.test.ts`
Expected: PASS (all tests)

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/dev-chat/driver.ts tests/dev-chat.test.ts
git commit -m "feat: run approved EXEC_REQUEST commands inside DevChatDriver's round loop"
```

---

### Task 6: CLI `--hitl` flag and event rendering

**Files:**
- Modify: `src/dev-chat/cli.ts`

**Interfaces:**
- Consumes: `DevChatDriver.setHitl` from Task 5.
- Produces: `dev chat NAME --hitl [MESSAGE]` CLI usage; no new exported types (this task is
  CLI wiring only).

- [ ] **Step 1: Locate and update the `dev chat` command parsing**

Find where `dev chat` parses `--model` (via `takeOption(args, "--model")`) in
`src/dev-chat/cli.ts`'s command dispatch, and add a sibling flag:

```typescript
const hitlRequested = takeFlag(args, "--hitl");
```

After the chat is opened (`driver.open(name, model)`), apply it:

```typescript
if (hitlRequested) driver.setHitl(opened.state, true);
```

Wrap that call so a `mode === "full"` mismatch produces the same clear top-level error
handling the rest of the CLI already uses for thrown `Error`s (no new try/catch needed if
the CLI's existing top-level handler already reports thrown errors and exits non-zero —
confirm this by reading the command dispatch's outer error handling before adding a new
one).

- [ ] **Step 2: Update help text**

In `DEV_HELP`, change the `dev chat` usage line to:

```
  codex-chatgpt-web dev chat NAME [--model MODEL] [--hitl] [MESSAGE]
```

and add a line under "Interactive commands" documenting `/help` already covers session
commands — no new slash command is introduced; `--hitl` is a launch-time flag only.

- [ ] **Step 3: Manually verify**

Run: `bun run dev:chat hitl-smoke --hitl "reply with plain text only, no commands needed"`
Expected: chat opens, HITL instructions are active, and since the model is asked not to
request a command, it returns a normal final answer. This is a manual smoke check (no
automated CLI test exists in this codebase for `dev chat`'s interactive/CLI layer beyond
`tests/dev-chat.test.ts`'s driver-level tests already extended in Tasks 4-5).

- [ ] **Step 4: Commit**

```bash
git add src/dev-chat/cli.ts
git commit -m "feat: add --hitl flag to dev chat CLI"
```

---

## Self-Review Notes

- **Spec coverage:** §3 Activation → Tasks 4-6; §4 Protocol module → Task 1; §5 Detection
  point → Task 5; §6 Approval gateway → Task 2; §7 Execution → Task 3; §8 CLI/UX → Task 6;
  §9 Testing → each task carries its own tests plus the Task 5 end-to-end round-trip; §10
  Non-goals → no task touches `browser-worker.ts`, the MCP connector, or the tunnel.
- **Placeholder scan:** Task 5's Step 3 contains one deliberately-flagged scaffold
  (`execTurnId`/`void execTurnId`) that the step explicitly instructs the implementer to
  delete — this is not a plan placeholder, it's a called-out correction to a drafting
  mistake so the implementer doesn't silently keep dead code. No other TBD/TODO/"handle
  edge cases" language remains.
- **Type consistency:** `ParsedExecRequest` (Task 1) and `RawExecRequest` (Task 3) are the
  same shape (`{ command: string; cwd?: string; reason?: string }`); Task 5 imports
  `parseExecRequest`'s return type directly into `runApprovedCommand`'s parameter, so no
  divergent duplicate type is introduced — confirmed the two names describe one shape, not
  two competing ones. `ApprovalGateway`/`ExecProposal`/`ApprovalDecision` are defined once
  in Task 2 and reused verbatim by Tasks 3 and 5. `hitlEnabled` (Task 4) is read the same way
  in Task 5's `requestBody` and round-loop branch as it's written in Task 6's CLI flag.
