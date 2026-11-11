// The dashboard — the PRIMARY interface. A GUI over SpawnClient: a launch form,
// live instance cards with action buttons (stop/start/extend/terminate/signal),
// TTL + cost meters, and a lifecycle event log. It renders from SpawnClient
// events; it never reaches into provider internals.

import type { SpawnClient, SpawnEvent } from "../core/client.js";
import type { LifecycleAction, ManagedInstance } from "../core/types.js";
import type { FanOutSummary } from "../core/fanout.js";
import { accumulatedCost } from "../core/lifecycle.js";
import { stopBlocker } from "../core/bounds.js";
import { newLaunchToken } from "../core/client.js";
import {
  describeSpawnError,
  isAmbiguousLaunchError,
  toSpawnError,
  type SpawnError,
  type SpawnOperation,
} from "../core/errors.js";
import { dnsNotice, sporedUpgrade, type Notice } from "../core/notices.js";
import { instancePlugins, LAUNCH_DECLARABLE_PLUGINS } from "../core/plugins.js";
import { humanRemaining, formatDuration, parseDuration } from "../core/duration.js";
import { parseGridShorthand } from "../core/params.js";
import { parseQueueConfig } from "../core/queue.js";
import { find, type FindResult } from "@spore-host/truffle-ts";

interface LogItem { atMs: number; kind: string; instance: string; text: string; }

/** One rendered instance card, kept across renders and keyed by instance id (#128). */
interface CardView {
  el: HTMLElement;
  info: HTMLElement;
  actions: HTMLElement;
  /** The last action's failure, in words; outside `info`, so a render keeps it. */
  error: HTMLElement;
  /** The instance as last rendered; button handlers read it, never a stale closure. */
  inst: ManagedInstance;
  infoHtml: string;
  /** The offered actions, joined; the buttons are rebuilt only when this changes. */
  actionKey: string;
}

interface CardAction {
  label: string;
  /** Shown on the button while the call runs ("stopping…"). */
  progress: string;
  op: SpawnOperation;
  /** Asked before anything runs; a false answer runs nothing. */
  confirm?: (inst: ManagedInstance) => string;
  run: (inst: ManagedInstance) => Promise<unknown>;
}
interface SweepView { kind: "sweep" | "queue" | "jobarray"; name: string; summary: FanOutSummary; done: boolean; }

export class Dashboard {
  readonly el: HTMLElement;
  private instancesEl!: HTMLElement;
  private orphanBannerEl!: HTMLElement;
  private listErrorEl!: HTMLElement;
  private logEl!: HTMLElement;
  private sweepsEl!: HTMLElement;
  private log: LogItem[] = [];
  private sweeps = new Map<string, SweepView>();
  private cards = new Map<string, CardView>();
  /** Instance id → the action running on it; survives re-renders. */
  private busy = new Map<string, string>();
  private orphanKey = "";

