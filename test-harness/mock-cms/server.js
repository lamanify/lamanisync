import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { createInitialCmsState } from '../fixtures/synthetic-data.js';

export class MockCmsServer {
  constructor(port = 4001) {
    this.port = port;
    this.server = null;
    this.state = createInitialCmsState();
    this.globalFault = 'none';
    this.faultDelayMs = 1000;
    this.targetedFaults = new Map(); // key: "METHOD:pathname" -> fault
    this.indexPath = path.resolve('test-harness/mock-cms/index.html');
  }

  reset() {
    this.state = createInitialCmsState();
    this.globalFault = 'none';
    this.faultDelayMs = 1000;
    this.targetedFaults.clear();
  }

  setFault(fault, delayMs = 1000, targetPath = null, method = null) {
    if (targetPath) {
      const key = `${(method || 'ALL').toUpperCase()}:${targetPath}`;
      if (fault === 'none') {
        this.targetedFaults.delete(key);
      } else {
        this.targetedFaults.set(key, { fault, delayMs });
      }
    } else {
      this.globalFault = fault;
      this.faultDelayMs = delayMs;
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.on('error', reject);
      this.server.listen(this.port, () => {
        console.log(`[Mock CMS] Running at http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  async handleRequest(req, res) {
    // Set permissive CORS headers for local extension testing
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie, If-Match, x-mock-fault');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const host = req.headers.host || `localhost:${this.port}`;
    const parsedUrl = new URL(req.url, `http://${host}`);
    const pathname = parsedUrl.pathname;

    // Serve HTML page on root
    if ((pathname === '/' || pathname === '/index.html') && req.method === 'GET') {
      try {
        const html = fs.readFileSync(this.indexPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      } catch (err) {
        return this.sendJson(res, 500, { error: 'HTML_LOAD_FAILED', message: err.message });
      }
    }

    // Check fault injection (header > targeted > global)
    const reqKey = `${req.method.toUpperCase()}:${pathname}`;
    const wildKey = `ALL:${pathname}`;
    const targeted = this.targetedFaults.get(reqKey) || this.targetedFaults.get(wildKey);

    const activeFault = req.headers['x-mock-fault'] || (targeted ? targeted.fault : this.globalFault);
    const delay = targeted ? targeted.delayMs : this.faultDelayMs;

    // Admin endpoints bypass fault injection so the admin can always reset/inspect
    if (!pathname.startsWith('/__admin')) {
      if (activeFault === 'slow') {
        await new Promise((r) => setTimeout(r, delay));
      } else if (activeFault === '401') {
        return this.sendJson(res, 401, {
          error: 'UNAUTHORIZED',
          message: 'CMS session expired or invalid',
        });
      } else if (activeFault === '403') {
        return this.sendJson(res, 403, {
          error: 'FORBIDDEN',
          message: 'Insufficient staff permissions for this clinic branch',
        });
      } else if (activeFault === '409') {
        return this.sendJson(res, 409, {
          error: 'CONFLICT',
          message: 'Simulated concurrent modification or slot clash',
        });
      } else if (activeFault === '429') {
        res.setHeader('Retry-After', '30');
        return this.sendJson(res, 429, {
          error: 'RATE_LIMITED',
          message: 'Too many requests to CMS API',
          retryAfterSeconds: 30,
        });
      } else if (activeFault === '500') {
        return this.sendJson(res, 500, {
          error: 'INTERNAL_ERROR',
          message: 'CMS database connection timeout',
        });
      }
    }

    try {
      const body = await this.readJsonBody(req);

      // --- Admin Endpoints ---
      if (pathname === '/__admin/fault' && req.method === 'POST') {
        this.setFault(body.fault || 'none', body.delayMs || 1000, body.targetPath || null, body.method || null);
        return this.sendJson(res, 200, {
          status: 'ok',
          globalFault: this.globalFault,
          targetedFaultsCount: this.targetedFaults.size,
        });
      }

      if (pathname === '/__admin/fault' && req.method === 'GET') {
        return this.sendJson(res, 200, {
          globalFault: this.globalFault,
          delayMs: this.faultDelayMs,
          targetedFaults: Array.from(this.targetedFaults.entries()),
        });
      }

      if (pathname.startsWith('/__admin/appointments/') && pathname.endsWith('/mutate') && req.method === 'POST') {
        const parts = pathname.split('/');
        const id = parts[parts.length - 2];
        const appt = this.state.appointments.find((a) => a.id === id);
        if (!appt) {
          return this.sendJson(res, 404, { error: 'NOT_FOUND', message: `Appointment ${id} not found` });
        }
        if (body.rev !== undefined) appt.rev = body.rev;
        else appt.rev += 1;
        if (body.startTime) appt.startTime = body.startTime;
        if (body.status) appt.status = body.status;
        appt.updatedAt = new Date().toISOString();
        return this.sendJson(res, 200, { status: 'mutated', data: appt });
      }

      if (pathname === '/__admin/reset' && req.method === 'POST') {
        this.reset();
        return this.sendJson(res, 200, { status: 'ok', message: 'Fixtures and faults reset to initial state' });
      }

      if (pathname === '/__admin/health' && req.method === 'GET') {
        return this.sendJson(res, 200, { status: 'ok', service: 'mock-cms', port: this.port });
      }

      // --- Auth / Session Endpoints ---
      if (pathname === '/api/auth/login' && req.method === 'POST') {
        res.setHeader('Set-Cookie', 'cms_session=dummy_staff_cookie; Path=/; HttpOnly; SameSite=Lax');
        return this.sendJson(res, 200, {
          token: 'mock-cms-session-token',
          staff: { id: 'STF-01', name: 'Staff Alice', role: 'receptionist' },
        });
      }

      if (pathname === '/api/auth/session' && req.method === 'GET') {
        const cookie = req.headers.cookie || '';
        const authHeader = req.headers.authorization || '';
        const hasSession = cookie.includes('cms_session=dummy_staff_cookie') || authHeader.includes('Bearer mock-cms-session-token');

        if (!hasSession) {
          return this.sendJson(res, 401, {
            error: 'UNAUTHORIZED',
            message: 'Missing or expired session cookie',
          });
        }
        return this.sendJson(res, 200, {
          authenticated: true,
          staff: { id: 'STF-01', name: 'Staff Alice', role: 'receptionist' },
          clinicId: 'CLN-001',
        });
      }

      // --- Patients Endpoints ---
      if (pathname === '/api/patients' && req.method === 'GET') {
        let patients = [...this.state.patients];
        const search = parsedUrl.searchParams.get('q');
        if (search) {
          const q = search.toLowerCase();
          patients = patients.filter(
            (p) => p.fullName.toLowerCase().includes(q) || p.phone.includes(q) || p.mrn.toLowerCase().includes(q),
          );
        }

        if (activeFault === 'drift') {
          // Alter schema shape for drift testing
          return this.sendJson(res, 200, {
            legacy_schema: true,
            records: patients.map((p) => ({
              patient_code: p.id,
              patient_label: p.fullName,
              contact: p.phone,
            })),
          });
        }

        const total = patients.length;
        if (parsedUrl.searchParams.has('page') || parsedUrl.searchParams.has('limit')) {
          const page = Math.max(1, parseInt(parsedUrl.searchParams.get('page') || '1', 10));
          const limit = Math.max(1, parseInt(parsedUrl.searchParams.get('limit') || '50', 10));
          const startIndex = (page - 1) * limit;
          patients = patients.slice(startIndex, startIndex + limit);
        }

        return this.sendJson(res, 200, {
          data: patients,
          total,
        });
      }

      if (pathname.startsWith('/api/patients/') && req.method === 'GET') {
        const id = pathname.replace('/api/patients/', '');
        const patient = this.state.patients.find((p) => p.id === id);
        if (!patient) {
          return this.sendJson(res, 404, { error: 'NOT_FOUND', message: `Patient ${id} not found` });
        }
        return this.sendJson(res, 200, { data: patient });
      }

      if (pathname === '/api/patients' && req.method === 'POST') {
        if (!body.fullName || !body.phone) {
          return this.sendJson(res, 400, {
            error: 'BAD_REQUEST',
            message: 'fullName and phone are required',
          });
        }

        const newId = `ZZTEST-P${String(this.state.patients.length + 1).padStart(2, '0')}`;
        const newPatient = {
          id: newId,
          mrn: `MRN-ZZ-${String(this.state.patients.length + 1).padStart(3, '0')}`,
          fullName: body.fullName,
          icOrPassport: body.icOrPassport || '000000-00-0000',
          phone: body.phone,
          email: body.email || '',
          dateOfBirth: body.dateOfBirth || '1990-01-01',
          gender: body.gender || 'unspecified',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        this.state.patients.push(newPatient);
        return this.sendJson(res, 201, { data: newPatient });
      }

      if (pathname.startsWith('/api/patients/') && req.method === 'PUT') {
        const id = pathname.replace('/api/patients/', '');
        const index = this.state.patients.findIndex((p) => p.id === id);
        if (index === -1) {
          return this.sendJson(res, 404, { error: 'NOT_FOUND', message: `Patient ${id} not found` });
        }

        this.state.patients[index] = {
          ...this.state.patients[index],
          ...body,
          id, // immutable ID
          updatedAt: new Date().toISOString(),
        };
        return this.sendJson(res, 200, { data: this.state.patients[index] });
      }

      // --- Appointments Endpoints ---
      if (pathname === '/api/appointments' && req.method === 'GET') {
        let appointments = [...this.state.appointments];
        const status = parsedUrl.searchParams.get('status');
        const providerId = parsedUrl.searchParams.get('providerId');

        if (status) {
          appointments = appointments.filter((a) => a.status === status);
        }
        if (providerId) {
          appointments = appointments.filter((a) => a.providerId === providerId);
        }

        const total = appointments.length;
        if (parsedUrl.searchParams.has('page') || parsedUrl.searchParams.has('limit')) {
          const page = Math.max(1, parseInt(parsedUrl.searchParams.get('page') || '1', 10));
          const limit = Math.max(1, parseInt(parsedUrl.searchParams.get('limit') || '50', 10));
          const startIndex = (page - 1) * limit;
          appointments = appointments.slice(startIndex, startIndex + limit);
        }

        return this.sendJson(res, 200, {
          data: appointments,
          total,
        });
      }

      if (pathname === '/api/appointments/availability' && req.method === 'GET') {
        const providerId = parsedUrl.searchParams.get('providerId');
        const date = parsedUrl.searchParams.get('date');

        if (!providerId || !date) {
          return this.sendJson(res, 400, {
            error: 'BAD_REQUEST',
            message: 'providerId and date parameters are required',
          });
        }

        // Generate synthetic availability slots
        const slots = [
          '09:00:00', '09:30:00', '10:00:00', '10:30:00',
          '11:00:00', '11:30:00', '14:00:00', '14:30:00',
        ].map((time) => {
          const startTime = `${date}T${time}+08:00`;
          const taken = this.state.appointments.some(
            (a) => a.providerId === providerId && a.status !== 'cancelled' && a.startTime === startTime,
          );
          return {
            startTime,
            available: !taken,
          };
        });

        return this.sendJson(res, 200, {
          providerId,
          date,
          slots,
        });
      }

      if (pathname.startsWith('/api/appointments/') && pathname !== '/api/appointments/availability' && req.method === 'GET') {
        const id = pathname.replace('/api/appointments/', '');
        const appt = this.state.appointments.find((a) => a.id === id);
        if (!appt) {
          return this.sendJson(res, 404, { error: 'NOT_FOUND', message: `Appointment ${id} not found` });
        }
        return this.sendJson(res, 200, { data: appt });
      }

      if (pathname === '/api/appointments' && req.method === 'POST') {
        if (!body.patientId || !body.providerId || !body.startTime || !body.endTime) {
          return this.sendJson(res, 400, {
            error: 'BAD_REQUEST',
            message: 'patientId, providerId, startTime and endTime are required',
          });
        }

        // Check for double booking clash
        const clash = this.state.appointments.find(
          (a) =>
            a.providerId === body.providerId &&
            a.status !== 'cancelled' &&
            a.startTime === body.startTime,
        );

        if (clash) {
          return this.sendJson(res, 409, {
            error: 'CONFLICT',
            message: `Provider ${body.providerId} is already booked at ${body.startTime}`,
            existingAppointmentId: clash.id,
          });
        }

        const newId = `APT-${String(this.state.appointments.length + 1).padStart(3, '0')}`;
        const slotDate = body.startTime.split('T')[0];
        const slotTimeNaive = body.startTime.includes('T') ? body.startTime.split('T')[1].slice(0, 8) : '00:00:00';
        const newAppt = {
          id: newId,
          patientId: body.patientId,
          providerId: body.providerId,
          serviceId: body.serviceId || 'SRV-01',
          locationId: body.locationId || 'LOC-01',
          startTime: body.startTime,
          endTime: body.endTime,
          slotDate,
          slotTimeNaive,
          displayTime: `${slotDate} ${slotTimeNaive}`,
          status: 'booked',
          notes: body.notes || '',
          rev: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        this.state.appointments.push(newAppt);
        return this.sendJson(res, 201, { data: newAppt });
      }

      if (pathname.startsWith('/api/appointments/') && req.method === 'PUT') {
        const id = pathname.replace('/api/appointments/', '');
        const appt = this.state.appointments.find((a) => a.id === id);
        if (!appt) {
          return this.sendJson(res, 404, { error: 'NOT_FOUND', message: `Appointment ${id} not found` });
        }

        // Concurrency check using revision
        const expectedRev = body.expectedRev || (req.headers['if-match'] ? parseInt(req.headers['if-match'], 10) : null);
        if (expectedRev !== null && expectedRev !== undefined && appt.rev !== expectedRev) {
          return this.sendJson(res, 409, {
            error: 'CONFLICT',
            message: `Revision mismatch. Current revision is ${appt.rev}, expected ${expectedRev}`,
            currentRev: appt.rev,
          });
        }

        // If rescheduling time, check for clash
        if (body.startTime && body.startTime !== appt.startTime) {
          const providerId = body.providerId || appt.providerId;
          const clash = this.state.appointments.find(
            (a) =>
              a.id !== id &&
              a.providerId === providerId &&
              a.status !== 'cancelled' &&
              a.startTime === body.startTime,
          );
          if (clash) {
            return this.sendJson(res, 409, {
              error: 'CONFLICT',
              message: `Provider ${providerId} is already booked at ${body.startTime}`,
              existingAppointmentId: clash.id,
            });
          }
        }

        appt.startTime = body.startTime || appt.startTime;
        appt.endTime = body.endTime || appt.endTime;
        appt.status = body.status || appt.status;
        appt.notes = body.notes !== undefined ? body.notes : appt.notes;
        appt.rev += 1;
        appt.updatedAt = new Date().toISOString();

        return this.sendJson(res, 200, { data: appt });
      }

      if (pathname.startsWith('/api/appointments/') && req.method === 'DELETE') {
        const id = pathname.replace('/api/appointments/', '');
        const appt = this.state.appointments.find((a) => a.id === id);
        if (!appt) {
          return this.sendJson(res, 404, { error: 'NOT_FOUND', message: `Appointment ${id} not found` });
        }

        appt.status = 'cancelled';
        appt.rev += 1;
        appt.updatedAt = new Date().toISOString();
        return this.sendJson(res, 200, { data: appt, message: 'Appointment cancelled successfully' });
      }

      // --- Reference Data Endpoints ---
      if (pathname === '/api/reference/providers' && req.method === 'GET') {
        return this.sendJson(res, 200, { data: this.state.providers });
      }

      if (pathname === '/api/reference/services' && req.method === 'GET') {
        return this.sendJson(res, 200, { data: this.state.services });
      }

      if (pathname === '/api/reference/locations' && req.method === 'GET') {
        return this.sendJson(res, 200, { data: this.state.locations });
      }

      // Fallthrough: 404
      return this.sendJson(res, 404, { error: 'NOT_FOUND', message: `Endpoint ${req.method} ${pathname} not found` });
    } catch (err) {
      console.error('[Mock CMS Error]', err);
      return this.sendJson(res, 500, { error: 'INTERNAL_ERROR', message: err.message });
    }
  }

  sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
  }

  readJsonBody(req) {
    return new Promise((resolve, reject) => {
      if (req.method === 'GET' || req.method === 'DELETE') {
        return resolve({});
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        if (!body) return resolve({});
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Invalid JSON payload'));
        }
      });
      req.on('error', reject);
    });
  }
}

// Standalone execution support
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4001;
  const server = new MockCmsServer(port);
  server.start().catch((err) => {
    console.error('Failed to start Mock CMS:', err);
    process.exit(1);
  });
}
