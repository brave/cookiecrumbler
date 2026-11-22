// Entrypoint for the API server: the only place with process concerns
// (CLI arguments, browser-binary check, startup logs, listen). The app
// itself is built by src/api.mjs.

import { existsSync } from 'fs'
import process from 'process'

import { createApp } from './api.mjs'

const browserBinaryPath = process.argv[2] || '/usr/bin/brave'
const port = process.argv[3] || 3000

if (!existsSync(browserBinaryPath)) {
  console.error(`Path ${browserBinaryPath} does not exist.`)
  console.error('Please specify an alternative on the command line.')
  process.exit(-1)
}

console.log(`Browser binary: ${browserBinaryPath}`)
console.log(`Port: ${port}`)

createApp({ browserBinaryPath }).listen(port)
