// Browser-native Globus Transfer — data movement in and out of a launched
// instance with no local machine and no software to install.
//
// The correction that makes this possible: Globus Transfer is NOT the same thing
// as Globus Connect Personal. The `globus-personal-endpoint` plugin needs
// `globus whoami` on a laptop because it wraps Connect *Personal* specifically.
// The Transfer API, by contrast, moves data between *managed collections* — an
// HPC DTN, an S3 collection, a campus storage endpoint — over plain REST, and
// every endpoint we need is CORS-enabled. Preflighted live from
// Origin: https://spore.host:
//
//   POST /v0.10/endpoint_search   ACAO: *   allow-headers: authorization
//   GET  /v0.10/task_list         ACAO: *   allow-headers: authorization
//   POST /v2/oauth2/token         ACAO: *   allow-headers: *
//
// And we already sign in to Globus (src/auth/globus.ts). Requesting
// TRANSFER_SCOPE yields a Transfer access token from that same sign-in, so this
// adds a capability without adding an auth system.
//
// Pairs with the `mountpoint-s3` plugin for the other direction: S3-as-filesystem
// on the instance is remote-only (pure user-data, see core/plugins.ts). Between
// Transfer and mountpoint-s3, data moves both ways with nothing installed
// locally.
//
// `fetch` is injected throughout, matching `completeLogin`'s convention, so the
// whole client is testable with no credentials and no network.

const TRANSFER_BASE = "https://transfer.api.globus.org/v0.10";

/** Injected HTTP + auth for the Transfer API. */
export interface TransferClientOptions {
  /**
   * A Globus Transfer access token — `GlobusTokens.transferToken`. Required: this
   * client has no way to obtain one, by design, so that the consent decision
   * stays in the auth layer where the user made it.
   */
  transferToken: string;
  /** Injected fetch, for tests. Defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Override the API base (for a test double or a future API version). */
  baseUrl?: string;
}

/**
 * A Globus error carrying the API's own code and message.
 *
 * The `code` matters more than the status: Transfer distinguishes
 * `ClientError.NotFound` from `PermissionDenied` from
 * `ConsentRequired`, and only the last one is fixable by sending the user back
 * through sign-in. A caller that only sees "403" cannot tell "you need to consent"
 * from "you may not touch this collection".
 */
export class GlobusTransferError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = "GlobusTransferError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }

  /**
   * True when the fix is to re-authenticate with additional consent — e.g. a
   * collection requiring its own data_access scope. Distinguishing this from a
   * flat permission denial is the difference between a working "Grant access"
   * button and a dead end.
   */
  get needsConsent(): boolean {
    return this.code === "ConsentRequired" || this.code.endsWith(".ConsentRequired");
  }
}

/** A managed collection (endpoint) as returned by endpoint_search. */
export interface TransferCollection {
  id: string;
  displayName: string;
  /** Owner string, e.g. "ncsa@globusid.org". */
  owner?: string;
  description?: string;
  /**
   * Whether the collection is currently reachable. Globus reports this
   * separately from existence, so a collection can be found and still be down.
   */
  activated?: boolean;
  /**
   * True for a Globus Connect Personal endpoint. Surfaced because GCP endpoints
   * are exactly the case that needs a running local client — a browser can name
   * one and submit a transfer to it, but it will sit queued if the user's laptop
   * is closed. Worth telling the user before they wait.
   */
  isGlobusConnectPersonal?: boolean;
  /** True when the collection needs a per-collection data_access consent. */
  requiresDataAccessConsent?: boolean;
}

/** One file/directory pair in a transfer request. */
export interface TransferItem {
  sourcePath: string;
  destinationPath: string;
  /** Recurse into a directory. Required (by Globus) when the source is a dir. */
  recursive?: boolean;
}

export interface SubmitTransferRequest {
  sourceCollectionId: string;
  destinationCollectionId: string;
  items: TransferItem[];
  /** Human-readable label shown in the Globus web app. */
  label?: string;
  /** Verify each file's checksum after transfer. Globus's default is true. */
  verifyChecksum?: boolean;
  /** Overwrite files that already exist at the destination and differ. */
  syncLevel?: "exists" | "size" | "mtime" | "checksum";
  /** Delete extraneous files at the destination. Off unless asked. */
  deleteDestinationExtra?: boolean;
}

/** Terminal and non-terminal task states, as Globus reports them. */
export type TransferTaskStatus = "ACTIVE" | "INACTIVE" | "SUCCEEDED" | "FAILED";

export interface TransferTask {
  taskId: string;
  status: TransferTaskStatus;
  label?: string;
  /** Files transferred so far / total known. Both can lag early in a task. */
  filesTransferred?: number;
  filesTotal?: number;
  bytesTransferred?: number;
  /** ISO timestamps as Globus returns them. */
  requestTime?: string;
  completionTime?: string;
  /**
   * Why a task is stuck, when it is. `INACTIVE` most often means credentials
   * expired or a collection needs re-activation; Globus puts the reason here and
   * a UI that shows only "INACTIVE" leaves the user with nothing to act on.
   */
  niceStatus?: string;
  niceStatusDescription?: string;
}

