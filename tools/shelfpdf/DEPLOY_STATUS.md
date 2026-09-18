# ShelfPDF deployment status

- Status: failed
- Runtime setup: cancelled
- Test fixtures: skipped
- Browser E2E: failure
- Checks: public page, image-to-PDF download, DRM-free EPUB preview
- Commit: 9fcbbbe871b81eeb2aa5d86e0839212533f690c8
- URL: https://suisan-neki.github.io/packet-poipoi/tools/shelfpdf/
- Workflow: https://github.com/Suisan-neki/packet-poipoi/actions/runs/35335551093

```text
--- runtime.log ---
update-alternatives: using /usr/share/fonts/opentype/ipafont-gothic/ipag.ttf to provide /usr/share/fonts/truetype/fonts-japanese-gothic.ttf (fonts-japanese-gothic.ttf) in auto mode
Setting up fonts-unifont (1:15.1.01-1build1) ...
Setting up xfonts-utils (1:7.7+6build3) ...
Setting up xfonts-cyrillic (1:1.0.5+nmu1) ...
Setting up xfonts-scalable (1:1.0.3-1.3) ...
Processing triggers for man-db (2.12.0-4build2) ...
Not building database; man-db/auto-update is not 'true'.
Processing triggers for fontconfig (2.15.0-1.1ubuntu2) ...

Running kernel seems to be up-to-date.

No services need to be restarted.

No containers need to be restarted.

No user sessions are running outdated binaries.

No VM guests are running outdated hypervisor (qemu) binaries on this host.
Downloading Chromium 140.0.7339.16 (playwright build v1187) from https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1187/chromium-linux.zip
|                                                                                |   0% of 173.7 MiB
|■■■■■■■■                                                                        |  10% of 173.7 MiB
|■■■■■■■■■■■■■■■■                                                                |  20% of 173.7 MiB
|■■■■■■■■■■■■■■■■■■■■■■■■                                                        |  30% of 173.7 MiB
|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■                                                |  40% of 173.7 MiB
|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■                                        |  50% of 173.7 MiB
|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■                                |  60% of 173.7 MiB
|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■                        |  70% of 173.7 MiB
|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■                |  80% of 173.7 MiB
|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■        |  90% of 173.7 MiB
|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■| 100% of 173.7 MiB
--- e2e.log ---
node:internal/modules/run_main:123
    triggerUncaughtException(
    ^

browserType.launch: Executable doesn't exist at /home/runner/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell
╔═════════════════════════════════════════════════════════════════════════╗
║ Looks like Playwright Test or Playwright was just installed or updated. ║
║ Please run the following command to download new browsers:              ║
║                                                                         ║
║     npx playwright install                                              ║
║                                                                         ║
║ <3 Playwright Team                                                      ║
╚═════════════════════════════════════════════════════════════════════════╝
    at /home/runner/work/packet-poipoi/packet-poipoi/tools/shelfpdf/e2e.mjs:9:32 {
  name: 'Error'
}

Node.js v22.23.2
```
