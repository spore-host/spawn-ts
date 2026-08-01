// Globus Transfer client tests. No credentials and no network: `fetch` is
// injected (the convention completeLogin already uses), and awaitTask's clock and
// sleep are injected too, so the polling loop runs in microseconds.

import { describe, expect, it, vi } from "vitest";

import { GlobusTransferError, isTerminal, transferClient } from "./globus.js";

/** A fetch double that replays canned responses in order and records requests. */
function fakeFetch(
  responses: Array<{ status?: number; body: unknown | string }>,
): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)];
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      text: async () => text,
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const TOKEN = "transfer-access-token";

describe("auth + request shape", () => {
  it("sends the transfer token as a bearer header", async () => {
    const { impl, calls } = fakeFetch([{ body: { DATA: [] } }]);
    await transferClient({ transferToken: TOKEN, fetchImpl: impl }).searchCollections("ncsa");
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("hits the v0.10 API base and encodes the query", async () => {
    const { impl, calls } = fakeFetch([{ body: { DATA: [] } }]);
    await transferClient({ transferToken: TOKEN, fetchImpl: impl }).searchCollections("my data");
    expect(calls[0].url).toContain("https://transfer.api.globus.org/v0.10/endpoint_search");
    expect(calls[0].url).toContain("filter_fulltext=my+data");
  });

  it("honours a base URL override without a double slash", async () => {
    const { impl, calls } = fakeFetch([{ body: { DATA: [] } }]);
    await transferClient({
      transferToken: TOKEN,
      fetchImpl: impl,
      baseUrl: "https://example.test/v0.10/",
    }).listTasks();
    expect(calls[0].url).toBe("https://example.test/v0.10/task_list");
  });
});

describe("searchCollections", () => {
  it("maps the wire shape into camelCase domain objects", async () => {
    const { impl } = fakeFetch([
      {
        body: {
          DATA: [
            {
              id: "ddb59aef-6d04-11e5-ba46-22000b92c6ec",
              display_name: "Globus Tutorial Collection 1",
              owner_string: "tutorial@globus.org",
              activated: true,
              is_globus_connect: false,
              entity_type: "GCSv5_mapped_collection",
            },
          ],
        },
      },
    ]);
    const [c] = await transferClient({ transferToken: TOKEN, fetchImpl: impl }).searchCollections("t");
    expect(c).toEqual({
      id: "ddb59aef-6d04-11e5-ba46-22000b92c6ec",
      displayName: "Globus Tutorial Collection 1",
      owner: "tutorial@globus.org",
      description: undefined,
      activated: true,
      isGlobusConnectPersonal: false,
      requiresDataAccessConsent: true,
    });
  });

  it("flags a Globus Connect Personal endpoint", async () => {
    // Worth surfacing: a browser can name a GCP endpoint and submit to it, but
    // the transfer sits queued until the user's laptop is on. Better said up
    // front than discovered after an hour of ACTIVE.
    const { impl } = fakeFetch([
      { body: { DATA: [{ id: "x", display_name: "my laptop", is_globus_connect: true }] } },
    ]);
    const [c] = await transferClient({ transferToken: TOKEN, fetchImpl: impl }).searchCollections("laptop");
    expect(c.isGlobusConnectPersonal).toBe(true);
  });

  it("never renders an unidentifiable row", async () => {
    // display_name is optional on older endpoints. A blank name in a picker is
    // unusable, so fall back through the other name fields to the id.
    const { impl } = fakeFetch([{ body: { DATA: [{ id: "abc", canonical_name: "ncsa#dtn" }, { id: "d" }] } }]);
    const found = await transferClient({ transferToken: TOKEN, fetchImpl: impl }).searchCollections("x");
    expect(found[0].displayName).toBe("ncsa#dtn");
    expect(found[1].displayName).toBe("d");
  });

  it("returns an empty list when DATA is absent, rather than throwing", async () => {
    const { impl } = fakeFetch([{ body: {} }]);
    expect(await transferClient({ transferToken: TOKEN, fetchImpl: impl }).searchCollections("q")).toEqual(
      [],
    );
  });
});

describe("submitTransfer", () => {
  it("fetches a submission_id first and sends it with the transfer", async () => {
    // Globus's idempotency mechanism: a retried POST carrying the same
    // submission_id is recognised as a duplicate. Skipping it lets a network
    // retry move the data twice.
    const { impl, calls } = fakeFetch([
      { body: { value: "sub-123" } },
      { body: { task_id: "task-abc" } },
    ]);
    const task = await transferClient({ transferToken: TOKEN, fetchImpl: impl }).submitTransfer({
      sourceCollectionId: "src",
      destinationCollectionId: "dst",
      label: "results out",
      items: [{ sourcePath: "/~/out/", destinationPath: "/data/out/", recursive: true }],
    });

    expect(calls[0].url).toContain("/submission_id");
    expect(calls[1].url).toContain("/transfer");
    const sent = JSON.parse(calls[1].init!.body as string);
    expect(sent.submission_id).toBe("sub-123");
    expect(sent.DATA_TYPE).toBe("transfer");
    expect(sent.source_endpoint).toBe("src");
    expect(sent.destination_endpoint).toBe("dst");
    expect(sent.DATA).toEqual([
      {
        DATA_TYPE: "transfer_item",
        source_path: "/~/out/",
        destination_path: "/data/out/",
        recursive: true,
      },
    ]);
    expect(task).toEqual({ taskId: "task-abc", status: "ACTIVE", label: "results out" });
  });

  it("sets content-type on a body-carrying request", async () => {
    const { impl, calls } = fakeFetch([{ body: { value: "s" } }, { body: { task_id: "t" } }]);
    await transferClient({ transferToken: TOKEN, fetchImpl: impl }).submitTransfer({
      sourceCollectionId: "a",
      destinationCollectionId: "b",
      items: [{ sourcePath: "/f", destinationPath: "/f" }],
    });
    expect((calls[1].init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("keeps checksum verification on by default", async () => {
    // Globus's own default. Silently trading integrity for speed is not this
    // layer's call to make.
    const { impl, calls } = fakeFetch([{ body: { value: "s" } }, { body: { task_id: "t" } }]);
    await transferClient({ transferToken: TOKEN, fetchImpl: impl }).submitTransfer({
      sourceCollectionId: "a",
      destinationCollectionId: "b",
      items: [{ sourcePath: "/f", destinationPath: "/f" }],
    });
    const sent = JSON.parse(calls[1].init!.body as string);
    expect(sent.verify_checksum).toBe(true);
    // And destructive options stay off unless asked for.
    expect(sent.delete_destination_extra).toBe(false);
  });

  it("refuses an empty item list instead of submitting a no-op task", async () => {
    // Globus accepts an empty DATA array and returns a task that succeeds having
    // moved nothing, which reads to a user as a silent failure.
    const { impl, calls } = fakeFetch([{ body: {} }]);
    await expect(
      transferClient({ transferToken: TOKEN, fetchImpl: impl }).submitTransfer({
        sourceCollectionId: "a",
        destinationCollectionId: "b",
        items: [],
      }),
    ).rejects.toThrow(/moving nothing/);
    // Nothing was sent at all — not even the submission_id fetch.
    expect(calls).toHaveLength(0);
  });

  it("throws rather than returning a task with no id", async () => {
    const { impl } = fakeFetch([{ body: { value: "s" } }, { body: { code: "Accepted" } }]);
    await expect(
      transferClient({ transferToken: TOKEN, fetchImpl: impl }).submitTransfer({
        sourceCollectionId: "a",
        destinationCollectionId: "b",
        items: [{ sourcePath: "/f", destinationPath: "/f" }],
      }),
    ).rejects.toThrow(/no task_id/);
  });

  it("throws when submission_id comes back without a value", async () => {
    const { impl } = fakeFetch([{ body: {} }]);
    await expect(
      transferClient({ transferToken: TOKEN, fetchImpl: impl }).submitTransfer({
        sourceCollectionId: "a",
        destinationCollectionId: "b",
        items: [{ sourcePath: "/f", destinationPath: "/f" }],
      }),
    ).rejects.toThrow(/submission_id response had no value/);
  });
});

describe("getTask / listTasks", () => {
  it("maps a completed task", async () => {
    const { impl } = fakeFetch([
      {
        body: {
          task_id: "t1",
          status: "SUCCEEDED",
          label: "in",
          files_transferred: 12,
          files: 12,
          bytes_transferred: 4096,
          request_time: "2026-07-30T00:00:00+00:00",
          completion_time: "2026-07-30T00:04:00+00:00",
          nice_status: null,
        },
      },
    ]);
    const t = await transferClient({ transferToken: TOKEN, fetchImpl: impl }).getTask("t1");
    expect(t).toMatchObject({
      taskId: "t1",
      status: "SUCCEEDED",
      filesTransferred: 12,
      filesTotal: 12,
      bytesTransferred: 4096,
      completionTime: "2026-07-30T00:04:00+00:00",
    });
    // Explicit nulls become undefined, not the string "null".
    expect(t.niceStatus).toBeUndefined();
  });

  it("carries nice_status so a stuck task says WHY", async () => {
    // "INACTIVE" alone gives the user nothing to act on; the reason is what makes
    // it actionable (credentials expired, collection needs reactivation).
    const { impl } = fakeFetch([
      {
        body: {
          task_id: "t2",
          status: "INACTIVE",
          nice_status: "PERMISSION_DENIED",
          nice_status_short_description: "Permission denied on the destination",
        },
      },
    ]);
    const t = await transferClient({ transferToken: TOKEN, fetchImpl: impl }).getTask("t2");
    expect(t.status).toBe("INACTIVE");
    expect(t.niceStatus).toBe("PERMISSION_DENIED");
    expect(t.niceStatusDescription).toContain("Permission denied");
  });

  it("treats an unrecognised status as ACTIVE, never SUCCEEDED or FAILED", async () => {
    // The direction of the guess matters. Guessing SUCCEEDED would report a
    // transfer complete that never ran; guessing FAILED would invent a failure.
    // ACTIVE only causes more polling, which is recoverable.
    const { impl } = fakeFetch([{ body: { task_id: "t", status: "SOMETHING_NEW" } }]);
    expect((await transferClient({ transferToken: TOKEN, fetchImpl: impl }).getTask("t")).status).toBe(
      "ACTIVE",
    );
  });

  it("url-encodes a task id", async () => {
    const { impl, calls } = fakeFetch([{ body: { task_id: "x", status: "ACTIVE" } }]);
    await transferClient({ transferToken: TOKEN, fetchImpl: impl }).getTask("a/b?c");
    expect(calls[0].url).toContain("/task/a%2Fb%3Fc");
  });

  it("lists tasks with a limit", async () => {
    const { impl, calls } = fakeFetch([{ body: { DATA: [{ task_id: "a", status: "ACTIVE" }] } }]);
    const tasks = await transferClient({ transferToken: TOKEN, fetchImpl: impl }).listTasks({ limit: 5 });
    expect(calls[0].url).toContain("task_list?limit=5");
    expect(tasks.map((t) => t.taskId)).toEqual(["a"]);
  });
});

describe("cancelTask", () => {
  it("reports cancelled only when Globus actually cancelled it", async () => {
    const { impl } = fakeFetch([{ body: { code: "Canceled", message: "The task has been cancelled" } }]);
    expect(await transferClient({ transferToken: TOKEN, fetchImpl: impl }).cancelTask("t")).toEqual({
      cancelled: true,
      message: "The task has been cancelled",
    });
  });

  it("does not claim a cancel for an already-finished task", async () => {
    // Both outcomes are HTTP 200. Reporting "cancelled" for TaskComplete would
    // tell the user they stopped a transfer that in fact already ran to
    // completion — the opposite of what happened.
    const { impl } = fakeFetch([{ body: { code: "TaskComplete", message: "The task completed" } }]);
    const r = await transferClient({ transferToken: TOKEN, fetchImpl: impl }).cancelTask("t");
    expect(r.cancelled).toBe(false);
    expect(r.message).toContain("completed");
  });
});

describe("awaitTask", () => {
  const clock = () => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  };

  it("polls until a terminal state and reports each update", async () => {
    const { impl } = fakeFetch([
      { body: { task_id: "t", status: "ACTIVE", files_transferred: 1 } },
      { body: { task_id: "t", status: "ACTIVE", files_transferred: 5 } },
      { body: { task_id: "t", status: "SUCCEEDED", files_transferred: 9 } },
    ]);
    const onUpdate = vi.fn();
    const c = clock();
    const final = await transferClient({ transferToken: TOKEN, fetchImpl: impl }).awaitTask("t", {
      intervalMs: 1000,
      onUpdate,
      now: c.now,
      sleep: c.sleep,
    });
    expect(final.status).toBe("SUCCEEDED");
    expect(onUpdate).toHaveBeenCalledTimes(3);
    expect(onUpdate.mock.calls.map(([t]) => t.filesTransferred)).toEqual([1, 5, 9]);
  });

  it("returns a FAILED task rather than throwing", async () => {
    // A failed transfer is a result, not an exception: the caller wants the task
    // object with its nice_status to show the user.
    const { impl } = fakeFetch([{ body: { task_id: "t", status: "FAILED", nice_status: "ENDPOINT_ERROR" } }]);
    const c = clock();
    const t = await transferClient({ transferToken: TOKEN, fetchImpl: impl }).awaitTask("t", {
      now: c.now,
      sleep: c.sleep,
    });
    expect(t.status).toBe("FAILED");
    expect(t.niceStatus).toBe("ENDPOINT_ERROR");
  });

  it("keeps polling an INACTIVE task — it is not terminal", async () => {
    const { impl } = fakeFetch([
      { body: { task_id: "t", status: "INACTIVE" } },
      { body: { task_id: "t", status: "SUCCEEDED" } },
    ]);
    const c = clock();
    const t = await transferClient({ transferToken: TOKEN, fetchImpl: impl }).awaitTask("t", {
      intervalMs: 10,
      now: c.now,
      sleep: c.sleep,
    });
    expect(t.status).toBe("SUCCEEDED");
  });

  it("times out with the last observed state, and says the transfer is still running", async () => {
    // Two distinct facts a bare "timed out" loses: WHY it was stuck, and that
    // giving up on watching is not the same as the transfer stopping.
    const { impl } = fakeFetch([
      {
        body: {
          task_id: "t",
          status: "INACTIVE",
          nice_status: "PAUSED_BY_ADMIN",
          nice_status_short_description: "An administrator paused this task",
        },
      },
    ]);
    const c = clock();
    await expect(
      transferClient({ transferToken: TOKEN, fetchImpl: impl }).awaitTask("t", {
        intervalMs: 100,
        timeoutMs: 100,
        now: c.now,
        sleep: c.sleep,
      }),
    ).rejects.toThrow(/PAUSED_BY_ADMIN[\s\S]*still running at Globus/);
  });

  it("uses PollTimeout as the error code so a timeout is distinguishable", async () => {
    const { impl } = fakeFetch([{ body: { task_id: "t", status: "ACTIVE" } }]);
    const c = clock();
    const err = await transferClient({ transferToken: TOKEN, fetchImpl: impl })
      .awaitTask("t", { intervalMs: 5, timeoutMs: 5, now: c.now, sleep: c.sleep })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GlobusTransferError);
    expect(err.code).toBe("PollTimeout");
  });
});

describe("error reporting", () => {
  it("preserves the Globus error code, message and request id", async () => {
    // The code carries more information than the status: NotFound,
    // PermissionDenied and ConsentRequired are all 4xx and all need different
    // handling.
    const { impl } = fakeFetch([
      {
        status: 404,
        body: { code: "ClientError.NotFound", message: "Endpoint not found", request_id: "req-9" },
      },
    ]);
    const err = await transferClient({ transferToken: TOKEN, fetchImpl: impl })
      .getCollection("nope")
      .catch((e) => e);
    expect(err).toBeInstanceOf(GlobusTransferError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("ClientError.NotFound");
    expect(err.message).toBe("Endpoint not found");
    expect(err.requestId).toBe("req-9");
  });

  it("identifies a consent requirement as fixable by re-authenticating", async () => {
    // A collection needing its own data_access consent is fixable with a
    // "Grant access" button; a flat permission denial is not. Both are 403.
    const { impl } = fakeFetch([
      { status: 403, body: { code: "ConsentRequired", message: "Missing required data_access consent" } },
    ]);
    const err = await transferClient({ transferToken: TOKEN, fetchImpl: impl })
      .getCollection("c")
      .catch((e) => e);
    expect(err.needsConsent).toBe(true);
  });

  it("does not mistake a plain permission denial for a consent problem", async () => {
    const { impl } = fakeFetch([{ status: 403, body: { code: "PermissionDenied", message: "nope" } }]);
    const err = await transferClient({ transferToken: TOKEN, fetchImpl: impl })
      .getCollection("c")
      .catch((e) => e);
    expect(err.needsConsent).toBe(false);
  });

  it("still produces a usable error for a non-JSON body", async () => {
    // A proxy's HTML 502 must not surface as a JSON parse error that hides the
    // actual status.
    const { impl } = fakeFetch([{ status: 502, body: "<html>Bad Gateway</html>" }]);
    const err = await transferClient({ transferToken: TOKEN, fetchImpl: impl })
      .listTasks()
      .catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.code).toBe("HTTP502");
    expect(err.message).toContain("Bad Gateway");
  });

  it("treats an unparseable 200 as an error, not as empty data", async () => {
    // The #63 invariant: a broken response must not be indistinguishable from
    // "there is nothing here". An empty task list is a fact; a corrupt body is a
    // failure.
    const { impl } = fakeFetch([{ status: 200, body: "not json at all" }]);
    const err = await transferClient({ transferToken: TOKEN, fetchImpl: impl })
      .listTasks()
      .catch((e) => e);
    expect(err).toBeInstanceOf(GlobusTransferError);
    expect(err.code).toBe("MalformedResponse");
  });
});

describe("isTerminal", () => {
  it("counts only SUCCEEDED and FAILED as terminal", () => {
    expect(isTerminal("SUCCEEDED")).toBe(true);
    expect(isTerminal("FAILED")).toBe(true);
    // INACTIVE looks final but Globus resumes it once credentials are refreshed.
    expect(isTerminal("INACTIVE")).toBe(false);
    expect(isTerminal("ACTIVE")).toBe(false);
  });
});
