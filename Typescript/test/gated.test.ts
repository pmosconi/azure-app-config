/**
 * `gated(options, handler)` — the fail-fast HTTP gate, as part of registering the handler.
 *
 * Two fail-fast consumers each pasted the same gate at the top of every handler that reads a
 * hydrated value: await `hydrate()`, answer 503 with `Retry-After` when it rejects, never let a
 * configuration failure or a failure in the 503 path become a 500. A new handler that forgot the
 * gate read undefined values. The wrapper must return the handler's own result on success, pass
 * the handler's own errors through untouched, never reject because of configuration, and log
 * nothing itself — `hydrate()` logs the failed attempt, once.
 *
 * The response type is structural, so the package takes no dependency on `@azure/functions`. The
 * type-level block at the end proves it still fits `app.http()`; `@azure/functions` is a
 * devDependency, used for its types only.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { load } from '@azure/app-configuration-provider';
import type { app, HttpHandler, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import {
  ConfigFloorError,
  gated,
  hydrate,
  resetHydration,
  type ConfigUnavailableResponse,
} from '../src/index';
import { KEYS, VALUES, fakeStore, providerFailoverError, restoreEnv, snapshotEnv } from './helpers';

vi.mock('@azure/app-configuration-provider', () => ({ load: vi.fn() }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {
    getToken() {
      return Promise.resolve(null);
    }
  },
}));

const loadMock = vi.mocked(load);
let env: NodeJS.ProcessEnv;

function logger() {
  return { log: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
  env = snapshotEnv();
  resetHydration();
  loadMock.mockReset();
  process.env.APP_CONFIG_ENDPOINT = 'https://example.invalid';
  process.env.APP_CONFIG_LABEL = 'prod';
  delete process.env.WEBSITE_INSTANCE_ID;
  for (const variable of Object.values(KEYS)) delete process.env[variable];
});

afterEach(() => {
  vi.useRealTimers();
  restoreEnv(env);
});

describe('gated, once configuration is loaded', () => {
  it('calls the handler with the original arguments and returns its result', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);
    const handler = vi.fn(async (request: { url: string }, context: { id: number }) => ({
      status: 200,
      body: `${request.url} ${context.id} ${process.env.HTTP_PORT}`,
    }));
    const request = { url: '/orders' };
    const context = { id: 7 };

    const response = await gated({ keys: KEYS, logger: logger() }, handler)(request, context);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toBe(request);
    expect(handler.mock.calls[0]![1]).toBe(context);
    expect(response).toEqual({ status: 200, body: '/orders 7 8080' });
  });

  it('runs the handler only after the environment is written', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);
    let seen: string | undefined;

    await gated({ keys: KEYS, logger: logger() }, () => {
      seen = process.env.MONGO_URL;
      return 'done';
    })();

    expect(seen).toBe(VALUES['shared:mongoUrl']);
  });

  it('lets the handler’s own error through untouched — not gated’s business', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);
    const own = new Error('handler bug');

    await expect(gated({ keys: KEYS, logger: logger() }, async () => Promise.reject(own))()).rejects.toBe(own);
    await expect(
      gated({ keys: KEYS, logger: logger() }, () => {
        throw own;
      })()
    ).rejects.toBe(own);
  });

  it('hydrates once for every call through it', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);
    const handler = gated({ keys: KEYS, logger: logger() }, () => 'ok');

    await Promise.all([handler(), handler(), handler()]);
    await handler();

    expect(loadMock).toHaveBeenCalledTimes(1);
  });
});

describe('gated, when configuration is not loaded', () => {
  it('answers 503 with Retry-After in whole seconds after a fresh failure, and skips the handler', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());
    const handler = vi.fn();

    const response = await gated({ keys: KEYS, retryFloorMs: 30_000, logger: logger() }, handler)();

    // 30 s plus the margin, rounded up: 31, never 30, so a client waiting it out clears the floor.
    expect(response).toEqual({ status: 503, body: 'Service Unavailable', headers: { 'Retry-After': '31' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 503 with the floor’s own wait inside the floor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());
    const options = { keys: KEYS, retryFloorMs: 30_000, logger: logger() };
    await hydrate(options).catch(() => undefined);
    vi.advanceTimersByTime(20_500);

    const response = await gated(options, vi.fn())();

    expect(response).toEqual({ status: 503, body: 'Service Unavailable', headers: { 'Retry-After': '10' } });
  });

  it('never sends a Retry-After of 0 — at least one second', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());
    const options = { keys: KEYS, retryFloorMs: 30_000, logger: logger() };
    await hydrate(options).catch(() => undefined);
    vi.advanceTimersByTime(29_999);

    const response = (await gated(options, vi.fn())()) as ConfigUnavailableResponse;

    expect(response.headers).toEqual({ 'Retry-After': '1' });
  });

  it('sends no Retry-After for an input error — waiting won’t fix it', async () => {
    delete process.env.APP_CONFIG_LABEL;

    const response = await gated({ keys: KEYS, logger: logger() }, vi.fn())();

    expect(response).toEqual({ status: 503, body: 'Service Unavailable' });
    expect(response).not.toHaveProperty('headers');
  });

  it('sends no Retry-After when the floor is already open', async () => {
    loadMock.mockRejectedValue(providerFailoverError());

    const response = await gated({ keys: KEYS, retryFloorMs: 0, logger: logger() }, vi.fn())();

    expect(response).toEqual({ status: 503, body: 'Service Unavailable' });
  });

  it('logs nothing itself: the attempt’s one line, and none for floor rejections', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());
    const log = logger();
    const handler = gated({ keys: KEYS, retryFloorMs: 30_000, logger: log }, vi.fn());

    await Promise.all([handler(), handler(), handler()]);
    await handler();
    await handler();

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![0]).toMatch(/^Configuration load failed: /);
    expect(log.log).not.toHaveBeenCalled();
  });

  it('answers 503 for undefined options rather than rejecting', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn();
    try {
      const response = await gated(undefined as never, handler)();

      expect(response).toEqual({ status: 503, body: 'Service Unavailable' });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('never rejects because of configuration, even when the logger throws', async () => {
    loadMock.mockRejectedValue(providerFailoverError());
    const throwing = {
      log: () => {
        throw new Error('logger down');
      },
    };

    const response = await gated({ keys: KEYS, logger: throwing }, vi.fn())();

    expect(response).toMatchObject({ status: 503, body: 'Service Unavailable' });
  });

  it('sends no Retry-After it cannot state in whole seconds, and still answers 503', async () => {
    // A floor this large is allowed, but its wait prints in exponent notation, which no client
    // reads as a delay. Nothing in the 503 path may throw either way.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());
    const options = { keys: KEYS, retryFloorMs: Number.MAX_VALUE, logger: logger() };
    await hydrate(options).catch(() => undefined);

    const response = await gated(options, vi.fn())();

    expect(response).toEqual({ status: 503, body: 'Service Unavailable' });
  });

  it('keeps the wait a ConfigFloorError reports, rounded up to the second', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());
    const options = { keys: KEYS, retryFloorMs: 30_000, logger: logger() };
    await hydrate(options).catch(() => undefined);
    vi.advanceTimersByTime(1_000);
    const floor = (await hydrate(options).catch((e: unknown) => e)) as ConfigFloorError;

    const response = (await gated(options, vi.fn())()) as ConfigUnavailableResponse;

    expect(response.headers!['Retry-After']).toBe(String(Math.ceil(floor.retryAfterMs / 1000)));
  });
});

/*
 * ---------------------------------------------------------------------------------------------
 * Compile-time: a gated handler registers with app.http() as it is. `tsc --noEmit` (npm run
 * typecheck) checks this block; at run time it is never called. `@azure/functions` is imported
 * for its types only, so the package itself depends on it neither at run time nor in its .d.ts.
 * ---------------------------------------------------------------------------------------------
 */
type HttpOptions = Parameters<typeof app.http>[1];
// Building a gated handler starts nothing; only calling it hydrates, and nothing here calls these.
const CONFIG = { keys: KEYS };

// The 503 fits the Functions response type.
const asResponse: HttpResponseInit = {} as ConfigUnavailableResponse;
void asResponse;

// The shape the README shows: parameters inferred from app.http's handler type, not annotated.
export const inferred: HttpOptions = {
  handler: gated(CONFIG, async (request, context) => {
    const url: string = request.url;
    context.log(url);
    return { status: 200, jsonBody: { url } };
  }),
};

// An annotated handler, a handler returning an HttpResponseInit, and one using no arguments.
export const annotated: HttpHandler = gated(
  CONFIG,
  async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    context.log(request.method);
    return { body: 'ok' };
  }
);
export const noArguments: HttpHandler = gated(CONFIG, () => ({ status: 204 }));

it('has the type-level checks above, which tsc runs', () => {
  expect(typeof inferred.handler).toBe('function');
});
