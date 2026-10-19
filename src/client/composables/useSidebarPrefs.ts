// Stand-in for BookOrbit's account-synced prefs: per-browser only, and storage may be unavailable.
export function useSidebarPrefs() {
  const key = (suffix: string) => `mangarr:sidebar:${suffix}`
  function readDeviceValue<T>(suffix: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key(suffix))
      return raw === null ? fallback : (JSON.parse(raw) as T)
    } catch {
      return fallback
    }
  }
  function writeDeviceValue<T>(suffix: string, value: T): void {
    try {
      localStorage.setItem(key(suffix), JSON.stringify(value))
    } catch {}
  }
  return { readDeviceValue, writeDeviceValue }
}
