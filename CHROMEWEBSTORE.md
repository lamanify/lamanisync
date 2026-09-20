# Chrome Web Store Permission Justifications & Extension Metadata

**Extension Name**: LamaniSync Dev  
**Manifest Version**: 3  
**Description**: Secure bridge between authenticated cloud CMS tabs and LamaniHub  

---

## 1. Declared Permissions

### `storage`
- **Why it is needed**:  
  Used to persist ephemeral connection session metadata (`installationId`, `connectionId`, `clinicId`, `targetOrigin`, and short-lived LamaniHub `sessionToken`) across service worker suspensions and browser restarts (AGENTS.md Rule 7).
- **Security & Privacy Boundary**:  
  In strict compliance with AGENTS.md Rules 4 and 6, `chrome.storage.local` is **never** used to store CMS passwords, session cookies, bearer tokens, CSRF secrets, or raw Patient Health Information (PHI). Only connection metadata and LamaniHub session tokens are stored.

### `scripting`
- **Why it is needed**:  
  Used strictly via `chrome.scripting.registerContentScripts` and `chrome.scripting.unregisterContentScripts` to dynamically register the safe page integration bridge scripts matching exclusively the exact paired CMS origin (`toExactOriginPattern(targetOrigin)`). Scripts are never declared statically with broad patterns (`<all_urls>` or wildcards), fulfilling AGENTS.md Rule 3.
- **Security & Privacy Boundary**:  
  Dynamic script registration is triggered strictly after explicit device pairing and user-approved host permission. When permissions are revoked or the device is unpaired, dynamic scripts are immediately unregistered. No remote scripts or dynamic code evaluation (`eval`, `new Function`) are ever executed (AGENTS.md Rule 2).

### `chrome.permissions` API (Manifest Check)
- **Status in Manifest**:  
  The `chrome.permissions` API is an intrinsic Chrome Extensions API and does not require or accept a `'permissions'` permission token in `permissions: []` in Manifest V3. Attempting to declare `'permissions'` inside `permissions` generates a Chrome manifest warning and Web Store review flag (`unrecognized permission`). The extension uses the built-in `chrome.permissions` API (`request`, `contains`, `remove`, `onRemoved`) strictly to manage optional host permissions.

---

## 2. Optional Host Permissions

### `optional_host_permissions` (`http://localhost:4001/*`, `https://*/*`)
- **Why it is needed**:  
  Allows the extension to request runtime host permissions dynamically via `chrome.permissions.request()` only after the device has successfully paired with a specific clinic CMS origin.
- **Security & Privacy Boundary**:  
  In strict compliance with AGENTS.md Rule 3:
  - **Zero Broad Host Permissions**: Wildcards (such as `*://*/*` or `https://*/*`) are strictly rejected at runtime by `validateOriginMatch` and `normalizeExactOrigin`.
  - **Exact Origin Only**: The extension prompts the staff user for host permission covering **only the exact paired CMS origin** (e.g. `http://localhost:4001` or clinical HTTPS domain) returned during the pairing handshake.
  - **User Gesture Required**: Host permission prompts are triggered exclusively by an explicit user click on the "Grant CMS Access" button in the extension popup (never automatically).
  - **Clean Revocation**: When the device is unpaired or revoked, host permissions are immediately dropped via `chrome.permissions.remove()`.

---

## 3. Remote Code & Content Security Policy (CSP)

- No remote code (`eval`, `new Function`, dynamic remote script tags) is used or loaded (AGENTS.md Rule 2).
- All execution logic is packaged locally within the extension bundle.
