const express = require('express'), { Pool } = require('pg'), jwt = require('jsonwebtoken'),
  bcrypt = require('bcryptjs'), fs = require('fs'), path = require('path');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SECRET = process.env.JWT_SECRET || 'dev-secret';
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const SLA_HOURS = { urgent: 4, high: 8, medium: 24, low: 72 };
const TEAMS = ['IT', 'HR', 'Facilities'];
const NEXT = { open: ['in_progress', 'resolved'], in_progress: ['resolved'], resolved: ['closed', 'in_progress'], closed: [] };
const wrap = f => (q, s, n) => f(q, s, n).catch(n);
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const audit = (uid, action, entity, id, detail = {}) =>
  pool.query('INSERT INTO audit_log(user_id,action,entity,entity_id,detail) VALUES($1,$2,$3,$4,$5)', [uid, action, entity, id, detail]);
const auth = roles => (q, s, n) => {
  try { q.user = jwt.verify((q.headers.authorization || '').replace('Bearer ', ''), SECRET); }
  catch { return s.status(401).json({ error: 'Sign in required' }); }
  if (roles && !roles.includes(q.user.role)) return s.status(403).json({ error: 'Not allowed for your role' });
  n();
};
const token = u => jwt.sign({ id: u.id, role: u.role, team: u.team, email: u.email }, SECRET, { expiresIn: '8h' });
const canSee = (u, t) => u.role === 'admin' || (u.role === 'agent' && u.team === t.category) || t.requester_id === u.id;
const withSla = t => ({ ...t, sla_breached: t.resolved_at ? t.resolved_at > t.due_at : (t.status !== 'closed' && new Date(t.due_at) < new Date()) });
async function loadTicket(q) {
  const { rows: [t] } = await pool.query('SELECT * FROM tickets WHERE id=$1', [q.params.id]);
  if (!t || !canSee(q.user, t)) throw bad('Request not found', 404);
  return t;
}

// ---- Auth & users
const checkCreds = ({ email, password }) => {
  if (!/^\S+@\S+\.\S+$/.test(email || '')) throw bad('Enter a valid email');
  if ((password || '').length < 8) throw bad('Password must be at least 8 characters');
};
app.post('/api/auth/register', wrap(async (q, s) => {
  checkCreds(q.body);
  const { rows: [u] } = await pool.query('INSERT INTO users(email,password_hash,role) VALUES($1,$2,$3) RETURNING *',
    [q.body.email.toLowerCase(), await bcrypt.hash(q.body.password, 10), 'employee']);
  await audit(u.id, 'register', 'user', u.id);
  s.status(201).json({ token: token(u), role: u.role });
}));
app.post('/api/auth/login', wrap(async (q, s) => {
  const { rows: [u] } = await pool.query('SELECT * FROM users WHERE email=$1', [(q.body.email || '').toLowerCase()]);
  if (!u || !(await bcrypt.compare(q.body.password || '', u.password_hash))) throw bad('Wrong email or password');
  await audit(u.id, 'login', 'user', u.id);
  s.json({ token: token(u), role: u.role, team: u.team });
}));
app.post('/api/users', auth(['admin']), wrap(async (q, s) => {   // admin creates agents
  checkCreds(q.body);
  if (!TEAMS.includes(q.body.team)) throw bad('team must be IT, HR or Facilities');
  const { rows: [u] } = await pool.query('INSERT INTO users(email,password_hash,role,team) VALUES($1,$2,$3,$4) RETURNING id,email,role,team',
    [q.body.email.toLowerCase(), await bcrypt.hash(q.body.password, 10), 'agent', q.body.team]);
  await audit(q.user.id, 'create', 'user', u.id, u);
  s.status(201).json(u);
}));
app.get('/api/agents', auth(['admin']), wrap(async (q, s) =>
  s.json((await pool.query("SELECT id,email,team FROM users WHERE role='agent' ORDER BY team,email")).rows)));

