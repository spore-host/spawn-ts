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

function sweepForm(dash: Dashboard): HTMLFormElement {
  return dash.el.querySelector<HTMLFormElement>(".sweep-form")!;
}

function setSweepField(dash: Dashboard, name: string, value: string) {
  (sweepForm(dash).elements.namedItem(name) as HTMLInputElement).value = value;
}

async function submitSweep(dash: Dashboard) {
  sweepForm(dash).dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
}

describe("Dashboard sweep form", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("starts a sweep from the grid form and renders a progress card", async () => {
    const { client, dash } = setup();
    setSweepField(dash, "grid", "alpha=0.1,0.2 beta=1,2");
    setSweepField(dash, "sweepName", "hp");
    setSweepField(dash, "ttl", "30m");
    await submitSweep(dash);

    const msg = dash.el.querySelector(".sweep-msg")!;
    expect(msg.textContent).toContain("4 members");
    expect(msg.className).toContain("good");

    await client.step(1000);
    const card = dash.el.querySelector(".sweep-card")!;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain("hp");
    expect(card.textContent).toContain("4 members");
    expect(card.textContent).toContain("4 running");
    // Every launched instance is tagged into the sweep.
    expect((await client.refresh()).every((i) => i.sweep?.name === "hp")).toBe(true);
  });

  it("shows a validation error for a malformed grid without launching", async () => {
    const { client, dash } = setup();
    setSweepField(dash, "grid", "bogus");
    await submitSweep(dash);
    const msg = dash.el.querySelector(".sweep-msg")!;
    expect(msg.className).toContain("bad");
    expect(client.activeSweeps()).toHaveLength(0);
  });

  it("logs sweep start and completion", async () => {
    const { client, dash } = setup();
    setSweepField(dash, "grid", "n=1");
    setSweepField(dash, "ttl", "5m");
    await submitSweep(dash);
    await client.step(1000);
    const log = dash.el.querySelector(".log")!;
    expect(log.textContent).toContain("started");

    // Drive past the TTL so the single member terminates → sweep done.
    for (let i = 0; i < 3; i++) await client.step(6 * 60_000);
    expect(log.textContent).toContain("done");
  });
});

function queueForm(dash: Dashboard): HTMLFormElement {
  return dash.el.querySelector<HTMLFormElement>(".queue-form")!;
}

function setQueueConfig(dash: Dashboard, json: string) {
  (queueForm(dash).elements.namedItem("config") as HTMLTextAreaElement).value = json;
}

async function submitQueue(dash: Dashboard) {
  queueForm(dash).dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
}

describe("Dashboard queue form", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  const cfg = JSON.stringify({
    queue_name: "p",
    jobs: [
      { job_id: "build", command: "make", timeout: "20m" },
      { job_id: "test", command: "make test", timeout: "20m", depends_on: ["build"] },
    ],
  });

  it("comes pre-filled with a valid example config", async () => {
    const { client, dash } = setup();
    await submitQueue(dash);
    expect(dash.el.querySelector(".queue-msg")!.className).toContain("good");
    await client.step(1000);
    expect(dash.el.querySelector(".sweep-card.queue")).toBeTruthy();
  });

  it("starts a queue and renders a card that shows blocked jobs", async () => {
    const { client, dash } = setup();
    setQueueConfig(dash, cfg);
    await submitQueue(dash);
    expect(dash.el.querySelector(".queue-msg")!.textContent).toContain("2 jobs");

    await client.step(1000);
    const card = dash.el.querySelector(".sweep-card.queue")!;
    expect(card.textContent).toContain("2 jobs");
    // "test" depends on "build", so it's blocked until build completes.
    expect(card.textContent).toContain("1 blocked");
  });

  it("shows a validation error for a bad config without launching", async () => {
    const { client, dash } = setup();
    setQueueConfig(dash, '{"jobs":[]}');
    await submitQueue(dash);
    expect(dash.el.querySelector(".queue-msg")!.className).toContain("bad");
    expect(client.activeSweeps()).toHaveLength(0);
  });
});

function trufflePicker(dash: Dashboard) {
  const form = dash.el.querySelector<HTMLFormElement>(".launch-form")!;
  return {
    q: form.querySelector<HTMLInputElement>(".truffle-q")!,
    matches: form.querySelector<HTMLElement>(".truffle-matches")!,
    typeInput: form.elements.namedItem("instanceType") as HTMLInputElement,
    priceInput: form.elements.namedItem("pricePerHour") as HTMLInputElement,
  };
}

async function typeQuery(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true }));
  // find() is async; let the microtask + render settle.
  await new Promise((r) => setTimeout(r, 0));
}