/** A Transfer API client over injected `fetch`. */
export interface TransferClient {
  searchCollections(query: string, opts?: { limit?: number }): Promise<TransferCollection[]>;
  getCollection(id: string): Promise<TransferCollection>;
  submitTransfer(req: SubmitTransferRequest): Promise<TransferTask>;
  getTask(taskId: string): Promise<TransferTask>;
  listTasks(opts?: { limit?: number }): Promise<TransferTask[]>;
  cancelTask(taskId: string): Promise<{ cancelled: boolean; message: string }>;
  /**
   * Poll a task until it reaches a terminal state. `onUpdate` fires on every
   * poll, so a UI can show progress without owning the loop.
   */
  awaitTask(taskId: string, opts?: AwaitTaskOptions): Promise<TransferTask>;
}

export interface AwaitTaskOptions {
  /** Poll interval in ms. Default 5s — Transfer tasks are minutes-to-hours. */
  intervalMs?: number;
  /** Give up after this long. 0/undefined = no limit. */
  timeoutMs?: number;
  onUpdate?: (task: TransferTask) => void;
  /** Injected clock + sleep, so tests need no real time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** True for a state Globus will not move off on its own. */
export function isTerminal(status: TransferTaskStatus): boolean {
  return status === "SUCCEEDED" || status === "FAILED";
}

export function transferClient(opts: TransferClientOptions): TransferClient {
  const base = (opts.baseUrl ?? TRANSFER_BASE).replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${opts.transferToken}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });

    // Read the body once, as text, so a non-JSON error page (a proxy's 502, say)
    // still produces a message rather than a JSON parse error that hides the
    // actual status.
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = undefined;
    }

    if (!res.ok) {
      const err = (body ?? {}) as { code?: string; message?: string; request_id?: string };
      throw new GlobusTransferError(
        res.status,
        err.code ?? `HTTP${res.status}`,
        err.message ?? text.slice(0, 200) ?? `Globus Transfer request failed: ${res.status}`,
        err.request_id,
      );
    }
    if (body === undefined) {
      throw new GlobusTransferError(
        res.status,
        "MalformedResponse",
        `Globus Transfer returned a ${res.status} with an unparseable body`,
      );
    }
    return body as T;
  }

  /**
   * Every mutating Transfer submission needs a one-shot submission_id, fetched
   * first and sent with the request. This is Globus's idempotency mechanism: a
   * retried POST carrying the same submission_id is recognised as a duplicate
   * rather than starting a second transfer of the same data. So this extra
   * round-trip is not ceremony — skipping it makes a network retry able to move
   * the data twice.
   */
  async function submissionId(): Promise<string> {
    const r = await call<{ value?: string }>("/submission_id");
    if (!r.value) {
      throw new GlobusTransferError(200, "MalformedResponse", "submission_id response had no value");
    }
    return r.value;
  }

  return {
    async searchCollections(query, o) {
      const params = new URLSearchParams({ filter_fulltext: query });
      if (o?.limit) params.set("limit", String(o.limit));
      const r = await call<{ DATA?: RawCollection[] }>(`/endpoint_search?${params}`);
      return (r.DATA ?? []).map(toCollection);
    },

    async getCollection(id) {
      return toCollection(await call<RawCollection>(`/endpoint/${encodeURIComponent(id)}`));
    },

    async submitTransfer(req) {
      if (req.items.length === 0) {
        // Globus accepts an empty DATA array and returns a task that transfers
        // nothing, which reads to a user as a silent failure. Refuse instead.
        throw new GlobusTransferError(
          0,
          "NoItems",
          "refusing to submit a transfer with no items — it would appear to succeed while moving nothing",
        );
      }
      const raw = await call<RawTask>("/transfer", {
        method: "POST",
        body: JSON.stringify({
          DATA_TYPE: "transfer",
          submission_id: await submissionId(),
          source_endpoint: req.sourceCollectionId,
          destination_endpoint: req.destinationCollectionId,
          label: req.label,
          // Globus defaults verify_checksum to true; keep that default rather
          // than silently trading integrity for speed.
          verify_checksum: req.verifyChecksum ?? true,
          sync_level: req.syncLevel,
          delete_destination_extra: req.deleteDestinationExtra ?? false,
          DATA: req.items.map((i) => ({
            DATA_TYPE: "transfer_item",
            source_path: i.sourcePath,
            destination_path: i.destinationPath,
            recursive: i.recursive ?? false,
          })),
        }),
      });
      // The submit response carries task_id but not a status, so report ACTIVE
      // rather than inventing a field. A caller wanting real state calls getTask.
      return { taskId: requireTaskId(raw), status: "ACTIVE", label: req.label };
    },

    async getTask(taskId) {
      return toTask(await call<RawTask>(`/task/${encodeURIComponent(taskId)}`));
    },

    async listTasks(o) {
      const params = new URLSearchParams();
      if (o?.limit) params.set("limit", String(o.limit));
      const q = params.toString();
      const r = await call<{ DATA?: RawTask[] }>(`/task_list${q ? `?${q}` : ""}`);
      return (r.DATA ?? []).map(toTask);
    },

    async cancelTask(taskId) {
      const r = await call<{ code?: string; message?: string }>(
        `/task/${encodeURIComponent(taskId)}/cancel`,
        { method: "POST" },
      );
      // Globus answers a cancel with code "Canceled" when it took effect and
      // "TaskComplete" when the task had already finished. Both are HTTP 200, so
      // reporting "cancelled" for the second would be a lie.
      return { cancelled: r.code === "Canceled", message: r.message ?? r.code ?? "" };
    },

    async awaitTask(taskId, o = {}) {
      const interval = o.intervalMs ?? 5_000;
      const now = o.now ?? (() => Date.now());
      const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
      const started = now();

      for (;;) {
        const task = await this.getTask(taskId);
        o.onUpdate?.(task);
        if (isTerminal(task.status)) return task;
        if (o.timeoutMs && now() - started >= o.timeoutMs) {
          // Time out with the LAST OBSERVED state in the message, not a bare
          // "timed out". A task stuck INACTIVE with nice_status
          // "PERMISSION_DENIED" is a completely different problem from one that
          // is simply still ACTIVE and slow, and the caller needs to know which.
          throw new GlobusTransferError(
            0,
            "PollTimeout",
            `stopped polling task ${taskId} after ${o.timeoutMs}ms; it is not finished — ` +
              `last observed status ${task.status}` +
              (task.niceStatus ? ` (${task.niceStatus}: ${task.niceStatusDescription ?? ""})` : "") +
              `. The transfer is still running at Globus; this only stopped watching it.`,
          );
        }
        await sleep(interval);
      }
    },
  };
}

