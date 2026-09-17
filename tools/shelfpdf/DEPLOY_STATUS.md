# ShelfPDF deployment status

- Status: failed
- Runtime setup: skipped
- Test fixtures: skipped
- Browser E2E: failure
- Checks: public page, image-to-PDF download, DRM-free EPUB preview
- Commit: 4d64b4e308cc57dffa6e63d29497ba2448d603b8
- URL: https://suisan-neki.github.io/packet-poipoi/tools/shelfpdf/
- Workflow: https://github.com/Suisan-neki/packet-poipoi/actions/runs/35210365588

```text
--- e2e.log ---
node:internal/modules/cjs/loader:1433
  throw err;
  ^

Error: Cannot find module '/home/runner/work/packet-poipoi/packet-poipoi/tools/shelfpdf/e2e.mjs'
    at Function._resolveFilename (node:internal/modules/cjs/loader:1430:15)
    at defaultResolveImpl (node:internal/modules/cjs/loader:1040:19)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1045:22)
    at Function._load (node:internal/modules/cjs/loader:1216:25)
    at wrapModuleLoad (node:internal/modules/cjs/loader:254:19)
    at Function.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:171:5)
    at node:internal/main/run_main_module:36:49 {
  code: 'MODULE_NOT_FOUND',
  requireStack: []
}

Node.js v22.23.2
```
