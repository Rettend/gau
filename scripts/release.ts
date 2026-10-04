import { npmRegistry, runCommand, type RunCommand } from './release-shared'

export async function release(args: string[], run: RunCommand = runCommand): Promise<void> {
  if (!args.some((arg) => ['--help', '-h', '--version', '-v'].includes(arg))) {
    // The release CLI cannot discover npm authentication behind our publish helper.
    // Check it before the CLI changes versions, commits, tags, or pushes anything.
    try {
      await run(['bun', 'pm', 'whoami', '--cwd', 'packages/gau', '--registry', npmRegistry])
    } catch {
      throw new Error('Bun could not verify npm authentication. Refresh your npm credentials, then retry the release.')
    }
  }
  await run(['bun', 'node_modules/@rttnd/release/dist/cli.js', ...args])
}

if (import.meta.main) await release(process.argv.slice(2))
