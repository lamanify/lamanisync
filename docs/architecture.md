# Architecture Overview

## Data Flow Pipeline

```plain text
CMS tab
  ↕ same-origin, authenticated browser session
Packaged page-world runner
  ↕ validated messages only
Isolated content script
  ↕ Chrome runtime messages
MV3 service worker
  ↕ signed HTTPS requests
LamaniHub Sync API → Supabase sync schema
```

## Component Boundaries

1. **CMS Tab**: Staff-authenticated web application running in a standard Chrome tab.
2. **Packaged Page-World Runner (MAIN world)**: Observes allowlisted network/DOM traffic and executes predefined CMS action recipes using the existing authenticated browser session.
3. **Isolated Content Script (ISOLATED world)**: Validates runner messages at the boundary, ensuring no arbitrary execution or raw session secrets leak into extension messaging.
4. **MV3 Service Worker**: Ephemeral background coordinator handling device identity, lease negotiation, signed API communication, alarms, and state machine transitions.
5. **LamaniHub Sync API**: Staging/production backend managing device pairing, adapter distributions, command queueing, and idempotency tracking.
6. **Supabase Sync Schema**: Persistence layer recording connection status, canonical sync events, and verified write receipts.
