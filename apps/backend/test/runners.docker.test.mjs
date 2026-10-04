import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createDockerDriver } from '../lib/runner/dockerDriver.js'

// Talks to the real Docker engine and needs the runner images built
// (`npm run runners:build`), so it only runs when asked to:
//
//   $env:TEST_DOCKER="1"; npm test --workspace=backend
const ENABLED = process.env.TEST_DOCKER === '1'

const HELLO = {
  javascript: `const lines = require('fs').readFileSync(0, 'utf8').trim().split('\\n')\nfor (const l of lines) console.log('hi ' + l)`,
  typescript: `const lines: string[] = require('fs').readFileSync(0, 'utf8').trim().split('\\n')\nfor (const l of lines) console.log('hi ' + l)`,
  python: `import sys\nfor line in sys.stdin:\n    print('hi ' + line.strip())`,
  java: `import java.util.*;\npublic class Solution {\n  public static void main(String[] a) {\n    Scanner s = new Scanner(System.in);\n    while (s.hasNextLine()) System.out.println("hi " + s.nextLine());\n  }\n}`,
  cpp: `#include <bits/stdc++.h>\nint main() { std::string l; while (std::getline(std::cin, l)) std::cout << "hi " << l << "\\n"; }`,
  csharp: `string? l;\nwhile ((l = Console.ReadLine()) != null) Console.WriteLine("hi " + l);`,
  php: `<?php\nwhile (($l = fgets(STDIN)) !== false) echo "hi " . trim($l) . "\\n";`,
  ruby: `STDIN.each_line { |l| puts "hi #{l.strip}" }`,
  go: `package main\n\nimport (\n\t"bufio"\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\ts := bufio.NewScanner(os.Stdin)\n\tfor s.Scan() {\n\t\tfmt.Println("hi " + s.Text())\n\t}\n}`,
  rust: `use std::io::BufRead;\nfn main() { for l in std::io::stdin().lock().lines() { println!("hi {}", l.unwrap()); } }`
}

const driver = createDockerDriver({ owner: `test-docker:${process.pid}` })
let images = new Set()

async function runOnce(language, source, { stdin = '', timeoutMs = 30000, maxOutputBytes = 80000 } = {}) {
  const handle = await driver.start(language)
  try {
    return await driver.execute(handle, { source, stdin, timeoutMs, maxOutputBytes })
  } finally {
    await driver.destroy(handle)
  }
}

describe('runner images (real Docker)', { skip: !ENABLED && 'set TEST_DOCKER=1 to run' }, () => {
  before(async () => {
    images = await driver.listImages()
  })

  after(async () => {
    await driver.removeOrphans()
  })

  for (const [language, source] of Object.entries(HELLO)) {
    test(`${language} runs with multi-line stdin`, async (t) => {
      if (!images.has(language)) {
        t.skip(`codesync-runner-${language} is not built`)
        return
      }
      const result = await runOnce(language, source, { stdin: 'a\nb\n' })
      assert.equal(result.stderr, '', `unexpected stderr: ${result.stderr}`)
      assert.equal(result.stdout, 'hi a\nhi b\n')
      assert.equal(result.exitCode, 0)
    })
  }

  describe('sandbox', () => {
    before((t) => {
      if (!images.has('python')) t.skip('codesync-runner-python is not built')
    })

    test('runs as the unprivileged runner user', async () => {
      const result = await runOnce('python', 'import os\nprint(os.getuid(), os.getgid())')
      assert.equal(result.stdout.trim(), '10001 10001')
    })

    test('has no network access', async () => {
      const result = await runOnce(
        'python',
        "import socket\nsocket.create_connection(('1.1.1.1', 53), timeout=3)\nprint('connected')"
      )
      assert.notEqual(result.exitCode, 0)
      assert.doesNotMatch(result.stdout, /connected/)
      assert.match(result.stderr, /Error/)
    })

    test('kills a program that exceeds the time limit', async () => {
      const startedAt = Date.now()
      const result = await runOnce('python', 'print("tick", flush=True)\nwhile True: pass', {
        timeoutMs: 2000
      })
      assert.equal(result.timedOut, true)
      assert.equal(result.stdout, 'tick\n')
      assert.ok(Date.now() - startedAt < 10000, 'the kill should be prompt')
    })

    test('stops a program that floods output', async () => {
      const result = await runOnce('python', "while True: print('x' * 1000)", {
        timeoutMs: 20000,
        maxOutputBytes: 10000
      })
      assert.equal(result.flooded, true)
      assert.equal(result.timedOut, false)
      assert.equal(result.stdout.length, 10000)
    })

    test('enforces the memory limit', async () => {
      const result = await runOnce('python', 'data = bytearray(2 * 1024 * 1024 * 1024)\nprint("allocated")')
      assert.notEqual(result.exitCode, 0)
      assert.doesNotMatch(result.stdout, /allocated/)
    })

    test('caps the size of files a program writes', async () => {
      const result = await runOnce(
        'python',
        "with open('/workspace/big', 'wb') as f:\n    f.write(b'0' * (100 * 1024 * 1024))\nprint('written')"
      )
      assert.notEqual(result.exitCode, 0)
      assert.doesNotMatch(result.stdout, /written/)
    })

    test('removes containers once destroyed', async () => {
      await runOnce('python', 'print(1)')
      assert.equal(await driver.removeOrphans(), 0, 'no container should be left behind')
    })
  })
})
