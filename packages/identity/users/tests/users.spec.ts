import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UsersService, {
  BadCredentialsError,
  InvalidUsernameError,
  OwnerRemovalError,
  ShortPasswordError,
  UsernameTakenError,
} from '../src/index.ts'
import type { UserId } from '../src/index.ts'
import { MemoryMediaPool as Pool, MemoryStorageBackend as Backend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

// One-shot control for the scrypt failure injection below.
const scryptControl = vi.hoisted(() => ({ failNext: false }))

// Wrap only `scrypt`: fail the next call on demand to reach the callback's
// error branch; every other crypto export stays the real implementation.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    scrypt: (...args: unknown[]) => {
      if (scryptControl.failNext) {
        scryptControl.failNext = false
        ;(args[4] as (error: Error | null) => void)(new Error('injected scrypt failure'))
        return
      }
      return (actual.scrypt as (...a: unknown[]) => unknown)(...args)
    },
  }
})

const id = (value: string): UserId => value as UserId

let fiber: Awaited<ReturnType<Context['plugin']>> | undefined

afterEach(async () => {
  await fiber?.dispose()
  fiber = undefined
})

/** Boot the real storage/domain/registry composition over the in-memory medium. */
async function harness(pool: Pool = new Pool()) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new Backend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  fiber = await ctx.plugin(UsersService)
  return { ctx, users: ctx.users, pool }
}

describe('UsersService create', () => {
  it('creates the first user as owner and projects without the password hash', async () => {
    const { users } = await harness()
    const owner = await users.create({ username: 'Alice', password: 'correct-horse' })
    expect(owner).toMatchObject({ username: 'Alice', displayName: 'Alice', isOwner: true })
    expect(owner.id).toBeTypeOf('string')
    expect('passwordHash' in owner).toBe(false)
    expect(users.list()).toHaveLength(1)
  })

  it('keeps the supplied display name and does not grant the owner bit a second time', async () => {
    const { users } = await harness()
    await users.create({ username: 'alice', password: 'password-one' })
    const second = await users.create({ username: 'Bob', password: 'password-two', displayName: 'Bobby' })
    expect(second).toMatchObject({ username: 'Bob', displayName: 'Bobby', isOwner: false })
  })

  it('rejects a case-insensitive username collision', async () => {
    const { users } = await harness()
    await users.create({ username: 'Alice', password: 'password-one' })
    await expect(users.create({ username: 'aLiCe', password: 'password-two' }))
      .rejects.toBeInstanceOf(UsernameTakenError)
    await expect(users.create({ username: 'ALICE', password: 'password-two' }))
      .rejects.toMatchObject({ code: 'users/username-taken' })
  })

  it('rejects an out-of-grammar username', async () => {
    const { users } = await harness()
    for (const username of ['', 'a'.repeat(33), '-lead', '_lead', 'has space']) {
      await expect(users.create({ username, password: 'password-one' }))
        .rejects.toBeInstanceOf(InvalidUsernameError)
    }
  })

  it('rejects a password shorter than the minimum', async () => {
    const { users } = await harness()
    await expect(users.create({ username: 'alice', password: 'seven' }))
      .rejects.toBeInstanceOf(ShortPasswordError)
  })

  it('rejects a create before startup', async () => {
    const service = new UsersService(new Context())
    await expect(service.create({ username: 'alice', password: 'password-one' }))
      .rejects.toThrow('users registry is not started yet')
  })

  it('propagates a scrypt derivation failure from create', async () => {
    const { users } = await harness()
    scryptControl.failNext = true
    await expect(users.create({ username: 'alice', password: 'password-one' }))
      .rejects.toThrow('injected scrypt failure')
  })
})

describe('UsersService verify', () => {
  it('resolves the user for correct credentials in any casing', async () => {
    const { users } = await harness()
    const owner = await users.create({ username: 'Alice', password: 'correct-horse' })
    const verified = await users.verify('aLiCe', 'correct-horse')
    expect(verified.id).toBe(owner.id)
    expect('passwordHash' in verified).toBe(false)
  })

  it('rejects a wrong password with bad-credentials', async () => {
    const { users } = await harness()
    await users.create({ username: 'alice', password: 'correct-horse' })
    await expect(users.verify('alice', 'not-the-password')).rejects.toBeInstanceOf(BadCredentialsError)
    await expect(users.verify('alice', 'not-the-password')).rejects.toMatchObject({ code: 'users/bad-credentials' })
  })

  it('rejects an unknown username with the same bad-credentials error', async () => {
    const { users } = await harness()
    await expect(users.verify('ghost', 'correct-horse')).rejects.toBeInstanceOf(BadCredentialsError)
  })
})

