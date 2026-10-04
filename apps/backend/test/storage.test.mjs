import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import * as Y from 'yjs'

import { createMemoryStorage, createPrismaClient, createPrismaStorage, slugFromDocName } from '../lib/storage.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL

describe('storage helpers', () => {
  test('slugFromDocName strips the room prefix', () => {
    assert.equal(slugFromDocName('room-abc123'), 'abc123')
    assert.equal(slugFromDocName('abc123'), 'abc123')
  })

  test('memory storage round-trips a Yjs snapshot', async () => {
    const storage = createMemoryStorage()
    assert.equal(await storage.load('room-missing'), null)

    await storage.createRoom('room-a', { hostName: 'Alice', hostTokenHash: 'abc' })
    const doc = new Y.Doc()
    doc.getText('monaco').insert(0, 'hello world')
    assert.equal(await storage.save('room-a', Y.encodeStateAsUpdate(doc)), true)

    const restored = new Y.Doc()
    Y.applyUpdate(restored, await storage.load('room-a'))
    assert.equal(restored.getText('monaco').toString(), 'hello world')
  })

  test('memory storage never creates a room by saving', async () => {
    const storage = createMemoryStorage()

    assert.equal(await storage.save('room-made-up', new Uint8Array([1, 2, 3])), false)

    assert.equal(await storage.load('room-made-up'), null)
    assert.equal(await storage.getAccess('room-made-up'), null)
  })

  test('memory storage tracks members', async () => {
    const storage = createMemoryStorage()
    await storage.createRoom('room-a', { hostName: 'Alice', hostTokenHash: 'h' })

    await storage.addMember('room-a', { id: 'm1', name: 'Bob', tokenHash: 't1' })
    assert.deepEqual((await storage.getAccess('room-a')).members.map((m) => m.name), ['Bob'])

    assert.equal(await storage.removeMember('room-a', 'm1'), true)
    assert.equal(await storage.removeMember('room-a', 'm1'), false)
    assert.deepEqual((await storage.getAccess('room-a')).members, [])
  })
})

// Exercises the real Prisma adapter when a test database is available.
describe('prisma storage', { skip: !DATABASE_URL && 'TEST_DATABASE_URL not set' }, () => {
  let prisma
  let storage

  test('round-trips a snapshot through Postgres', async (t) => {
    prisma = await createPrismaClient(DATABASE_URL)
    storage = createPrismaStorage(prisma)

    const docName = `room-pg-${Date.now()}`
    t.after(async () => {
      await prisma.room.deleteMany({ where: { slug: slugFromDocName(docName) } })
    })

    assert.equal(await storage.load(docName), null)

    await storage.createRoom(docName, { hostName: 'Alice', hostTokenHash: 'hash' })
    const doc = new Y.Doc()
    doc.getText('monaco').insert(0, 'const persisted = true')
    assert.equal(await storage.save(docName, Y.encodeStateAsUpdate(doc)), true)

    const restored = new Y.Doc()
    Y.applyUpdate(restored, await storage.load(docName))
    assert.equal(restored.getText('monaco').toString(), 'const persisted = true')

    // Saving again must update in place and bump the version.
    doc.getText('monaco').insert(0, '// header\n')
    await storage.save(docName, Y.encodeStateAsUpdate(doc))

    const room = await prisma.room.findUnique({
      where: { slug: slugFromDocName(docName) },
      select: { docState: { select: { version: true } } }
    })
    assert.equal(room.docState.version, 2)

    const rooms = await prisma.room.count({ where: { slug: slugFromDocName(docName) } })
    assert.equal(rooms, 1, 'save must update rather than duplicate the room')
  })

  test('never creates a room by saving', async () => {
    const docName = `room-unknown-${Date.now()}`

    assert.equal(await storage.save(docName, new Uint8Array([1, 2, 3])), false)

    assert.equal(await prisma.room.count({ where: { slug: slugFromDocName(docName) } }), 0)
  })

  test('stores the host and members, and removes members', async (t) => {
    const docName = `room-access-${Date.now()}`
    t.after(async () => {
      await prisma.room.deleteMany({ where: { slug: slugFromDocName(docName) } })
      await prisma.$disconnect()
    })

    await storage.createRoom(docName, { hostName: 'Alice', hostTokenHash: 'host-hash' })
    await storage.addMember(docName, { id: `m-${Date.now()}`, name: 'Bob', tokenHash: `t-${Date.now()}` })

    const access = await storage.getAccess(docName)
    assert.equal(access.hostName, 'Alice')
    assert.equal(access.hostTokenHash, 'host-hash')
    assert.deepEqual(access.members.map((member) => member.name), ['Bob'])

    assert.equal(await storage.removeMember(docName, access.members[0].id), true)
    assert.deepEqual((await storage.getAccess(docName)).members, [])
  })
})
