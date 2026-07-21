// @vitest-environment happy-dom
//
// DOM tests for the dashboard. They drive a real SpawnClient (MockProvider, sim
// clock) through the actual DOM the Dashboard builds — submitting the launch
// form, clicking instance-card action buttons, and asserting the resulting
// client state + rendered log. No AWS, no network.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Dashboard } from "./dashboard.js";
import { SpawnClient } from "../core/client.js";
import { MockProvider } from "../core/mock.js";

const T0 = Date.UTC(2026, 6, 20, 12, 0, 0);

function setup(confirm: (m: string) => Promise<boolean> = async () => true) {
  const client = new SpawnClient({ provider: new MockProvider(), startMs: T0, clock: 1 });
  const dash = new Dashboard(client, confirm);
  document.body.innerHTML = "";
  document.body.appendChild(dash.el);
  return { client, dash };
}

function form(dash: Dashboard): HTMLFormElement {
  return dash.el.querySelector<HTMLFormElement>(".launch-form")!;
}

function setField(dash: Dashboard, name: string, value: string) {
  const el = form(dash).elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
  el.value = value;
}

async function submit(dash: Dashboard) {
  form(dash).dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  // Let the async submit handler settle.
  await new Promise((r) => setTimeout(r, 0));
}

describe("Dashboard launch form", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the empty state before any launch", () => {
    const { dash } = setup();
    expect(dash.el.querySelector(".instances")!.textContent).toContain("no instances");
    // The log only renders once the first event arrives; empty before that.
    expect(dash.el.querySelector(".log")!.textContent).toBe("");
  });

  it("submitting the form launches an instance and reports success", async () => {
    const { client, dash } = setup();
    setField(dash, "name", "my-job");
    setField(dash, "ttl", "4h");
    await submit(dash);

    const list = client.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("my-job");

    const msg = dash.el.querySelector(".launch-msg")!;
    expect(msg.textContent).toContain("launched my-job");
    expect(msg.className).toContain("good");
    // Name field is cleared for the next launch.
    expect((form(dash).elements.namedItem("name") as HTMLInputElement).value).toBe("");
  });

  it("renders an instance card with the name, id and state after launch", async () => {
    const { dash } = setup();
    setField(dash, "name", "carded");
    await submit(dash);

    const card = dash.el.querySelector(".inst")!;
    expect(card.querySelector(".name")!.textContent).toBe("carded");
    expect(card.querySelector(".id")!.textContent).toMatch(/^i-/);
    expect(card.querySelector(".state")!.textContent).toBe("running");
  });

  it("reads spot / hibernate checkboxes and select fields", async () => {
    const { client, dash } = setup();
    setField(dash, "name", "spotty");
    (form(dash).elements.namedItem("spot") as HTMLInputElement).checked = true;
    setField(dash, "onComplete", "terminate");
    await submit(dash);

    const inst = client.list()[0];
    expect(inst.spot).toBe(true);
    expect(inst.onComplete).toBe("terminate");
  });

  it("shows the error message when a launch throws (invalid ttl surfaces as good=false path)", async () => {
    // Force the client to reject so we exercise the catch branch.
    const { client, dash } = setup();
    vi.spyOn(client, "launch").mockRejectedValue(new Error("boom"));
    setField(dash, "name", "will-fail");
    await submit(dash);

    const msg = dash.el.querySelector(".launch-msg")!;
    expect(msg.textContent).toBe("boom");
    expect(msg.className).toContain("bad");
  });
});

