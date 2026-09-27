// Hardened git helper — argv-only, GIT_ASKPASS, hooks off.
// GIT_TOKEN NEVER appears in argv, stdout, or stderr.
// rule-token-never-in-argv, sec-git-token-isolation

import { spawn } from 'child_process'
import { join } from 'path'

const ASKPASS = process.env.GIT_ASKPASS_PATH ?? '/app/bin/askpass.sh'

export interface GitIdentity {
  email: string
  name: string
}

export interface RunGitResult {
  stdout: string
  stderr: string
  code: number
}

export async function runGit(
  cwd: string,
  args: string[],
  identity?: GitIdentity,
): Promise<RunGitResult> {
  const extraArgs: string[] = ['-c', 'core.hooksPath=/dev/null']
  if (identity) {
    extraArgs.push('-c', `user.email=${identity.email}`)
    extraArgs.push('-c', `user.name=${identity.name}`)
  }

  const token = process.env.GIT_TOKEN
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]
    ),
    GIT_ASKPASS: ASKPASS,
    GIT_TERMINAL_PROMPT: '0',
  }
  if (token) {
    env['GIT_TOKEN'] = token
  }

  return new Promise((resolve) => {
    const proc = spawn('git', [...extraArgs, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false, // NEVER shell: true
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 })
    })
    proc.on('error', (err) => {
      resolve({ stdout: '', stderr: err.message, code: 1 })
    })
  })
}

export async function runGitOrThrow(
  cwd: string,
  args: string[],
  identity?: GitIdentity,
): Promise<string> {
  const result = await runGit(cwd, args, identity)
  if (result.code !== 0) {
    // Never include the token in the error message
    const msg = result.stderr.replace(process.env.GIT_TOKEN ?? '__no_token__', '[REDACTED]')
    throw new Error(`git ${args[0]} failed (exit ${result.code}): ${msg}`)
  }
  return result.stdout
}