  constructor(
    private client: SpawnClient,
    private confirmFn: (msg: string) => Promise<boolean>,
    /**
     * Newest published spored version, for the upgrade notice (#56). A value, not
     * a fetcher: the GitHub release lookup is the embedder's call to make. Omitted
     * means no upgrade notice at all — never "you're up to date".
     */
    private latestSporedVersion?: string,
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
        <div class="list-error" role="alert" hidden></div>
        <div class="instances"></div>
      </div>
      <div class="dash-section">
        <h2>Lifecycle log</h2>
        <div class="log"></div>
      </div>`;
    this.instancesEl = this.el.querySelector(".instances")!;
    this.orphanBannerEl = this.el.querySelector(".orphan-banner")!;
    this.listErrorEl = this.el.querySelector(".list-error")!;
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
          <div><label>pre-stop <span class="picker-hint">(run by spored)</span></label><input name="preStop" placeholder="aws s3 sync … (on the instance)" /></div>
          <div><label>notify url <span class="picker-hint">(spored)</span></label><input name="notifyUrl" placeholder="Slack/Teams webhook" /></div>
          <div class="checks">
            <label class="inline"><input type="checkbox" name="spot" /> spot</label>
            <label class="inline"><input type="checkbox" name="hibernateOnIdle" /> hibernate on idle</label>
          </div>
        </div>
        <div class="plugin-picker">
          <label>plugins <span class="picker-hint">(declared in user-data; spored installs them at boot)</span></label>
          <div class="plugin-checks">${LAUNCH_DECLARABLE_PLUGINS.map(
            (name) =>
              `<label class="inline"><input type="checkbox" name="plugin" value="${name}" /> ${name}</label>`,
          ).join("")}</div>
          <!-- A checkbox per declarable plugin rather than a free-text field, so the
               offered set IS the supported set and a rejection can't be reached from
               here. But an absence with no explanation reads as an arbitrary
               omission, so the five that aren't offered are named with the reason. -->
          <div class="plugin-note">
            spore-sync, rclone, tailscale, globus-personal-endpoint and
            github-actions-runner aren't here: each needs a local half that mints and
            pushes a secret, which no launch-time path has. Install those with the
            spawn CLI. All twelve are still <em>detected</em> on the cards below.
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
    const button = form.querySelector<HTMLButtonElement>(".launch-btn")!;
    // One idempotency token per launch intent (#129, spore-host#673): kept
    // across retries of the same form, so a double-click or a retry after a
    // lost response returns the first instance instead of launching a second;
    // replaced once that launch succeeds or the form changes.
    let intent: string | undefined;
    form.addEventListener("input", () => (intent = undefined));
    form.addEventListener("change", () => (intent = undefined));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      intent ??= newLaunchToken();
      const clientToken = intent;
      button.disabled = true;
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
          hooks:
            s("preStop") || s("notifyUrl")
              ? {
                  ...(s("preStop") ? { preStop: s("preStop") } : {}),
                  ...(s("notifyUrl") ? { notifyUrl: s("notifyUrl") } : {}),
                }
              : undefined,
          // getAll — the plugin checkboxes share one name, and fd.get() would
          // return only the first, quietly launching with one of three ticked
          // boxes honoured. Same defect the CLI's flagList exists to avoid.
          plugins: fd.getAll("plugin").map((v) => ({ ref: String(v) })),
          clientToken,
        });
        intent = undefined;
        msg.textContent = `launched ${inst.name}`;
        msg.className = "launch-msg good";
        (form.elements.namedItem("name") as HTMLInputElement).value = "";
      } catch (err) {
        msg.textContent = (err as Error).message;
        msg.className = "launch-msg bad";
        // Keep the token only when the launch may have happened anyway.
        if (!isAmbiguousLaunchError(err)) intent = undefined;
      } finally {
        button.disabled = false;
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
          // An unpriced type clears $/hr rather than leaving the previous pick's
          // price attributed to it (truffle-ts 0.6 prices no type it doesn't know).
          priceInput.value = i.onDemandPrice ? String(i.onDemandPrice) : "";
          matchesEl.hidden = true;
          q.value = "";
        });
        matchesEl.appendChild(btn);
      }
      matchesEl.hidden = false;
    };

    // A query truffle can't read: a parse error ("conflicting architectures"),
    // or, from truffle-ts 0.6, an UnrecognizedQueryError for a query made only of
    // unknown words (0.5 returned every type for those). Its message is a line
    // naming the unknown words plus a line of suggestions; each gets its own row
    // so the hint doesn't run into the error. Matched on `name`, not instanceof:
    // 0.5 has no such export, and the range still admits 0.5.
    const renderError = (err: unknown) => {
      const e = err as Error;
      const lines = String(e?.message ?? err).split("\n").map((l) => l.trim()).filter(Boolean);
      const cls = e?.name === "UnrecognizedQueryError" ? "truffle-empty truffle-unrecognized" : "truffle-empty";
      matchesEl.innerHTML = lines
        .map((l, n) => `<div class="${cls}${n > 0 ? " truffle-hint" : ""}">${escapeHtml(l)}</div>`)
        .join("");
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
        renderError(err);
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
      case "error":
        this.onError(e.error);
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
      // The viability line (#52) — shown only for an array that set a threshold,
      // since 1 is the no-op default. When the array has gone non-viable, say so
      // and say what follows: otherwise a user watching the card sees running
      // members disappear with no stated reason.
      const viability =
        s.minViable > 1
          ? s.nonViable
            ? `<div class="meta warn">non-viable — only ${s.viableCandidates} of ${s.total} can come up, ` +
              `below min-viable ${s.minViable}; survivors are being terminated</div>`
            : `<div class="meta">min-viable ${s.minViable} of ${s.total}</div>`
          : "";
      // Which slices have no worker. "97 of 100 running" doesn't say which three
      // are missing, and for an indexed array that is the actionable part.
      const missing =
        v.kind === "jobarray" && s.missingIndexes.length > 0 && s.missingIndexes.length < s.total
          ? `<div class="meta">missing index${s.missingIndexes.length === 1 ? "" : "es"}: ${s.missingIndexes.join(", ")}</div>`
          : "";
      const card = document.createElement("div");
      card.className = `sweep-card ${v.kind}` + (v.done ? " done" : "") + (s.nonViable ? " nonviable" : "");
      card.innerHTML = `
        <div class="row1">
          <span class="name">${escapeHtml(v.name)}</span>
          <span class="id">${escapeHtml(v.kind === "jobarray" ? "job array" : v.kind)} · ${escapeHtml(id)}</span>
          <span class="state">${s.nonViable ? "non-viable" : v.done ? "done" : "running"}</span>
        </div>
        <div class="meta">${s.total} ${v.kind === "queue" ? "jobs" : "members"} · ${parts.join(" · ")}</div>
        ${viability}${missing}
        <div class="meter sweep"><span style="width:${pct}%"></span></div>`;
      this.sweepsEl.appendChild(card);
    }
  }

  /**
   * Render the instance cards IN PLACE, keyed by instance id (#128).
   *
   * The monitor emits an `instances` event several times a second, and this
   * used to replace every card each time. A press slower than the gap between
   * renders landed mousedown and mouseup on different elements, so no click
   * fired (a 180 ms press on "terminate" opened nothing), and a button's
   * disabled state was wiped by the next render. Now a card is created once
   * per instance id, its text is rewritten only when it changed, and its
   * buttons are rebuilt only when the set of offered actions changes and no
   * action is running on it.
   */
  private renderInstances(insts: ManagedInstance[]): void {
    this.renderOrphanBanner();
    const state = this.client.listState;
    if (state.status === "ok") this.listErrorEl.hidden = true;
    const live = insts.filter((i) => i.state !== "terminated");
    const empty = this.instancesEl.querySelector(":scope > .empty");
    if (live.length === 0) {
      for (const c of this.cards.values()) c.el.remove();
      this.cards.clear();
      // "No instances" only from a list that loaded: before the first one,
      // or after a failure, an empty list is not knowledge (#125).
      const text =
        state.status === "ok"
          ? "no instances — launch one above"
          : state.status === "loading"
            ? "checking instances…"
            : "";
      if (empty?.textContent !== text) {
        this.instancesEl.innerHTML = text ? `<div class="empty">${text}</div>` : "";
      }
      return;
    }
    empty?.remove();
    const now = this.client.now();
    const seen = new Set<string>();
    let prev: HTMLElement | null = null;
    for (const i of live) {
      seen.add(i.instanceId);
      let c = this.cards.get(i.instanceId);
      if (!c) {
        c = this.createCard(i);
        this.cards.set(i.instanceId, c);
      }
      this.updateCard(c, i, now);
      // Keep list order without moving a card that is already in place: moving
      // the node under the pointer is as bad as replacing it.
      const want: ChildNode | null = prev ? prev.nextSibling : this.instancesEl.firstChild;
      if (want !== c.el) this.instancesEl.insertBefore(c.el, want);
      prev = c.el;
    }
    for (const [id, c] of this.cards) {
      if (seen.has(id)) continue;
      c.el.remove();
      this.cards.delete(id);
    }
  }

  /**
   * Warn about orphans — managed, live instances past their TTL that spored
   * should have reaped (the #19 failure mode) — with a one-click reap. Rebuilt
   * only when the set of orphans changes, for the same reason as the cards.
   */
  private renderOrphanBanner(): void {
    const orphans = this.client.findOrphans();
    const key = orphans.map((o) => o.instance.instanceId).join(",");
    if (key === this.orphanKey) return;
    this.orphanKey = key;
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

  private createCard(i: ManagedInstance): CardView {
    const el = document.createElement("div");
    el.className = "inst";
    el.dataset.instanceId = i.instanceId;
    const info = document.createElement("div");
    info.className = "inst-info";
    const actions = document.createElement("div");
    actions.className = "actions";
    const error = document.createElement("div");
    error.className = "card-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    el.append(info, actions, error);
    return { el, info, actions, error, inst: i, infoHtml: "", actionKey: "" };
  }

  private updateCard(c: CardView, i: ManagedInstance, now: number): void {
    c.inst = i;
    const html = this.cardInfoHtml(i, now);
    if (html !== c.infoHtml) {
      c.info.innerHTML = html;
      c.infoHtml = html;
    }
    const offered = this.cardActions(i);
    const key = offered.map((a) => a.label).join("|");
    // Never pull a button out from under a running action: the busy state and
    // the button the user pressed both stay until it settles.
    if (key !== c.actionKey && !this.busy.has(i.instanceId)) {
      c.actions.replaceChildren(...offered.map((a) => this.actionBtn(i.instanceId, a)));
      c.actionKey = key;
    }
  }

  private cardInfoHtml(i: ManagedInstance, now: number): string {
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

    // Tag-derived notices (#56). Only the two the card can't already show: the
    // meters above cover what `lifecycleProtection` says, and `elasticIpNotice`
    // needs a DescribeAddresses call the dashboard doesn't make. A failed DNS
    // registration, though, is invisible everywhere else — the user just gets a
    // hostname that never resolves.
    const notices = [dnsNotice(i), sporedUpgrade(i, this.latestSporedVersion || "")]
      .filter((n): n is Notice => n !== null)
      .map(
        (n) =>
          `<div class="notice ${n.level}">${n.level === "warn" ? "⚠️ " : ""}${escapeHtml(n.text)}</div>`,
      )
      .join("");

    // Detected plugins, from the spore:plugin:* tags the instance already carries.
    // Rendered only when at least one is present: an empty list is NOT "no
    // plugins installed" (the tag is best-effort, and never written for the
    // launch-time path), so silence is the honest rendering of it. A card that
    // said "no plugins" would assert what the data can't support — the CLI's
    // --plugins spells out that caveat for a user who wants to ask.
    const detected = instancePlugins(i);
    const pluginLine = detected.length
      ? `<div class="meta plugins">plugins — ${detected
          .map((pl) => {
            const label = `${pl.name}${pl.version ? ` ${pl.version}` : ""}`;
            // verify=none means verification ran and reached neither a signature
            // nor a manifest — a supply-chain finding. "unknown" means we can't
            // tell. Distinct classes, so they can't be styled or read alike.
            const cls = pl.verify === "none" ? "vnone" : pl.verify === "unknown" ? "vunknown" : "vok";
            return `<span class="plugin ${cls}" title="verify=${escapeHtml(pl.verify)}">${escapeHtml(
              label,
            )}</span>`;
          })
          .join(" ")}</div>`
      : "";

    return `
      <div class="row1">
        <span class="name">${escapeHtml(i.name)}</span>
        <span class="id">${i.instanceId}</span>
        <span class="state ${i.state}">${i.state}</span>
      </div>
      <div class="meta">${meta.map(escapeHtml).join(" · ")}</div>
      ${ttlMeter}${costMeter}${idleLine}${pluginLine}${notices}`;
  }

  /**
   * The buttons a card offers. Every one acts on the card's instance ID: the
   * Name is a label, and two instances can share it (#128).
   */
  private cardActions(i: ManagedInstance): CardAction[] {
    const out: CardAction[] = [];
    const running = i.state === "running";
    const stopped = i.state === "stopped" || i.state === "hibernated";
    if (running) {
      // Offered only where EC2 would accept them (#129): never on a one-time
      // Spot instance, and hibernate only on one launched hibernatable.
      if (!stopBlocker(i, "stop")) {
        out.push({ label: "stop", progress: "stopping…", op: "stop", run: (x) => this.client.stop(x.instanceId) });
      }
      if (!stopBlocker(i, "hibernate")) {
        out.push({
          label: "hibernate",
          progress: "hibernating…",
          op: "hibernate",
          run: (x) => this.client.hibernate(x.instanceId),
        });
      }
      out.push({
        label: "extend 1h",
        progress: "extending…",
        op: "extend",
        run: (x) => this.client.extend(x.instanceId, "1h"),
      });
      // A simulation affordance: on a real backend it was an unconfirmed
      // terminate or stop dressed as a demo button (#128).
      if (i.onComplete && !this.client.backend.isReal) {
        out.push({
          label: "signal complete",
          progress: "signalling…",
          op: "signalComplete",
          run: (x) => this.client.signalComplete(x.instanceId),
        });
      }
    }
    if (stopped) {
      out.push({ label: "start", progress: "starting…", op: "start", run: (x) => this.client.start(x.instanceId) });
    }
    out.push({
      label: "terminate",
      progress: "terminating…",
      op: "terminate",
      confirm: (x) => `terminate ${x.name} (${x.instanceId})? This is permanent.`,
      run: (x) => this.client.terminate(x.instanceId),
    });
    return out;
  }

  /**
   * One card button. While its call runs the button says what is happening
   * ("stopping…") and the card's buttons are disabled; a failure is shown on
   * the card in words with the AWS code, and logged. Nothing is left as an
   * unhandled rejection (#125): the old handler re-enabled the button and
   * showed nothing when AWS refused.
   */
  private actionBtn(instanceId: string, a: CardAction): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = a.label;
    b.disabled = this.busy.has(instanceId);
    b.addEventListener("click", () => void this.runAction(instanceId, a, b));
    return b;
  }

  private async runAction(instanceId: string, a: CardAction, b: HTMLButtonElement): Promise<void> {
    const c = this.cards.get(instanceId);
    if (!c || this.busy.has(instanceId)) return;
    const inst = c.inst;
    this.busy.set(instanceId, a.label);
    const setBusy = (on: boolean) => {
      for (const x of (this.cards.get(instanceId)?.actions ?? c.actions).querySelectorAll("button")) x.disabled = on;
    };
    setBusy(true);
    try {
      if (a.confirm && !(await this.confirmFn(a.confirm(inst)))) return;
      b.textContent = a.progress;
      c.error.hidden = true;
      c.error.textContent = "";
      await a.run(inst);
      this.pushLog({ kind: "info", instance: inst.name, text: `${a.label}: requested (${instanceId})` });
    } catch (err) {
      const e = toSpawnError(err, a.op, instanceId);
      const now = this.cards.get(instanceId) ?? c;
      this.showCardError(now, e);
      this.pushLog({ kind: "error", instance: inst.name, text: `${a.label} failed — ${describeSpawnError(e)} [${e.code}]` });
    } finally {
      b.textContent = a.label;
      this.busy.delete(instanceId);
      setBusy(false);
      const now = this.cards.get(instanceId);
      // Catch up on an action-set change that arrived while it ran.
      if (now) this.updateCard(now, now.inst, this.client.now());
    }
  }

  private showCardError(c: CardView, e: SpawnError): void {
    c.error.replaceChildren();
    const text = document.createElement("span");
    text.className = "card-error-text";
    text.textContent = describeSpawnError(e);
    const detail = document.createElement("span");
    detail.className = "card-error-detail";
    detail.textContent = `${e.code}${e.aws && e.message ? `: ${e.message}` : ""}`;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "card-error-dismiss";
    dismiss.textContent = "dismiss";
    dismiss.addEventListener("click", () => {
      c.error.hidden = true;
      c.error.replaceChildren();
    });
    c.error.append(text, " ", detail, " ", dismiss);
    c.error.hidden = false;
  }

  /**
   * A failure nobody awaited: a refresh or a monitor tick. A failed list keeps
   * the cards it last had (they may still be running and billing) and says the
   * list is stale; it never turns into "no instances" (#125).
   */
  private onError(e: SpawnError): void {
    this.pushLog({ kind: "error", instance: e.instanceId ?? "-", text: `${describeSpawnError(e)} [${e.code}]` });
    if (e.operation !== "list" && e.operation !== "monitor") return;
    const state = this.client.listState;
    const asOf =
      state.checkedAtMs !== undefined
        ? ` Showing the list from ${new Date(state.checkedAtMs).toISOString().slice(11, 19)}; those instances may still be running.`
        : " Your instances may still be running and costing money.";
    this.listErrorEl.textContent = `${describeSpawnError(e)} [${e.code}]${asOf}`;
    this.listErrorEl.hidden = false;
    // Drop a "no instances" or "checking…" placeholder: neither is true now.
    if (this.cards.size === 0) this.instancesEl.innerHTML = "";
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
