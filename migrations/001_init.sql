CREATE TABLE users(id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('employee','agent','admin')),
  team TEXT CHECK (team IN ('IT','HR','Facilities')), created_at TIMESTAMPTZ DEFAULT now(),
  CHECK (role <> 'agent' OR team IS NOT NULL));
CREATE TABLE tickets(id SERIAL PRIMARY KEY, requester_id INT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL CHECK (category IN ('IT','HR','Facilities')),
  title TEXT NOT NULL, description TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('low','medium','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  assignee_id INT REFERENCES users(id), due_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(), resolved_at TIMESTAMPTZ);
CREATE INDEX tickets_category_status ON tickets(category, status);
CREATE TABLE comments(id SERIAL PRIMARY KEY, ticket_id INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE audit_log(id SERIAL PRIMARY KEY, user_id INT, action TEXT NOT NULL, entity TEXT NOT NULL,
  entity_id INT, detail JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT now());
