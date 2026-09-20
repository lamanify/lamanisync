# LamaniSync API Contract Specification

This document provides the complete API contract between the LamaniSync Chrome Extension, the Target Cloud CMS (Mock CMS), and the LamaniHub Sync Service (Mock Sync API).

---

## 1. Network Topology & Fixed Origins

| Service | Base URL | Role |
| :--- | :--- | :--- |
| **Mock Cloud CMS** | `http://localhost:4001` | Simulates the clinic EHR/CMS web application session |
| **Mock Sync API** | `http://localhost:4002` | Simulates the LamaniHub synchronization & command gateway |

Both servers run locally and never connect to external network hosts.

---

## 2. Mock Cloud CMS Contract (`http://localhost:4001`)

### 2.1 Authentication & Session

#### `POST /api/auth/login`
Simulates staff logging into the cloud CMS web application.

- **Request Body**:
  ```json
  {
    "username": "staff_alice",
    "password": "dummy_password"
  }
  ```
- **Response `200 OK`**:
  ```json
  {
    "token": "mock-cms-session-token",
    "staff": {
      "id": "STF-01",
      "name": "Staff Alice",
      "role": "receptionist"
    }
  }
  ```
- **Response Headers**:
  `Set-Cookie: cms_session=dummy_staff_cookie; Path=/; HttpOnly; SameSite=Lax`

#### `GET /api/auth/session`
Validates whether the active browser tab has a live CMS session.

- **Headers**: `Cookie: cms_session=dummy_staff_cookie` or `Authorization: Bearer mock-cms-session-token`
- **Response `200 OK`**:
  ```json
  {
    "authenticated": true,
    "staff": {
      "id": "STF-01",
      "name": "Staff Alice",
      "role": "receptionist"
    },
    "clinicId": "CLN-001"
  }
  ```
- **Error `401 Unauthorized`**:
  ```json
  {
    "error": "UNAUTHORIZED",
    "message": "Missing or expired session cookie"
  }
  ```

---

### 2.2 Patient Management

#### `GET /api/patients`
List patients with search and pagination.

- **Query Parameters**:
  - `q` *(optional)*: Search string across full name, phone number, or MRN.
  - `page` *(optional, default: 1)*: Page number.
  - `limit` *(optional, default: 50)*: Page size.
- **Response `200 OK`**:
  ```json
  {
    "data": [
      {
        "id": "ZZTEST-P01",
        "mrn": "MRN-ZZ-001",
        "fullName": "ZZTEST Patient 01",
        "icOrPassport": "900101-14-5001",
        "phone": "+60123456701",
        "email": "zztest.patient01@example.test",
        "dateOfBirth": "1990-01-01",
        "gender": "female",
        "createdAt": "2026-01-01T08:00:00+08:00",
        "updatedAt": "2026-01-01T08:00:00+08:00"
      }
    ],
    "total": 1
  }
  ```

#### `GET /api/patients/:id`
Retrieve single patient by external CMS ID.

- **Response `200 OK`**:
  ```json
  {
    "data": {
      "id": "ZZTEST-P01",
      "mrn": "MRN-ZZ-001",
      "fullName": "ZZTEST Patient 01",
      "icOrPassport": "900101-14-5001",
      "phone": "+60123456701",
      "email": "zztest.patient01@example.test",
      "dateOfBirth": "1990-01-01",
      "gender": "female",
      "createdAt": "2026-01-01T08:00:00+08:00",
      "updatedAt": "2026-01-01T08:00:00+08:00"
    }
  }
  ```
- **Error `404 Not Found`**:
  ```json
  {
    "error": "NOT_FOUND",
    "message": "Patient ZZTEST-P99 not found"
  }
  ```

#### `POST /api/patients`
Register a new patient record in the CMS.

- **Request Body**:
  ```json
  {
    "fullName": "ZZTEST Patient 05",
    "phone": "+60123456705",
    "icOrPassport": "960505-14-5005",
    "email": "zztest.patient05@example.test",
    "dateOfBirth": "1996-05-05",
    "gender": "female"
  }
  ```
- **Response `201 Created`**:
  ```json
  {
    "data": {
      "id": "ZZTEST-P05",
      "mrn": "MRN-ZZ-005",
      "fullName": "ZZTEST Patient 05",
      "icOrPassport": "960505-14-5005",
      "phone": "+60123456705",
      "email": "zztest.patient05@example.test",
      "dateOfBirth": "1996-05-05",
      "gender": "female",
      "createdAt": "2026-09-21T05:45:00.000Z",
      "updatedAt": "2026-09-21T05:45:00.000Z"
    }
  }
  ```