// ---- Tickets: category routes to a team; the least-loaded agent in that team is auto-assigned
app.post('/api/tickets', auth(), wrap(async (q, s) => {
  const { category, title, description, priority } = q.body;
  if (!TEAMS.includes(category)) throw bad('Choose IT, HR or Facilities');
  if (!SLA_HOURS[priority]) throw bad('Choose a priority: low, medium, high or urgent');
  if (!title || title.length > 120) throw bad('Title is required (max 120 characters)');
  if (!description || description.length > 2000) throw bad('Description is required (max 2000 characters)');
  const { rows: [a] } = await pool.query(
    `SELECT u.id FROM users u WHERE u.role='agent' AND u.team=$1 ORDER BY
     (SELECT count(*) FROM tickets t WHERE t.assignee_id=u.id AND t.status IN ('open','in_progress')), u.id LIMIT 1`, [category]);
  const { rows: [t] } = await pool.query(
    `INSERT INTO tickets(requester_id,category,title,description,priority,assignee_id,due_at)
     VALUES($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval) RETURNING *`,
    [q.user.id, category, title, description, priority, a ? a.id : null, SLA_HOURS[priority]]);
  await audit(q.user.id, 'create', 'ticket', t.id, { category, priority, assignee: t.assignee_id });
  s.status(201).json(withSla(t));
}));
app.get('/api/tickets', auth(), wrap(async (q, s) => {
  const u = q.user;
  const [where, params] = u.role === 'admin' ? ['', []] : u.role === 'agent' ? ['WHERE t.category=$1', [u.team]] : ['WHERE t.requester_id=$1', [u.id]];
  const { rows } = await pool.query(`SELECT t.*,r.email AS requester,a.email AS assignee FROM tickets t
    JOIN users r ON r.id=t.requester_id LEFT JOIN users a ON a.id=t.assignee_id ${where} ORDER BY t.due_at`, params);
  s.json(rows.map(withSla));
}));
app.get('/api/tickets/:id', auth(), wrap(async (q, s) => {
  const t = await loadTicket(q);
  const { rows } = await pool.query('SELECT c.*,u.email FROM comments c JOIN users u ON u.id=c.user_id WHERE ticket_id=$1 ORDER BY c.id', [t.id]);
  s.json({ ...withSla(t), comments: rows });
}));
app.post('/api/tickets/:id/comments', auth(), wrap(async (q, s) => {
  const t = await loadTicket(q);
  if (!q.body.body || q.body.body.length > 1000) throw bad('Comment is required (max 1000 characters)');
  const { rows: [c] } = await pool.query('INSERT INTO comments(ticket_id,user_id,body) VALUES($1,$2,$3) RETURNING *', [t.id, q.user.id, q.body.body]);
  await audit(q.user.id, 'comment', 'ticket', t.id);
  s.status(201).json(c);
}));
app.patch('/api/tickets/:id', auth(['agent', 'admin']), wrap(async (q, s) => {
  const t = await loadTicket(q), { status, assignee_id } = q.body, sets = [], vals = [];
  if (status) {
    if (!NEXT[t.status].includes(status)) throw bad(`Cannot move a request from ${t.status} to ${status}`, 409);
    vals.push(status); sets.push(`status=$${vals.length}`);
    if (status === 'resolved') sets.push('resolved_at=now()');
    if (t.status === 'resolved' && status === 'in_progress') sets.push('resolved_at=NULL');
  }
  if (assignee_id !== undefined) {
    if (q.user.role !== 'admin') throw bad('Only admins can reassign', 403);
    const { rows: [a] } = await pool.query("SELECT team FROM users WHERE id=$1 AND role='agent'", [assignee_id]);
    if (!a || a.team !== t.category) throw bad('Assignee must be an agent in the ' + t.category + ' team');
    vals.push(assignee_id); sets.push(`assignee_id=$${vals.length}`);
  }
  if (!sets.length) throw bad('Nothing to update');
  vals.push(t.id);
  const { rows: [n] } = await pool.query(`UPDATE tickets SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
  await audit(q.user.id, 'update', 'ticket', t.id, { from: t.status, to: n.status, assignee: n.assignee_id });
  s.json(withSla(n));
}));

// ---- Dashboard & audit
app.get('/api/dashboard', auth(['agent', 'admin']), wrap(async (q, s) => {
  const [w, p] = q.user.role === 'agent' ? ['WHERE category=$1', [q.user.team]] : ['', []];
  const run = sql => pool.query(sql.replace('{W}', w), p).then(r => r.rows);
  const [byStatus, byCategory, [m]] = await Promise.all([
    run('SELECT status,count(*)::int n FROM tickets {W} GROUP BY status'),
    run('SELECT category,count(*)::int n FROM tickets {W} GROUP BY category'),
    run(`SELECT count(*) FILTER (WHERE (resolved_at IS NULL AND status<>'closed' AND due_at<now()) OR resolved_at>due_at)::int breached,
         count(*)::int total, round(avg(extract(epoch FROM resolved_at-created_at))/3600) avg_resolution_hours FROM tickets {W}`)]);
  s.json({ byStatus, byCategory, ...m, sla_compliance_pct: m.total ? Math.round(100 * (m.total - m.breached) / m.total) : 100 });
}));
app.get('/api/audit', auth(['admin']), wrap(async (q, s) =>
  s.json((await pool.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200')).rows)));

app.use((e, q, s, n) => {
  if (e.code === '23505') e = bad('That value already exists', 409);
  if (!e.status) console.error(e);
  s.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' });
});

async function migrate() {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY)');
  const dir = path.join(__dirname, '../migrations');
  for (const f of fs.readdirSync(dir).sort()) {
    if ((await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f])).rowCount) continue;
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    await pool.query('INSERT INTO schema_migrations VALUES($1)', [f]);
    console.log('migrated', f);
  }
  if (!(await pool.query('SELECT 1 FROM users LIMIT 1')).rowCount) {
    const h = await bcrypt.hash(process.env.SEED_PASSWORD || 'Passw0rd123', 10);
    await pool.query(`INSERT INTO users(email,password_hash,role,team) VALUES
      ('admin@demo.com',$1,'admin',NULL),('it@demo.com',$1,'agent','IT'),('hr@demo.com',$1,'agent','HR'),
      ('facilities@demo.com',$1,'agent','Facilities'),('employee@demo.com',$1,'employee',NULL)`, [h]);
  }
}
migrate().then(() => app.listen(3000, () => console.log('API on :3000'))).catch(e => { console.error(e); process.exit(1); });
