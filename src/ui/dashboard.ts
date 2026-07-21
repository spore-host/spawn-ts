// The dashboard — the PRIMARY interface. A GUI over SpawnClient: a launch form,
// live instance cards with action buttons (stop/start/extend/terminate/signal),
// TTL + cost meters, and a lifecycle event log. It renders from SpawnClient
// events; it never reaches into provider internals.

import type { SpawnClient, SpawnEvent } from "../core/client.js";
import type { LifecycleAction, ManagedInstance } from "../core/types.js";
import type { FanOutSummary } from "../core/fanout.js";
import { accumulatedCost } from "../core/lifecycle.js";
import { humanRemaining, formatDuration, parseDuration } from "../core/duration.js";
import { parseGridShorthand } from "../core/params.js";
import { parseQueueConfig } from "../core/queue.js";
import { find, type FindResult } from "@spore-host/truffle-ts";

interface LogItem { atMs: number; kind: string; instance: string; text: string; }
interface SweepView { kind: "sweep" | "queue" | "jobarray"; name: string; summary: FanOutSummary; done: boolean; }

export class Dashboard {
  readonly el: HTMLElement;
  private instancesEl!: HTMLElement;
  private orphanBannerEl!: HTMLElement;
  private logEl!: HTMLElement;
  private sweepsEl!: HTMLElement;
  private log: LogItem[] = [];
  private sweeps = new Map<string, SweepView>();

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
      <div class="dash-section sweep">
        <h2>Parameter sweep</h2>
        ${this.sweepFormHtml()}
      </div>
      <div class="dash-section queue">
        <h2>Batch job queue</h2>
        ${this.queueFormHtml()}
      </div>
      <div class="dash-section">
        <h2>Sweeps &amp; queues</h2>
        <div class="sweeps"></div>
      </div>
      <div class="dash-section">
        <h2>Instances</h2>
        <div class="orphan-banner" hidden></div>
        <div class="instances"></div>
      </div>
      <div class="dash-section">
        <h2>Lifecycle log</h2>
        <div class="log"></div>
      </div>`;
    this.instancesEl = this.el.querySelector(".instances")!;
    this.orphanBannerEl = this.el.querySelector(".orphan-banner")!;
    this.logEl = this.el.querySelector(".log")!;
    this.sweepsEl = this.el.querySelector(".sweeps")!;

    this.wireForm();
    this.wireTrufflePicker();
    this.wireSweepForm();
    this.wireQueueForm();
    client.on((e) => this.onEvent(e));
    this.renderInstances(client.list());
    this.renderSweeps();
  }

  private launchFormHtml(): string {
    return `
      <form class="launch-form" autocomplete="off">
        <div class="grid2">
          <div><label>name</label><input name="name" placeholder="my-job" required /></div>
          <div class="picker">
            <label>find instance <span class="picker-hint">(truffle — "h100 efa", "cheapest graviton 32gb")</span></label>
            <input name="truffleQuery" class="truffle-q" placeholder="natural-language query" autocomplete="off" />
            <div class="truffle-matches" hidden></div>
          </div>
          <div><label>instance type</label><input name="instanceType" value="c6a.xlarge" /></div>
          <div><label>ttl</label><input name="ttl" value="4h" placeholder="4h / 0 = none" /></div>
          <div><label>idle timeout</label><input name="idleTimeout" placeholder="30m / blank" /></div>
          <div><label>session timeout <span class="picker-hint">(idle SSH logout)</span></label><input name="sessionTimeout" placeholder="30m / blank" /></div>
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

  private sweepFormHtml(): string {
    return `
      <form class="sweep-form" autocomplete="off">
        <div class="grid2">
          <div><label>name</label><input name="sweepName" placeholder="hyperparam" /></div>
          <div><label>grid (k=v1,v2 …)</label><input name="grid" placeholder="lr=0.01,0.1 bs=32,64" required /></div>
          <div><label>ttl (all members)</label><input name="ttl" value="30m" /></div>
          <div><label>$/hr (cost meter)</label><input name="pricePerHour" value="0.017" /></div>
          <div><label>max concurrent</label><input name="maxConcurrent" value="0" placeholder="0 = all at once" /></div>
          <div><label>launch delay</label><input name="launchDelay" placeholder="blank / 5s" /></div>
        </div>
        <button type="submit" class="sweep-btn">Start sweep</button>
        <span class="sweep-msg"></span>
      </form>`;
  }

