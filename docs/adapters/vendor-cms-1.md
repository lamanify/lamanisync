# Vendor CMS #1 Adapter Reconnaissance & Architecture Specification

**Document Version:** 1.0.0  
**Target System:** Vendor CMS #1 (MedCloud / ClinicSoft Cloud CMS)  
**Certification Status:** CERTIFIED (Phase 12)  
**Governing Rules:** AGENTS.md Rules 3, 4, 5, 8, 10, 14  

---

## 1. Executive Summary & Authorization Protocol

Vendor CMS #1 is a cloud-hosted Clinic Management System (CMS) widely deployed across Malaysian general practice (GP) and specialized healthcare clinics. This specification documents the certified integration architecture between LamaniSync Chrome Extension and Vendor CMS #1.

### Written Authorization & Protocol (AGENTS.md Rule 14)
- **Authorization Gate:** Integration is strictly restricted to authorized clinic tenants with signed Data Processing Agreements (DPA) and Vendor Interface Agreements.
- **Dedicated Staging/Sandbox Origin:** Development and contract certifications execute exclusively against dedicated sandbox endpoints (`http://localhost:4001` or sandbox cloud tenant `https://sandbox.vendor-cms-1.local`).
- **Synthetic Data Isolation:** Zero live production patient data is utilized during development, automated contract testing, or certification audits (AGENTS.md Rule 5). All synthetic records carry explicit test prefixes (`ZZTEST-*`).

---

## 2. Session Mechanics & Security Boundary

### 2.1 Ambient Browser Authentication (AGENTS.md Rule 4)
- **Session Transport:** Vendor CMS #1 utilizes HttpOnly, Secure, SameSite=Lax session cookies (`cms_session`).
- **Zero-Secret Transmission:** The LamaniSync extension never inspects, captures, decrypts, or transmits `cms_session` cookies, passwords, or bearer tokens to LamaniHub or any remote server.
- **Ambient Context:** Page-world and content-script bridge operations rely exclusively on the browser's ambient credential forwarding during same-origin requests initiated from the clinic staff's authenticated tab.

### 2.2 CSRF Protection Mechanism
- **CSRF Token Source:** Embedded in page DOM via `<meta name="csrf-token" content="...">` and replicated in a readable cookie (`cms_csrf`).
- **CSRF Extraction Hook:** Managed via allowlisted packaged hook `vendor-cms-1-extract-csrf`.
- **Request Header:** All state-modifying requests (`POST`, `PUT`, `DELETE`) require header `X-CSRF-Token: <token>`.

### 2.3 Required Minimum Staff Role
- **Minimum Role:** `receptionist` or `clinic_assistant`.
- **Allowed Operations:**
  - View clinic appointment calendar and patient roster.
  - Check provider availability.
  - Register new patients.
  - Book, reschedule, and cancel appointments.
- **Enforcement:** The adapter gracefully detects HTTP 403 (`FORBIDDEN`) when an under-privileged staff profile is active and alerts the user without leaking data or corrupting state.

---

## 3. Endpoint Inventory & Request/Response Schemas

All paths are relative to the validated origin (AGENTS.md Rule 3: exact origin match only).

### 3.1 Patient Management

#### `GET /api/patients`
- **Capability:** `PATIENT_READ` / `patients.read`
- **Query Parameters:**
  - `q` (string, optional): Search query (patient name, phone, or MRN).
  - `page` (integer, optional, default: 1): 1-indexed pagination page.
  - `limit` (integer, optional, default: 50, max: 100): Page limit.
- **Response Format (200 OK):**
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
- **Capability:** `PATIENT_READ` / `patients.read`
- **URL Parameters:** `id` (string, required): Patient identifier.
- **Response Format (200 OK):**
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

