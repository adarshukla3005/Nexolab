export function resolveCloneUrl(url: string): string {
  // Normalize GitLab URL — accepts cloud and self-hosted
  const m = url.match(/https?:\/\/([\w.:-]+)\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/)
  if (!m) throw new Error(`Cannot resolve GitLab clone URL: ${url}`)
  return `https://${m[1]}/${m[2]}.git`
}

export function detectGitLab(url: string): boolean {
  return /gitlab\.com/.test(url) || Boolean(url.match(/https?:\/\/([\w.:-]+)\//) && !url.includes('github.com'))
}