  private wireSweepForm(): void {
    const form = this.el.querySelector<HTMLFormElement>(".sweep-form")!;
    const msg = this.el.querySelector<HTMLElement>(".sweep-msg")!;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const s = (k: string) => String(fd.get(k) ?? "").trim();
      const grid = parseGridShorthand(s("grid"));
      if ("error" in grid) {
        msg.textContent = grid.error;
        msg.className = "sweep-msg bad";
        return;
      }
      const defaults: Record<string, string | number | boolean> = {};
      if (s("ttl")) defaults.ttl = s("ttl");
      const price = Number(s("pricePerHour"));
      if (Number.isFinite(price) && price > 0) defaults.price_per_hour = price;
      const delayRaw = s("launchDelay");
      try {
        const sw = this.client.startSweep(
          { grid: grid.value, defaults },
          {
            name: s("sweepName") || undefined,
            maxConcurrent: Number(s("maxConcurrent")) || 0,
            launchDelayMs: delayRaw ? parseDuration(delayRaw) ?? 0 : 0,
          },
        );
        msg.textContent = `started ${sw.id} — ${sw.size} members`;
        msg.className = "sweep-msg good";
      } catch (err) {
        msg.textContent = (err as Error).message;
        msg.className = "sweep-msg bad";
      }
    });
  }

  private queueFormHtml(): string {
    const example = JSON.stringify(
      {
        queue_name: "pipeline",
        jobs: [
          { job_id: "build", command: "make", timeout: "20m" },
          { job_id: "test", command: "make test", timeout: "20m", depends_on: ["build"] },
        ],
        on_failure: "stop",
      },
      null,
      2,
    );
    return `
      <form class="queue-form" autocomplete="off">
        <label>queue config (JSON — jobs[] with depends_on / retry / timeout)</label>
        <textarea name="config" rows="8" spellcheck="false">${escapeHtml(example)}</textarea>
        <div class="grid2">
          <div><label>max concurrent</label><input name="maxConcurrent" value="0" placeholder="0 = all eligible" /></div>
          <div><label>launch delay</label><input name="launchDelay" placeholder="blank / 5s" /></div>
        </div>
        <button type="submit" class="queue-btn">Start queue</button>
        <span class="queue-msg"></span>
      </form>`;
  }

  private wireQueueForm(): void {
    const form = this.el.querySelector<HTMLFormElement>(".queue-form")!;
    const msg = this.el.querySelector<HTMLElement>(".queue-msg")!;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const s = (k: string) => String(fd.get(k) ?? "").trim();
      let cfg;
      try {
        cfg = parseQueueConfig(s("config"));
      } catch (err) {
        msg.textContent = (err as Error).message;
        msg.className = "queue-msg bad";
        return;
      }
      const delayRaw = s("launchDelay");
      try {
        const q = this.client.startQueue(cfg, {
          maxConcurrent: Number(s("maxConcurrent")) || 0,
          launchDelayMs: delayRaw ? parseDuration(delayRaw) ?? 0 : 0,
        });
        msg.textContent = `started ${q.id} — ${q.size} jobs`;
        msg.className = "queue-msg good";
      } catch (err) {
        msg.textContent = (err as Error).message;
        msg.className = "queue-msg bad";
      }
    });
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
          sessionTimeout: s("sessionTimeout") || 0,
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

  /**
   * The truffle instance picker: a natural-language query resolves (offline, via
   * truffle-ts) to matching EC2 instance types. Picking one fills the launch
   * form's instance-type field and auto-fills $/hr from the estimate. truffle-ts
   * only supplies data + logic; this markup + wiring is spawn-ts's own choice.
   */
  private wireTrufflePicker(): void {
    const form = this.el.querySelector<HTMLFormElement>(".launch-form")!;
    const q = form.querySelector<HTMLInputElement>(".truffle-q")!;
    const matchesEl = form.querySelector<HTMLElement>(".truffle-matches")!;
    const typeInput = form.elements.namedItem("instanceType") as HTMLInputElement;
    const priceInput = form.elements.namedItem("pricePerHour") as HTMLInputElement;

    let seq = 0;
    const render = (results: FindResult[]) => {
      if (results.length === 0) {
        matchesEl.innerHTML = `<div class="truffle-empty">no matches</div>`;
        matchesEl.hidden = false;
        return;
      }
      matchesEl.innerHTML = "";
      for (const r of results.slice(0, 8)) {
        const i = r.instance;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "truffle-match";
        const price = i.onDemandPrice ? `$${i.onDemandPrice.toFixed(3)}/hr` : "—";
        btn.innerHTML =
          `<span class="tm-type">${escapeHtml(i.instanceType)}</span>` +
          `<span class="tm-spec">${i.vcpus} vCPU · ${Math.round(i.memoryMib / 1024)} GiB` +
          `${i.gpus ? ` · ${i.gpus}× ${escapeHtml(i.gpuModel ?? "GPU")}` : ""}</span>` +
          `<span class="tm-price">${price}</span>`;
        btn.addEventListener("click", () => {
          typeInput.value = i.instanceType;
          if (i.onDemandPrice) priceInput.value = String(i.onDemandPrice);
          matchesEl.hidden = true;
          q.value = "";
        });
        matchesEl.appendChild(btn);
      }
      matchesEl.hidden = false;
    };

    const run = async () => {
      const query = q.value.trim();
      if (!query) {
        matchesEl.hidden = true;
        return;
      }
      const mine = ++seq;
      try {
        const results = await find(query);
        if (mine !== seq) return; // a newer query superseded this one
        render(results);
      } catch (err) {
        if (mine !== seq) return;
        matchesEl.innerHTML = `<div class="truffle-empty">${escapeHtml((err as Error).message)}</div>`;
        matchesEl.hidden = false;
      }
    };

    // Debounce keystrokes; Enter runs immediately.
    let timer: ReturnType<typeof setTimeout> | null = null;
    q.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), 200);
    });
    q.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (timer) clearTimeout(timer);
        void run();
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
      case "sweep":
      case "queue":
      case "jobarray":
        this.onFanOutEvent(e);
        break;
    }
  }

  private onFanOutEvent(e: Extract<SpawnEvent, { type: "sweep" | "queue" | "jobarray" }>): void {
    const noun = e.type === "queue" ? "queue" : e.type === "jobarray" ? "job array" : "sweep";
    const unit = e.type === "queue" ? "jobs" : "members";
    const prev = this.sweeps.get(e.id);
    this.sweeps.set(e.id, { kind: e.type, name: e.name, summary: e.summary, done: e.done });
    // Log the first sighting and completion, not every intermediate tick.
    if (!prev) {
      this.pushLog({ kind: "info", instance: e.name, text: `${noun} ${e.id} started — ${e.summary.total} ${unit}` });
    } else if (e.done && !prev.done) {
      const { completed, failed, skipped } = e.summary;
      this.pushLog({
        kind: failed ? "warning" : "info",
        instance: e.name,
        text: `${noun} ${e.id} done — ${completed} completed${failed ? `, ${failed} failed` : ""}${
          skipped ? `, ${skipped} skipped` : ""
        }`,
      });
    }
    this.renderSweeps();
  }

  private renderSweeps(): void {
    if (this.sweeps.size === 0) {
      this.sweepsEl.innerHTML = "";
      return;
    }
    this.sweepsEl.innerHTML = "";
    // Newest last-updated first isn't tracked; insertion order is fine + stable.
    for (const [id, v] of this.sweeps) {
      const s = v.summary;
      // "launched" = anything that has left the not-yet-started states. Skipped
      // members were never launched but are settled, so they count toward done.
      const settled = s.completed + s.failed + s.skipped;
      const pct = s.total > 0 ? Math.round(((s.running + settled) / s.total) * 100) : 0;
      const parts = [
        `${s.running} running`,
        `${s.completed} completed`,
        ...(s.blocked ? [`${s.blocked} blocked`] : []),
        ...(s.failed ? [`${s.failed} failed`] : []),
        ...(s.skipped ? [`${s.skipped} skipped`] : []),
      ];
      const card = document.createElement("div");
      card.className = `sweep-card ${v.kind}` + (v.done ? " done" : "");
      card.innerHTML = `
        <div class="row1">
          <span class="name">${escapeHtml(v.name)}</span>
          <span class="id">${escapeHtml(v.kind === "jobarray" ? "job array" : v.kind)} · ${escapeHtml(id)}</span>
          <span class="state">${v.done ? "done" : "running"}</span>
        </div>
        <div class="meta">${s.total} ${v.kind === "queue" ? "jobs" : "members"} · ${parts.join(" · ")}</div>
        <div class="meter sweep"><span style="width:${pct}%"></span></div>`;
      this.sweepsEl.appendChild(card);
    }
  }

  private renderInstances(insts: ManagedInstance[]): void {
    this.renderOrphanBanner();
    const live = insts.filter((i) => i.state !== "terminated");
    if (live.length === 0) {
      this.instancesEl.innerHTML = `<div class="empty">no instances — launch one above</div>`;
      return;
    }
    const now = this.client.now();
    this.instancesEl.innerHTML = "";
    for (const i of live) this.instancesEl.appendChild(this.instanceCard(i, now));
  }

  /**
   * Warn about orphans — managed, live instances past their TTL that spored
   * should have reaped (the #19 failure mode) — with a one-click reap.
   */
  private renderOrphanBanner(): void {
    const orphans = this.client.findOrphans();
    if (orphans.length === 0) {
      this.orphanBannerEl.hidden = true;
      this.orphanBannerEl.innerHTML = "";
      return;
    }
    this.orphanBannerEl.hidden = false;
    this.orphanBannerEl.innerHTML =
      `<span>⚠️ ${orphans.length} orphan${orphans.length === 1 ? "" : "s"} past TTL — ` +
      `spored didn't reap ${orphans.length === 1 ? "it" : "them"}.</span>`;
    const btn = document.createElement("button");
    btn.textContent = `Reap ${orphans.length}`;
    btn.addEventListener("click", async () => {
      if (await this.confirmFn(`terminate ${orphans.length} orphaned instance(s)? This is permanent.`)) {
        btn.disabled = true;
        await this.client.reapOrphans(orphans);
      }
    });
    this.orphanBannerEl.appendChild(btn);
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