describe("Dashboard instance-card actions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  function buttons(dash: Dashboard): HTMLButtonElement[] {
    return [...dash.el.querySelectorAll<HTMLButtonElement>(".inst .actions button")];
  }
  function clickBtn(dash: Dashboard, label: string) {
    const b = buttons(dash).find((x) => x.textContent === label);
    if (!b) throw new Error(`no "${label}" button; have: ${buttons(dash).map((x) => x.textContent)}`);
    b.click();
    return new Promise((r) => setTimeout(r, 0));
  }

  it("a running instance exposes stop / hibernate / extend / terminate", async () => {
    const { dash } = setup();
    setField(dash, "name", "runner");
    setField(dash, "onComplete", ""); // no signal-complete button
    await submit(dash);
    const labels = buttons(dash).map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(["stop", "hibernate", "extend 1h", "terminate"]));
    expect(labels).not.toContain("signal complete");
  });

  it("shows signal complete only when on-complete is set", async () => {
    const { dash } = setup();
    setField(dash, "name", "sig");
    setField(dash, "onComplete", "stop");
    await submit(dash);
    expect(buttons(dash).map((b) => b.textContent)).toContain("signal complete");
  });

  it("stop button transitions the instance to stopped and shows a start button", async () => {
    const { client, dash } = setup();
    setField(dash, "name", "s1");
    await submit(dash);
    await clickBtn(dash, "stop");
    expect((await client.get("s1"))!.state).toBe("stopped");
    expect(buttons(dash).map((b) => b.textContent)).toContain("start");
  });

  it("terminate button asks for confirmation and removes the card when confirmed", async () => {
    const confirm = vi.fn(async () => true);
    const { client, dash } = setup(confirm);
    setField(dash, "name", "goner");
    await submit(dash);
    await clickBtn(dash, "terminate");
    expect(confirm).toHaveBeenCalledWith("terminate goner? This is permanent.");
    expect((await client.get("goner"))!.state).toBe("terminated");
    expect(dash.el.querySelector(".instances")!.textContent).toContain("no instances");
  });

  it("terminate does nothing when confirmation is declined", async () => {
    const { client, dash } = setup(async () => false);
    setField(dash, "name", "survivor");
    await submit(dash);
    await clickBtn(dash, "terminate");
    expect((await client.get("survivor"))!.state).toBe("running");
  });

  it("extend 1h pushes the TTL deadline out by an hour", async () => {
    const { client, dash } = setup();
    setField(dash, "name", "ext");
    setField(dash, "ttl", "1h");
    await submit(dash);
    const before = (await client.get("ext"))!.ttlDeadlineMs;
    await clickBtn(dash, "extend 1h");
    expect((await client.get("ext"))!.ttlDeadlineMs).toBe(before + 3600_000);
  });
});

describe("Dashboard meters and log", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders TTL and cost meters for a bounded, priced instance", async () => {
    const { dash } = setup();
    setField(dash, "name", "metered");
    setField(dash, "ttl", "4h");
    setField(dash, "pricePerHour", "1");
    setField(dash, "costLimit", "10");
    await submit(dash);
    const card = dash.el.querySelector(".inst")!;
    expect(card.querySelector(".meter.ttl")).toBeTruthy();
    expect(card.querySelector(".meter.cost")).toBeTruthy();
    expect(card.textContent).toContain("left → terminate");
  });

  it("logs the launch event", async () => {
    const { dash } = setup();
    setField(dash, "name", "logged");
    await submit(dash);
    const log = dash.el.querySelector(".log")!;
    expect(log.textContent).toContain("logged");
    expect(log.querySelector(".log-line.launch")).toBeTruthy();
  });

  it("logs an action when the monitor terminates on TTL expiry", async () => {
    const { client, dash } = setup();
    setField(dash, "name", "reaped");
    setField(dash, "ttl", "1h");
    await submit(dash);
    await client.step(61 * 60_000); // past the deadline → ttl:terminate
    const log = dash.el.querySelector(".log")!;
    expect(log.querySelector(".log-line.action")).toBeTruthy();
    expect(log.textContent).toContain("ttl: terminate");
  });

  it("logs a backend change via the provider event", async () => {
    const { client, dash } = setup();
    client.setProvider(new MockProvider());
    const log = dash.el.querySelector(".log")!;
    expect(log.textContent).toContain("backend → mock");
  });

  it("escapes HTML in instance names", async () => {
    const { dash } = setup();
    setField(dash, "name", "<script>x</script>");
    await submit(dash);
    const nameEl = dash.el.querySelector(".inst .name")!;
    // Rendered as text, not a live element.
    expect(nameEl.querySelector("script")).toBeNull();
    expect(nameEl.textContent).toBe("<script>x</script>");
  });
});
