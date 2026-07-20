// The terminal pane — a SECONDARY, keyboard-accessible interface over the same
// SpawnClient the GUI uses. It runs the spawn CLI commands (see cli/commands.ts)
// against the client's active provider, then refreshes the client so the GUI
// reflects any change immediately. The GUI is the primary interface; this pane
// exists for power users and accessibility.

import { runCommand, type ShellCtx, type CmdResult } from "../cli/commands.js";
import type { SpawnClient } from "../core/client.js";

export class Terminal {
  readonly el: HTMLElement;
  private output: HTMLElement;
  private input: HTMLInputElement;
  private history: string[] = [];
  private histIdx = 0;

  constructor(
    private client: SpawnClient,
    private confirmFn: ShellCtx["confirm"],
  ) {
    this.el = document.createElement("div");
    this.el.className = "terminal";
    this.el.innerHTML = `
      <div class="term-output"></div>
      <div class="term-input-row">
        <span class="prompt">$</span>
        <input class="term-input" spellcheck="false" autocomplete="off"
               aria-label="spawn command input"
               placeholder="spawn launch my-job --ttl 4h --on-complete terminate" />
      </div>`;
    this.output = this.el.querySelector(".term-output")!;
    this.input = this.el.querySelector(".term-input")!;

    this.input.addEventListener("keydown", (e) => void this.onKey(e));
    this.el.addEventListener("click", () => this.input.focus());

    this.print("spawn (browser) — type 'help' for commands.", "sys");
    const b = client.backend;
    this.print(`backend: ${b.label}${b.isReal ? " (REAL/billable)" : " (mock)"}`, "sys");
  }

  focus(): void {
    this.input.focus();
  }

  private async onKey(e: KeyboardEvent): Promise<void> {
    if (e.key === "Enter") {
      const line = this.input.value.trim();
      this.input.value = "";
      if (!line) return;
      this.history.push(line);
      this.histIdx = this.history.length;
      this.print(line, "cmd");
      await this.exec(line);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (this.histIdx > 0) this.input.value = this.history[--this.histIdx] ?? "";
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (this.histIdx < this.history.length - 1) this.input.value = this.history[++this.histIdx] ?? "";
      else {
        this.histIdx = this.history.length;
        this.input.value = "";
      }
    }
  }

  private async exec(line: string): Promise<void> {
    const ctx: ShellCtx = {
      provider: this.client.activeProvider,
      now: () => this.client.now(),
      confirm: this.confirmFn,
    };
    let res: CmdResult;
    try {
      res = await runCommand(line, ctx);
    } catch (err) {
      this.print((err as Error).message, "err");
      return;
    }
    for (const l of res.lines) this.print(l, res.error ? "err" : "out");
    // Any mutating command should be reflected in the GUI: refresh the client.
    if (/^(spawn\s+)?(launch|terminate|stop|start|hibernate|extend)\b/.test(line)) {
      await this.client.refresh();
    }
  }

  print(text: string, kind: "cmd" | "out" | "err" | "sys" = "out"): void {
    const line = document.createElement("div");
    line.className = "term-line " + kind;
    line.textContent = text;
    this.output.appendChild(line);
    this.output.scrollTop = this.output.scrollHeight;
  }
}