describe("Dashboard truffle instance picker", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("resolves a query to matching instance types", async () => {
    const { dash } = setup();
    const p = trufflePicker(dash);
    await typeQuery(p.q, "nvidia h100");
    expect(p.matches.hidden).toBe(false);
    expect(p.matches.textContent).toContain("p5.48xlarge");
  });

  it("picking a match fills instance type + auto-fills $/hr", async () => {
    const { dash } = setup();
    const p = trufflePicker(dash);
    await typeQuery(p.q, "h100");
    const first = p.matches.querySelector<HTMLButtonElement>(".truffle-match")!;
    first.click();
    expect(p.typeInput.value).toBe("p5.48xlarge");
    expect(Number(p.priceInput.value)).toBeGreaterThan(0);
    expect(p.matches.hidden).toBe(true); // closes after pick
    expect(p.q.value).toBe(""); // query cleared
  });

  it("then launches with the picked type", async () => {
    const { client, dash } = setup();
    const p = trufflePicker(dash);
    await typeQuery(p.q, "cheapest graviton 8 cores 32gb");
    p.matches.querySelector<HTMLButtonElement>(".truffle-match")!.click();
    setField(dash, "name", "picked");
    await submit(dash);
    const inst = await client.get("picked");
    expect(inst?.instanceType).toBe(p.typeInput.value);
    expect(inst?.instanceType).not.toBe("c6a.xlarge"); // not the default
  });

  it("shows an empty state for a valid but unmatchable query", async () => {
    const { dash } = setup();
    const p = trufflePicker(dash);
    await typeQuery(p.q, "igv nvidia"); // disjoint → no matches
    expect(p.matches.textContent).toContain("no matches");
  });

  it("surfaces a parse error (conflicting architectures) without throwing", async () => {
    const { dash } = setup();
    const p = trufflePicker(dash);
    await typeQuery(p.q, "intel graviton");
    expect(p.matches.textContent!.toLowerCase()).toContain("conflicting");
  });

  it("clears the dropdown when the query is emptied", async () => {
    const { dash } = setup();
    const p = trufflePicker(dash);
    await typeQuery(p.q, "h100");
    expect(p.matches.hidden).toBe(false);
    await typeQuery(p.q, "");
    expect(p.matches.hidden).toBe(true);
  });

  it("supports a glob pattern query (truffle-ts 0.2.0)", async () => {
    const { dash } = setup();
    const p = trufflePicker(dash);
    await typeQuery(p.q, "m7g*");
    const types = [...p.matches.querySelectorAll(".tm-type")].map((e) => e.textContent);
    expect(types.length).toBeGreaterThan(0);
    expect(types.every((t) => t!.startsWith("m7g."))).toBe(true);
  });
});

describe("Dashboard orphan banner", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("shows a reap banner for a past-TTL instance and hides it otherwise", async () => {
    // Launch on a T0 client (deadline T0+1h); mount the dashboard on a T0+2h
    // client sharing the provider, so the instance is a past-TTL orphan.
    const provider = new MockProvider();
    const launcher = new SpawnClient({ provider, startMs: T0, clock: 1 });
    await launcher.launch({ name: "zombie", ttl: "1h" });

    const client = new SpawnClient({ provider, startMs: T0 + 2 * 3600_000, clock: 1 });
    const dash = new Dashboard(client, async () => true);
    document.body.appendChild(dash.el);
    await client.refresh();

    const banner = dash.el.querySelector<HTMLElement>(".orphan-banner")!;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("1 orphan");

    // Click reap → instance terminated → banner hides on the next render.
    banner.querySelector("button")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect((await client.get("zombie"))!.state).toBe("terminated");
    expect(dash.el.querySelector<HTMLElement>(".orphan-banner")!.hidden).toBe(true);
  });

  it("keeps the banner hidden when nothing is past TTL", async () => {
    const { dash } = setup();
    setField(dash, "name", "fresh");
    setField(dash, "ttl", "4h");
    await submit(dash);
    expect(dash.el.querySelector<HTMLElement>(".orphan-banner")!.hidden).toBe(true);
  });
});

describe("Dashboard job-array card", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a jobarray progress card started via the client", async () => {
    const { client, dash } = setup();
    client.startJobArray({ name: "compute", ttl: "30m" }, 3, { id: "arr-1" });
    await client.step(1000);
    const card = dash.el.querySelector(".sweep-card.jobarray")!;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain("compute");
    expect(card.textContent).toContain("job array");
    expect(card.textContent).toContain("3 members");
    expect((await client.refresh()).every((i) => i.jobArray?.name === "compute")).toBe(true);
  });
});
