# AGENTS.md

Project: LamaniSync Chrome Extension

1. Build Manifest V3 only.
2. Never use eval, new Function, remote JavaScript, dynamic remote imports, or arbitrary remote expressions.
3. Never request a runtime host permission broader than the exact paired CMS origin.
4. Never copy or transmit CMS passwords, cookies, bearer tokens, or CSRF secrets to LamaniHub.
5. Never use production patient data or credentials in development or tests.
6. Do not store raw PHI in chrome.storage.local.
7. Treat the MV3 service worker as ephemeral; correctness must survive suspension and restart.
8. Page-world code may execute only predefined adapter action IDs—never arbitrary remote URL/method/body instructions.
9. Validate every message and remote manifest at runtime.
10. An appointment is not confirmed until the CMS write is read back and verified.
11. Add tests with every behavior change. Run lint, typecheck, unit tests, build, and relevant browser tests before declaring completion.
12. Work one phase at a time. Stop at the stated acceptance gate and summarize files, tests, risks, and manual checks.
13. Do not add a dependency or permission without explaining why it is needed and recording it in CHROMEWEBSTORE.md.
14. Never modify LamaniHub production or a live CMS unless the task explicitly states that written authorization and a dummy-record protocol are in place.
