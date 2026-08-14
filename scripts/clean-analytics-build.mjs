import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'packages', 'analytics', 'lib')

async function removeBundledJavaScript(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'types') await removeBundledJavaScript(target)
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.js')) await fs.unlink(target)
  }
}

async function removeTestDeclarations(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) await removeTestDeclarations(target)
    else if (entry.isFile() && entry.name.includes('.test.')) await fs.unlink(target)
  }
}

await fs.mkdir(output, { recursive: true })
await removeBundledJavaScript(output)
await removeTestDeclarations(path.join(output, 'types'))
