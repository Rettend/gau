/** Shared storage for expiring challenges and rate limits. Times are Unix milliseconds. */
export interface VerificationRecord {
  id: string
  value: string
  expiresAt: number
  version: number
}

export interface VerificationStore {
  get: (id: string) => Promise<VerificationRecord | null>
  /** Atomic compare-and-set. null means insert only; otherwise match the existing version. */
  set: (record: VerificationRecord, expectedVersion: number | null) => Promise<boolean>
  deleteExpired: (now: number) => Promise<void>
}
