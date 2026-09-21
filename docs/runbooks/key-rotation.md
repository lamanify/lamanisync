# LamaniSync — Key Rotation Playbook

This playbook documents zero-downtime procedures for rotating Ed25519 manifest signing root keys and rotating clinic device session tokens, strictly adhering to AGENTS.md Rules 2, 4, and 9.

---

## 1. Key Architecture & Roles

| Key Type | Algorithm | Storage Location | Lifetime | Rotation Frequency | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Manifest Root Signing Key** | Ed25519 | Offline HSM / AWS KMS | 2 years | Annual / On Compromise | Signs dynamic adapter manifests |
| **Manifest Verification Key** | Ed25519 (SPKI) | Extension bundle (`verifier.ts`) | 2 years | Annual / Paired with Root | Validates manifest integrity in browser |
| **Device ECDSA / Ed25519 Key** | ECDSA P-256 / Ed25519 | Workstation IndexedDB (non-exportable) | Indefinite | On Re-pairing / Device Wipe | Signs client sync requests |
| **Device Session Token (JWT)** | EdDSA / ES256 | `chrome.storage.local` (encrypted) | 24 hours | Daily (Proactive at 80% TTL) | Authenticates sync requests to LamaniHub |

---

## 2. Ed25519 Root Key Zero-Downtime Rotation Procedure

Rotating the root key requires a phased overlap to ensure extensions running older versions continue verifying manifests until updated via Chrome Web Store.

```plain text
[Phase 1: Generate & Stage]  ──>  [Phase 2: Extension Update]
            │
            ▼
[Phase 3: Dual-Sign / Switch] ──>  [Phase 4: Deprecate & Retire Old Key]
```

### Phase 1: Generate New Key Pair
1. Generate a new high-entropy Ed25519 key pair in offline HSM or secure vault:
   ```bash
   node -e '
     const crypto = require("node:crypto");
     const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
       publicKeyEncoding: { type: "spki", format: "pem" },
       privateKeyEncoding: { type: "pkcs8", format: "pem" }
     });
     console.log("=== NEW PUBLIC KEY ===");
     console.log(publicKey);
   '
   ```
2. Store the private key securely in the signing HSM / KMS vault.

### Phase 2: Stage New Key in Extension Bundle
1. Add the new public key to the trusted key set in `src/adapters/verifier.ts`:
   ```typescript
   export const TRUSTED_PUBLIC_KEYS = [
     PRIMARY_ACTIVE_PUBLIC_KEY,   // Old key (active)
     STAGED_NEXT_PUBLIC_KEY,      // New key (staged)
   ];
   ```
2. Submit extension update to Chrome Web Store (e.g. `v0.1.1`).
3. Monitor extension adoption until > 95% of active clinic installations have updated to `v0.1.1`.

### Phase 3: Switch Active Signing Key
1. Update LamaniHub manifest packaging pipeline to sign manifests with the new private key.
2. Verify that both updated extensions and existing extensions successfully validate the signed payload.
3. If an extension on an older version fails verification, `ManifestLifecycleManager` gracefully falls back to the Last-Known-Good (LKG) cached manifest without service disruption.

### Phase 4: Retire Old Key
1. After 30 days of 100% fleet adoption, remove the retired public key from the primary slot.
2. Mark the retired key as revoked in the LamaniHub key registry.
3. Archive the retired private key in cold vault storage.

---

## 3. Emergency Key Revocation (Compromised Key)

If a manifest signing key is suspected compromised:

1. **Trigger Global Kill-Switch Immediately**:
   - Halts extension manifest updates globally within 30 seconds.
2. **Deploy Emergency Extension Patch**:
   - Release hotfix with revoked key removed and emergency key pinned.
3. **Rollback Fleet to LKG**:
   - Active extensions automatically retain their verified Last-Known-Good manifest.
4. **Re-Sign All Manifests**:
   - Re-sign all certified adapter manifests with the emergency root key.
5. **Resume Operations**:
   - Lift global kill-switch once the patched extension version is deployed.

---

## 4. Device Session Token Rotation

Device session tokens are managed automatically by `TokenManager` (`src/background/token-manager.ts`):

1. **Normal Lifecycle**:
   - Initial pairing issues a 24-hour JWT token.
   - `TokenManager` calculates 80% TTL expiration mark (at ~19.2 hours).
   - An alarm triggers background token refresh via `POST /api/v1/sync/refresh`.
2. **Manual Device Revocation**:
   - In the event of lost clinic hardware or workstation decommissioning:
     ```bash
     curl -X POST "https://sync.lamanify.com/api/v1/sync/revoke" \
       -H "Authorization: Bearer $LAMANI_ADMIN_TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"installationId": "inst_clinic_east_01", "reason": "Staff workstation decommissioned"}'
     ```
   - All subsequent requests from the revoked device return HTTP 403 Forbidden with `code: "REVOKED"`.
   - The extension permanently transitions `ConnectionFSM` to `REVOKED`, purges session tokens, and displays the revocation notice.
