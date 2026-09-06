/**
 * REAL-composition proof: a test-only cordis.yml booted through the vendored
 * Loader mounts the storage stack and the users registry, a created user is
 * verifiable before a cold restart, and it survives one — the registry opens
 * the same `users` unit from the durable json backend on the second boot.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import UsersService, { BadCredentialsError, UsernameTakenError } from '../src/index.ts'

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  root = undefined
})

/** Write the storage-stack + users cordis.yml, then boot it through the real Loader. */
async function loadComposition(configPath: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root as string).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-identity-users', UsersService],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  const unloaded = [...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  return ctx
}

describe('identity users through a real Loader composition', () => {
  it('boots the registry and keeps a created user durable across a cold restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-identity-users-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-storage'",
      "- name: '@deepseek-ai/dsh-storage-json'",
      '  config:',
      `    root: ${JSON.stringify(join(root, 'storage'))}`,
      "- name: '@deepseek-ai/dsh-storage-domain'",
      '  config:',
      '    backend: json',
      "- name: '@deepseek-ai/dsh-identity-users'",
      '',
    ].join('\n'))

    const first = await loadComposition(configPath)
    const owner = await first.users.create({ username: 'Alice', password: 'correct-horse' })
    expect(owner.isOwner).toBe(true)
    await expect(first.users.verify('alice', 'correct-horse')).resolves.toMatchObject({ username: 'Alice' })
    await expect(first.users.verify('alice', 'wrong-password')).rejects.toBeInstanceOf(BadCredentialsError)
    await expect(first.users.create({ username: 'ALICE', password: 'other-pass' }))
      .rejects.toBeInstanceOf(UsernameTakenError)

    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const second = await loadComposition(configPath)
    expect(second.users.get('Alice')?.isOwner).toBe(true)
    expect(second.users.list().map(user => user.username)).toEqual(['Alice'])
    await expect(second.users.verify('Alice', 'correct-horse')).resolves.toMatchObject({ username: 'Alice' })
  })
})