#### `POST /api/patients`
- **Capability:** `PATIENT_WRITE` / `patients.create`
- **Headers:** `Content-Type: application/json`, `X-CSRF-Token: <token>`
- **Request Body:**
```json
{
  "fullName": "ZZTEST Patient New",
  "phone": "+60123456789",
  "email": "zztest.new@example.test",
  "icOrPassport": "950101-14-1234"
}
```
- **Response Format (201 Created):**
```json
{
  "data": {
    "id": "ZZTEST-P05",
    "mrn": "MRN-ZZ-005",
    "fullName": "ZZTEST Patient New",
    "icOrPassport": "950101-14-1234",
    "phone": "+60123456789",
    "email": "zztest.new@example.test",
    "createdAt": "2026-10-01T10:00:00+08:00",
    "updatedAt": "2026-10-01T10:00:00+08:00"
  }
}
```

#### `PUT /api/patients/:id`
- **Capability:** `PATIENT_WRITE` / `patients.update`
- **Headers:** `Content-Type: application/json`, `X-CSRF-Token: <token>`
- **Request Body:**
```json
{
  "fullName": "ZZTEST Patient 01 Updated",
  "phone": "+60123456701",
  "email": "updated.p01@example.test"
}
```
- **Response Format (200 OK):**
```json
{
  "data": {
    "id": "ZZTEST-P01",
    "mrn": "MRN-ZZ-001",
    "fullName": "ZZTEST Patient 01 Updated",
    "phone": "+60123456701",
    "email": "updated.p01@example.test",
    "updatedAt": "2026-10-01T10:05:00+08:00"
  }
}
```

---

### 3.2 Appointment Management

#### `GET /api/appointments`
- **Capability:** `APPOINTMENT_READ` / `appointments.read`
- **Query Parameters:**
  - `providerId` (string, optional): Filter by doctor ID.
  - `status` (string, optional): `booked` | `completed` | `cancelled`.
  - `startDate` (ISO timestamp string, optional).
  - `endDate` (ISO timestamp string, optional).
  - `page` (integer, default: 1), `limit` (integer, default: 50).
