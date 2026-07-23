// App entry: builds one SpawnClient (the API), then mounts the GUI dashboard
// (primary) and the terminal (secondary) as two consumers of it, plus a topbar
// with the backend picker and sim-speed control.

import { SpawnClient } from "./core/client.js";
import { Dashboard } from "./ui/dashboard.js";
import { Terminal } from "./ui/terminal.js";
import { backendDialog, confirmDialog } from "./ui/modals.js";

const app = document.getElementById("app")!;

// Start with the mock backend and an accelerated sim clock (60× = 1 sim-minute
// per real second) so TTL/idle/cost lifecycle plays out visibly in a demo.
const client = new SpawnClient({ clock: 60 });

// Topbar
const topbar = document.createElement("div");
topbar.className = "topbar";
topbar.innerHTML = `
  <div class="title"><span class="spore">spore</span>.host spawn</div>
  <span class="badge backend"></span>
  <div class="spacer"></div>
  <label style="color:var(--muted)">sim speed
    <select class="speed">
      <option value="1">1× realtime</option>
      <option value="60" selected>60× (1m/s)</option>
      <option value="600">600× (10m/s)</option>
      <option value="3600">3600× (1h/s)</option>
    </select>
  </label>
  <a class="demo-link" href="./demo/direct/">BYOA demo →</a>
  <button class="pick-backend">Backend…</button>`;
app.appendChild(topbar);

const badge = topbar.querySelector<HTMLElement>(".badge.backend")!;
function refreshBadge() {
  const b = client.backend;
  badge.textContent = b.label + (b.isReal ? " · REAL" : " · mock");
  badge.className = "badge backend " + (b.isReal ? "real" : "mock");
}
refreshBadge();

topbar.querySelector<HTMLSelectElement>(".speed")!.addEventListener("change", (e) => {
  client.setSpeed(Number((e.target as HTMLSelectElement).value));
});

topbar.querySelector(".pick-backend")!.addEventListener("click", async () => {
  const p = await backendDialog(client.activeProvider);
  if (p) {
    client.setProvider(p);
    refreshBadge();
    // Sim speed only applies to mock; reset the selector for real backends.
    const speedSel = topbar.querySelector<HTMLSelectElement>(".speed")!;
    speedSel.disabled = p.isReal;
    if (p.isReal) speedSel.value = "1";
  }
});

// Dashboard (primary) + terminal (secondary), both over the same client.
const dashboard = new Dashboard(client, confirmDialog);
const terminal = new Terminal(client, confirmDialog);
app.appendChild(terminal.el);
app.appendChild(dashboard.el);

client.on((e) => {
  if (e.type === "provider") refreshBadge();
});

// Kick off the lifecycle monitor loop and initial state.
client.startMonitor();
void client.refresh();
terminal.focus();
