// Modal dialogs: a yes/no confirm (for destructive actions) and the backend
// picker (mock / substrate emulator / real AWS with in-memory credentials).

import { EC2Provider } from "../aws/ec2.js";
import { MockProvider } from "../core/mock.js";
import type { Provider } from "../core/provider.js";

/** A promise-based confirm dialog. Resolves true if the user confirms. */
export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>Confirm</h3>
        <div>${escapeHtml(message)}</div>
        <div class="buttons">
          <button class="cancel">Cancel</button>
          <button class="primary confirm">Confirm</button>
        </div>
      </div>`;
    const done = (v: boolean) => {
      backdrop.remove();
      resolve(v);
    };
    backdrop.querySelector(".cancel")!.addEventListener("click", () => done(false));
    backdrop.querySelector(".confirm")!.addEventListener("click", () => done(true));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) done(false);
    });
    document.body.appendChild(backdrop);
    (backdrop.querySelector(".confirm") as HTMLButtonElement).focus();
  });
}

/**
 * Backend picker. Resolves to a new Provider (or null if cancelled). Credentials
 * entered for the "aws" backend live only in the created EC2Provider's client —
 * never persisted to storage.
 */
export function backendDialog(current: Provider): Promise<Provider | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>Backend</h3>
        <label>compute backend</label>
        <select class="backend-kind">
          <option value="mock">mock — in-memory, not billable (default)</option>
          <option value="substrate">substrate — local emulator (localhost:4566)</option>
          <option value="aws">real AWS — billable</option>
        </select>
        <div class="aws-fields" style="display:none">
          <label>region</label><input class="f-region" value="us-east-1" />
          <label>access key id</label><input class="f-akid" autocomplete="off" />
          <label>secret access key</label><input class="f-secret" type="password" autocomplete="off" />
          <label>session token (optional)</label><input class="f-token" autocomplete="off" />
          <label>endpoint (blank = real AWS)</label><input class="f-endpoint" placeholder="" />
          <div class="warn">Credentials are held in memory only and never stored. Real launches are billable.</div>
        </div>
        <div class="sub-fields" style="display:none">
          <label>endpoint</label><input class="f-sub-endpoint" value="http://localhost:4566" />
          <div class="warn">Requires substrate with CORS enabled (see substrate#346).</div>
        </div>
        <div class="buttons">
          <button class="cancel">Cancel</button>
          <button class="primary apply">Apply</button>
        </div>
      </div>`;

    const kind = backdrop.querySelector<HTMLSelectElement>(".backend-kind")!;
    const awsFields = backdrop.querySelector<HTMLElement>(".aws-fields")!;
    const subFields = backdrop.querySelector<HTMLElement>(".sub-fields")!;
    kind.value = current.isReal ? "aws" : current.label.startsWith("substrate") ? "substrate" : "mock";
    const sync = () => {
      awsFields.style.display = kind.value === "aws" ? "block" : "none";
      subFields.style.display = kind.value === "substrate" ? "block" : "none";
    };
    kind.addEventListener("change", sync);
    sync();

    const done = (p: Provider | null) => {
      backdrop.remove();
      resolve(p);
    };
    backdrop.querySelector(".cancel")!.addEventListener("click", () => done(null));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) done(null);
    });
    backdrop.querySelector(".apply")!.addEventListener("click", () => {
      const val = (sel: string) => backdrop.querySelector<HTMLInputElement>(sel)!.value.trim();
      if (kind.value === "mock") return done(new MockProvider());
      if (kind.value === "substrate") {
        return done(
          new EC2Provider({
            region: "us-east-1",
            accessKeyId: "test",
            secretAccessKey: "test",
            endpoint: val(".f-sub-endpoint") || "http://localhost:4566",
          }),
        );
      }
      // real AWS
      done(
        new EC2Provider({
          region: val(".f-region") || "us-east-1",
          accessKeyId: val(".f-akid"),
          secretAccessKey: val(".f-secret"),
          sessionToken: val(".f-token") || undefined,
          endpoint: val(".f-endpoint") || undefined,
        }),
      );
    });

    document.body.appendChild(backdrop);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
