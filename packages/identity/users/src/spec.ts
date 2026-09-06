/**
 * The users domain declaration: the record schema and the `defineDomain` spec
 * the registry opens. The zod schema validates the shipped format at the
 * durability boundary.
 * @module @deepseek-ai/dsh-identity-users/src/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { UserId } from './types.ts'

/** User id schema at the durable boundary; branding has no runtime representation. */
const userId = z.string().transform(value => brandString<UserId>(value))

/**
 * Durable shape of one user record, keyed on the lowercased username.
 * `username` keeps its original casing; `passwordHash` is
 * base64(salt || scrypt-hash); timestamps are ISO-8601 strings.
 */
export const userRecord = z.object({
  id: userId,
  username: z.string(),
  displayName: z.string(),
  passwordHash: z.string(),
  isOwner: z.boolean(),
  createdAt: z.string(),
})

/** One stored user record, inferred from {@link userRecord}. */
export type UserRecord = z.infer<typeof userRecord>

/**
 * The users domain spec: one `users` table keyed by the lowercased username.
 * The registry opens this through `ctx.storage.domain`; the spec object is the
 * single source of the domain's identity, version, and schema.
 */
export const usersDomainSpec = defineDomain({
  name: 'users',
  version: 1,
  tables: { users: domainTable<string, UserRecord>(userRecord) },
})