- **Error `400 Bad Request`**:
  ```json
  {
    "error": "BAD_REQUEST",
    "message": "fullName and phone are required"
  }
  ```

#### `PUT /api/patients/:id`
Update an existing patient record.

- **Request Body**: Partial update object (e.g. `{ "phone": "+60123456799" }`)
- **Response `200 OK`**: Updated patient entity with refreshed `updatedAt`.
- **Error `404 Not Found`**: Patient ID not found.

---

### 2.3 Appointments & Availability

#### `GET /api/appointments`
Query appointments with optional filters.

- **Query Parameters**:
  - `status` *(optional)*: Filter by status (`booked`, `cancelled`, `completed`).
  - `providerId` *(optional)*: Filter by doctor ID (`DOC-01`).
- **Response `200 OK`**:
  ```json
  {
    "data": [
      {
        "id": "APT-001",
        "patientId": "ZZTEST-P01",
        "providerId": "DOC-01",
        "serviceId": "SRV-01",
        "locationId": "LOC-01",
        "startTime": "2026-10-01T09:00:00+08:00",
        "endTime": "2026-10-01T09:15:00+08:00",
        "status": "booked",
        "notes": "Initial checkup",
        "rev": 1,
        "createdAt": "2026-09-01T10:00:00+08:00",
        "updatedAt": "2026-09-01T10:00:00+08:00"
      }
    ],
    "total": 1
  }
  ```

#### `GET /api/appointments/availability`
Check doctor slot availability for a specified date.

- **Query Parameters**:
  - `providerId`: Doctor ID (e.g. `DOC-01`).
  - `date`: Calendar date in `YYYY-MM-DD` format (e.g. `2026-10-01`).
- **Response `200 OK`**:
  ```json
  {
    "providerId": "DOC-01",
    "date": "2026-10-01",
    "slots": [
      { "startTime": "2026-10-01T09:00:00+08:00", "available": false },
      { "startTime": "2026-10-01T09:30:00+08:00", "available": true }
    ]
  }
  ```

#### `POST /api/appointments`
Book a new appointment. Rejects double bookings on active slots with `409 Conflict`.

- **Request Body**:
  ```json
  {
    "patientId": "ZZTEST-P01",
    "providerId": "DOC-01",
    "serviceId": "SRV-01",
    "locationId": "LOC-01",
    "startTime": "2026-10-01T11:00:00+08:00",
    "endTime": "2026-10-01T11:15:00+08:00",
    "notes": "Follow-up consultation"
  }
  ```
- **Response `201 Created`**:
  ```json
  {
    "data": {
      "id": "APT-003",
      "patientId": "ZZTEST-P01",
      "providerId": "DOC-01",
      "serviceId": "SRV-01",
      "locationId": "LOC-01",
      "startTime": "2026-10-01T11:00:00+08:00",
      "endTime": "2026-10-01T11:15:00+08:00",
      "status": "booked",
      "notes": "Follow-up consultation",
      "rev": 1,
      "createdAt": "2026-09-21T05:45:00.000Z",
      "updatedAt": "2026-09-21T05:45:00.000Z"
    }
  }
  ```
- **Error `409 Conflict` (Slot Collision)**:
  ```json
  {
    "error": "CONFLICT",
    "message": "Provider DOC-01 is already booked at 2026-10-01T09:00:00+08:00",
    "existingAppointmentId": "APT-001"
  }
  ```

#### `PUT /api/appointments/:id`
Reschedule or modify appointment details. Enforces revision fencing (`rev` or `If-Match`).

- **Request Body**:
  ```json
  {
    "startTime": "2026-10-01T14:00:00+08:00",
    "endTime": "2026-10-01T14:15:00+08:00",
    "expectedRev": 1
  }
  ```
- **Response `200 OK`**:
  ```json
  {
    "data": {
      "id": "APT-001",
      "startTime": "2026-10-01T14:00:00+08:00",
      "endTime": "2026-10-01T14:15:00+08:00",
      "status": "booked",
      "rev": 2,
      "updatedAt": "2026-09-21T05:45:00.000Z"
    }
  }
  ```
