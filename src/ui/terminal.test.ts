// @vitest-environment happy-dom
//
// DOM tests for the terminal pane: it runs real spawn CLI commands (cli/commands)
// against a SpawnClient's provider, prints output lines, keeps history, and
// refreshes the client after mutating commands.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Terminal } from "./terminal.js";
import { SpawnClient } from "../core/client.js";
import { MockProvider } from "../core/mock.js";

const T0 = Date.UTC(2026, 6, 20, 12, 0, 0);

function setup(confirm = vi.fn(async () => true)) {
  const client = new SpawnClient({ provider: new MockProvider(), startMs: T0, clock: 1 });
  const term = new Terminal(client, confirm);
  document.body.innerHTML = "";
  document.body.appendChild(term.el);
  return { client, term, confirm };
}

function input(term: Terminal): HTMLInputElement {
  return term.el.querySelector<HTMLInputElement>(".term-input")!;
}
function outputText(term: Terminal): string {
  return term.el.querySelector(".term-output")!.textContent ?? "";
}
async function type(term: Terminal, line: string) {
  const inp = input(term);
  inp.value = line;
  inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
}

describe("Terminal", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("prints a banner with the active backend on construction", () => {
    const { term } = setup();
    const text = outputText(term);
    expect(text).toContain("type 'help'");
    expect(text).toContain("backend: mock");
    expect(text).toContain("(mock)");
  });

  it("runs help and prints command output", async () => {
    const { term } = setup();
    await type(term, "help");
    // The typed command is echoed, then the help output printed.
    expect(term.el.querySelector(".term-line.cmd")!.textContent).toBe("help");
    expect(outputText(term)).toContain("launch");
  });

  it("launch command creates an instance and refreshes the client", async () => {
    const { client, term } = setup();
    const refresh = vi.spyOn(client, "refresh");
    await type(term, "spawn launch job --ttl 4h --price-per-hour 0.153");
    expect(outputText(term)).toContain("launched job");
    // Mutating command → client.refresh() so the GUI updates.
    expect(refresh).toHaveBeenCalled();
    expect((await client.get("job"))!.name).toBe("job");
  });

  it("prints error lines for a failed command without throwing", async () => {
    const { term } = setup();
    await type(term, "launch job --ttl notaduration");
    expect(term.el.querySelector(".term-line.err")).toBeTruthy();
    expect(outputText(term)).toContain("invalid --ttl");
  });

  it("ignores an empty line", async () => {
    const { term } = setup();
    const before = term.el.querySelectorAll(".term-line").length;
    await type(term, "   ");
    expect(term.el.querySelectorAll(".term-line").length).toBe(before);
  });

  it("does not refresh after a read-only command", async () => {
    const { client, term } = setup();
    const refresh = vi.spyOn(client, "refresh");
    await type(term, "list");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("recalls history with ArrowUp / ArrowDown", async () => {
    const { term } = setup();
    await type(term, "list");
    await type(term, "help");
    const inp = input(term);

    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(inp.value).toBe("help");
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(inp.value).toBe("list");
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(inp.value).toBe("help");
    // ArrowDown past the newest entry clears the input.
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(inp.value).toBe("");
  });

  it("focus() and click both focus the input", () => {
    const { term } = setup();
    term.focus();
    expect(document.activeElement).toBe(input(term));

    input(term).blur();
    term.el.dispatchEvent(new Event("click", { bubbles: true }));
    expect(document.activeElement).toBe(input(term));
  });

  it("surfaces a thrown command error as an err line", async () => {
    const { term } = setup();
    // 'terminate' with confirm resolving is fine; force runCommand to throw by
    // driving a command whose handler rejects. 'status' on a missing instance
    // returns an error result (not a throw), so use an unknown-ish path instead:
    await type(term, "terminate does-not-exist");
    expect(term.el.querySelector(".term-line.err")).toBeTruthy();
  });
});
