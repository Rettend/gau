import type { VerificationStore } from '../../src/core'
import { expect, it } from 'vite-plus/test'

export function verificationTests(getStore: () => VerificationStore) {
  it('atomically inserts and updates verification records across concurrent requests', async () => {
    const store = getStore()
    const record = { id: 'challenge', value: 'pending', expiresAt: Date.now() + 600000, version: 0 }
    const inserts = await Promise.all(Array.from({ length: 6 }, () => store.set(record, null)))
    expect(inserts.filter(Boolean)).toHaveLength(1)
    expect(await store.get(record.id)).toEqual(record)
    const updates = await Promise.all(
      Array.from({ length: 6 }, () => store.set({ ...record, value: 'consumed', version: 1 }, 0)),
    )
    expect(updates.filter(Boolean)).toHaveLength(1)
    expect(await store.get(record.id)).toEqual({ ...record, value: 'consumed', version: 1 })
    expect(await store.set({ ...record, value: 'replayed', version: 1 }, 0)).toBe(false)
  })

  it('removes expired records while preserving active challenges', async () => {
    const store = getStore()
    const now = Date.now()
    await store.set({ id: 'expired', value: 'old', expiresAt: now, version: 0 }, null)
    await store.set({ id: 'active', value: 'new', expiresAt: now + 600000, version: 0 }, null)
    await store.deleteExpired(now)
    expect(await store.get('expired')).toBeNull()
    expect(await store.get('active')).not.toBeNull()
  })
}
