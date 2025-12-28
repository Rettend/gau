import type { Adapter } from '../../src/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryAdapter } from '../../src/adapters/memory'

describe('memory adapter', () => {
  let adapter: Adapter

  beforeEach(() => {
    adapter = MemoryAdapter()
  })

  it('createUser: should create a new user with all fields', async () => {
    const user = await adapter.createUser({
      name: 'Test User',
      email: 'test@example.com',
      image: 'image.png',
      emailVerified: true,
    })
    expect(user.id).toBeDefined()
    expect(user.name).toBe('Test User')
    expect(user.email).toBe('test@example.com')
    expect(user.image).toBe('image.png')
    expect(user.emailVerified).toBe(true)
  })

  it('createUser: should create a user with only an email', async () => {
    const user = await adapter.createUser({ email: 'minimal@example.com' })
    expect(user.id).toBeDefined()
    expect(user.email).toBe('minimal@example.com')
    expect(user.name).toBeNull()
    expect(user.image).toBeNull()
    expect(user.emailVerified).toBeNull()
  })

  it('createUser: should create a user with custom ID', async () => {
    const customId = 'custom-user-id'
    const user = await adapter.createUser({ id: customId, email: 'custom@example.com' })
    expect(user.id).toBe(customId)
    expect(user.email).toBe('custom@example.com')
  })

  it('getUser: should retrieve a user by id', async () => {
    const createdUser = await adapter.createUser({ email: 'get@example.com' })
    const user = await adapter.getUser(createdUser.id)
    expect(user).toEqual(createdUser)
  })

  it('getUser: should return null for a non-existent user', async () => {
    const user = await adapter.getUser('non-existent-id')
    expect(user).toBeNull()
  })

  it('getUserByEmail: should retrieve a user by email', async () => {
    const createdUser = await adapter.createUser({ email: 'getbyemail@example.com' })
    const user = await adapter.getUserByEmail('getbyemail@example.com')
    expect(user).toEqual(createdUser)
  })

  it('getUserByEmail: should return null for a non-existent email', async () => {
    const user = await adapter.getUserByEmail('non-existent@example.com')
    expect(user).toBeNull()
  })

  it('getUserByAccount: should retrieve a user by account', async () => {
    const createdUser = await adapter.createUser({ email: 'getbyaccount@example.com' })
    await adapter.linkAccount({
      userId: createdUser.id,
      provider: 'test-provider',
      providerAccountId: 'test-provider-id',
    })
    const user = await adapter.getUserByAccount('test-provider', 'test-provider-id')
    expect(user).toEqual(createdUser)
  })

  it('getUserByAccount: should return null for a non-existent account', async () => {
    const user = await adapter.getUserByAccount('non-existent-provider', 'non-existent-id')
    expect(user).toBeNull()
  })

  it('updateUser: should update user fields', async () => {
    const createdUser = await adapter.createUser({ name: 'Original Name', email: 'update@example.com' })
    const updatedUser = await adapter.updateUser({
      id: createdUser.id,
      name: 'Updated Name',
      image: 'new-image.png',
      emailVerified: true,
    })
    expect(updatedUser.name).toBe('Updated Name')
    expect(updatedUser.image).toBe('new-image.png')
    expect(updatedUser.emailVerified).toBe(true)
    expect(updatedUser.email).toBe('update@example.com') // Should not change
  })

  it('updateUser: should update email and maintain email lookup', async () => {
    const createdUser = await adapter.createUser({ email: 'old@example.com' })
    const updatedUser = await adapter.updateUser({
      id: createdUser.id,
      email: 'new@example.com',
    })

    expect(updatedUser.email).toBe('new@example.com')
    const retrievedByNewEmail = await adapter.getUserByEmail('new@example.com')
    expect(retrievedByNewEmail).toEqual(updatedUser)

    const retrievedByOldEmail = await adapter.getUserByEmail('old@example.com')
    expect(retrievedByOldEmail).toBeNull()
  })

  it('updateUser: should throw error for non-existent user', async () => {
    await expect(adapter.updateUser({
      id: 'non-existent',
      name: 'Test',
    })).rejects.toThrow('User not found')
  })

  it('linkAccount: should link an account to a user', async () => {
    const user = await adapter.createUser({ email: 'link@example.com' })
    await adapter.linkAccount({
      userId: user.id,
      provider: 'test-provider',
      providerAccountId: 'test-provider-id',
    })
    const retrievedUser = await adapter.getUserByAccount('test-provider', 'test-provider-id')
    expect(retrievedUser).toEqual(user)
  })

  it('linkAccount: should store account data correctly', async () => {
    const user = await adapter.createUser({ email: 'link-data@example.com' })
    await adapter.linkAccount({
      userId: user.id,
      provider: 'github',
      providerAccountId: 'gh123',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 1234567890,
      idToken: 'id-token',
      tokenType: 'Bearer',
      scope: 'read:user',
      sessionState: 'state123',
    })

    const accounts = await adapter.getAccounts(user.id)
    expect(accounts).toHaveLength(1)
    const account = accounts[0]!
    expect(account.provider).toBe('github')
    expect(account.providerAccountId).toBe('gh123')
    expect(account.accessToken).toBe('access-token')
    expect(account.refreshToken).toBe('refresh-token')
    expect(account.expiresAt).toBe(1234567890)
    expect(account.idToken).toBe('id-token')
    expect(account.tokenType).toBe('Bearer')
    expect(account.scope).toBe('read:user')
    expect(account.sessionState).toBe('state123')
  })

  it('updateAccount: should update token fields for an account', async () => {
    const user = await adapter.createUser({ email: 'tokens@example.com' })
    await adapter.linkAccount({ userId: user.id, provider: 'github', providerAccountId: 'gh1' })

    await adapter.updateAccount!({
      userId: user.id,
      provider: 'github',
      providerAccountId: 'gh1',
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: 123456,
      idToken: 'id-token',
      tokenType: 'Bearer',
      scope: 'read',
    })

    const accounts = await adapter.getAccounts(user.id)
    const acc = accounts.find(a => a.provider === 'github' && a.providerAccountId === 'gh1')!
    expect(acc.accessToken).toBe('new-access')
    expect(acc.refreshToken).toBe('new-refresh')
    expect(acc.expiresAt).toBe(123456)
    expect(acc.idToken).toBe('id-token')
    expect(acc.tokenType).toBe('Bearer')
    expect(acc.scope).toBe('read')
  })

  it('updateAccount: should not update if account belongs to different user', async () => {
    const user1 = await adapter.createUser({ email: 'user1@example.com' })
    const user2 = await adapter.createUser({ email: 'user2@example.com' })

    await adapter.linkAccount({ userId: user1.id, provider: 'github', providerAccountId: 'gh1' })

    // Try to update from user2's perspective
    await adapter.updateAccount!({
      userId: user2.id,
      provider: 'github',
      providerAccountId: 'gh1',
      accessToken: 'should-not-update',
    })

    const accounts = await adapter.getAccounts(user1.id)
    const acc = accounts.find(a => a.provider === 'github' && a.providerAccountId === 'gh1')!
    expect(acc.accessToken).toBeUndefined()
  })

  it('deleteUser: should delete a user', async () => {
    const user = await adapter.createUser({ email: 'delete@example.com' })
    expect(await adapter.getUser(user.id)).not.toBeNull()
    await adapter.deleteUser(user.id)
    expect(await adapter.getUser(user.id)).toBeNull()
  })

  it('deleteUser: should remove user from email lookup', async () => {
    const user = await adapter.createUser({ email: 'delete-email@example.com' })
    await adapter.deleteUser(user.id)
    const retrievedByEmail = await adapter.getUserByEmail('delete-email@example.com')
    expect(retrievedByEmail).toBeNull()
  })

  it('deleteUser: should remove associated accounts', async () => {
    const user = await adapter.createUser({ email: 'delete-accounts@example.com' })
    await adapter.linkAccount({ userId: user.id, provider: 'github', providerAccountId: 'gh1' })
    await adapter.linkAccount({ userId: user.id, provider: 'google', providerAccountId: 'gg1' })

    let accounts = await adapter.getAccounts(user.id)
    expect(accounts).toHaveLength(2)

    await adapter.deleteUser(user.id)

    accounts = await adapter.getAccounts(user.id)
    expect(accounts).toHaveLength(0)

    const userByAccount = await adapter.getUserByAccount('github', 'gh1')
    expect(userByAccount).toBeNull()
  })

  it('getAccounts: should return all accounts for a user', async () => {
    const user = await adapter.createUser({ email: 'accounts@example.com' })
    await adapter.linkAccount({ userId: user.id, provider: 'github', providerAccountId: 'gh1' })
    await adapter.linkAccount({ userId: user.id, provider: 'google', providerAccountId: 'gg1' })
    const accounts = await adapter.getAccounts(user.id)
    expect(accounts).toHaveLength(2)
    expect(accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'github', providerAccountId: 'gh1' }),
      expect.objectContaining({ provider: 'google', providerAccountId: 'gg1' }),
    ]))
  })

  it('getAccounts: should return an empty array for a user with no accounts', async () => {
    const user = await adapter.createUser({ email: 'no-accounts@example.com' })
    const accounts = await adapter.getAccounts(user.id)
    expect(accounts).toEqual([])
  })

  it('getAccounts: should return an empty array for a non-existent user', async () => {
    const accounts = await adapter.getAccounts('non-existent-user-id')
    expect(accounts).toEqual([])
  })

  it('getUserAndAccounts: should return user and their accounts', async () => {
    const user = await adapter.createUser({ email: 'userandaccounts@example.com' })
    await adapter.linkAccount({ userId: user.id, provider: 'github', providerAccountId: 'gh1' })
    await adapter.linkAccount({ userId: user.id, provider: 'google', providerAccountId: 'gg1' })

    const result = await adapter.getUserAndAccounts(user.id)
    expect(result).not.toBeNull()
    expect(result!.user).toEqual(user)
    expect(result!.accounts).toHaveLength(2)
    expect(result!.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'github', providerAccountId: 'gh1' }),
      expect.objectContaining({ provider: 'google', providerAccountId: 'gg1' }),
    ]))
  })

  it('getUserAndAccounts: should return user and empty array for user with no accounts', async () => {
    const user = await adapter.createUser({ email: 'userandnoaccounts@example.com' })
    const result = await adapter.getUserAndAccounts(user.id)
    expect(result).not.toBeNull()
    expect(result!.user).toEqual(user)
    expect(result!.accounts).toEqual([])
  })

  it('getUserAndAccounts: should return null for non-existent user', async () => {
    const result = await adapter.getUserAndAccounts('non-existent-user-id')
    expect(result).toBeNull()
  })

  it('unlinkAccount: should unlink an account from a user', async () => {
    const user = await adapter.createUser({ email: 'unlink@example.com' })
    await adapter.linkAccount({
      userId: user.id,
      provider: 'github',
      providerAccountId: 'gh1',
    })
    let accounts = await adapter.getAccounts(user.id)
    expect(accounts).toHaveLength(1)

    await adapter.unlinkAccount('github', 'gh1')

    accounts = await adapter.getAccounts(user.id)
    expect(accounts).toHaveLength(0)

    const userByAccount = await adapter.getUserByAccount('github', 'gh1')
    expect(userByAccount).toBeNull()
  })

  it('unlinkAccount: should not affect other accounts for the same user', async () => {
    const user = await adapter.createUser({ email: 'unlink-multi@example.com' })
    await adapter.linkAccount({ userId: user.id, provider: 'github', providerAccountId: 'gh1' })
    await adapter.linkAccount({ userId: user.id, provider: 'google', providerAccountId: 'gg1' })

    await adapter.unlinkAccount('github', 'gh1')

    const accounts = await adapter.getAccounts(user.id)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.provider).toBe('google')

    const userByGhAccount = await adapter.getUserByAccount('github', 'gh1')
    expect(userByGhAccount).toBeNull()
    const userByGgAccount = await adapter.getUserByAccount('google', 'gg1')
    expect(userByGgAccount).toEqual(user)
  })

  it('unlinkAccount: unlinking a non-existent account should not throw', async () => {
    await expect(adapter.unlinkAccount('noop', 'noop')).resolves.toBeUndefined()
  })

  it('unlinkAccount: should remove account data', async () => {
    const user = await adapter.createUser({ email: 'unlink-data@example.com' })
    await adapter.linkAccount({
      userId: user.id,
      provider: 'github',
      providerAccountId: 'gh1',
      accessToken: 'token',
    })

    let accounts = await adapter.getAccounts(user.id)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.accessToken).toBe('token')

    await adapter.unlinkAccount('github', 'gh1')

    accounts = await adapter.getAccounts(user.id)
    expect(accounts).toHaveLength(0)
  })

  it('should handle multiple users with separate data', async () => {
    const user1 = await adapter.createUser({ email: 'user1@example.com' })
    const user2 = await adapter.createUser({ email: 'user2@example.com' })

    await adapter.linkAccount({ userId: user1.id, provider: 'github', providerAccountId: 'gh1' })
    await adapter.linkAccount({ userId: user2.id, provider: 'github', providerAccountId: 'gh2' })

    const accounts1 = await adapter.getAccounts(user1.id)
    const accounts2 = await adapter.getAccounts(user2.id)

    expect(accounts1).toHaveLength(1)
    expect(accounts1[0]!.providerAccountId).toBe('gh1')
    expect(accounts2).toHaveLength(1)
    expect(accounts2[0]!.providerAccountId).toBe('gh2')
  })

  it('should handle role field in users', async () => {
    const user = await adapter.createUser({
      email: 'role@example.com',
      role: 'admin',
    })
    expect(user.role).toBe('admin')

    const updatedUser = await adapter.updateUser({
      id: user.id,
      role: 'user',
    })
    expect(updatedUser.role).toBe('user')
  })
})

declare module '../../src/core' {
  interface User {
    nickname?: string | null
  }
  interface NewUser {
    nickname?: string | null
  }
}

describe('memory adapter custom fields', () => {
  let adapter: Adapter

  beforeEach(() => {
    adapter = MemoryAdapter()
  })

  it('createUser: should preserve custom fields', async () => {
    const user = await adapter.createUser({
      email: 'custom@example.com',
      nickname: 'customNick',
    })
    expect(user.nickname).toBe('customNick')
  })

  it('updateUser: should preserve custom fields', async () => {
    const user = await adapter.createUser({
      email: 'update-custom@example.com',
      nickname: 'originalNick',
    })

    const updated = await adapter.updateUser({
      id: user.id,
      nickname: 'newNick',
    })
    expect(updated.nickname).toBe('newNick')
    expect(updated.email).toBe('update-custom@example.com')
  })

  it('updateUser: should not lose custom fields when updating core fields', async () => {
    const user = await adapter.createUser({
      email: 'preserve@example.com',
      nickname: 'keepMe',
    })

    const updated = await adapter.updateUser({
      id: user.id,
      name: 'New Name',
    })
    expect(updated.name).toBe('New Name')
    expect(updated.nickname).toBe('keepMe')
  })
})
