# Employee Service Request System (Arrowstack Project 2)

Internal portal where employees raise IT / HR / Facilities requests that are routed to the right team, tracked against SLAs and summarised on a dashboard.

## Run
    docker compose up --build
Open http://localhost:3001. Demo accounts, all with password `Passw0rd123`:
`employee@demo.com`, `it@demo.com`, `hr@demo.com`, `facilities@demo.com` (agents), `admin@demo.com`.

## Stack
Node 20 + Express, PostgreSQL 16, JWT + bcrypt, Docker. Plain HTML/JS UI served by the API.

## Roles
| Action | Employee | Agent | Admin |
|---|---|---|---|
| Create requests, comment on own requests | yes | yes | yes |
| See requests | own only | own team's category | all |
| Change status, view dashboard | no | own team | all |
| Reassign (within team), create agents, read audit log | no | no | yes |

## Business rules
- Category (IT/HR/Facilities) routes the request to that team; the agent with the fewest open requests is auto-assigned.
- SLA response deadline by priority: urgent 4h, high 8h, medium 24h, low 72h. A request is "SLA missed" if it is overdue and unresolved, or was resolved after its deadline.
- Status flow: open → in_progress → resolved → closed. A resolved request can be reopened to in_progress. Other jumps return 409.
- Dashboard: counts by status and team, SLA compliance %, missed count, average resolution hours.
- Every create, comment, status/assignee change, login and user creation is written to `audit_log`.

## API
POST /api/auth/register|login · POST /api/users (admin), GET /api/agents (admin) · POST/GET /api/tickets · GET /api/tickets/:id ·
POST /api/tickets/:id/comments · PATCH /api/tickets/:id (status, assignee_id) · GET /api/dashboard · GET /api/audit

## Validation evidence (run against the stack and save output in /evidence)
    B=http://localhost:3001/api; J='Content-Type: application/json'
    login(){ curl -s $B/auth/login -H "$J" -d "{\"email\":\"$1\",\"password\":\"Passw0rd123\"}" | sed 's/.*"token":"\([^"]*\)".*/\1/'; }
    E=$(login employee@demo.com); I=$(login it@demo.com); H=$(login hr@demo.com)
    curl -s -X POST $B/tickets -H "Authorization: Bearer $E" -H "$J" -d '{"category":"IT","priority":"urgent","title":"VPN down","description":"Cannot connect"}'   # 201, due in 4h, assigned to IT agent
    curl -s -X POST $B/tickets -H "Authorization: Bearer $E" -H "$J" -d '{"category":"IT","priority":"asap","title":"x","description":"y"}'                 # 400 invalid priority
    curl -s $B/tickets/1 -H "Authorization: Bearer $H"                                                                                                       # 404 HR agent cannot see IT ticket
    curl -s -X PATCH $B/tickets/1 -H "Authorization: Bearer $I" -H "$J" -d '{"status":"closed"}'                                                             # 409 invalid transition
    curl -s $B/dashboard -H "Authorization: Bearer $E"                                                                                                       # 403 employee

## Known limitations / next steps
SLA clock ignores business hours and weekends; no email notifications, attachments, pagination or automated tests; no escalation when an SLA is about to be missed. Next: Jest + Supertest tests, business-hours SLA calendar, escalation job, React front end.
