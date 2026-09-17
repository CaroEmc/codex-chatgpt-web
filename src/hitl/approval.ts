import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";

export interface ExecProposal {
  command: string;
  cwd: string;
  reason?: string;
  /** Identifies the requesting turn when several can prompt on one terminal (daemon HITL).
   * Absent for single-session callers such as `dev chat`, whose rendering is unchanged. */
  traceId?: string;
}

export type ApprovalDecision =
  | { action: "run"; command: string }
  | { action: "reject" };

export interface ApprovalGateway {
  request(proposal: ExecProposal, signal?: AbortSignal): Promise<ApprovalDecision>;
}

type TtyInput = NodeJS.ReadableStream & { isTTY?: boolean };

function renderProposal(proposal: ExecProposal): string {
  const lines = [
    "======================= [AI EXECUTION PROPOSAL] =======================",
    ...(proposal.traceId ? [`Turn   : ${proposal.traceId}`] : []),
    `Reason : ${proposal.reason ?? "(none given)"}`,
    `Dir    : ${proposal.cwd}`,
    `Command: ${proposal.command}`,
    "-----------------------------------------------------------------------",
    "[Enter / y] Run   [c] Edit command   [n / Esc] Reject",
  ];
  return `${lines.join("\n")}\n> `;
}

/** Runs every proposal without asking (`serve --hitl --hitl-auto-approve`). The operator opted out
 * of per-command approval explicitly; each command is still echoed so the terminal keeps an audit
 * trail, and the workspace cwd boundary in exec.ts still applies before this gateway is reached. */
export class AutoApproveGateway implements ApprovalGateway {
  constructor(private readonly output: NodeJS.WritableStream = process.stdout) {}

  async request(proposal: ExecProposal, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (signal?.aborted) return { action: "reject" };
    this.output.write(
      `[hitl] auto-approved${proposal.traceId ? ` (turn ${proposal.traceId})` : ""}: ${proposal.command}\n`
        + `       dir: ${proposal.cwd}${proposal.reason ? `\n       reason: ${proposal.reason}` : ""}\n`,
    );
    return { action: "run", command: proposal.command };
  }
}

/** Fails closed (reject, no prompt) whenever the input stream is not an attached
 * terminal, so headless/non-interactive `dev chat` invocations never stall.
 *
 * When a long-lived `readline.Interface` already owns the input stream (e.g. the
 * interactive REPL loop in cli.ts), pass it as `sharedReader` so `request()` reuses
 * it instead of opening a second `readline.Interface` on the same stdin — two
 * concurrent interfaces on one stream corrupt each other and can permanently hang
 * the next prompt. */
export class TtyApprovalGateway implements ApprovalGateway {
  constructor(
    private readonly input: TtyInput = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
    private readonly sharedReader?: ReadlineInterface,
  ) {}

  async request(proposal: ExecProposal, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (!this.input.isTTY) return { action: "reject" };
    if (signal?.aborted) return { action: "reject" };
    const reader = this.sharedReader ?? createInterface({ input: this.input, output: this.output });
    try {
      this.output.write(renderProposal(proposal));
      const answer = (await this.questionOrAbort(reader, "", signal))?.trim().toLowerCase();
      // Fail closed: only an explicit Enter/"y" runs as-is. Anything unrecognized
      // (garbage input, a stray keystroke) rejects rather than silently executing.
      if (answer === undefined || answer === "n" || answer === "esc") return { action: "reject" };
      if (answer === "c") {
        this.output.write(`Edit command (Enter to keep):\n${proposal.command}\n> `);
        const edited = await this.questionOrAbort(reader, "", signal);
        if (edited === undefined) return { action: "reject" };
        return { action: "run", command: edited.trim() || proposal.command };
      }
      if (answer === "" || answer === "y") return { action: "run", command: proposal.command };
      return { action: "reject" };
    } finally {
      if (!this.sharedReader) reader.close();
    }
  }

  /** Resolves the question, or `undefined` if `signal` aborts first. On abort, the reader is
   * closed so a stray answer arriving after the fact cannot be mistaken for a real decision. */
  private async questionOrAbort(
    reader: ReadlineInterface,
    query: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!signal) return reader.question(query);
    return new Promise<string | undefined>(resolvePromise => {
      const onAbort = () => {
        resolvePromise(undefined);
        if (!this.sharedReader) reader.close();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      reader.question(query).then(
        answer => {
          signal.removeEventListener("abort", onAbort);
          resolvePromise(answer);
        },
        () => {
          signal.removeEventListener("abort", onAbort);
          resolvePromise(undefined);
        },
      );
    });
  }
}
