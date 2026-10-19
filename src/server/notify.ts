const url = process.env.GOTIFY_URL?.replace(/\/+$/, '')
const token = process.env.GOTIFY_TOKEN

export type Notify = (title: string, message: string) => Promise<void>

// Best effort: a notification that can't be delivered must never fail the job that triggered it.
export const notify: Notify = async (title, message) => {
  console.log(`[notify] ${title}: ${message}`)
  if (!url || !token) return
  try {
    const res = await fetch(`${url}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gotify-key': token },
      body: JSON.stringify({ title, message, priority: 5 }),
    })
    if (!res.ok) console.error(`[notify] gotify ${res.status}: ${await res.text()}`)
  } catch (e) {
    console.error(`[notify] gotify unreachable: ${(e as Error).message}`)
  }
}
