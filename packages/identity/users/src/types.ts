/**
 * Public user identity types for the durable user registry (`ctx.users`).
 * @module @deepseek-ai/dsh-identity-users/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * A stable user id (branded UUID v4). The brand keeps a user id from being
 * passed where a workspace or session id is expected; comparison and
 * serialization retain the underlying string behavior.
 */
export type UserId = Branded<'UserId'>

/**
 * One registered user, projected for public consumers. `passwordHash` stays
 * inside the durable record so a `list()` reader never holds a verifiable
 * credential; `username` keeps its original casing while uniqueness is
 * case-insensitive.
 */
export interface User {
  /** Stable branded id. */
  readonly id: UserId
  /** Username in the casing the user supplied. */
  readonly username: string
  /** Display name; defaults to the username when the creator omits one. */
  readonly displayName: string
  /** Exactly one user holds this bit; the first user created sets it. */
  readonly isOwner: boolean
  /** ISO-8601 creation instant. */
  readonly createdAt: string
}