// --- wire shapes -----------------------------------------------------------
// Kept private and mapped into camelCase domain types, so Globus's snake_case
// and its DATA/DATA_TYPE envelope conventions don't leak into callers.

interface RawCollection {
  id?: string;
  display_name?: string;
  canonical_name?: string;
  name?: string;
  owner_string?: string;
  description?: string;
  activated?: boolean;
  is_globus_connect?: boolean;
  gcp_connected?: boolean;
  high_assurance?: boolean;
  entity_type?: string;
  [k: string]: unknown;
}

interface RawTask {
  task_id?: string;
  status?: string;
  label?: string;
  files_transferred?: number;
  files?: number;
  bytes_transferred?: number;
  request_time?: string;
  completion_time?: string | null;
  nice_status?: string | null;
  nice_status_short_description?: string | null;
  [k: string]: unknown;
}

function toCollection(r: RawCollection): TransferCollection {
  return {
    id: r.id ?? "",
    // display_name is optional on older endpoints; fall back rather than render
    // an empty row the user cannot identify.
    displayName: r.display_name || r.name || r.canonical_name || r.id || "(unnamed collection)",
    owner: r.owner_string,
    description: r.description,
    activated: r.activated,
    isGlobusConnectPersonal: r.is_globus_connect === true,
    // A "guest"/mapped collection on Globus Connect Server v5 needs its own
    // data_access consent beyond the base transfer scope. Surfaced so a UI can
    // warn before the submit fails with ConsentRequired.
    requiresDataAccessConsent: r.entity_type === "GCSv5_mapped_collection",
  };
}

function requireTaskId(r: RawTask): string {
  if (!r.task_id) {
    throw new GlobusTransferError(200, "MalformedResponse", "transfer submit returned no task_id");
  }
  return r.task_id;
}

function toTask(r: RawTask): TransferTask {
  return {
    taskId: r.task_id ?? "",
    status: normalizeStatus(r.status),
    label: r.label,
    filesTransferred: r.files_transferred,
    filesTotal: r.files,
    bytesTransferred: r.bytes_transferred,
    requestTime: r.request_time,
    completionTime: r.completion_time ?? undefined,
    niceStatus: r.nice_status ?? undefined,
    niceStatusDescription: r.nice_status_short_description ?? undefined,
  };
}

/**
 * Map Globus's status string onto the four states, treating anything unrecognised
 * as ACTIVE.
 *
 * ACTIVE is the safe unknown, and the direction matters: guessing SUCCEEDED on an
 * unknown string would report a transfer complete that never ran, and guessing
 * FAILED would report a failure that never happened. ACTIVE only causes the
 * caller to keep polling, which is recoverable.
 */
function normalizeStatus(s?: string): TransferTaskStatus {
  switch (s) {
    case "SUCCEEDED":
    case "FAILED":
    case "INACTIVE":
    case "ACTIVE":
      return s;
    default:
      return "ACTIVE";
  }
}
