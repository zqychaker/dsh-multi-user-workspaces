/**
 * Durable user registry (`ctx.users`): the identity foundation for a
 * multi-user deployment. One record per case-insensitive username, scrypt
 * hashed credentials, and a single owner bit set on the first user created.
 * @module @deepseek-ai/dsh-identity-users
 */

import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import type { ScryptOptions } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { usersDomainSpec } from './spec.ts'
import type { UserRecord } from './spec.ts'
import type { User, UserId } from './types.ts'

export type { User, UserId } from './types.ts'
export { userRecord, usersDomainSpec } from './spec.ts'
export type { UserRecord } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    users: UsersService
  }
}

/** Canonical username: an alphanumeric start, then alnum/. _ -, 1-32 total; matched case-insensitively. */
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/
/** Minimum password length; a protocol constant, not config. */
const MIN_PASSWORD_LENGTH = 8
/** scrypt parameters: fixed protocol constants, not config. */
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 32
// Comfortably above the 128 * N * r scratch the params require (16 MiB), so a
// worker with the 32 MiB default cannot also trip the limit.
const SCRYPT_MAXMEM = 64 * 1024 * 1024
const SALT_BYTES = 16
const SCRYPT_OPTIONS: ScryptOptions = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }

/**
 * Promise form of `crypto.scrypt` with the fixed protocol params.
 * @param password - The clear-text password.
 * @param salt - The salt to derive under.
 * @param keylen - Derived key length in bytes.
 * @returns the derived key.
 */
function scryptAsync(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error !== null) reject(error)
      else resolve(derivedKey)
    })
  })
}

/** A user-registry failure; `code` is the stable discriminant callers switch on. */
export type UserErrorCode =
  | 'users/invalid-username'
  | 'users/short-password'
  | 'users/username-taken'
  | 'users/bad-credentials'
  | 'users/owner-removal'

/** Base for every user-registry error; subclasses pin one `code` each. */
export abstract class UserError extends Error {
  /** Stable discriminant for the failure class. */
  abstract readonly code: UserErrorCode
}

/** A create named a username outside the canonical grammar. */
export class InvalidUsernameError extends UserError {
  override readonly name = 'InvalidUsernameError'
  override readonly code = 'users/invalid-username' as const
  /**
   * @param username - The rejected username, in its supplied casing.
   */
  constructor(readonly username: string) {
    super(`invalid username '${username}': expected 1-32 characters of [a-z0-9._-] starting with a letter or digit`)
  }
}

