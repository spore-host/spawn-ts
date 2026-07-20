// The dashboard — the PRIMARY interface. A GUI over SpawnClient: a launch form,
// live instance cards with action buttons (stop/start/extend/terminate/signal),
// TTL + cost meters, and a lifecycle event log. It renders from SpawnClient
// events; it never reaches into provider internals.

import type { SpawnClient, SpawnEvent } from "../core/client.js";
import type { LifecycleAction, ManagedInstance } from "../core/types.js";
import { accumulatedCost } from "../core/lifecycle.js";
import { humanRemaining, formatDuration } from "../core/duration.js";

interface LogItem { atMs: number; kind: string; instance: string; text: string; }

export class Dashboard {
  readonly el: HTMLElement;
  private instancesEl!: HTMLElement;
  private logEl!: HTMLElement;
  private log: LogItem[] = [];

  constructor(
    private client: SpawnClient,
    private confirmFn: (msg: string) => Promise<boolean>,
  ) {
    this.el = document.createElement("div");
    this.el.className = "dashboard";
    this.el.innerHTML = `
      <div class="dash-section launch">
        <h2>Launch</h2>
        ${this.launchFormHtml()}
      </div>
      <div class="dash-section">
        <h2>Instances</h2>
        <div class="instances"></div>
      </div>
      <div class="dash-section">
        <h2>Lifecycle log</h2>
        <div class="log"></div>
      </div>`;
    this.instancesEl = this.el.querySelector(".instances")!;
    this.logEl = this.el.querySelector(".log")!;

    this.wireForm();
    client.on((e) => this.onEvent(e));
    this.renderInstances(client.list());
  }

  private launchFormHtml(): string {
    return `
      <form class="launch-form" autocomplete="off">
        <div class="grid2">
          <div><label>name</label><input name="name" placeholder="my-job" required /></div>
          <div><label>instance type</label><input name="instanceType" value="c6a.xlarge" /></div>
          <div><label>ttl</label><input name="ttl" value="4h" placeholder="4h / 0 = none" /></div>
          <div><label>idle timeout</label><input name="idleTimeout" placeholder="30m / blank" /></div>
          <div><label>on-complete</label>
            <select name="onComplete">
              <option value="">(none)</option>
              <option value="terminate">terminate</option>
              <option value="stop">stop</option>
              <option value="hibernate">hibernate</option>
            </select>
          </div>
          <div><label>$/hr (for cost meter)</label><input name="pricePerHour" value="0.153" /></div>
          <div><label>cost limit ($)</label><input name="costLimit" placeholder="0 = none" /></div>
          <div class="checks">
            <label class="inline"><input type="checkbox" name="spot" /> spot</label>
            <label class="inline"><input type="checkbox" name="hibernateOnIdle" /> hibernate on idle</label>
          </div>
        </div>
        <button type="submit" class="launch-btn">Launch</button>
        <span class="launch-msg"></span>
      </form>`;
  }

