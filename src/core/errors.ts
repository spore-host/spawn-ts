// Typed errors for SpawnClient operations (#125).
//
// Every SpawnClient method that talks to the provider rejects with a SpawnError
// that says which operation failed, on which instance, and the AWS error code
// (`UnauthorizedOperation`, `IncorrectInstanceState`, …) when AWS supplied one,
// so a caller can tell "you may not" from "not now" from "AWS is down" without
// parsing a message. The original error stays on `cause`.
//
// A failure must reach the user. The Dashboard used to `void` a rejected
// action, so a denied stop re-enabled the button and showed nothing, and a
// failed DescribeInstances left a list that looked current. A caller that gets
// a SpawnError has the code to choose its own words; `describeSpawnError` gives
// plain words for the ones spawn-ts itself shows.

/** The SpawnClient operations that can fail. */
export type SpawnOperation =
  | "list"
  | "launch"
  | "stop"
  | "start"
  | "hibernate"
  | "terminate"
  | "extend"
  | "signalComplete"
  | "monitor";

/**
 * Codes spawn-ts uses for failures it detects itself, before or instead of an
 * AWS call. Distinguishable from AWS's by `SpawnError.aws === false`.
 */
export type SpawnErrorCode =
  | "InvalidInstanceId"
  | "InstanceNotFound"
  | "AmbiguousName"
  | "NotSimulated"
  | "NoTtl"
  | "InvalidDuration"
  | "LaunchRefused"
  | "NetworkError"
  | "Unknown";

export class SpawnError extends Error {
  override readonly name = "SpawnError";
  /** Which SpawnClient operation failed. */
  readonly operation: SpawnOperation;
  /** The instance it was acting on, when there was one. */
  readonly instanceId?: string;
  /**
   * The AWS error code when AWS returned one (`aws === true`), e.g.
   * `UnauthorizedOperation`; otherwise one of {@link SpawnErrorCode}.
   */
  readonly code: string;
  /** True when `code` came from AWS. */
  readonly aws: boolean;
  /** HTTP status of the AWS response, when there was one. */
  readonly httpStatus?: number;
  /** AWS request id, for support. */
  readonly requestId?: string;
  override readonly cause: unknown;

  constructor(init: {
    operation: SpawnOperation;
    message: string;
    code: string;
    aws: boolean;
    instanceId?: string;
    httpStatus?: number;
    requestId?: string;
    cause?: unknown;
  }) {
    super(init.message);
    this.operation = init.operation;
    this.instanceId = init.instanceId;
    this.code = init.code;
    this.aws = init.aws;
    this.httpStatus = init.httpStatus;
    this.requestId = init.requestId;
    this.cause = init.cause;
  }
}

interface AwsShaped {
  name?: unknown;
  Code?: unknown;
  message?: unknown;
  $fault?: unknown;
  $metadata?: { httpStatusCode?: unknown; requestId?: unknown };
}

/**
 * The AWS error code on an error thrown by an AWS SDK v3 client, or undefined
 * when it isn't one. The SDK sets `name` to the code and adds `$fault` and
 * `$metadata`; an error from a test double or an older shape may carry `Code`.
 */
export function awsErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as AwsShaped;
  if (typeof e.Code === "string" && e.Code) return e.Code;
  const fromSdk = e.$fault !== undefined || e.$metadata !== undefined;
  if (fromSdk && typeof e.name === "string" && e.name && e.name !== "Error") return e.name;
  return undefined;
}

/**
 * spawn-ts's own failures, by the error class or message they're raised with.
 * Order matters: the first match wins.
 */
const LOCAL_CODES: [RegExp, SpawnErrorCode][] = [
  [/needs an instance id/, "InvalidInstanceId"],
  [/^multiple instances found with name/, "AmbiguousName"],
  [/no spawn-managed instance/, "InstanceNotFound"],
  [/is not a simulation/, "NotSimulated"],
  [/has no TTL to extend/, "NoTtl"],
  [/^invalid duration/, "InvalidDuration"],
];

/**
 * Wrap any thrown value as a SpawnError for `operation`. A SpawnError passes
 * through unchanged; the message is otherwise kept as it was, so a caller
 * matching on it still matches.
 */
export function toSpawnError(err: unknown, operation: SpawnOperation, instanceId?: string): SpawnError {
  if (err instanceof SpawnError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const code = awsErrorCode(err);
  const meta = typeof err === "object" && err !== null ? (err as AwsShaped).$metadata : undefined;
  if (code) {
    return new SpawnError({
      operation,
      instanceId,
      message,
      code,
      aws: true,
      httpStatus: typeof meta?.httpStatusCode === "number" ? meta.httpStatusCode : undefined,
      requestId: typeof meta?.requestId === "string" ? meta.requestId : undefined,
      cause: err,
    });
  }
  let local: SpawnErrorCode = "Unknown";
  // fetch() rejects with a TypeError when the network fails, in every browser.
  if (err instanceof TypeError && /fetch|network|load failed/i.test(message)) local = "NetworkError";
  else if (err instanceof Error && err.name === "AmbiguousNameError") local = "AmbiguousName";
  else local = LOCAL_CODES.find(([re]) => re.test(message))?.[1] ?? "Unknown";
  return new SpawnError({ operation, instanceId, message, code: local, aws: false, cause: err });
}

const VERB: Record<SpawnOperation, string> = {
  list: "check your instances",
  launch: "launch",
  stop: "stop this instance",
  start: "start this instance",
  hibernate: "hibernate this instance",
  terminate: "terminate this instance",
  extend: "extend this instance",
  signalComplete: "signal completion",
  monitor: "check your instances",
};

/**
 * One plain sentence for a SpawnError, naming the action, for a UI that has no
 * error catalogue of its own (the Dashboard). The code and AWS's own message
 * are kept on the error for "details"; this sentence never replaces them.
 */
export function describeSpawnError(e: SpawnError): string {
  const verb = VERB[e.operation];
  switch (e.code) {
    case "UnauthorizedOperation":
    case "AccessDenied":
    case "AccessDeniedException":
      return `You don't have permission to ${verb}.`;
    case "IncorrectInstanceState":
      return `Couldn't ${verb}: it isn't in a state that allows it right now, and may already be changing state.`;
    case "UnsupportedOperation":
      return `Couldn't ${verb}: EC2 doesn't support it for this instance.`;
    case "UnsupportedHibernationConfiguration":
      return "This instance wasn't launched with hibernation enabled, so it can't hibernate. Stop it instead.";
    case "InvalidInstanceID.NotFound":
    case "InstanceNotFound":
      return "That instance no longer exists.";
    case "ExpiredToken":
    case "ExpiredTokenException":
    case "RequestExpired":
      return "Your sign-in has expired. Sign in again; your instances are still running.";
    case "RequestLimitExceeded":
    case "Throttling":
    case "ThrottlingException":
      return "AWS is busy. Try again in a few seconds.";
    case "NetworkError":
      return `Couldn't reach AWS to ${verb}. Check your connection.`;
    default:
      return `Couldn't ${verb}: ${e.message.replace(/\.$/, "")}.`;
  }
}