/** A create whose password is shorter than the protocol minimum. */
export class ShortPasswordError extends UserError {
  override readonly name = 'ShortPasswordError'
  override readonly code = 'users/short-password' as const
  constructor() {
    super(`password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
}

/** A create that collides with an existing username, ignoring case. */
export class UsernameTakenError extends UserError {
  override readonly name = 'UsernameTakenError'
  override readonly code = 'users/username-taken' as const
  /**
   * @param username - The already-taken username, in its supplied casing.
   */
  constructor(readonly username: string) {
    super(`username '${username}' is already taken`)
  }
}

/** A verify that named an unknown username or supplied a wrong password. */
export class BadCredentialsError extends UserError {
  override readonly name = 'BadCredentialsError'
  override readonly code = 'users/bad-credentials' as const
  constructor() {
    super('bad credentials')
  }
}

/** A remove that named the owner, who is disallowed from deletion in v1. */
export class OwnerRemovalError extends UserError {
  override readonly name = 'OwnerRemovalError'
  override readonly code = 'users/owner-removal' as const
  /**
   * @param userId - The owner user id.
   */
  constructor(readonly userId: UserId) {
    super(`cannot remove the owner user '${userId}'`)
  }
}

/**
 * Derive base64(salt || scrypt-hash) for one password under a fixed salt.
 * @param password - The clear-text password.
 * @param salt - The salt the stored record was derived under.
 * @returns the salt and derived hash concatenated, as a buffer.
 */
async function deriveHash(password: string, salt: Buffer): Promise<Buffer> {
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN)
  return Buffer.concat([salt, hash])
}

/** Mint a fresh salt and return base64(salt || hash) for storage. */
function hashPassword(password: string): Promise<string> {
  return deriveHash(password, randomBytes(SALT_BYTES)).then(buffer => buffer.toString('base64'))
}

/**
 * Durable user registry. Startup opens the `users` domain, rebuilds the
 * in-memory indexes, and validates that at most one user holds the owner bit.
 * The dependency is the domain form alone; no session or persistence peer is
 * needed.
 */
export class UsersService extends Service {
  /** The domain data form is the single hard dependency. */
  static inject = ['storageDomain']

  private table?: KvTable<string, UserRecord>
  private readonly byKey = new Map<string, UserRecord>()
  private readonly byId = new Map<UserId, UserRecord>()
  private operationTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'users')
  }

  /** Open the domain, rebuild the in-memory indexes, and validate the owner bit. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(usersDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'users.domainClose')
    this.table = domain.table('users')
    for (const [key, record] of this.table.entries()) {
      this.byKey.set(key, record)
      this.byId.set(record.id, record)
    }
    this.validateOwnerBit()
  }

  /**
   * Create a user. Rejects an out-of-grammar username (`users/invalid-username`),
   * a short password (`users/short-password`), and a case-insensitive username
   * collision (`users/username-taken`). The first user ever created takes the
   * owner bit.
   * @param input - The username, password, and optional display name.
   * @returns the created user, projected without its password hash.
   */
  async create(input: { username: string; password: string; displayName?: string }): Promise<User> {
    return await this.enqueueOperation(async () => {
      const key = input.username.toLowerCase()
      if (!USERNAME_RE.test(key)) throw new InvalidUsernameError(input.username)
      if (input.password.length < MIN_PASSWORD_LENGTH) throw new ShortPasswordError()
      if (this.byKey.has(key)) throw new UsernameTakenError(input.username)
      const id = brandString<UserId>(randomUUID())
      const record: UserRecord = {
        id,
        username: input.username,
        displayName: input.displayName ?? input.username,
        passwordHash: await hashPassword(input.password),
        isOwner: this.byId.size === 0,
        createdAt: new Date().toISOString(),
      }
      await this.requireTable().put(key, record)
      this.byKey.set(key, record)
      this.byId.set(id, record)
      return this.project(record)
    })
  }

  /**
   * Verify credentials and resolve the user. Both an unknown username and a
   * wrong password reject `users/bad-credentials` (one error, no timing
   * oracle): a missing user still burns one scrypt derivation.
   * @param username - The username, in any casing.
   * @param password - The clear-text password.
   * @returns the resolved user, projected without its password hash.
   */
  async verify(username: string, password: string): Promise<User> {
    const record = this.byKey.get(username.toLowerCase())
    if (record === undefined) {
      await deriveHash(password, randomBytes(SALT_BYTES))
      throw new BadCredentialsError()
    }
    const stored = Buffer.from(record.passwordHash, 'base64')
    const salt = stored.subarray(0, SALT_BYTES)
    const candidate = await deriveHash(password, salt)
    if (!timingSafeEqual(candidate, stored)) throw new BadCredentialsError()
    return this.project(record)
  }

  /**
   * Read one user by id or username, synchronously.
   * @param idOrUsername - A user id or a username in any casing.
   * @returns the user, or `undefined` when neither names a stored user.
   */
  get(idOrUsername: string): User | undefined {
    const byId = this.byId.get(idOrUsername as UserId)
    if (byId !== undefined) return this.project(byId)
    const byKey = this.byKey.get(idOrUsername.toLowerCase())
    return byKey === undefined ? undefined : this.project(byKey)
  }

  /**
   * Every user, in creation order (by `createdAt`, ties broken by username).
   * @returns a fresh ordered array of users, projected without password hashes.
   */
  list(): readonly User[] {
    return [...this.byId.values()]
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
        || left.username.localeCompare(right.username))
      .map(record => this.project(record))
  }

  /**
   * Remove a user and its record. An unknown id is an idempotent no-op; the
   * owner rejects `users/owner-removal`. Workspaces and sessions are untouched.
   * @param userId - The user to remove.
   * @returns resolution after durability.
   */
  async remove(userId: UserId): Promise<void> {
    await this.enqueueOperation(async () => {
      const record = this.byId.get(userId)
      if (record === undefined) return
      if (record.isOwner) throw new OwnerRemovalError(userId)
      await this.requireTable().delete(record.username.toLowerCase())
      this.byKey.delete(record.username.toLowerCase())
      this.byId.delete(userId)
    })
  }

  /** Project a durable record to its public form, dropping the password hash. */
  private project(record: UserRecord): User {
    return {
      id: record.id,
      username: record.username,
      displayName: record.displayName,
      isOwner: record.isOwner,
      createdAt: record.createdAt,
    }
  }

  /** More than one owner bit means a write path bypassed the registry. */
  private validateOwnerBit(): void {
    let owners = 0
    for (const record of this.byId.values()) {
      if (record.isOwner) owners++
    }
    if (owners > 1) {
      throw new Error(`users domain is inconsistent: ${owners} users hold the owner bit, expected at most one`)
    }
  }

  private requireTable(): KvTable<string, UserRecord> {
    if (this.table === undefined) throw new Error('users registry is not started yet')
    return this.table
  }

  /** Serialize the check-then-write operations that own the owner bit and the key table. */
  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

export default UsersService
