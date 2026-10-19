import { afterEach, expect, test, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function load(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  return { fetch, notify: (await import('../src/server/notify.ts')).notify }
}

test('posts to gotify with the app token header', async () => {
  const { fetch, notify } = await load({ GOTIFY_URL: 'https://gotify.example/', GOTIFY_TOKEN: 'abc' })
  await notify('Title', 'Body')
  const [url, init] = fetch.mock.calls[0]!
  expect(url).toBe('https://gotify.example/message')
  expect((init!.headers as Record<string, string>)['x-gotify-key']).toBe('abc')
  expect(JSON.parse(init!.body as string)).toEqual({ title: 'Title', message: 'Body', priority: 5 })
})

test('does nothing remote when unconfigured, and never throws', async () => {
  const { fetch, notify } = await load({ GOTIFY_URL: '', GOTIFY_TOKEN: '' })
  await notify('T', 'B')
  expect(fetch).not.toHaveBeenCalled()

  vi.resetModules()
  const failing = await load({ GOTIFY_URL: 'https://gotify.example', GOTIFY_TOKEN: 'abc' })
  failing.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(failing.notify('T', 'B')).resolves.toBeUndefined()
})
