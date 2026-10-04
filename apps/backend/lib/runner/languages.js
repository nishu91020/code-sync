/**
 * Languages that can be executed, and how their runner containers are sized.
 * Each entry corresponds to an image built from `runners/<language>/`.
 *
 * `source` is the file name the image's `run` script compiles/executes.
 * Limits are deliberately per language: compilers and managed runtimes (JVM,
 * .NET, rustc) need far more memory and threads than an interpreter.
 */
export const RUNNER_LANGUAGES = {
  javascript: { source: 'main.js', memoryMb: 256, pids: 128 },
  typescript: { source: 'main.ts', memoryMb: 384, pids: 128 },
  python: { source: 'main.py', memoryMb: 256, pids: 128 },
  java: { source: 'Main.java', memoryMb: 512, pids: 256 },
  cpp: { source: 'main.cpp', memoryMb: 512, pids: 128 },
  csharp: { source: 'main.cs', memoryMb: 1024, pids: 512 },
  php: { source: 'main.php', memoryMb: 256, pids: 128 },
  ruby: { source: 'main.rb', memoryMb: 256, pids: 128 },
  go: { source: 'main.go', memoryMb: 512, pids: 256 },
  rust: { source: 'main.rs', memoryMb: 512, pids: 128 }
}

/** The editor's language when a room has not chosen one; mirrors the web app. */
export const DEFAULT_LANGUAGE = 'javascript'

export const runnableLanguages = Object.keys(RUNNER_LANGUAGES)

export function isRunnable(language) {
  return Object.prototype.hasOwnProperty.call(RUNNER_LANGUAGES, language)
}

export function imageFor(language) {
  return `codesync-runner-${language}:latest`
}

/** The command that builds the image for `language`, shown to users. */
export function buildHint(language) {
  return `npm run runners:build -- ${language}`
}
