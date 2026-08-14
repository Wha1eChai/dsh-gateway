const [lane, phase] = process.argv.slice(2)

if (!lane || !phase) {
  throw new Error('usage: phase-not-implemented.mjs <lane> <phase>')
}

process.stderr.write(`${lane} is intentionally unavailable until Phase ${phase}; this is not a passing or skipped test.\n`)
process.exitCode = 2
