/* Zia ERP · Supabase adapter
   Gives the app the same small storage/user/download interface it used on claude.ai, backed by Supabase:
   records live in the `docs` table, roles in `team`, access requests in `requests`. Everything is loaded once
   after sign-in and kept live with Supabase Realtime. */
(function () {
  window.ERP_HOSTED = true;
  const cfg = window.ERP_CONFIG || {};
  const $ = s => document.querySelector(s);
  const apiKey = cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_PUBLISHABLE_KEY || cfg.SUPABASE_KEY;
  const configured = cfg.SUPABASE_URL && apiKey && !/YOUR-/.test(cfg.SUPABASE_URL + apiKey);
  const sb = configured && window.supabase ? window.supabase.createClient(cfg.SUPABASE_URL, apiKey) : null;
  window.ERP_SB = sb;

  /* ---------- sign-in screen ---------- */
  let resolveAuth; const authed = new Promise(r => resolveAuth = r);
  let session = null, myRole = null;
  const gate = $('#authGate');
  const msg = (t, bad) => { const m = $('#authMsg'); m.textContent = t || ''; m.className = 'auth-msg' + (bad ? ' bad' : ''); };
  let mode = 'signin';
  function setMode(m) {
    mode = m; $('#authTitle').textContent = m === 'signup' ? 'Create your account' : m === 'reset' ? 'Reset your password' : 'Sign in';
    $('#authNameRow').hidden = m !== 'signup'; $('#authPassRow').hidden = m === 'reset';
    $('#authSubmit').textContent = m === 'signup' ? 'Create account' : m === 'reset' ? 'Send reset link' : 'Sign in';
    $('#authSwitch').innerHTML = m === 'signin' ? 'New here? <button type="button" data-auth="signup">Create an account</button> · <button type="button" data-auth="reset">Forgot password?</button>'
      : '<button type="button" data-auth="signin">Back to sign in</button>'; msg('');
  }
  async function afterSignIn(s) {
    session = s; gate.hidden = true;
    try { await sb.rpc('claim_first_admin'); } catch (e) {}
    const { data } = await sb.from('team').select('role').eq('user_id', s.user.id).maybeSingle();
    myRole = data?.role || null;
    const who = $('#whoami'); if (who) { who.hidden = false; $('#whoName').textContent = s.user.user_metadata?.name || s.user.email; }
    resolveAuth();
  }
  if (!configured) {
    gate.hidden = false; $('#authForm').hidden = true;
    msg('This copy is not connected to a database yet. Open config.js and paste your Supabase project URL and anon key (see README).', true);
  } else if (sb) {
    setMode('signin');
    gate.addEventListener('click', e => { const b = e.target.closest('[data-auth]'); if (b) setMode(b.dataset.auth); });
    $('#authForm').addEventListener('submit', async e => {
      e.preventDefault(); const email = $('#authEmail').value.trim(), password = $('#authPass').value, name = $('#authName').value.trim();
      const btn = $('#authSubmit'); btn.disabled = true; msg('Please wait…');
      try {
        if (mode === 'signup') {
          if (!name) throw new Error('Enter your name');
          const { data, error } = await sb.auth.signUp({ email, password, options: { data: { name }, emailRedirectTo: location.origin + location.pathname } });
          if (error) throw error;
          if (!data.session) { msg('Account created. Check your email and click the confirmation link, then sign in.'); setTimeout(() => setMode('signin'), 50); msg('Account created. Check your email and click the confirmation link, then sign in.'); }
        } else if (mode === 'reset') {
          const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }); if (error) throw error;
          msg('If that email has an account, a reset link is on its way.');
        } else {
          const { error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw error;
        }
      } catch (err) { msg(err.message === 'Invalid login credentials' ? 'Wrong email or password.' : (err.message || 'Something went wrong'), true); }
      btn.disabled = false;
    });
    sb.auth.onAuthStateChange((ev, s) => {
      if (ev === 'PASSWORD_RECOVERY') { const p = prompt('Enter a new password'); if (p) sb.auth.updateUser({ password: p }).then(({ error }) => alert(error ? error.message : 'Password updated')); }
      if (s && !session) afterSignIn(s);
      if (!s && session) location.reload();
    });
    sb.auth.getSession().then(({ data }) => { if (data.session) afterSignIn(data.session); else gate.hidden = false; });
    document.addEventListener('click', e => { if (e.target.closest('#signOut')) sb.auth.signOut(); });
  }

  /* ---------- local cache + live updates ---------- */
  const cache = {}; const listeners = {}; let loaded = null;
  const coll = c => cache[c] || (cache[c] = new Map());
  const emit = c => (listeners[c] || []).forEach(fn => fn());
  const snap = c => { const docs = [...coll(c).entries()].map(([id, data]) => ({ id, exists: true, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } })); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [] }; };
  const teamRow = r => ({ role: r.role, email: r.email, name: r.name, date: (r.created_at || '').slice(0, 10) });
  const reqRow = r => ({ email: r.email, name: r.name, requestedAt: Date.parse(r.created_at) || 0, date: (r.created_at || '').slice(0, 10) });
  async function loadAll() {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('docs').select('collection,id,data').range(from, from + 999);
      if (error) { console.warn(error); break; }
      data.forEach(r => coll(r.collection).set(r.id, r.data)); if (data.length < 1000) break;
    }
    const t = await sb.from('team').select('*'); (t.data || []).forEach(r => coll('team').set(r.user_id, teamRow(r)));
    const q = await sb.from('requests').select('*'); (q.data || []).forEach(r => coll('requests').set(r.user_id, reqRow(r)));
    sb.channel('erp-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, p => { const r = p.new && Object.keys(p.new).length ? p.new : p.old; if (!r?.collection) return;
        if (p.eventType === 'DELETE') coll(r.collection).delete(r.id); else coll(r.collection).set(r.id, r.data); emit(r.collection); if (r.collection === 'meta') emit('meta'); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team' }, p => { const r = p.eventType === 'DELETE' ? p.old : p.new; if (!r?.user_id) return;
        if (p.eventType === 'DELETE') coll('team').delete(r.user_id); else coll('team').set(r.user_id, teamRow(r)); emit('team');
        if (r.user_id === session.user.id) { const was = myRole; myRole = p.eventType === 'DELETE' ? null : r.role; if (was !== myRole && (!was || !myRole)) setTimeout(() => location.reload(), 300); } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'requests' }, p => { const r = p.eventType === 'DELETE' ? p.old : p.new; if (!r?.user_id) return;
        if (p.eventType === 'DELETE') coll('requests').delete(r.user_id); else coll('requests').set(r.user_id, reqRow(r)); emit('requests'); })
      .subscribe();
  }
  const fail = error => { const e = new Error(error.message || 'Save failed'); e.code = (error.code === '42501' || /row-level security/i.test(error.message || '')) ? 'invalid_argument' : 'unavailable'; return e; };
  async function write(c, id, body) {
    if (c === 'team') {
      const req = coll('requests').get(id) || {}; const old = coll('team').get(id) || {};
      const { error } = await sb.from('team').upsert({ user_id: id, role: body.role, email: old.email || req.email || null, name: old.name || req.name || null }); if (error) throw fail(error);
      coll('team').set(id, { ...old, role: body.role, email: old.email || req.email, name: old.name || req.name }); emit('team'); return;
    }
    if (c === 'requests') {
      const u = session.user; const { error } = await sb.from('requests').upsert({ user_id: id, email: u.email, name: u.user_metadata?.name || u.email }); if (error) throw fail(error);
      coll('requests').set(id, { email: u.email, name: u.user_metadata?.name, requestedAt: Date.now() }); emit('requests'); return;
    }
    const prev = coll(c).get(id); coll(c).set(id, body); emit(c);
    const { error } = await sb.from('docs').upsert({ collection: c, id, data: body, updated_at: new Date().toISOString() });
    if (error) { if (prev === undefined) coll(c).delete(id); else coll(c).set(id, prev); emit(c); throw fail(error); }
  }
  async function remove(c, id) {
    const table = c === 'team' ? 'team' : c === 'requests' ? 'requests' : 'docs';
    const prev = coll(c).get(id); coll(c).delete(id); emit(c);
    const q = table === 'docs' ? sb.from('docs').delete().eq('collection', c).eq('id', id) : sb.from(table).delete().eq('user_id', id);
    const { error } = await q; if (error) { if (prev !== undefined) coll(c).set(id, prev); emit(c); throw fail(error); }
  }
  const docRef = (c, id) => ({ id, path: c + '/' + id, set: b => write(c, id, JSON.parse(JSON.stringify(b))), delete: () => remove(c, id),
    get: async () => ({ id, exists: coll(c).has(id), data: () => coll(c).get(id) }),
    onSnapshot(fn) { const f = () => fn({ id, exists: coll(c).has(id), data: () => coll(c).get(id) }); (listeners[c] || (listeners[c] = [])).push(f); loaded.then(f); return () => { listeners[c] = listeners[c].filter(x => x !== f); }; } });
  const dbApi = {
    collection: c => ({ path: c, doc: id => docRef(c, id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8))),
      onSnapshot(fn) { const f = () => fn(snap(c)); (listeners[c] || (listeners[c] = [])).push(f); loaded.then(f); return () => { listeners[c] = listeners[c].filter(x => x !== f); }; } }),
    doc: p => { const [c, id] = p.split('/'); return docRef(c, id); }
  };

  /* ---------- people ---------- */
  const initials = n => { const s = (n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#2e3a8c"/><text x="32" y="41" font-family="Arial" font-size="24" fill="#fff" text-anchor="middle">${s.replace(/[<&]/g, '')}</text></svg>`); };
  const userApi = {
    me: async () => { const u = session.user; const name = u.user_metadata?.name || u.email; return { id: u.id, name, email: u.email, avatarUrl: initials(name), color: '#2e3a8c', isOwner: myRole === 'admin', canEdit: myRole === 'admin' }; },
    profiles: async ids => Object.fromEntries((Array.isArray(ids) ? ids : [ids]).map(id => { const t = coll('team').get(id) || coll('requests').get(id) || {}; const isMe = id === session.user.id;
      const name = t.name || (isMe ? session.user.user_metadata?.name : '') || t.email || ''; return [id, { id, name, email: t.email || (isMe ? session.user.email : null), avatarUrl: initials(name || '?'), color: '#2e3a8c', isMe, guest: false }]; })),
    search: async () => [], isOwner: async () => myRole === 'admin', canEdit: async () => myRole === 'admin', can: async () => null, id: async () => session.user.id
  };
  const downloadsApi = { save: async ({ filename, data }) => { const blob = data instanceof Blob ? data : new Blob([data], { type: /\.pdf$/.test(filename) ? 'application/pdf' : /\.csv$/.test(filename) ? 'text/csv' : 'application/octet-stream' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); } };

  /* ---------- the interface the app asks for ---------- */
  window.claude = {
    use: async name => {
      if (!sb) return null;
      await authed; if (!loaded) loaded = loadAll();
      await loaded;
      return name === 'db' ? dbApi : name === 'user' ? userApi : name === 'downloads' ? downloadsApi : null;
    }
  };
})();
