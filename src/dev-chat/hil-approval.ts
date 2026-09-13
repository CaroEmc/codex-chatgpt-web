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
