import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from 'jose'
import { handleAction, type Env } from '../functions/lib/handler'

const env: Env = {
  EXPENSE_API_URL: 'https://script.example/exec',
  EXPENSE_API_SECRET: 'test-secret',
  CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
  CF_ACCESS_AUD: 'aud-tag',
}
const NOW = 1_700_000_000
const KEY = '3b241101-e2bb-4255-8caf-4136c566a962'
const EMAIL = 'azhe@example.com'
const transaction = {
  date: '2026-08-09',
  amount: 300,
  payer: '小語',
  split: '這筆平分',
  category: '餐飲',
  payee: '全聯',
} as const

let jwks: JWTVerifyGetKey
let cookie: string

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  const jwk = await exportJWK(pair.publicKey)
  jwks = createLocalJWKSet({
    keys: [{ ...jwk, alg: 'RS256', kid: 'k1' }],
  })
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setAudience(env.CF_ACCESS_AUD)
    .setExpirationTime(NOW + 86_400)
    .setIssuedAt(NOW)
    .sign(pair.privateKey as CryptoKey)
  cookie = `CF_Authorization=${token}`
})

function req(
  body: unknown,
  authCookie: string | null = cookie,
  email: string | null = EMAIL,
): Request {
  return new Request('https://pwa.example/api/x', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authCookie === null ? {} : { cookie: authCookie }),
      ...(email === null ? {} : { 'Cf-Access-Authenticated-User-Email': email }),
    },
    body: JSON.stringify(body),
  })
}

function deps(fetchFn: typeof fetch) {
  return { jwks, fetchFn, now: () => NOW }
}

function noFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('must not fetch')
  }) as unknown as typeof fetch
}

function decodePayload(encoded: string): unknown {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(encoded.length / 4) * 4, '=')
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

