import { DEFAULT_LANGUAGE, isRunnable } from './languages.js'

/**
 * Turns "which language does each active room have selected" into pool demand,
 * so a language's container only runs while somebody is actually using it.
 *
 * A room counts while at least one client is connected. Its language is read
 * from the shared `meta` map, which every collaborator writes when they change
 * the language picker; unset means the editor default.
 *
 * @param {import('node:events').EventEmitter} roomEvents emits `active` / `inactive` with the room's doc
 * @param {{ addDemand(language: string): void, removeDemand(language: string): void }} pool
 */
export function trackLanguageDemand(roomEvents, pool) {
  /** @type {Map<object, { language: string|null, observer: () => void }>} */
  const tracked = new Map()

  const resolve = (doc) => {
    const language = doc.getMap('meta').get('language')
    if (language === undefined) return DEFAULT_LANGUAGE
    // Markup and data languages (html, yaml…) have no runtime to warm.
    return isRunnable(language) ? language : null
  }

  const onActive = (doc) => {
    if (tracked.has(doc)) return

    const entry = {
      language: resolve(doc),
      observer: () => {
        const next = resolve(doc)
        if (next === entry.language) return
        if (entry.language) pool.removeDemand(entry.language)
        entry.language = next
        if (next) pool.addDemand(next)
      }
    }

    tracked.set(doc, entry)
    doc.getMap('meta').observe(entry.observer)
    if (entry.language) pool.addDemand(entry.language)
  }

  const onInactive = (doc) => {
    const entry = tracked.get(doc)
    if (!entry) return
    tracked.delete(doc)
    doc.getMap('meta').unobserve(entry.observer)
    if (entry.language) pool.removeDemand(entry.language)
  }

  roomEvents.on('active', onActive)
  roomEvents.on('inactive', onInactive)

  return () => {
    roomEvents.off('active', onActive)
    roomEvents.off('inactive', onInactive)
    for (const doc of Array.from(tracked.keys())) onInactive(doc)
  }
}