  private wireForm(): void {
    const form = this.el.querySelector<HTMLFormElement>(".launch-form")!;
    const msg = this.el.querySelector<HTMLElement>(".launch-msg")!;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const s = (k: string) => String(fd.get(k) ?? "").trim();
      const numOr = (k: string, d: number) => {
        const v = Number(s(k));
        return Number.isFinite(v) ? v : d;
      };
      try {
        const inst = await this.client.launch({
          name: s("name"),
          instanceType: s("instanceType") || undefined,
          ttl: s("ttl") || 0,
          idleTimeout: s("idleTimeout") || 0,
          onComplete: (s("onComplete") as LifecycleAction | "") || "",
          pricePerHour: numOr("pricePerHour", 0),
          costLimit: numOr("costLimit", 0),
          spot: fd.get("spot") === "on",
          hibernateOnIdle: fd.get("hibernateOnIdle") === "on",
        });
        msg.textContent = `launched ${inst.name}`;
        msg.className = "launch-msg good";
        (form.elements.namedItem("name") as HTMLInputElement).value = "";
      } catch (err) {
        msg.textContent = (err as Error).message;
        msg.className = "launch-msg bad";
      }
    });
  }

  private onEvent(e: SpawnEvent): void {
    switch (e.type) {
      case "instances":
        this.renderInstances(e.instances);
        break;
      case "launched":
        this.pushLog({ kind: "launch", instance: e.instance.name, text: `launched ${e.instance.instanceType} (${e.instance.instanceId})` });
        break;
      case "action":
        this.pushLog({ kind: "action", instance: e.instance, text: `${e.rule}: ${e.action} — ${e.reason}` });
        break;
      case "warning":
        this.pushLog({ kind: "warning", instance: e.instance, text: e.message });
        break;
      case "info":
        this.pushLog({ kind: "info", instance: e.instance, text: e.message });
        break;
      case "provider":
        this.pushLog({ kind: "info", instance: "-", text: `backend → ${e.label}${e.isReal ? " (REAL)" : ""}` });
        break;
    }
  }

  private renderInstances(insts: ManagedInstance[]): void {
    const live = insts.filter((i) => i.state !== "terminated");
    if (live.length === 0) {
      this.instancesEl.innerHTML = `<div class="empty">no instances — launch one above</div>`;
      return;
    }
    const now = this.client.now();
    this.instancesEl.innerHTML = "";
    for (const i of live) this.instancesEl.appendChild(this.instanceCard(i, now));
  }

  private instanceCard(i: ManagedInstance, now: number): HTMLElement {
    const card = document.createElement("div");
    card.className = "inst";

    const meta: string[] = [`${i.instanceType}`, i.region];
    if (i.spot) meta.push("spot");
    if (i.publicIp) meta.push(i.publicIp);

    let ttlMeter = "";
    if (i.ttlDeadlineMs && i.ttlMs) {
      const remaining = i.ttlDeadlineMs - now;
      const pct = Math.max(0, Math.min(100, (remaining / i.ttlMs) * 100));
      const cls = pct < 10 ? "crit" : pct < 25 ? "warn" : "";
      ttlMeter = `
        <div class="meta">TTL — ${humanRemaining(remaining)} left → terminate</div>
        <div class="meter ttl ${cls}"><span style="width:${pct}%"></span></div>`;
    }

    let costMeter = "";
    if (i.pricePerHour) {
      const spent = accumulatedCost(i);
      if (i.costLimit) {
        const pct = Math.min(100, (spent / i.costLimit) * 100);
        costMeter = `
          <div class="meta">cost — $${spent.toFixed(4)} / $${i.costLimit.toFixed(2)}</div>
          <div class="meter cost ${pct >= 90 ? "crit" : ""}"><span style="width:${pct}%"></span></div>`;
      } else {
        costMeter = `<div class="meta">cost — $${spent.toFixed(4)} @ $${i.pricePerHour}/hr</div>`;
      }
    }

    let idleLine = "";
    if (i.idleTimeoutMs) {
      idleLine = `<div class="meta">idle ${formatDuration(i.idleTimeoutMs)} → ${i.hibernateOnIdle ? "hibernate" : "stop"}</div>`;
    }

    card.innerHTML = `
      <div class="row1">
        <span class="name">${escapeHtml(i.name)}</span>
        <span class="id">${i.instanceId}</span>
        <span class="state ${i.state}">${i.state}</span>
      </div>
      <div class="meta">${meta.map(escapeHtml).join(" · ")}</div>
      ${ttlMeter}${costMeter}${idleLine}
      <div class="actions"></div>`;

    const actions = card.querySelector(".actions")!;
    const running = i.state === "running";
    const stopped = i.state === "stopped" || i.state === "hibernated";
    if (running) {
      this.actionBtn(actions, "stop", () => this.client.stop(i.name));
      this.actionBtn(actions, "hibernate", () => this.client.hibernate(i.name));
      this.actionBtn(actions, "extend 1h", () => this.client.extend(i.name, "1h"));
      if (i.onComplete) this.actionBtn(actions, "signal complete", () => this.client.signalComplete(i.name));
    }
    if (stopped) this.actionBtn(actions, "start", () => this.client.start(i.name));
    this.actionBtn(actions, "terminate", async () => {
      if (await this.confirmFn(`terminate ${i.name}? This is permanent.`)) {
        await this.client.terminate(i.name);
      }
    });

    return card;
  }

  private actionBtn(parent: Element, label: string, fn: () => Promise<unknown>): void {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => {
      b.disabled = true;
      void fn().finally(() => (b.disabled = false));
    });
    parent.appendChild(b);
  }

  private pushLog(item: Omit<LogItem, "atMs">): void {
    this.log.unshift({ ...item, atMs: this.client.now() });
    if (this.log.length > 100) this.log.pop();
    this.renderLog();
  }

  private renderLog(): void {
    if (this.log.length === 0) {
      this.logEl.innerHTML = `<div class="empty">no events yet</div>`;
      return;
    }
    this.logEl.innerHTML = this.log
      .map((l) => {
        const t = new Date(l.atMs).toISOString().slice(11, 19);
        return `<div class="log-line ${l.kind}"><span class="t">${t}</span> <span class="inst-name">${escapeHtml(
          l.instance,
        )}</span> ${escapeHtml(l.text)}</div>`;
      })
      .join("");
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
