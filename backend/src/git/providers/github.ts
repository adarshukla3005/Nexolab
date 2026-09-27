export function resolveCloneUrl(url: string): string {
  // Convert HTTPS GitHub URL to token-auth URL — token injected via GIT_ASKPASS at runtime
  const m = url.match(/https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/)
  if (!m) throw new Error(`Not a GitHub HTTPS URL: ${url}`)
  return `https://github.com/${m[1]}.git`
}

export function detectGitHub(url: string): boolean {
  return /github\.com/.test(url)
}
