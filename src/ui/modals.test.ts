// @vitest-environment happy-dom
//
// DOM tests for the modal dialogs: the promise-based confirm and the backend
// picker (mock / substrate / real AWS). The picker constructs real providers,
// so we assert on their label/isReal rather than reaching into credentials.

import { describe, it, expect, beforeEach } from "vitest";
import { confirmDialog, backendDialog } from "./modals.js";
import { MockProvider } from "../core/mock.js";
import { EC2Provider } from "../aws/ec2.js";

function backdrop(): HTMLElement {
  return document.body.querySelector<HTMLElement>(".modal-backdrop")!;
}
function click(sel: string) {
  document.body.querySelector<HTMLElement>(sel)!.click();
}

describe("confirmDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("mounts a modal and resolves true on Confirm", async () => {
    const p = confirmDialog("delete it?");
    expect(backdrop()).toBeTruthy();
    expect(backdrop().textContent).toContain("delete it?");
    click(".confirm");
    expect(await p).toBe(true);
    // Modal is removed after resolving.
    expect(document.body.querySelector(".modal-backdrop")).toBeNull();
  });

  it("resolves false on Cancel", async () => {
    const p = confirmDialog("nope?");
    click(".cancel");
    expect(await p).toBe(false);
  });

  it("resolves false when clicking the backdrop", async () => {
    const p = confirmDialog("outside click");
    backdrop().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await p).toBe(false);
  });

  it("escapes HTML in the message", async () => {
    const p = confirmDialog("<img src=x onerror=1>");
    expect(backdrop().querySelector("img")).toBeNull();
    click(".cancel");
    await p;
  });
});

describe("backendDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("resolves null on Cancel", async () => {
    const p = backendDialog(new MockProvider());
    click(".cancel");
    expect(await p).toBeNull();
  });

  it("resolves a MockProvider when 'mock' is applied", async () => {
    const p = backendDialog(new MockProvider());
    (backdrop().querySelector(".backend-kind") as HTMLSelectElement).value = "mock";
    click(".apply");
    const provider = await p;
    expect(provider).toBeInstanceOf(MockProvider);
  });

  it("builds a non-real substrate EC2Provider with the entered endpoint", async () => {
    const p = backendDialog(new MockProvider());
    const kind = backdrop().querySelector<HTMLSelectElement>(".backend-kind")!;
    kind.value = "substrate";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    backdrop().querySelector<HTMLInputElement>(".f-sub-endpoint")!.value = "http://localhost:9999";
    click(".apply");
    const provider = (await p) as EC2Provider;
    expect(provider).toBeInstanceOf(EC2Provider);
    expect(provider.isReal).toBe(false);
    expect(provider.label).toBe("substrate:us-east-1");
  });

  it("builds a real AWS EC2Provider from the credential fields", async () => {
    const p = backendDialog(new MockProvider());
    const kind = backdrop().querySelector<HTMLSelectElement>(".backend-kind")!;
    kind.value = "aws";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    backdrop().querySelector<HTMLInputElement>(".f-region")!.value = "eu-west-1";
    backdrop().querySelector<HTMLInputElement>(".f-akid")!.value = "AKIA123";
    backdrop().querySelector<HTMLInputElement>(".f-secret")!.value = "sekret";
    click(".apply");
    const provider = (await p) as EC2Provider;
    expect(provider).toBeInstanceOf(EC2Provider);
    expect(provider.isReal).toBe(true);
    expect(provider.label).toBe("aws:eu-west-1");
  });

  it("toggles the aws / substrate field groups when the kind changes", async () => {
    const p = backendDialog(new MockProvider());
    const kind = backdrop().querySelector<HTMLSelectElement>(".backend-kind")!;
    const aws = backdrop().querySelector<HTMLElement>(".aws-fields")!;
    const sub = backdrop().querySelector<HTMLElement>(".sub-fields")!;

    // Default is mock → both hidden.
    expect(aws.style.display).toBe("none");
    expect(sub.style.display).toBe("none");

    kind.value = "aws";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    expect(aws.style.display).toBe("block");
    expect(sub.style.display).toBe("none");

    kind.value = "substrate";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    expect(aws.style.display).toBe("none");
    expect(sub.style.display).toBe("block");

    click(".cancel");
    await p;
  });

  it("preselects the kind matching the current provider", async () => {
    const current = new EC2Provider({
      region: "us-east-1",
      accessKeyId: "x",
      secretAccessKey: "y",
      endpoint: "http://localhost:4566",
    });
    const p = backendDialog(current);
    expect(backdrop().querySelector<HTMLSelectElement>(".backend-kind")!.value).toBe("substrate");
    click(".cancel");
    await p;
  });
});