- **Error `409 Conflict` (Revision Mismatch)**:
  ```json
  {
    "error": "CONFLICT",
    "message": "Revision mismatch. Current revision is 2, expected 1",
    "currentRev": 2
  }
  ```

#### `DELETE /api/appointments/:id`
Cancel an appointment. Retains record with `status: "cancelled"` and increments `rev`.

- **Response `200 OK`**:
  ```json
  {
    "data": {
      "id": "APT-001",
      "status": "cancelled",
      "rev": 2,
      "updatedAt": "2026-09-21T05:45:00.000Z"
    },
    "message": "Appointment cancelled successfully"
  }
  ```

---

### 2.4 Reference Data

- `GET /api/reference/providers`: Returns list of active practitioners.
- `GET /api/reference/services`: Returns list of clinic services with standard duration and pricing.
- `GET /api/reference/locations`: Returns list of consultation rooms and treatment suites.

---

### 2.5 Admin Endpoints & Fault Controls

#### `POST /__admin/fault`
Sets global deliberate fault condition for all subsequent CMS requests.

- **Request Body**:
  ```json
  {
    "fault": "401" | "403" | "409" | "429" | "500" | "slow" | "drift" | "none",
    "delayMs": 1500
  }
  ```
- **Response `200 OK`**: `{ "status": "ok", "globalFault": "401", "delayMs": 1500 }`

#### `POST /__admin/reset`
Resets all patients, appointments, and faults back to the baseline deterministic synthetic fixtures.

- **Response `200 OK`**: `{ "status": "ok", "message": "Fixtures and faults reset to initial state" }`

---

## 3. Mock LamaniHub Sync API Contract (`http://localhost:4002`)

### 3.1 Device Pairing & Installation

#### `POST /v1/sync/installations/pair`
Pairs a Chrome extension installation with a clinic connection using a short-lived pairing code and non-exportable client public key.

- **Request Body**:
  ```json
  {
    "pairingCode": "PAIR-TEST-123",
    "clientPublicKey": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...",
    "deviceName": "Front Desk Chrome Profile"
  }
  ```
- **Response `200 OK`**:
  ```json
  {
    "installationId": "inst_mock_12345",
    "connectionId": "conn_mock_67890",
    "clinicId": "CLN-001",
    "sessionToken": "stk_mock_98765",
    "expiresAt": "2026-10-01T00:00:00Z",
    "targetOrigin": "http://localhost:4001"
  }
  ```
- **Error `400 Bad Request` (Expired Code)**:
  ```json
  {
    "error": "PAIRING_CODE_EXPIRED",
    "message": "The pairing code has expired"
  }
  ```

#### `POST /v1/sync/installations/heartbeat`
Extension periodic health ping updating freshness timestamps.

- **Request Body**:
  ```json
  {
    "installationId": "inst_mock_12345",
    "version": "0.1.0",
    "status": "ACTIVE"
  }
  ```
- **Response `200 OK`**: `{ "status": "ok", "serverTime": "2026-09-21T05:45:00.000Z" }`

#### `POST /v1/sync/installations/revoke`
Revokes an installation server-side during unpair flow.

- **Request Body**: `{ "installationId": "inst_mock_12345" }`
- **Response `200 OK`**: `{ "status": "revoked" }`

---

### 3.2 Adapter Distribution

#### `GET /v1/sync/connections/:id/adapter`
Fetches the signed adapter manifest defining allowlisted endpoints, transforms, and capabilities.

- **Response `200 OK`**:
  ```json
  {
    "adapterId": "acme-cloud-v1",
    "name": "ACME Cloud CMS Adapter (Mock)",
    "version": "1.0.0",
    "targetOrigin": "http://localhost:4001",
    "signature": "simulated_ed25519_signature_test_key_valid",
    "capabilities": [
      "PATIENT_READ",
      "PATIENT_WRITE",
      "APPOINTMENT_READ",
      "APPOINTMENT_WRITE",
      "REFERENCE_DATA_READ"
    ]
  }
  ```

---

### 3.3 Event Ingestion

#### `POST /v1/sync/events/batch`
Ingests batches of normalized, redacted change events observed by the extension runner.

- **Request Body**:
  ```json
  {
    "installationId": "inst_mock_12345",
    "batchId": "batch_999",
    "events": [
      {
        "eventId": "evt_001",
        "entityType": "appointment",
        "entityId": "APT-001",
        "eventType": "APPOINTMENT_BOOKED",
        "revision": 1,
        "occurredAt": "2026-09-21T05:40:00Z",
        "payload": { "patientId": "ZZTEST-P01", "providerId": "DOC-01" }
      }
    ]
  }
  ```