- **Response Format (200 OK):**
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
      "slotDate": "2026-10-01",
      "slotTimeNaive": "09:00:00",
      "displayTime": "01/10/2026 09:00 AM",
      "status": "booked",
      "notes": "Consultation",
      "rev": 1,
      "createdAt": "2026-09-01T10:00:00+08:00",
      "updatedAt": "2026-09-01T10:00:00+08:00"
    }
  ],
  "total": 1
}
```

#### `GET /api/appointments/availability`
- **Capability:** `APPOINTMENT_READ` / `appointments.availability`
- **Query Parameters:**
  - `providerId` (string, required): Doctor ID.
  - `date` (string, required): YYYY-MM-DD.
- **Response Format (200 OK):**
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
- **Capability:** `APPOINTMENT_WRITE` / `appointments.create`
- **Preconditions:** Slot availability verification against `/api/appointments/availability`.
- **Headers:** `Content-Type: application/json`, `X-CSRF-Token: <token>`
- **Request Body:**
```json
{
  "patientId": "ZZTEST-P01",
  "providerId": "DOC-01",
  "serviceId": "SRV-01",
  "locationId": "LOC-01",
  "startTime": "2026-10-01T09:30:00+08:00",
  "endTime": "2026-10-01T09:45:00+08:00",
  "notes": "Follow-up"
}
```
- **Response Format (201 Created):**
```json
{
  "data": {
    "id": "APT-003",
    "patientId": "ZZTEST-P01",
    "providerId": "DOC-01",
    "serviceId": "SRV-01",
    "locationId": "LOC-01",
    "startTime": "2026-10-01T09:30:00+08:00",
    "endTime": "2026-10-01T09:45:00+08:00",
    "status": "booked",
    "notes": "Follow-up",
    "rev": 1,
    "createdAt": "2026-10-01T08:00:00+08:00",
    "updatedAt": "2026-10-01T08:00:00+08:00"
  }
}
```

#### `PUT /api/appointments/:id`
- **Capability:** `APPOINTMENT_WRITE` / `appointments.reschedule`
- **Headers:** `Content-Type: application/json`, `X-CSRF-Token: <token>`, `If-Match: <rev>`
- **Request Body:**
```json
{
  "startTime": "2026-10-01T11:00:00+08:00",
  "endTime": "2026-10-01T11:15:00+08:00",
  "expectedRev": 1,
  "notes": "Rescheduled"
}
```
- **Response Format (200 OK):**
```json
{
  "data": {
    "id": "APT-003",
    "startTime": "2026-10-01T11:00:00+08:00",
    "endTime": "2026-10-01T11:15:00+08:00",
    "status": "booked",
    "rev": 2,
    "updatedAt": "2026-10-01T08:15:00+08:00"
  }
}
```

#### `DELETE /api/appointments/:id`
- **Capability:** `APPOINTMENT_WRITE` / `appointments.cancel`
- **Response Format (200 OK):**
```json
{
  "data": {
    "id": "APT-003",
    "status": "cancelled",
    "rev": 3,
    "updatedAt": "2026-10-01T08:30:00+08:00"
  },
  "message": "Appointment cancelled successfully"
}
```

---

### 3.3 Reference Data

#### `GET /api/reference/providers`
- Returns active clinical practitioners (`id`, `fullName`, `specialty`, `active`).

#### `GET /api/reference/services`
- Returns medical treatment/service offerings (`id`, `name`, `durationMinutes`, `defaultPrice`).

#### `GET /api/reference/locations`
- Returns consultation rooms and suites (`id`, `name`, `roomType`).

---

## 4. Error Taxonomy & Status Schemas

| HTTP Status | Error Code | Description | Extension Handling |
| :--- | :--- | :--- | :--- |
| **400** | `BAD_REQUEST` | Validation error in payload | Fail closed, report error, do not retry |
| **401** | `UNAUTHORIZED` | Ambient session expired or logged out | Transition FSM to `STALE_AUTH`, prompt staff re-login |
| **403** | `FORBIDDEN` | Insufficient staff role permissions | Alert user regarding staff role requirement |
| **404** | `NOT_FOUND` | Patient or appointment ID does not exist | Mark target missing, abort recipe execution |
| **409** | `CONFLICT` | Slot double-booking or revision clash | Fail closed without overwrite, trigger outbox conflict flow |
| **429** | `RATE_LIMITED` | Vendor API rate throttling | Parse `Retry-After` header, apply exponential backoff |
| **500** | `INTERNAL_ERROR` | Vendor cloud database timeout | Exponential backoff retry with max retry budget |

---

## 5. Two-Tenant Architecture Matrix

To avoid hardcoding vendor quirks into the core extension engine, tenant variations are governed by declarative manifest configuration and mapping profiles.

| Aspect | Tenant A (Standard Cloud) | Tenant B (Custom Field Variant) |
| :--- | :--- | :--- |
| **Deployment Mode** | Multi-tenant SaaS Standard | Private Cloud / Customized Variant |
| **Patient Full Name Field** | `fullName` | `clientName` |
| **Patient Phone Field** | `phone` | `mobile_no` |
| **National ID Field** | `icOrPassport` | `nric` |
| **Slot Date Extraction** | Pre-parsed in `slotDate` | Computed from `startTime` ISO |
| **Adapter Mapping** | Direct declarative JSON paths | Config-driven field aliases in recipe transforms |
| **CSRF Handling** | Standard DOM meta header | Dual cookie + meta token lookup |

---

## 6. Read-After-Write Verification (AGENTS.md Rule 10)

Every state-mutating recipe enforces read-back verification before reporting success to LamaniHub:
1. **Patient Creation:** Read back `/api/patients/:id` and assert identity match on `fullName` and normalized `phone`.
2. **Appointment Booking:** Read back `/api/appointments/:id` and assert `status === 'booked'`, matching `patientId`, `providerId`, and incremented `rev === 1`.
3. **Appointment Reschedule:** Read back `/api/appointments/:id` and assert updated `startTime` and incremented `rev > expectedRev`.
4. **Appointment Cancellation:** Read back `/api/appointments/:id` and assert `status === 'cancelled'` and incremented revision.