describe('handleAction', () => {
  it.each([
    ['missing', null],
    ['invalid', 'CF_Authorization=not-a-jwt'],
  ])('returns 401 for a %s Access cookie without contacting Apps Script', async (_label, authCookie) => {
    const fetchFn = noFetch()

    const response = await handleAction(
      'create_transaction',
      req({ idempotencyKey: KEY, transaction }, authCookie),
      env,
      deps(fetchFn),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ ok: false, error: 'unauthorized' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns 403 for a retired action outside the allowlist', async () => {
    const fetchFn = noFetch()

    const response = await handleAction(
      'list_receivables',
      req({}),
      env,
      deps(fetchFn),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ ok: false, error: 'forbidden action' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns auth-check expiry without contacting Apps Script', async () => {
    const fetchFn = noFetch()

    const response = await handleAction(
      'auth-check',
      req({}),
      env,
      deps(fetchFn),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, exp: NOW + 86_400 })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns a structural 400 for an invalid amount without contacting Apps Script', async () => {
    const fetchFn = noFetch()

    const response = await handleAction(
      'create_transaction',
      req({
        idempotencyKey: KEY,
        transaction: { ...transaction, amount: 0 },
      }),
      env,
      deps(fetchFn),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, error: 'invalid amount' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns a structural 400 for an invalid split without contacting Apps Script', async () => {
    const fetchFn = noFetch()

    const response = await handleAction(
      'create_transaction',
      req({
        idempotencyKey: KEY,
        transaction: { ...transaction, split: '三七分' },
      }),
      env,
      deps(fetchFn),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, error: 'invalid split' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('uses the client idempotency key as nonce and sends the exact create payload', async () => {
    const upstreamBody = '{"ok":true,"txn_id":"txn-1","row":42}'
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body)) as {
        nonce: string
        payload: string
      }

      expect(url).toBe(env.EXPENSE_API_URL)
      expect(init?.method).toBe('POST')
      expect(init?.headers).toEqual({ 'content-type': 'application/json' })
      expect(envelope.nonce).toBe(KEY)
      expect(decodePayload(envelope.payload)).toEqual({
        action: 'create_transaction',
        idempotencyKey: KEY,
        userEmail: EMAIL,
        transaction,
      })
      return new Response(upstreamBody, { status: 201 })
    }) as unknown as typeof fetch

    const response = await handleAction(
      'create_transaction',
      req({ idempotencyKey: KEY, transaction }),
      env,
      deps(fetchFn),
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(201)
    expect(await response.text()).toBe(upstreamBody)
  })

  it('stamps the Access email and drops spoofed body email fields', async () => {
    const upstreamBody = '{"ok":true}'
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body)) as { payload: string }

      expect(decodePayload(envelope.payload)).toEqual({
        action: 'create_transaction',
        idempotencyKey: KEY,
        userEmail: EMAIL,
        transaction,
      })
      return new Response(upstreamBody, { status: 200 })
    }) as unknown as typeof fetch

    const response = await handleAction(
      'create_transaction',
      req({
        idempotencyKey: KEY,
        userEmail: 'spoof@example.com',
        transaction: { ...transaction, userEmail: 'spoof@example.com' },
      }),
      env,
      deps(fetchFn),
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(200)
  })

  it('forwards a GAS error body and status byte-for-byte without rewrapping', async () => {
    const gasErrorBody = '{"ok":false,"error":"unknown or disabled category: 餐飲"}'
    const fetchFn = vi.fn(async () =>
      new Response(gasErrorBody, { status: 200 }),
    ) as unknown as typeof fetch

    const response = await handleAction(
      'create_transaction',
      req({ idempotencyKey: KEY, transaction }),
      env,
      deps(fetchFn),
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(gasErrorBody)
  })

  it('uses a random nonce for health and forwards the upstream response', async () => {
    const upstreamBody = '{"ok":true,"now":"2026-07-26T12:00:00.000Z"}'
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body)) as {
        nonce: string
        payload: string
      }

      expect(envelope.nonce).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )
      expect(envelope.nonce).not.toBe(KEY)
      expect(decodePayload(envelope.payload)).toEqual({ action: 'health' })
      return new Response(upstreamBody, { status: 207 })
    }) as unknown as typeof fetch

    const response = await handleAction(
      'health',
      req({}),
      env,
      deps(fetchFn),
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(207)
    expect(await response.text()).toBe(upstreamBody)
  })

  it('allows health without the Access email header', async () => {
    const upstreamBody = '{"ok":true}'
    const fetchFn = vi.fn(async () =>
      new Response(upstreamBody, { status: 200 }),
    ) as unknown as typeof fetch

    const response = await handleAction(
      'health',
      req({}, cookie, null),
      env,
      deps(fetchFn),
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(upstreamBody)
  })

  it('uses a random nonce for list_transactions and forwards the upstream response verbatim', async () => {
    const upstreamBody = '[{"txn_id":"","日期":"2026-07-27","金額":"000260.00"}]'
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body)) as {
        nonce: string
        payload: string
      }

      expect(envelope.nonce).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )
      expect(envelope.nonce).not.toBe(KEY)
      expect(decodePayload(envelope.payload)).toEqual({
        action: 'list_transactions',
        date_from: '2026-07-01',
        date_to: '2026-07-31',
      })
      return new Response(upstreamBody, { status: 206 })
    }) as unknown as typeof fetch

    const response = await handleAction(
      'list_transactions',
      req({ date_from: '2026-07-01', date_to: '2026-07-31' }),
      env,
      deps(fetchFn),
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(206)
    expect(await response.text()).toBe(upstreamBody)
  })

  it('uses the client idempotency key as settle nonce and sends the stamped settlement contract', async () => {
    const upstreamBody = '{"ok":true,"txn_id":"settle-1","row":42}'
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body)) as {
        nonce: string
        payload: string
      }

      expect(envelope.nonce).toBe(KEY)
      expect(decodePayload(envelope.payload)).toEqual({
        action: 'settle',
        idempotencyKey: KEY,
        userEmail: EMAIL,
        date: '2026-08-09',
        amount: 125.5,
        payer: '阿哲',
      })
      return new Response(upstreamBody, { status: 201 })
    }) as unknown as typeof fetch

    const response = await handleAction(
      'settle',
      req({
        idempotencyKey: KEY,
        date: '2026-08-09',
        amount: 125.5,
        payer: '阿哲',
      }),
      env,
      deps(fetchFn),
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(201)
    expect(await response.text()).toBe(upstreamBody)
  })

  it.each([
    ['blank payer', { idempotencyKey: KEY, date: '2026-08-09', amount: 125.5, payer: ' ' }, 'invalid payer'],
    ['missing amount', { idempotencyKey: KEY, date: '2026-08-09', payer: '阿哲' }, 'invalid amount'],
    ['impossible date', { idempotencyKey: KEY, date: '2026-02-30', amount: 125.5, payer: '阿哲' }, 'invalid date'],
    ['non-UUID idempotencyKey', { idempotencyKey: 'not-a-uuid', date: '2026-08-09', amount: 125.5, payer: '阿哲' }, 'invalid idempotency key'],
  ])('rejects settle with %s before contacting Apps Script', async (_label, body, error) => {
    const fetchFn = noFetch()

    const response = await handleAction(
      'settle',
      req(body),
      env,
      deps(fetchFn),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, error })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('uses the client idempotency key as reverse_transaction nonce and sends the stamped reversal contract', async () => {
    const upstreamBody = '{"ok":true,"txn_id":"reverse-1","row":42}'
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body)) as {
        nonce: string
        payload: string
      }

      expect(envelope.nonce).toBe(KEY)
      expect(decodePayload(envelope.payload)).toEqual({
        action: 'reverse_transaction',
        idempotencyKey: KEY,
        userEmail: EMAIL,
        txn_id: 'original-1',
        date: '2026-08-09',
      })
      return new Response(upstreamBody, { status: 201 })
    }) as unknown as typeof fetch

    const response = await handleAction(
      'reverse_transaction',
      req({
        idempotencyKey: KEY,
        txn_id: 'original-1',
        date: '2026-08-09',
      }),
      env,
      deps(fetchFn),
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(201)
    expect(await response.text()).toBe(upstreamBody)
  })

  it.each([
    ['blank txn_id', { idempotencyKey: KEY, txn_id: ' ', date: '2026-08-09' }, 'invalid txn_id'],
    ['impossible date', { idempotencyKey: KEY, txn_id: 'original-1', date: '2026-02-30' }, 'invalid date'],
    ['non-UUID idempotencyKey', { idempotencyKey: 'not-a-uuid', txn_id: 'original-1', date: '2026-08-09' }, 'invalid idempotency key'],
  ])('rejects reverse_transaction with %s before contacting Apps Script', async (_label, body, error) => {
    const fetchFn = noFetch()

    const response = await handleAction(
      'reverse_transaction',
      req(body),
      env,
      deps(fetchFn),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, error })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed date_from', { date_from: '2026/07/01', date_to: '2026-07-31' }, 'invalid date_from'],
    ['impossible date_to', { date_from: '2026-07-01', date_to: '2026-02-30' }, 'invalid date_to'],
  ])('rejects %s with 400 without contacting Apps Script', async (_label, body, error) => {
    const fetchFn = noFetch()

    const response = await handleAction(
      'list_transactions',
      req(body),
      env,
      deps(fetchFn),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, error })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects date_from later than date_to with a distinct 400 error', async () => {
    const fetchFn = noFetch()

    const response = await handleAction(
      'list_transactions',
      req({ date_from: '2026-08-01', date_to: '2026-07-31' }),
      env,
      deps(fetchFn),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      ok: false,
      error: 'date_from later than date_to',
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('uses a random nonce for get_options and forwards the upstream response verbatim', async () => {
    const upstreamBody = '{"schema_version":"abcdef012345","accounts":[]}'
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body)) as {
        nonce: string
        payload: string
      }

      expect(envelope.nonce).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )
      expect(envelope.nonce).not.toBe(KEY)
      expect(decodePayload(envelope.payload)).toEqual({ action: 'get_options' })
      return new Response(upstreamBody, { status: 203 })
    }) as unknown as typeof fetch

    const response = await handleAction(
      'get_options',
      req({}),
      env,
      deps(fetchFn),
    )

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(203)
    expect(await response.text()).toBe(upstreamBody)
  })

  it.each(['create_transaction', 'settle', 'reverse_transaction'] as const)(
    'returns 401 for %s without an Access email header and without contacting Apps Script',
    async action => {
      const validBodyForAction = action === 'create_transaction'
        ? { idempotencyKey: KEY, transaction }
        : action === 'settle'
          ? {
            idempotencyKey: KEY,
            date: '2026-08-09',
            amount: 125.5,
            payer: '阿哲',
          }
          : {
            idempotencyKey: KEY,
            txn_id: 'original-1',
            date: '2026-08-09',
          }
      const fetchFn = noFetch()

      const response = await handleAction(
        action,
        req(validBodyForAction, cookie, null),
        env,
        deps(fetchFn),
      )

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ ok: false, error: 'unauthorized' })
      expect(fetchFn).not.toHaveBeenCalled()
    },
  )
})
