/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

module.exports = function loadTypeScript(entry, globals = {}) {
  const cache = new Map()
  const load = filename => {
    const resolved = filename.endsWith('.ts') ? filename : `${filename}.ts`
    if (cache.has(resolved)) return cache.get(resolved).exports
    const loadedModule = { exports: {} }
    cache.set(resolved, loadedModule)
    const source = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    const localRequire = request => {
      if (request === 'server-only') return {}
      if (request.startsWith('.')) return load(path.resolve(path.dirname(resolved), request))
      return require(request)
    }
    vm.runInNewContext(source, {
      ...globals,
      module: loadedModule,
      exports: loadedModule.exports,
      require: localRequire,
      crypto,
      AbortSignal,
      URL,
      setTimeout,
      clearTimeout
    }, { filename: resolved })
    return loadedModule.exports
  }
  return load(path.resolve(__dirname, entry))
}
