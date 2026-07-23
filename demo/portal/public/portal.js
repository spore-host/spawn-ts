// Portal UI — talks only to the portal service's own endpoints. It never sees or
// sends AWS credentials; the portal holds its own identity and assumes a role in
// the user's account server-side. Plain JS (served statically by the portal), no
// build step.

const $ = (sel) => document.querySelector(sel);

function msg(text, kind = "") {
  const el = $(".msg");
  el.textContent = text;
  el.className = "msg " + kind;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

$(".launch").addEventListener("click", async () => {
  const name = $(".f-name").value.trim() || "portal-demo";
  const ttl = $(".f-ttl").value;
  $(".launch").disabled = true;
  msg("Asking the portal to assume the account role and launch…");
  try {
    const inst = await api("POST", "/api/launch", { name, ttl });
    msg(`Portal launched ${inst.instanceId} (${inst.state}) — owned by the portal role.`, "ok");
    await refresh();
  } catch (err) {
    msg(`Launch failed: ${err.message}`, "err");
  } finally {
    $(".launch").disabled = false;
  }
});

$(".refresh").addEventListener("click", () => void refresh());

$(".term-close").addEventListener("click", async () => {
  await window.portalTerminal.close();
  $(".term-card").hidden = true;
  $(".term-card .term").innerHTML = "";
});

async function refresh() {
  const wrap = $(".instances");
  wrap.innerHTML = "<div class='hint'>Loading…</div>";
  try {
    const list = await api("GET", "/api/instances");
    if (!list.length) {
      wrap.innerHTML = "<div class='hint'>No portal-managed instances.</div>";
      return;
    }
    wrap.innerHTML = "";
    for (const i of list) {
      const deadline = i.ttlDeadlineMs ? new Date(i.ttlDeadlineMs).toLocaleTimeString() : "—";
      const card = document.createElement("div");
      card.className = "inst";
      card.innerHTML = `
        <div class="row"><span>instance</span><code>${i.instanceId}</code></div>
        <div class="row"><span>state</span><b class="state-${i.state}">${i.state}</b></div>
        <div class="row"><span>type</span>${i.instanceType} · ${i.region}</div>
        <div class="row"><span>TTL deadline</span>${deadline}</div>
        <div class="row"><span>controlled by</span><b>${i.managedBy}</b> (not you)</div>
      `;
      if (i.state === "running") {
        const openTerm = document.createElement("button");
        openTerm.textContent = "Open terminal (via portal)";
        openTerm.addEventListener("click", async () => {
          openTerm.disabled = true;
          openTerm.textContent = "Opening…";
          try {
            document.querySelector(".term-card").hidden = false;
            await window.portalTerminal.open(i.instanceId, document.querySelector(".term-card .term"));
            msg(`Portal brokered an SSM session into ${i.instanceId}.`, "ok");
          } catch (err) {
            msg(`Terminal failed: ${err.message}`, "err");
          } finally {
            openTerm.disabled = false;
            openTerm.textContent = "Open terminal (via portal)";
          }
        });
        card.appendChild(openTerm);
      }

      const term = document.createElement("button");
      term.textContent = "Terminate (via portal)";
      term.addEventListener("click", async () => {
        term.disabled = true;
        try {
          await api("POST", "/api/terminate", { instanceId: i.instanceId });
          await refresh();
        } catch (err) {
          msg(`Terminate failed: ${err.message}`, "err");
          term.disabled = false;
        }
      });
      card.appendChild(term);
      wrap.appendChild(card);
    }
  } catch (err) {
    wrap.innerHTML = `<div class='hint err'>Could not reach the portal: ${err.message}</div>`;
  }
}

void refresh();