- **Response `200 OK`**:
  ```json
  {
    "acknowledged": true,
    "batchId": "batch_999",
    "processedCount": 1,
    "checkpoint": "chk_1758433500000"
  }
  ```

---

### 3.4 Leader Lease Coordination (Fenced)

#### `POST /v1/sync/leases/acquire`
Acquires a single-leader lease for tenant-level polling and synchronization. Enforces monotonic fencing tokens.

- **Request Body**:
  ```json
  {
    "connectionId": "conn_mock_67890",
    "installationId": "inst_mock_12345",
    "durationSeconds": 30
  }
  ```
- **Response `200 OK` (Granted)**:
  ```json
  {
    "status": "GRANTED",
    "leaseId": "lease_conn_mock_67890_1",
    "fencingToken": 1,
    "expiresAt": "2026-09-21T05:45:30.000Z"
  }
  ```
- **Error `409 Conflict` (Held by another device)**:
  ```json
  {
    "status": "DENIED",
    "error": "LEASE_CONFLICT",
    "message": "Another installation holds the active leader lease",
    "currentHolder": "inst_other_999",
    "expiresAt": "2026-09-21T05:45:28.000Z"
  }
  ```

#### `POST /v1/sync/leases/renew`
Extends lease expiration if the installation holds the current fencing token.

- **Request Body**:
  ```json
  {
    "connectionId": "conn_mock_67890",
    "leaseId": "lease_conn_mock_67890_1",
    "fencingToken": 1,
    "installationId": "inst_mock_12345",
    "durationSeconds": 30
  }
  ```
- **Response `200 OK`**: `{ "status": "RENEWED", "expiresAt": "..." }`

#### `POST /v1/sync/leases/release`
Releases leader lease explicitly upon clean shutdown or tab disconnect.

- **Request Body**:
  ```json
  {
    "connectionId": "conn_mock_67890",
    "leaseId": "lease_conn_mock_67890_1"
  }
  ```
- **Response `200 OK`**: `{ "status": "RELEASED" }`

---

### 3.5 Outbox Command Execution & Verification

#### `GET /v1/sync/outbox/next`
Pulls next pending outbound command dispatched by LamaniHub for browser-side execution.

- **Query Parameters**: `connectionId=conn_mock_67890`
- **Response `200 OK` (Pending Command)**:
  ```json
  {
    "command": {
      "commandId": "CMD-TEST-001",
      "connectionId": "conn_mock_67890",
      "actionId": "CREATE_APPOINTMENT",
      "payload": {
        "patientId": "ZZTEST-P01",
        "providerId": "DOC-01",
        "serviceId": "SRV-01",
        "locationId": "LOC-01",
        "startTime": "2026-10-02T14:00:00+08:00",
        "endTime": "2026-10-02T14:15:00+08:00",
        "notes": "Sync API dispatched booking"
      },
      "status": "LEASED"
    }
  }
  ```
- **Response `200 OK` (No Pending Commands)**:
  ```json
  {
    "command": null
  }
  ```

#### `POST /v1/sync/outbox/:commandId/result`
Reports the read-after-write verified result of command execution.

- **Request Body**:
  ```json
  {
    "status": "VERIFIED",
    "writeReceipt": {
      "externalId": "APT-004",
      "revision": 1,
      "verifiedAt": "2026-09-21T05:45:00Z"
    }
  }
  ```
- **Response `200 OK`**:
  ```json
  {
    "acknowledged": true,
    "commandId": "CMD-TEST-001",
    "status": "VERIFIED"
  }
  ```

---

## 4. Concurrency & Fault Taxonomy

```plain text
HTTP Status | Contract Error Code     | Meaning / Handling Strategy
------------|-------------------------|---------------------------------------------
401         | UNAUTHORIZED            | Session expired; extension moves to REAUTH_REQUIRED
403         | FORBIDDEN               | Privilege violation; extension reports DEGRADED
409         | CONFLICT                | Slot collision or revision mismatch; triggers outbox CONFLICT
429         | RATE_LIMITED            | CMS backpressure; extension respects Retry-After seconds
500         | INTERNAL_ERROR          | CMS crashed/timed out; extension schedules exponential retry
```
