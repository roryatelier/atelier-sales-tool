// Next's dev worker can still write .next after SIGTERM is sent. Wait for the
// child and its inherited streams to close before removing the fixture tree.
module.exports = async function stopFixtureServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return
  await new Promise((resolve, reject) => {
    const force = setTimeout(() => server.kill('SIGKILL'), 5000)
    const deadline = setTimeout(() => { cleanup(); reject(new Error('Fixture server did not stop')) }, 10000)
    const cleanup = () => { clearTimeout(force); clearTimeout(deadline) }
    server.once('close', () => { cleanup(); resolve() })
    server.kill('SIGTERM')
  })
}
