import type { PipelinePolicy, PipelineRequest, PipelineResponse, SendRequest } from '@azure/core-rest-pipeline';
import type { TokenCredential } from '@azure/identity';
import type { CredentialEvidence, FailureObservation } from './interface';

/**
 * Why this file exists.
 *
 * The provider does not report why a load failed, and it does not merely obscure the reason — it
 * discards it. `#executeWithFailoverPolicy` catches a failoverable error (401, 403, 408, 429, 5xx,
 * ENOTFOUND, ENOENT, ECONNREFUSED, ECONNRESET, ETIMEDOUT), `continue`s to the next client, and on
 * running out throws `new Error("All fallback clients failed to get configuration settings.")` —
 * constructed fresh, with no `cause` and no `errors`. `load()` then wraps whatever escaped in
 * `new Error("The load operation failed.", { cause })`. So the chain that reaches a caller is two
 * or three opaque sentences, and the `RestError` carrying the 403 was dropped on the floor.
 *
 * Unwrapping that chain therefore cannot work, for the one class of failure the unwrapping was
 * written for. Only errors the provider considers non-failoverable — a 404, a 400 — arrive with
 * their cause intact.
 *
 * What the provider does support is `clientOptions`, which it merges into every
 * `AppConfigurationClient` it constructs. A pipeline policy positioned `perRetry` sits below the
 * SDK's own retry policy and sees every attempt: the raw response, before the generated client
 * turns a status into an error, and any transport error the sender throws. So the status the
 * provider throws away is observed on the way past, at the cost of no extra request.
 *
 * The alternative was a second, direct `getConfigurationSetting` call after a failure to find out
 * what the first one hit. That spends another request against a store whose Free SKU allows 1,000
 * a day — the very budget invariant 2 exists to protect — and it reports the outcome of a
 * different request, which need not be the one that failed.
 */

const MAX_BODY_CHARACTERS = 300;

export interface Diagnostics {
  /** Give this to the provider as `clientOptions.additionalPolicies`. */
  readonly policy: PipelinePolicy;
  /** Every distinct failure seen on the wire during this attempt, in the order they happened. */
  observations(): FailureObservation[];
}

export function createDiagnostics(): Diagnostics {
  const observed: FailureObservation[] = [];

  const record = (observation: FailureObservation): void => {
    const already = observed.some(
      seen =>
        seen.status === observation.status &&
        seen.code === observation.code &&
        seen.message === observation.message
    );
    if (!already) observed.push(observation);
  };

  const policy: PipelinePolicy = {
    name: 'actvalue-azure-app-config-diagnostics',
    async sendRequest(request: PipelineRequest, next: SendRequest): Promise<PipelineResponse> {
      try {
        const response = await next(request);
        // A 4xx or 5xx is a response, not a throw: the generated client turns it into a RestError
        // above the pipeline, and the provider then discards that RestError. This is the only
        // place the status is visible to us.
        if (response.status >= 400) record(fromResponse(response));
        return response;
      } catch (error) {
        // A transport failure — DNS, refused connection, the startup timeout's abort.
        record(fromTransportError(error));
        throw error;
      }
    },
  };

  return { policy, observations: () => observed.slice() };
}

/** Render observations as the `detail` of a {@link ConfigLoadError}. */
export function describeObservations(observations: FailureObservation[]): string {
  return observations.map(describeObservation).join('; ');
}

function describeObservation(observation: FailureObservation): string {
  const qualifiers: string[] = [];
  if (observation.status !== undefined) qualifiers.push(`HTTP ${observation.status}`);
  if (observation.code !== undefined && observation.code !== '') qualifiers.push(observation.code);
  return qualifiers.length ? `${observation.message} [${qualifiers.join(' ')}]` : observation.message;
}

function fromResponse(response: PipelineResponse): FailureObservation {
  return {
    status: response.status,
    message: reasonFromBody(response.bodyAsText) ?? defaultReason(response.status),
  };
}

/**
 * App Configuration answers an error with RFC 7807 problem+json — `type`, `title`, `detail`,
 * `status`. `title` is the sentence worth reporting. Anything unparseable is truncated rather
 * than guessed at, and an error body carries no configuration values, only the reason one was
 * refused.
 */
function reasonFromBody(body: string | null | undefined): string | undefined {
  if (typeof body !== 'string' || body.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const problem = parsed as { title?: unknown; detail?: unknown; message?: unknown };
      for (const field of [problem.title, problem.detail, problem.message]) {
        if (typeof field === 'string' && field.trim() !== '') return truncate(field.trim());
      }
    }
  } catch {
    // Not JSON. Fall through to the raw text.
  }
  return truncate(body.trim());
}

function defaultReason(status: number): string {
  switch (status) {
    case 401:
      return 'The store rejected the credential';
    case 403:
      return 'The credential is not authorised to read this store';
    case 404:
      return 'The store or key was not found';
    case 429:
      return 'The store is throttling: the request quota is spent';
    default:
      return status >= 500 ? 'The store reported a server error' : 'The store refused the request';
  }
}

function fromTransportError(error: unknown): FailureObservation {
  if (error instanceof Error) {
    const details = error as Error & { code?: unknown; statusCode?: unknown };
    return {
      status: typeof details.statusCode === 'number' ? details.statusCode : undefined,
      code: typeof details.code === 'string' ? details.code : undefined,
      message: error.message,
    };
  }
  return { message: String(error) };
}

function truncate(text: string): string {
  return text.length > MAX_BODY_CHARACTERS ? `${text.slice(0, MAX_BODY_CHARACTERS)}…` : text;
}


/**
 * The other half of observing on the way past.
 *
 * When a load fails having made no observable request, the provider's chain is the same whether
 * the credential never answered or the policy never ran — it is
 * `The load operation failed.` wrapping `The load operation timed out.` in both cases. (The
 * `All fallback clients failed` message never reaches the caller from the startup path at all:
 * it is a plain `Error`, so `#initializeWithRetryPolicy` finds it neither an input error nor a
 * REST error, and retries it with backoff until the abort — at which point the timeout has
 * already won the race. It only ever reaches `console.warn`.)
 *
 * So the difference cannot be read out of the error. It can be read here: wrap the credential
 * and record whether a token was asked for, and whether it arrived. A token that arrived followed
 * by no observed request is the provider having stopped honouring `clientOptions`; a token that
 * never arrived is the credential.
 */
export interface CredentialWatch {
  /** Hand this to the provider in place of the real credential. It delegates unchanged. */
  readonly credential: TokenCredential;
  evidence(): CredentialEvidence;
}

export function watchCredential(inner: TokenCredential): CredentialWatch {
  let requested = false;
  let resolved = false;

  const credential: TokenCredential = {
    getToken: async (scopes, options) => {
      requested = true;
      const token = await inner.getToken(scopes, options);
      resolved = true;
      return token;
    },
  };

  return { credential, evidence: () => ({ requested, resolved }) };
}