describe('UsersService get and list', () => {
  it('reads a user by id and by username in any casing, and misses cleanly', async () => {
    const { users } = await harness()
    const owner = await users.create({ username: 'Alice', password: 'password-one' })
    expect(users.get(owner.id)?.username).toBe('Alice')
    expect(users.get('alice')?.id).toBe(owner.id)
    expect(users.get('ALICE')?.id).toBe(owner.id)
    expect(users.get('no-such-user')).toBeUndefined()
  })

  it('lists every user in creation order', async () => {
    const { users } = await harness()
    const a = await users.create({ username: 'zeta', password: 'password-one' })
    const b = await users.create({ username: 'alpha', password: 'password-two' })
    const listed = users.list()
    expect(listed.map(user => user.id)).toEqual([a.id, b.id])
  })
})

describe('UsersService remove', () => {
  it('removes a non-owner user and reads miss afterwards', async () => {
    const { users } = await harness()
    await users.create({ username: 'alice', password: 'password-one' })
    const bob = await users.create({ username: 'bob', password: 'password-two' })
    await users.remove(bob.id)
    expect(users.get('bob')).toBeUndefined()
    expect(users.list()).toHaveLength(1)
  })

  it('treats an unknown id as an idempotent no-op', async () => {
    const { users } = await harness()
    await expect(users.remove(id('00000000-0000-4000-8000-000000000000'))).resolves.toBeUndefined()
  })

  it('rejects removing the owner', async () => {
    const { users } = await harness()
    const owner = await users.create({ username: 'alice', password: 'password-one' })
    await expect(users.remove(owner.id)).rejects.toBeInstanceOf(OwnerRemovalError)
    await expect(users.remove(owner.id)).rejects.toMatchObject({ code: 'users/owner-removal' })
  })
})

describe('startup invariants', () => {
  it('fails loud when more than one stored user holds the owner bit', async () => {
    const pool = new Pool()
    pool.versions.set('users', 1)
    const table = new Map<string, unknown>([
      ['alice', { id: id('11111111-1111-4111-8111-111111111111'), username: 'Alice', displayName: 'Alice', passwordHash: 'x', isOwner: true, createdAt: '2026-01-01T00:00:00.000Z' }],
      ['bob', { id: id('22222222-2222-4222-8222-222222222222'), username: 'Bob', displayName: 'Bob', passwordHash: 'y', isOwner: true, createdAt: '2026-01-02T00:00:00.000Z' }],
    ])
    pool.media.set('users', { tables: new Map([['users', table]]), global: null })
    await expect(harness(pool)).rejects.toThrow('users domain is inconsistent')
  })

  it('rejects a v0 unit file as a version mismatch', async () => {
    const pool = new Pool()
    pool.versions.set('users', 0)
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new Backend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    fiber = undefined
    await expect(ctx.plugin(UsersService)).rejects.toMatchObject({ name: 'StorageError', code: 'version-mismatch' })
  })

  it('boots a stored owner plus non-owners and orders creation-order ties by username', async () => {
    const pool = new Pool()
    pool.versions.set('users', 1)
    // Inserted in a non-alphabetical order with one shared createdAt, so the
    // listing must order by the username tiebreak rather than insertion order.
    const table = new Map<string, unknown>([
      ['carol', { id: id('33333333-3333-4333-8333-333333333333'), username: 'Carol', displayName: 'Carol', passwordHash: 'z', isOwner: false, createdAt: '2026-01-01T00:00:00.000Z' }],
      ['alice', { id: id('11111111-1111-4111-8111-111111111111'), username: 'Alice', displayName: 'Alice', passwordHash: 'x', isOwner: true, createdAt: '2026-01-01T00:00:00.000Z' }],
      ['bob', { id: id('22222222-2222-4222-8222-222222222222'), username: 'Bob', displayName: 'Bob', passwordHash: 'y', isOwner: false, createdAt: '2026-01-01T00:00:00.000Z' }],
    ])
    pool.media.set('users', { tables: new Map([['users', table]]), global: null })
    const { users } = await harness(pool)
    expect(users.list().map(user => user.username)).toEqual(['Alice', 'Bob', 'Carol'])
    expect(users.get('Alice')?.isOwner).toBe(true)
    expect(users.list().filter(user => user.isOwner)).toHaveLength(1)
  })
})
