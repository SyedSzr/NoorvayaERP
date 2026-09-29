/* ===== core helpers ===== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);
const N = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
const money = v => { const c = S.settings.currency || 'Rs'; const r = Math.round(N(v)); return (r < 0 ? '−' : '') + c + ' ' + Math.abs(r).toLocaleString('en-PK'); };
const qty = v => N(v).toLocaleString('en-PK', { maximumFractionDigits: 2 });
const fdate = s => { if (!s) return '—'; const d = new Date(s + 'T00:00:00'); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '\u00a0'); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sum = (a, f) => a.reduce((t, x) => t + N(f(x)), 0);

const COLS = ['products', 'parties', 'purchases', 'sales', 'returns', 'expenses', 'adjustments'];
const S = {
  products: [], parties: [], purchases: [], sales: [], returns: [], expenses: [], adjustments: [],
  settings: { business: 'Zia', currency: 'Rs', deadDays: 90, tagline: 'Clothing ERP' },
  loaded: new Set(), view: 'dashboard', period: 'month', from: '', to: '', q: {}, tab: {}, readOnly: false
};
const STATUS = {
  received: { label: 'Order received', tone: 'info' },
  tailor: { label: 'At tailor', tone: 'warn' },
  ready: { label: 'Ready', tone: 'brand' },
  delivered: { label: 'Delivered', tone: 'good' },
  cancelled: { label: 'Cancelled', tone: 'bad' }
};
const FLOW = ['received', 'tailor', 'ready', 'delivered'];
const ROLES = { customer: 'Customer', supplier: 'Supplier', tailor: 'Tailor', designer: 'Designer' };
const EXP_CATS = ['Designer fee', 'Embroidery / lace', 'Shipping & courier', 'Packaging', 'Rent', 'Salaries', 'Utilities', 'Marketing', 'Photoshoot', 'Other'];
const ADJ_REASONS = { opening: 'Opening stock', count: 'Stock count correction', damage: 'Damaged / faulty', lost: 'Lost / missing', sample: 'Given as sample', made: 'Ready pieces made' };
const PAY_METHODS = ['Cash', 'Bank transfer', 'JazzCash', 'Easypaisa', 'Card', 'Cheque'];
const pill = (label, tone) => `<span class="pill t-${tone}">${esc(label)}</span>`;

/* ===== storage ===== */
let db = null, dl = null, mode = 'connecting';
const LS_KEY = 'zia-erp-local-v1';
function saveLocal() { try { const o = {}; COLS.forEach(c => o[c] = S[c]); o.settings = S.settings; localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) {} }
function loadLocal() { try { const o = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (o) { COLS.forEach(c => S[c] = o[c] || []); S.settings = { ...S.settings, ...(o.settings || {}) }; } } catch (e) {} COLS.forEach(c => S.loaded.add(c)); }

async function put(col, obj) {
  if (S.readOnly) { toast('You have view-only access'); throw new Error('ro'); }
  const body = JSON.parse(JSON.stringify(obj)); const id = body.id || uid(); delete body.id;
  body.updatedAt = Date.now(); if (!body.createdAt) body.createdAt = body.updatedAt;
  if (mode !== 'db') {
    const i = S[col].findIndex(x => x.id === id); const rec = { ...body, id };
    if (i >= 0) S[col][i] = rec; else S[col].push(rec);
    saveLocal(); queue(); return id;
  }
  const prev = S[col].slice(); const i = S[col].findIndex(x => x.id === id);
  if (i >= 0) S[col][i] = { ...body, id }; else S[col].push({ ...body, id });
  try { await db.collection(col).doc(id).set(body); }
  catch (e) {
    S[col] = prev; queue();
    if (e && e.code === 'invalid_argument' && !S.readOnly) { S.readOnly = true; queue(); toast('Saving is not allowed for your access level'); }
    else if (e && e.code === 'quota_exceeded') toast('Storage is full. Export a backup and clear old records in Settings.');
    else toast('Could not save: ' + (e && e.message || 'try again'));
    throw e;
  }
  return id;
}
async function removeDoc(col, id) {
  if (mode !== 'db') { S[col] = S[col].filter(x => x.id !== id); saveLocal(); queue(); return; }
  S[col] = S[col].filter(x => x.id !== id); queue();
  await db.collection(col).doc(id).delete();
}
async function saveSettings(patch) {
  S.settings = { ...S.settings, ...patch };
  if (mode !== 'db') { saveLocal(); queue(); return; }
  await db.doc('meta/settings').set(S.settings); queue();
}
async function offerFile(filename, data) {
  if (!dl) { toast('Downloads are not available in this view'); return; }
  try { await dl.save({ filename, data }); toast('Saved ' + filename); }
  catch (e) { if (e && e.code !== 'declined') toast('Could not save file: ' + (e.message || e.code)); }
}
function csv(rows) { return rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n'); }

/* ===== lookups & derived numbers ===== */
let D = {};
const P = id => D.pmap?.get(id);
const party = id => D.partyMap?.get(id);
const pname = id => P(id)?.name || 'Deleted item';
const partyName = id => party(id)?.name || (id ? 'Deleted contact' : 'Walk-in');
const live = so => so.status !== 'cancelled';
const received = pu => pu.status !== 'scheduled';

function saleTotals(so) {
  const sub = sum(so.items || [], i => N(i.qty) * N(i.rate));
  const total = sub - N(so.discount) + N(so.delivery);
  const mat = sum(so.items || [], i => N(i.qty) * N(i.matCost));
  const stitch = sum(so.items || [], i => N(i.qty) * N(i.stitch));
  const paid = sum(so.payments || [], p => p.amount);
  const credit = live(so) ? sum(S.returns.filter(r => r.kind === 'sale' && r.refId === so.id), r => r.amount) : 0;
  return { sub, total, mat, stitch, cogs: mat + stitch, paid, credit, due: live(so) ? total - paid - credit : 0 };
}
function purchaseTotals(pu) {
  const sub = sum(pu.items || [], i => N(i.qty) * N(i.rate));
  const total = sub + N(pu.extra);
  const paid = sum(pu.payments || [], p => p.amount);
  const credit = sum(S.returns.filter(r => r.kind === 'purchase' && r.refId === pu.id), r => r.amount);
  return { sub, total, paid, credit, due: received(pu) ? total - paid - credit : 0 };
}

function derive() {
  const pmap = new Map(S.products.map(p => [p.id, p]));
  const partyMap = new Map(S.parties.map(p => [p.id, p]));
  const st = {};
  const g = id => st[id] || (st[id] = { qty: 0, inQty: 0, inVal: 0, lastMove: null, lastSale: null, firstIn: null, soldQty: 0 });
  const mx = (a, b) => (!a || b > a) ? b : a, mn = (a, b) => (!a || b < a) ? b : a;
  const onOrder = {};
  for (const pu of S.purchases) {
    if (!received(pu)) { for (const i of pu.items || []) onOrder[i.pid] = (onOrder[i.pid] || 0) + N(i.qty); continue; }
    const sub = sum(pu.items || [], i => N(i.qty) * N(i.rate)); const f = sub ? (sub + N(pu.extra)) / sub : 1;
    for (const i of pu.items || []) { const s = g(i.pid); s.qty += N(i.qty); s.inQty += N(i.qty); s.inVal += N(i.qty) * N(i.rate) * f; s.firstIn = mn(s.firstIn, pu.date); }
  }
  for (const a of S.adjustments) {
    const s = g(a.pid); s.qty += N(a.qty);
    if (N(a.qty) > 0) { s.firstIn = mn(s.firstIn, a.date); if (N(a.cost) > 0) { s.inQty += N(a.qty); s.inVal += N(a.qty) * N(a.cost); } }
    else s.lastMove = mx(s.lastMove, a.date);
  }
  for (const r of S.returns) for (const i of r.items || []) {
    if (r.kind === 'purchase') { g(i.pid).qty -= N(i.qty); }
    else if (i.restock) { g(i.pid).qty += N(i.qty); }
  }
  for (const so of S.sales) { if (!live(so)) continue;
    for (const i of so.items || []) { const p = pmap.get(i.pid); const s = g(i.pid);
      s.soldQty += N(i.qty); s.lastSale = mx(s.lastSale, so.date); s.lastMove = mx(s.lastMove, so.date);
      if (p && p.kind === 'design' && i.src !== 'ready') {
        if (p.fabricId) { const f = g(p.fabricId); f.qty -= N(i.qty) * (N(p.fabricQty) || 1); f.lastMove = mx(f.lastMove, so.date); }
      } else s.qty -= N(i.qty);
    }
  }
  D = { pmap, partyMap, st, onOrder };
  const unit = {};
  for (const p of S.products) if (p.kind !== 'design') { const s = g(p.id); unit[p.id] = s.inQty > 0 ? s.inVal / s.inQty : N(p.cost); }
  for (const p of S.products) if (p.kind === 'design') unit[p.id] = designCost(p, unit);
  D.unit = unit;
  const dead = N(S.settings.deadDays) || 90, t = today();
  D.inv = S.products.map(p => {
    const s = g(p.id); const u = unit[p.id] || 0; const since = s.lastMove || s.firstIn;
    const age = since ? daysBetween(since, t) : null;
    let status = 'ok';
    if (s.qty <= 0 && p.kind !== 'design') status = 'out';
    else if (s.qty > 0 && age !== null && age >= dead) status = 'stuck';
    else if (p.kind !== 'design' && N(p.reorder) > 0 && s.qty <= N(p.reorder)) status = 'low';
    if (p.kind === 'design' && s.qty <= 0) status = 'mto';
    return { p, onOrder: onOrder[p.id] || 0, qty: s.qty, unit: u, value: Math.max(0, s.qty) * u, lastSale: s.lastSale, lastMove: s.lastMove, age, status, soldQty: s.soldQty };
  });
  D.stockValue = sum(D.inv, r => r.value);
  D.receivable = sum(S.sales, so => Math.max(0, saleTotals(so).due));
  { const owe = S.sales.filter(so => live(so) && saleTotals(so).due > 0.5); D.recvCount = new Set(owe.map(so => so.partyId || so.id)).size; D.recvLate = owe.filter(so => so.payBy && so.payBy < today()).length; }
  D.payable = sum(S.purchases, pu => Math.max(0, purchaseTotals(pu).due));
  D.tailorDue = sum(S.sales.filter(so => live(so) && so.tailorId && !so.tailorPaid && so.status !== 'received'), so => saleTotals(so).stitch);
  D.scheduled = S.purchases.filter(pu => !received(pu)).sort((a, b) => (a.expected || '9').localeCompare(b.expected || '9'));
  D.lateSchedule = D.scheduled.filter(pu => pu.expected && pu.expected < today()).length;
  D.openOrders = S.sales.filter(so => so.type === 'custom' && ['received', 'tailor', 'ready'].includes(so.status));
}
function designCost(p, unit = D.unit) {
  const fab = p.fabricId ? (unit?.[p.fabricId] ?? N(pmapGet(p.fabricId)?.cost)) : 0;
  return N(p.fabricQty || 1) * fab + N(p.otherCost);
}
function pmapGet(id) { return S.products.find(x => x.id === id); }
function fullDesignCost(p) { return designCost(p) + N(p.stitchCost); }

/* ===== periods & reports ===== */
function range(key = S.period) {
  const t = today(), d = new Date();
  switch (key) {
    case 'today': return [t, t];
    case '7d': return [addDays(t, -6), t];
    case 'month': return [ymd(new Date(d.getFullYear(), d.getMonth(), 1)), t];
    case 'lastmonth': return [ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)), ymd(new Date(d.getFullYear(), d.getMonth(), 0))];
    case 'quarter': return [addDays(t, -89), t];
    case 'year': return [ymd(new Date(d.getFullYear(), 0, 1)), t];
    case 'custom': return [S.from || '2000-01-01', S.to || t];
    default: return ['2000-01-01', '2999-12-31'];
  }
}
const PERIODS = { today: 'Today', '7d': '7 days', month: 'This month', lastmonth: 'Last month', quarter: '90 days', year: 'This year', all: 'All time', custom: 'Custom' };
const inR = (d, [a, b]) => d >= a && d <= b;

function pnl(rg) {
  const sales = S.sales.filter(so => live(so) && inR(so.date, rg));
  const gross = sum(sales, so => saleTotals(so).sub), disc = sum(sales, so => so.discount), deliv = sum(sales, so => so.delivery);
  const mat = sum(sales, so => saleTotals(so).mat), stitch = sum(sales, so => saleTotals(so).stitch);
  const rets = S.returns.filter(r => r.kind === 'sale' && inR(r.date, rg));
  const retRev = sum(rets, r => r.amount);
  const retCost = sum(rets, r => sum(r.items || [], i => i.restock ? N(i.qty) * N(i.cost) : 0));
  const netRev = gross - disc - retRev + deliv;
  const cogs = mat + stitch - retCost;
  const grossProfit = netRev - cogs;
  const exp = {}; S.expenses.filter(e => inR(e.date, rg)).forEach(e => exp[e.category || 'Other'] = (exp[e.category || 'Other'] || 0) + N(e.amount));
  const expTotal = Object.values(exp).reduce((a, b) => a + b, 0);
  const writeoffs = sum(S.adjustments.filter(a => inR(a.date, rg) && N(a.qty) < 0 && ['damage', 'lost', 'sample'].includes(a.reason)), a => -N(a.qty) * (D.unit[a.pid] || 0));
  const net = grossProfit - expTotal - writeoffs;
  return { orders: sales.length, gross, disc, deliv, retRev, retCost, netRev, mat, stitch, cogs, grossProfit, exp, expTotal, writeoffs, net };
}
function topSellers(rg) {
  const m = {};
  for (const so of S.sales) { if (!live(so) || !inR(so.date, rg)) continue;
    for (const i of so.items || []) { const r = m[i.pid] || (m[i.pid] = { pid: i.pid, qty: 0, rev: 0, cost: 0 }); r.qty += N(i.qty); r.rev += N(i.qty) * N(i.rate); r.cost += N(i.qty) * (N(i.matCost) + N(i.stitch)); } }
  for (const rt of S.returns) { if (rt.kind !== 'sale' || !inR(rt.date, rg)) continue;
    for (const i of rt.items || []) { const r = m[i.pid] || (m[i.pid] = { pid: i.pid, qty: 0, rev: 0, cost: 0 }); r.qty -= N(i.qty); r.rev -= N(i.qty) * N(i.rate); if (i.restock) r.cost -= N(i.qty) * N(i.cost); } }
  return Object.values(m).map(r => ({ ...r, profit: r.rev - r.cost })).filter(r => r.qty > 0 || r.rev > 0).sort((a, b) => b.rev - a.rev);
}
function monthly(n = 12) {
  const out = []; const d = new Date(); d.setDate(1);
  for (let k = n - 1; k >= 0; k--) {
    const a = new Date(d.getFullYear(), d.getMonth() - k, 1), b = new Date(d.getFullYear(), d.getMonth() - k + 1, 0);
    const r = pnl([ymd(a), ymd(b)]);
    out.push({ label: a.toLocaleDateString('en-GB', { month: 'short' }), rev: r.netRev, profit: r.net });
  }
  return out;
}
function nextNo(col, prefix) {
  let m = 0; for (const x of S[col]) { const k = parseInt(String(x.no || '').replace(/\D/g, ''), 10); if (k > m) m = k; }
  return prefix + '-' + String(m + 1).padStart(4, '0');
}
function partyBalance(pt) {
  if (pt.role === 'customer') return sum(S.sales.filter(so => so.partyId === pt.id), so => saleTotals(so).due);
  if (pt.role === 'supplier') return sum(S.purchases.filter(pu => pu.partyId === pt.id), pu => purchaseTotals(pu).due);
  if (pt.role === 'tailor') return sum(S.sales.filter(so => live(so) && so.tailorId === pt.id && !so.tailorPaid && so.status !== 'received'), so => saleTotals(so).stitch);
  return 0;
}
/* ===== render loop ===== */
const NAV = [
  ['Daily work'], ['dashboard', 'Overview'], ['sales', 'Sales & orders'], ['tailor', 'Tailor board'], ['purchases', 'Purchases'], ['returns', 'Returns'],
  ['Stock'], ['inventory', 'Inventory'], ['catalog', 'Fabrics & designs'],
  ['Accounts'], ['parties', 'Contacts'], ['expenses', 'Expenses'], ['reports', 'Reports'], ['settings', 'Settings']
];
let rq = false;
function queue() { if (rq) return; rq = true; requestAnimationFrame(() => { rq = false; render(); }); }
function render() {
  derive();
  const counts = { purchases: D.scheduled.length, tailor: D.openOrders.length, inventory: D.inv.filter(r => ['low', 'out', 'stuck'].includes(r.status) && r.p.kind !== 'design').length };
  counts.settings = A.isAdmin ? A.requests.filter(r => !A.team.some(t => t.id === r.id)).length : 0;
  const waiting = mode !== 'local' && !A.ready, blocked = !waiting && !R();
  const navItems = []; let hdr = null; NAV.forEach(n => { if (n.length === 1) hdr = n; else if (canView(n[0])) { if (hdr) { navItems.push(hdr); hdr = null; } navItems.push(n); } });
  $('#nav').innerHTML = (waiting || blocked) ? '' : navItems.map(n => n.length === 1 ? `<div class="grp">${n[0]}</div>` :
    `<button data-go="${n[0]}" class="${S.view === n[0] ? 'on' : ''}"><span>${n[1]}</span>${counts[n[0]] ? `<span class="count">${counts[n[0]]}</span>` : ''}</button>`).join('');
  $('#bizName').textContent = S.settings.business || 'My business';
  $('#logo').textContent = (S.settings.business || 'Z').trim().charAt(0).toUpperCase();
  const ae = document.activeElement; const aid = ae && ae.id && $('#main').contains(ae) ? ae.id : null; const sel = aid && ae.selectionStart;
  $('#main').innerHTML = waiting ? `<div class="empty"><b>Checking your access</b>One moment.</div>` : blocked ? waitingView() :
    (S.readOnly ? `<div class="banner">You have view-only access. Ask the owner if you need to make changes.</div>` : '') +
    (mode === 'local' ? `<div class="banner">Shared storage is not available in this view, so changes are kept only in this browser.</div>` : '') +
    (A.role !== 'admin' && R() ? `<div class="note" style="margin-bottom:14px">Signed in as <b>${esc(A.me?.name || 'team member')}</b> · ${esc(R().label)}</div>` : '') +
    (VIEWS[canView(S.view) ? S.view : 'dashboard'] || VIEWS.dashboard)();
  if (S.view === 'settings' && !waiting && !blocked) fillPeople();
  if (aid) { const el = document.getElementById(aid); if (el) { el.focus(); try { el.setSelectionRange(sel, sel); } catch (e) {} } }
  $('#syncDot').className = 'dot ' + (mode === 'db' ? 'ok' : mode === 'local' ? 'warn' : '');
  $('#syncTxt').textContent = mode === 'db' ? 'Saved to cloud · live' : mode === 'local' ? 'This browser only' : 'Connecting…';
}
function go(v) { if (!canView(v)) return; S.view = v; try { history.replaceState(null, '', '#' + v); } catch (e) {} render(); window.scrollTo(0, 0); }

const periodChips = () => `<div class="chips">${Object.entries(PERIODS).map(([k, l]) => `<button class="chip ${S.period === k ? 'on' : ''}" data-period="${k}">${l}</button>`).join('')}</div>` +
  (S.period === 'custom' ? `<div class="row" style="margin-top:8px"><label class="f">From<input type="date" id="pFrom" value="${S.from}"></label><label class="f">To<input type="date" id="pTo" value="${S.to}"></label></div>` : '');
const tabs = (key, opts) => `<div class="chips">${opts.map(([k, l]) => `<button class="chip ${(S.tab[key] || opts[0][0]) === k ? 'on' : ''}" data-tab="${esc(key + ':' + k)}">${esc(l)}</button>`).join('')}</div>`;
const tabOf = (key, def) => S.tab[key] || def;
const searchBox = (key, ph) => `<input class="search" id="q-${key}" data-q="${key}" placeholder="${ph}" value="${esc(S.q[key] || '')}">`;
const match = (key, ...fields) => { const q = (S.q[key] || '').toLowerCase().trim(); return !q || fields.join(' ').toLowerCase().includes(q); };
const emptyRow = (cols, title, sub) => `<tr><td colspan="${cols}"><div class="empty"><b>${title}</b>${sub}</div></td></tr>`;
const statusPill = s => pill(STATUS[s]?.label || s, STATUS[s]?.tone || 'mute');
const invPill = s => ({ ok: pill('In stock', 'good'), low: pill('Low stock', 'warn'), out: pill('Out of stock', 'bad'), stuck: pill('Stuck', 'accent'), mto: pill('Made to order', 'mute') })[s];
const itemsLine = so => (so.items || []).map(i => `${pname(i.pid)} × ${qty(i.qty)}`).join(', ');

const VIEWS = {};

/* ===== Overview ===== */
VIEWS.dashboard = () => {
  const rg = range(), r = pnl(rg), top = topSellers(rg).slice(0, 6), months = monthly(12);
  const stuck = D.inv.filter(x => x.status === 'stuck').sort((a, b) => b.value - a.value).slice(0, 6);
  const low = D.inv.filter(x => x.status === 'low' || x.status === 'out').filter(x => x.p.kind !== 'design').slice(0, 6);
  const pipeCount = s => S.sales.filter(so => so.type === 'custom' && so.status === s).length;
  const late = D.openOrders.filter(so => so.dueDate && so.dueDate < today()).length;
  const recent = [...S.sales].sort((a, b) => (b.date + b.no).localeCompare(a.date + a.no)).slice(0, 6);
  const maxTop = Math.max(1, ...top.map(t => t.rev));
  return `
  <div class="head"><div><h1>Overview</h1><p>${PERIODS[S.period]} · ${fdate(rg[0])} – ${fdate(rg[1] > today() ? today() : rg[1])}</p></div>
    <div class="row"><button class="btn" data-act="newPurchase">+ Purchase</button><button class="btn primary" data-act="newSale">+ New sale / order</button></div></div>
  <div style="margin-bottom:14px">${periodChips()}</div>
  <div class="kpis">
    <div class="kpi"><div class="l">Net sales</div><div class="v">${money(r.netRev)}</div><div class="s">${r.orders} orders · returns ${money(r.retRev)}</div></div>
    <div class="kpi profit"><div class="l">Gross profit</div><div class="v">${money(r.grossProfit)}</div><div class="s">${r.netRev ? Math.round(r.grossProfit / r.netRev * 100) : 0}% margin after fabric & stitching</div></div>
    <div class="kpi profit ${r.net >= 0 ? 'pos' : 'neg'}"><div class="l">${r.net >= 0 ? 'Net profit' : 'Net loss'}</div><div class="v">${money(r.net)}</div><div class="s">after ${money(r.expTotal + r.writeoffs)} expenses & write-offs</div></div>
    <div class="kpi cost"><div class="l">Stock value</div><div class="v">${money(D.stockValue)}</div><div class="s">${qty(sum(D.inv.filter(x => x.p.kind !== 'design'), x => Math.max(0, x.qty)))} units of fabric & suits</div></div>
    <button class="kpi kpi-btn" data-act="receivables"><div class="l">Customers owe you</div><div class="v ${D.receivable > 0.5 ? 'warn' : ''}">${money(D.receivable)}</div><div class="s">${D.recvCount} customer${D.recvCount === 1 ? '' : 's'}${D.recvLate ? ` · <span class="bad">${D.recvLate} overdue</span>` : ''} · <span style="color:var(--brand)">View list →</span></div></button>
    <div class="kpi cost"><div class="l">You owe suppliers</div><div class="v">${money(D.payable)}</div><div class="s">for cloth received</div></div>
    <div class="kpi cost"><div class="l">Tailor payable</div><div class="v">${money(D.tailorDue)}</div><div class="s">${D.openOrders.length} orders open${late ? ` · <span class="bad">${late} late</span>` : ''}</div></div>
  </div>
  <div class="grid2">
    <div class="panel profit"><h2>Sales & profit, last 12 months</h2>${monthChart(months)}</div>
    <div class="panel"><h2>Custom order pipeline <button class="btn sm" data-go="tailor">Open board</button></h2>
      <div class="pipe">${FLOW.map(s => `<div><b>${pipeCount(s)}</b><span>${STATUS[s].label}</span></div>`).join('')}</div>
      <h2 style="margin-top:18px">Top selling <small>${PERIODS[S.period]}</small></h2>
      ${top.length ? `<div class="bars">${top.map(t => `<div class="bar"><div class="t"><span>${esc(pname(t.pid))}</span><span class="mono">${qty(t.qty)} · ${money(t.rev)}</span></div><div class="track"><div class="fill" style="width:${Math.max(3, t.rev / maxTop * 100)}%"></div></div></div>`).join('')}</div>` : `<div class="empty">No sales in this period yet.</div>`}
    </div>
    <div class="panel"><h2>Stuck inventory <small>no movement in ${S.settings.deadDays || 90}+ days</small></h2>
      <div class="tw"><table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n cost">Value</th><th class="n">Idle</th></tr></thead><tbody>
      ${stuck.length ? stuck.map(x => `<tr><td>${esc(x.p.name)}</td><td class="n">${qty(x.qty)}</td><td class="n cost">${money(x.value)}</td><td class="n warn">${x.age}d</td></tr>`).join('') : emptyRow(4, 'Nothing stuck', 'All stock has moved recently.')}
      </tbody></table></div></div>
    <div class="panel"><h2>Reorder soon ${low.length ? '<button class="btn sm" data-act="reorderPlan">Schedule purchase</button>' : ''}</h2>
      <div class="tw"><table><thead><tr><th>Item</th><th class="n">In stock</th><th class="n">On order</th><th class="n">Reorder at</th><th></th></tr></thead><tbody>
      ${low.length ? low.map(x => `<tr><td>${esc(x.p.name)}</td><td class="n">${qty(x.qty)} ${esc(x.p.unit || '')}</td><td class="n ${x.onOrder ? 'good' : 'muted'}">${x.onOrder ? qty(x.onOrder) : '—'}</td><td class="n">${qty(x.p.reorder)}</td><td>${invPill(x.status)}</td></tr>`).join('') : emptyRow(5, 'Stock levels are healthy', 'Set a reorder level on a fabric to get alerts.')}
      </tbody></table></div></div>
  </div>
  <div class="panel" style="margin-top:16px"><h2>Scheduled purchases <small>${D.scheduled.length} open${D.lateSchedule ? ` · <span class="bad">${D.lateSchedule} overdue</span>` : ''}</small></h2>
    <div class="tw">${scheduledTable(D.scheduled.slice(0, 6))}</div></div>
  <div class="panel" style="margin-top:16px"><h2>Recent sales <button class="btn sm" data-go="sales">All sales</button></h2>
    <div class="tw">${salesTable(recent, true)}</div></div>`;
};
function monthChart(m) {
  const W = 560, H = 220, L = 58, B = 26, T = 10, R = 8;
  const vals = m.flatMap(x => [x.rev, x.profit]); let max = Math.max(0, ...vals), min = Math.min(0, ...vals);
  if (max === min) max = min + 1;
  const raw = (max - min) / 4, mag = Math.pow(10, Math.floor(Math.log10(raw))), step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(k => k >= raw);
  max = Math.ceil(max / step) * step; min = Math.floor(min / step) * step;
  const y = v => T + (max - v) / (max - min) * (H - T - B);
  const bw = (W - L - R) / m.length; const ticks = Math.round((max - min) / step);
  let g = '';
  for (let k = 0; k <= ticks; k++) { const v = min + (max - min) * k / ticks; const yy = y(v);
    g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="var(--line)" ${Math.abs(v) < 1e-9 ? 'stroke-width="1.5"' : 'stroke-dasharray="2 3"'}/><text x="${L - 6}" y="${yy + 4}" text-anchor="end">${short(v)}</text>`; }
  m.forEach((x, i) => { const cx = L + i * bw; const w = Math.min(14, bw * .32);
    const r1 = y(Math.max(0, x.rev)), r0 = y(0);
    g += `<rect x="${cx + bw / 2 - w - 1}" y="${Math.min(r1, r0)}" width="${w}" height="${Math.abs(r0 - r1)}" rx="2" fill="var(--brand)"><title>${x.label}: sales ${money(x.rev)}</title></rect>`;
    const p1 = y(x.profit); g += `<rect x="${cx + bw / 2 + 1}" y="${Math.min(p1, r0)}" width="${w}" height="${Math.abs(r0 - p1)}" rx="2" fill="${x.profit < 0 ? 'var(--bad)' : 'var(--accent)'}"><title>${x.label}: ${x.profit < 0 ? 'loss' : 'profit'} ${money(x.profit)}</title></rect>`;
    g += `<text x="${cx + bw / 2}" y="${H - 8}" text-anchor="middle">${x.label}</text>`; });
  return `<div class="legend"><span><i style="background:var(--brand)"></i>Net sales</span><span><i style="background:var(--accent)"></i>Net profit</span><span><i style="background:var(--bad)"></i>Loss</span></div><div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly sales and profit">${g}</svg></div>`;
}
function short(v) { const a = Math.abs(v); const s = a >= 1e7 ? (a / 1e7).toFixed(1).replace(/\.0$/, '') + 'Cr' : a >= 1e5 ? (a / 1e5).toFixed(1).replace(/\.0$/, '') + 'L' : a >= 1e3 ? (a / 1e3).toFixed(0) + 'k' : Math.round(a) + ''; return (v < 0 ? '−' : '') + s; }

/* ===== Sales ===== */
function salesTable(list, compact) {
  return `<table><thead><tr><th>No.</th><th>Date</th><th>Customer</th>${compact ? '' : '<th>Type</th><th>Items</th>'}<th class="n">Total</th><th class="n">Due</th><th>Status</th></tr></thead><tbody>
  ${list.length ? list.map(so => { const t = saleTotals(so); const late = so.type === 'custom' && ['received', 'tailor', 'ready'].includes(so.status) && so.dueDate && so.dueDate < today();
    return `<tr class="click" data-open="sale:${so.id}"><td class="mono">${esc(so.no)}</td><td>${fdate(so.date)}</td><td>${esc(partyName(so.partyId))}</td>${compact ? '' : `<td>${so.type === 'custom' ? pill('Stitched order', 'brand') : pill('Unstitched', 'mute')}</td><td class="muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(itemsLine(so))}</td>`}<td class="n">${money(t.total)}</td><td class="n ${t.due > 0.5 ? 'bad' : 'muted'}">${t.due > 0.5 ? money(t.due) : 'Paid'}</td><td>${statusPill(so.status)}${late ? ' ' + pill('Late', 'bad') : ''}</td></tr>`; }).join('')
  : emptyRow(compact ? 6 : 8, 'No sales yet', 'Record your first sale or stitched order with “New sale / order”.')}</tbody></table>`;
}
VIEWS.sales = () => {
  const tb = tabOf('sales', 'all'), st = tabOf('salesSt', 'any');
  const list = S.sales.filter(so => (tb === 'all' || so.type === tb) && (st === 'any' || so.status === st) && match('sales', so.no, partyName(so.partyId), itemsLine(so)))
    .sort((a, b) => (b.date + b.no).localeCompare(a.date + a.no));
  const tot = sum(list.filter(live), so => saleTotals(so).total), due = sum(list, so => Math.max(0, saleTotals(so).due));
  return `<div class="head"><div><h1>Sales & orders</h1><p>Stitched outfit orders and unstitched wholesale sales in one place.</p></div>
    <div class="row"><button class="btn" data-act="exportSales">Export CSV</button><button class="btn primary" data-act="newSale">+ New sale / order</button></div></div>
  <div class="toolbar">${tabs('sales', [['all', 'All'], ['custom', 'Stitched orders'], ['wholesale', 'Unstitched / wholesale']])}${searchBox('sales', 'Search invoice, customer, design…')}</div>
  <div class="toolbar">${tabs('salesSt', [['any', 'Any status'], ...Object.entries(STATUS).map(([k, v]) => [k, v.label])])}<span class="muted">${list.length} records · ${money(tot)} · due ${money(due)}</span></div>
  <div class="tw">${salesTable(list)}</div>`;
};

/* ===== Tailor board ===== */
VIEWS.tailor = () => {
  const cutoff = addDays(today(), -14);
  const orders = S.sales.filter(so => so.type === 'custom' && so.status !== 'cancelled' && match('tailor', so.no, partyName(so.partyId), partyName(so.tailorId), itemsLine(so)));
  const colHtml = s => { let l = orders.filter(o => o.status === s); if (s === 'delivered') l = l.filter(o => (o.deliveredDate || o.date) >= cutoff);
    l.sort((a, b) => (a.dueDate || '9').localeCompare(b.dueDate || '9'));
    return `<div class="col"><h3><span>${STATUS[s].label}</span><span class="muted">${l.length}</span></h3>${l.map(o => { const late = s !== 'delivered' && o.dueDate && o.dueDate < today(); const nx = FLOW[FLOW.indexOf(s) + 1];
      return `<div class="card ${late ? 'late' : ''}" data-open="sale:${o.id}"><div class="top"><span class="mono">${esc(o.no)}</span><span class="${late ? 'bad' : 'muted'}">${o.dueDate ? 'Due ' + fdate(o.dueDate) : ''}</span></div><b>${esc(partyName(o.partyId))}</b><div class="items">${esc(itemsLine(o))}</div>${o.tailorId ? `<div class="items">Tailor: ${esc(partyName(o.tailorId))}</div>` : ''}${nx ? `<div><button class="btn sm" data-advance="${o.id}">${nx === 'tailor' ? 'Send to tailor' : nx === 'ready' ? 'Mark stitched' : 'Mark delivered'} →</button></div>` : ''}</div>`; }).join('') || '<div class="muted" style="font-size:12.5px;padding:4px">Empty</div>'}</div>`; };
  const tailors = S.parties.filter(p => p.role === 'tailor');
  const unpaid = S.sales.filter(so => live(so) && so.type === 'custom' && so.tailorId && !so.tailorPaid && so.status !== 'received');
  return `<div class="head"><div><h1>Tailor board</h1><p>Every stitched order from receipt to delivery. Delivered column shows the last 14 days.</p></div>
    <div class="row">${searchBox('tailor', 'Search order, customer, tailor…')}<button class="btn primary" data-act="newSale" data-type="custom">+ Stitched order</button></div></div>
  <div class="board">${FLOW.map(colHtml).join('')}</div>
  <div class="grid2" style="margin-top:16px">
    <div class="panel"><h2>Tailors</h2><div class="tw"><table><thead><tr><th>Tailor</th><th class="n">Pieces at tailor</th><th class="n">Stitching unpaid</th></tr></thead><tbody>
    ${tailors.length ? tailors.map(t => `<tr><td>${esc(t.name)}</td><td class="n">${qty(sum(S.sales.filter(so => so.tailorId === t.id && so.status === 'tailor'), so => sum(so.items || [], i => i.qty)))}</td><td class="n">${money(partyBalance(t))}</td></tr>`).join('') : emptyRow(3, 'No tailors added', 'Add tailors under Contacts.')}
    </tbody></table></div></div>
    <div class="panel cost"><h2>Stitching to pay <small>${money(sum(unpaid, so => saleTotals(so).stitch))}</small></h2><div class="tw"><table><thead><tr><th>Order</th><th>Tailor</th><th class="n">Amount</th><th></th></tr></thead><tbody>
    ${unpaid.length ? unpaid.map(so => `<tr><td class="mono">${esc(so.no)}</td><td>${esc(partyName(so.tailorId))}</td><td class="n">${money(saleTotals(so).stitch)}</td><td class="n"><button class="btn sm" data-tailorpaid="${so.id}">Mark paid</button></td></tr>`).join('') : emptyRow(4, 'All tailors paid', 'Stitching charges appear here once an order is sent to a tailor.')}
    </tbody></table></div></div></div>`;
};

/* ===== Purchases ===== */
function scheduledTable(list) {
  return `<table><thead><tr><th>Order</th><th>Supplier</th><th>Items to buy</th><th>Expected</th><th class="n">Est. total</th><th></th></tr></thead><tbody>
  ${list.length ? list.map(pu => { const late = pu.expected && pu.expected < today();
    return `<tr class="click" data-open="purchase:${pu.id}"><td class="mono">${esc(pu.no)}</td><td>${esc(partyName(pu.partyId))}</td><td class="muted">${esc((pu.items || []).map(i => `${pname(i.pid)} × ${qty(i.qty)}`).join(', '))}</td><td class="${late ? 'bad' : ''}">${fdate(pu.expected)}${late ? ' ' + pill('Overdue', 'bad') : ''}</td><td class="n">${money(purchaseTotals(pu).sub)}</td><td class="n"><button class="btn sm primary" data-receive="${pu.id}">Receive stock</button></td></tr>`; }).join('')
  : emptyRow(6, 'Nothing scheduled', 'Plan upcoming cloth purchases with “Schedule purchase”. Stock updates when you receive them.')}</tbody></table>`;
}
VIEWS.purchases = () => {
  const tb = tabOf('pur', D.scheduled.length ? 'scheduled' : 'received');
  const m = pu => match('purchases', pu.no, partyName(pu.partyId), (pu.items || []).map(i => pname(i.pid)).join(' '));
  const sched = D.scheduled.filter(m);
  const list = S.purchases.filter(received).filter(m).sort((a, b) => (b.date + b.no).localeCompare(a.date + a.no));
  const lowN = reorderLines().length;
  return `<div class="head"><div><h1>Purchases</h1><p>Plan what to buy, then receive it. Stock goes up only when a purchase is received.</p></div>
    <div class="row"><button class="btn" data-act="exportPurchases">Export CSV</button><button class="btn" data-act="reorderPlan">Reorder low stock${lowN ? ` (${lowN})` : ''}</button><button class="btn" data-act="schedulePurchase">+ Schedule purchase</button><button class="btn primary" data-act="newPurchase">+ Bought now</button></div></div>
  <div class="toolbar">${tabs('pur', [['scheduled', `Scheduled (${D.scheduled.length})`], ['received', `Received (${S.purchases.filter(received).length})`]])}${searchBox('purchases', 'Search order, supplier, fabric…')}</div>
  ${tb === 'scheduled' ? `<div class="toolbar"><span class="muted">${sched.length} planned · estimated ${money(sum(sched, pu => purchaseTotals(pu).sub))}${D.lateSchedule ? ` · <span class="bad">${D.lateSchedule} overdue</span>` : ''}</span></div><div class="tw">${scheduledTable(sched)}</div>`
  : `<div class="toolbar"><span class="muted">Total ${money(sum(list, pu => purchaseTotals(pu).total))} · you owe ${money(sum(list, pu => Math.max(0, purchaseTotals(pu).due)))}</span></div>
  <div class="tw"><table><thead><tr><th>Bill no.</th><th>Received</th><th>Supplier</th><th>Items</th><th class="n">Total</th><th class="n">Paid</th><th class="n">Due</th></tr></thead><tbody>
  ${list.length ? list.map(pu => { const t = purchaseTotals(pu); return `<tr class="click" data-open="purchase:${pu.id}"><td class="mono">${esc(pu.no)}</td><td>${fdate(pu.date)}</td><td>${esc(partyName(pu.partyId))}</td><td class="muted">${esc((pu.items || []).map(i => `${pname(i.pid)} × ${qty(i.qty)}`).join(', '))}</td><td class="n">${money(t.total)}</td><td class="n">${money(t.paid)}</td><td class="n ${t.due > 0.5 ? 'bad' : 'muted'}">${t.due > 0.5 ? money(t.due) : 'Paid'}</td></tr>`; }).join('') : emptyRow(7, 'No purchases received yet', 'Record cloth you buy to build up stock.')}
  </tbody></table></div>`}`;
};

/* ===== Returns ===== */
VIEWS.returns = () => {
  const tb = tabOf('returns', 'all');
  const list = S.returns.filter(r => (tb === 'all' || r.kind === tb) && match('returns', r.no, partyName(r.partyId), r.reason)).sort((a, b) => (b.date + b.no).localeCompare(a.date + a.no));
  const refNo = r => (r.kind === 'sale' ? S.sales : S.purchases).find(x => x.id === r.refId)?.no || '—';
  return `<div class="head"><div><h1>Returns</h1><p>Customer returns reduce sales and can go back into stock. Returns to suppliers reduce what you owe.</p></div>
    <div class="row"><button class="btn" data-act="newReturn" data-kind="purchase">+ Return to supplier</button><button class="btn primary" data-act="newReturn" data-kind="sale">+ Customer return</button></div></div>
  <div class="toolbar">${tabs('returns', [['all', 'All'], ['sale', 'From customers'], ['purchase', 'To suppliers']])}${searchBox('returns', 'Search…')}</div>
  <div class="tw"><table><thead><tr><th>No.</th><th>Date</th><th>Type</th><th>Against</th><th>Contact</th><th>Items</th><th>Reason</th><th class="n">Amount</th><th></th></tr></thead><tbody>
  ${list.length ? list.map(r => `<tr><td class="mono">${esc(r.no)}</td><td>${fdate(r.date)}</td><td>${r.kind === 'sale' ? pill('Customer return', 'warn') : pill('To supplier', 'info')}</td><td class="mono">${esc(refNo(r))}</td><td>${esc(partyName(r.partyId))}</td><td class="muted">${esc((r.items || []).map(i => `${pname(i.pid)} × ${qty(i.qty)}${r.kind === 'sale' ? (i.restock ? ' (restocked)' : ' (written off)') : ''}`).join(', '))}</td><td>${esc(r.reason || '')}</td><td class="n">${money(r.amount)}</td><td class="n" style="white-space:nowrap"><button class="btn sm" data-printret="${r.id}">Print</button> <button class="btn sm danger" data-delreturn="${r.id}">Delete</button></td></tr>`).join('') : emptyRow(9, 'No returns', 'Returns you record show up here.')}
  </tbody></table></div>`;
};
/* ===== Inventory ===== */
VIEWS.inventory = () => {
  const tb = tabOf('inv', 'fabric'), fl = tabOf('invSt', 'any');
  const rows = D.inv.filter(r => (tb === 'fabric' ? r.p.kind !== 'design' : r.p.kind === 'design') && (fl === 'any' || r.status === fl) && match('inv', r.p.name, r.p.code, r.p.category, r.p.color))
    .sort((a, b) => b.value - a.value);
  return `<div class="head"><div><h1>Inventory</h1><p>Live stock from purchases, sales, tailor orders, returns and adjustments.</p></div>
    <div class="row"><button class="btn" data-act="exportStock">Export CSV</button><button class="btn primary" data-act="adjust">Adjust stock</button></div></div>
  <div class="kpis">
    <div class="kpi cost"><div class="l">Stock value (at cost)</div><div class="v">${money(D.stockValue)}</div></div>
    <div class="kpi"><div class="l">Low / out of stock</div><div class="v">${D.inv.filter(r => r.status === 'low' || r.status === 'out').length}</div><div class="s">items to reorder</div></div>
    <div class="kpi cost"><div class="l">Stuck stock</div><div class="v">${money(sum(D.inv.filter(r => r.status === 'stuck'), r => r.value))}</div><div class="s">${D.inv.filter(r => r.status === 'stuck').length} items idle ${S.settings.deadDays || 90}+ days</div></div>
  </div>
  <div class="toolbar">${tabs('inv', [['fabric', 'Unstitched fabric & suits'], ['design', 'Ready stitched pieces']])}${searchBox('inv', 'Search item, code, colour…')}</div>
  <div class="toolbar">${tabs('invSt', [['any', 'All'], ['ok', 'In stock'], ['low', 'Low'], ['out', 'Out'], ['stuck', 'Stuck'], ...(tb === 'design' ? [['mto', 'Made to order']] : [])])}</div>
  <div class="tw"><table><thead><tr><th>Code</th><th>Item</th><th class="n">In stock</th><th class="n">On order</th><th class="n cost">Avg cost</th><th class="n cost">Stock value</th><th class="n">Sale price</th><th class="n">Sold</th><th>Last movement</th><th>Status</th></tr></thead><tbody>
  ${rows.length ? rows.map(r => `<tr class="click" data-open="product:${r.p.id}"><td class="mono">${esc(r.p.code || '')}</td><td>${esc(r.p.name)}<div class="muted" style="font-size:12px">${esc([r.p.category, r.p.color].filter(Boolean).join(' · '))}</div></td><td class="n ${r.qty < 0 ? 'bad' : ''}">${qty(r.qty)} ${esc(r.p.unit || '')}</td><td class="n ${r.onOrder ? 'good' : 'muted'}">${r.onOrder ? qty(r.onOrder) : '—'}</td><td class="n cost">${money(r.unit)}</td><td class="n cost">${money(r.value)}</td><td class="n">${money(r.p.price)}</td><td class="n">${qty(r.soldQty)}</td><td>${r.lastMove ? fdate(r.lastMove) + ` <span class="muted">(${r.age}d)</span>` : '<span class="muted">Never</span>'}</td><td>${invPill(r.status)}</td></tr>`).join('') : emptyRow(10, 'Nothing here', tb === 'design' ? 'Stitched pieces appear when a customer return is restocked or you add ready pieces with “Adjust stock”.' : 'Add fabrics under “Fabrics & designs”, then record a purchase.')}
  </tbody><tfoot class="cost"><tr><td colspan="5">Total</td><td class="n">${money(sum(rows, r => r.value))}</td><td colspan="4"></td></tr></tfoot></table></div>
  <div class="panel" style="margin-top:16px"><h2>Recent stock adjustments</h2><div class="tw"><table><thead><tr><th>Date</th><th>Item</th><th>Reason</th><th class="n">Qty</th><th>Note</th><th></th></tr></thead><tbody>
  ${S.adjustments.length ? [...S.adjustments].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 25).map(a => `<tr><td>${fdate(a.date)}</td><td>${esc(pname(a.pid))}</td><td>${esc(ADJ_REASONS[a.reason] || a.reason)}</td><td class="n ${N(a.qty) < 0 ? 'bad' : 'good'}">${N(a.qty) > 0 ? '+' : ''}${qty(a.qty)}</td><td class="muted">${esc(a.note || '')}</td><td class="n"><button class="btn sm danger" data-deladj="${a.id}">Delete</button></td></tr>`).join('') : emptyRow(6, 'No adjustments', 'Use “Adjust stock” for opening stock, damage, or count corrections.')}
  </tbody></table></div></div>`;
};

/* ===== Catalog ===== */
VIEWS.catalog = () => {
  const tb = tabOf('cat', 'fabric');
  const cats = [...new Set(S.products.filter(p => (tb === 'fabric') === (p.kind !== 'design')).map(p => (p.category || '').trim()).filter(Boolean))].sort();
  const cf = cats.includes(S.tab['catCat' + tb]) ? S.tab['catCat' + tb] : 'all';
  const list = S.products.filter(p => (tb === 'fabric' ? p.kind !== 'design' : p.kind === 'design') && (cf === 'all' || (p.category || '').trim() === cf) && match('cat', p.name, p.code, p.category, p.color)).sort((a, b) => String(a.code || a.name).localeCompare(String(b.code || b.name)));
  const head = tb === 'fabric'
    ? '<th>Code</th><th>Fabric / suit</th><th>Unit</th><th class="n cost">Avg cost</th><th class="n">Retail price</th><th class="n">Wholesale</th><th class="n profit">Margin</th><th class="n">Reorder at</th>'
    : '<th>Design no.</th><th>Outfit</th><th>Uses fabric</th><th class="n cost">Fabric + extras</th><th class="n cost">Stitching</th><th class="n cost">Total cost</th><th class="n">Sale price</th><th class="n profit">Margin</th>';
  const row = p => { if (tb === 'fabric') { const c = D.unit[p.id] || 0; const m = N(p.price) ? (N(p.price) - c) / N(p.price) * 100 : 0;
      return `<tr class="click" data-open="product:${p.id}"><td class="mono">${esc(p.code || '')}</td><td>${esc(p.name)}<div class="muted" style="font-size:12px">${esc([p.category, p.color].filter(Boolean).join(' · '))}</div></td><td>${esc(p.unit || '')}</td><td class="n cost">${money(c)}</td><td class="n">${money(p.price)}</td><td class="n">${p.wholesale ? money(p.wholesale) : '—'}</td><td class="n profit ${m < 0 ? 'bad' : ''}">${Math.round(m)}%</td><td class="n">${p.reorder ? qty(p.reorder) : '—'}</td></tr>`; }
    const mc = designCost(p), tc = mc + N(p.stitchCost), m = N(p.price) ? (N(p.price) - tc) / N(p.price) * 100 : 0;
    return `<tr class="click" data-open="product:${p.id}"><td class="mono">${esc(p.code || '')}</td><td>${esc(p.name)}<div class="muted" style="font-size:12px">${esc([p.category, p.designerId ? 'by ' + partyName(p.designerId) : ''].filter(Boolean).join(' · '))}</div></td><td>${p.fabricId ? esc(pname(p.fabricId)) + ` <span class="muted">× ${qty(p.fabricQty || 1)}</span>` : '<span class="muted">None set</span>'}</td><td class="n cost">${money(mc)}</td><td class="n cost">${money(p.stitchCost)}</td><td class="n cost">${money(tc)}</td><td class="n">${money(p.price)}</td><td class="n profit ${m < 0 ? 'bad' : ''}">${Math.round(m)}%</td></tr>`; };
  return `<div class="head"><div><h1>Fabrics & designs</h1><p>Fabrics are the unstitched cloth and suits you buy. Designs are your outfits, each made from a fabric and stitched by a tailor.</p></div>
    <div class="row"><button class="btn primary" data-act="newProduct" data-kind="${tb === 'fabric' ? 'fabric' : 'design'}">+ ${tb === 'fabric' ? 'Fabric / unstitched suit' : 'Design'}</button></div></div>
  <div class="toolbar">${tabs('cat', [['fabric', `Fabrics & unstitched suits (${S.products.filter(p => p.kind !== 'design').length})`], ['design', `Outfit designs (${S.products.filter(p => p.kind === 'design').length})`]])}${searchBox('cat', 'Search…')}</div>
  ${cats.length > 1 ? `<div class="toolbar">${tabs('catCat' + tb, [['all', 'All categories'], ...cats.map(c => [c, c + ' (' + S.products.filter(p => (tb === 'fabric') === (p.kind !== 'design') && (p.category || '').trim() === c).length + ')'])])}</div>` : ''}
  <div class="tw"><table><thead><tr>${head}</tr></thead><tbody>${list.length ? list.map(row).join('') : emptyRow(8, tb === 'fabric' ? 'No fabrics yet' : 'No designs yet', tb === 'fabric' ? 'Add the cloth or unstitched suits you buy.' : 'Add an outfit design and link it to the fabric it uses.')}</tbody></table></div>`;
};

/* ===== Contacts ===== */
VIEWS.parties = () => {
  const tb = tabOf('parties', 'customer');
  const list = S.parties.filter(p => p.role === tb && match('parties', p.name, p.phone, p.city)).sort((a, b) => a.name.localeCompare(b.name));
  const balLabel = { customer: 'Owes you', supplier: 'You owe', tailor: 'Stitching unpaid', designer: '' }[tb];
  return `<div class="head"><div><h1>Contacts</h1><p>Customers, suppliers, tailors and designers, with running balances.</p></div>
    <div class="row"><button class="btn primary" data-act="newParty" data-role="${tb}">+ ${ROLES[tb]}</button></div></div>
  <div class="toolbar">${tabs('parties', Object.entries(ROLES).map(([k, v]) => [k, v + 's (' + S.parties.filter(p => p.role === k).length + ')']))}${searchBox('parties', 'Search name, phone, city…')}</div>
  <div class="tw"><table><thead><tr><th>Name</th><th>Phone</th><th>City</th><th class="n">${tb === 'customer' ? 'Orders' : tb === 'supplier' ? 'Bills' : tb === 'tailor' ? 'Orders stitched' : 'Designs'}</th><th class="n">${balLabel}</th></tr></thead><tbody>
  ${list.length ? list.map(p => { const cnt = tb === 'customer' ? S.sales.filter(s => s.partyId === p.id).length : tb === 'supplier' ? S.purchases.filter(s => s.partyId === p.id).length : tb === 'tailor' ? S.sales.filter(s => s.tailorId === p.id).length : S.products.filter(x => x.designerId === p.id).length; const b = partyBalance(p);
    return `<tr class="click" data-open="party:${p.id}"><td>${esc(p.name)}</td><td class="mono">${esc(p.phone || '')}</td><td>${esc(p.city || '')}</td><td class="n">${cnt}</td><td class="n ${b > 0.5 ? 'bad' : 'muted'}">${tb === 'designer' ? '' : b > 0.5 ? money(b) : b < -0.5 ? 'Credit ' + money(-b) : 'Settled'}</td></tr>`; }).join('') : emptyRow(5, 'No ' + ROLES[tb].toLowerCase() + 's yet', 'Add one to start tracking.')}
  </tbody></table></div>`;
};

/* ===== Expenses ===== */
VIEWS.expenses = () => {
  const rg = range(); const list = S.expenses.filter(e => inR(e.date, rg) && match('exp', e.category, e.note, partyName(e.partyId))).sort((a, b) => b.date.localeCompare(a.date));
  const byCat = {}; list.forEach(e => byCat[e.category] = (byCat[e.category] || 0) + N(e.amount)); const mx = Math.max(1, ...Object.values(byCat));
  return `<div class="head"><div><h1>Expenses</h1><p>Designer fees, rent, courier, packaging and every other running cost.</p></div>
    <div class="row"><button class="btn primary" data-act="newExpense">+ Expense</button></div></div>
  <div style="margin-bottom:14px">${periodChips()}</div>
  <div class="grid2">
  <div class="panel"><h2>By category <small>${money(sum(list, e => e.amount))}</small></h2>${Object.keys(byCat).length ? `<div class="bars">${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `<div class="bar"><div class="t"><span>${esc(c)}</span><span class="mono">${money(v)}</span></div><div class="track"><div class="fill" style="width:${v / mx * 100}%;background:var(--accent)"></div></div></div>`).join('')}</div>` : '<div class="empty">No expenses in this period.</div>'}</div>
  <div class="panel"><h2>Expenses ${searchBox('exp', 'Search…')}</h2><div class="tw"><table><thead><tr><th>Date</th><th>Category</th><th>Paid to / note</th><th class="n">Amount</th></tr></thead><tbody>
  ${list.length ? list.map(e => `<tr class="click" data-open="expense:${e.id}"><td>${fdate(e.date)}</td><td>${esc(e.category)}</td><td class="muted">${esc([e.partyId ? partyName(e.partyId) : '', e.note].filter(Boolean).join(' · '))}</td><td class="n">${money(e.amount)}</td></tr>`).join('') : emptyRow(4, 'No expenses', 'Add costs to see your true net profit.')}
  </tbody></table></div></div></div>`;
};

/* ===== Reports ===== */
VIEWS.reports = () => {
  const rg = range(), r = pnl(rg), top = topSellers(rg);
  const stuck = D.inv.filter(x => x.status === 'stuck').sort((a, b) => b.value - a.value);
  const recv = S.parties.filter(p => p.role === 'customer').map(p => [p, partyBalance(p)]).filter(x => x[1] > 0.5).sort((a, b) => b[1] - a[1]);
  const pay = S.parties.filter(p => p.role === 'supplier').map(p => [p, partyBalance(p)]).filter(x => x[1] > 0.5).sort((a, b) => b[1] - a[1]);
  const sold = new Set(top.map(t => t.pid));
  const never = D.inv.filter(x => x.p.kind !== 'design' && x.qty > 0 && !x.lastSale);
  const byType = t => { const l = S.sales.filter(so => live(so) && so.type === t && inR(so.date, rg)); return { n: l.length, rev: sum(l, so => saleTotals(so).sub - N(so.discount)), gp: sum(l, so => { const x = saleTotals(so); return x.sub - N(so.discount) - x.cogs; }) }; };
  const cu = byType('custom'), wh = byType('wholesale');
  const line = (l, v, cls = '') => `<tr class="${cls}"><td>${l}</td><td class="n">${money(v)}</td></tr>`;
  return `<div class="head"><div><h1>Reports</h1><p>${fdate(rg[0])} – ${fdate(rg[1] > today() ? today() : rg[1])}</p></div>
    <div class="row"><button class="btn" data-act="exportPL">Export profit & loss</button><button class="btn" data-act="exportTop">Export top sellers</button></div></div>
  <div style="margin-bottom:14px">${periodChips()}</div>
  <div class="grid2">
  <div class="panel"><h2>Profit & loss <small>${r.orders} orders</small></h2><div class="tw"><table class="pl"><tbody>
    <tr class="sec"><td colspan="2">Income</td></tr>
    ${line('Gross sales', r.gross, 'ind')}${line('Less discounts', -r.disc, 'ind')}${line('Less customer returns', -r.retRev, 'ind')}${line('Delivery charges collected', r.deliv, 'ind')}
    ${line('Net sales', r.netRev, 'tot')}
    <tr class="sec"><td colspan="2">Cost of goods sold</td></tr>
    ${line('Fabric & materials', r.mat, 'ind')}${line('Tailor stitching', r.stitch, 'ind')}${line('Less cost of restocked returns', -r.retCost, 'ind')}
    ${line('Total cost of goods', r.cogs, 'tot')}
    ${line('Gross profit', r.grossProfit, 'tot')}
    <tr class="sec"><td colspan="2">Expenses</td></tr>
    ${Object.entries(r.exp).sort((a, b) => b[1] - a[1]).map(([k, v]) => line(esc(k), v, 'ind')).join('') || '<tr class="ind"><td class="muted">No expenses</td><td></td></tr>'}
    ${line('Stock written off (damage, lost, samples)', r.writeoffs, 'ind')}
    ${line('Total expenses', r.expTotal + r.writeoffs, 'tot')}
    <tr class="tot big"><td>${r.net >= 0 ? 'Net profit' : 'Net loss'}</td><td class="n ${r.net >= 0 ? 'good' : 'bad'}">${money(r.net)}</td></tr>
  </tbody></table></div></div>
  <div class="panel"><h2>Business mix</h2><div class="tw"><table><thead><tr><th>Line</th><th class="n">Orders</th><th class="n">Sales</th><th class="n">Gross profit</th><th class="n">Margin</th></tr></thead><tbody>
    <tr><td>Stitched outfits</td><td class="n">${cu.n}</td><td class="n">${money(cu.rev)}</td><td class="n">${money(cu.gp)}</td><td class="n">${cu.rev ? Math.round(cu.gp / cu.rev * 100) : 0}%</td></tr>
    <tr><td>Unstitched / wholesale</td><td class="n">${wh.n}</td><td class="n">${money(wh.rev)}</td><td class="n">${money(wh.gp)}</td><td class="n">${wh.rev ? Math.round(wh.gp / wh.rev * 100) : 0}%</td></tr>
  </tbody></table></div>
  <h2 style="margin-top:18px">Money outstanding</h2><div class="tw"><table><tbody>
    <tr><td>Customers owe you</td><td class="n">${money(D.receivable)}</td></tr><tr><td>You owe suppliers</td><td class="n">${money(D.payable)}</td></tr><tr><td>Stitching owed to tailors</td><td class="n">${money(D.tailorDue)}</td></tr><tr><td>Stock on hand (at cost)</td><td class="n">${money(D.stockValue)}</td></tr>
  </tbody></table></div></div>
  </div>
  <div class="panel" style="margin-top:16px"><h2>Top selling products <small>net of returns</small></h2><div class="tw"><table><thead><tr><th>#</th><th>Product</th><th>Type</th><th class="n">Qty sold</th><th class="n">Sales</th><th class="n">Cost</th><th class="n">Profit</th><th class="n">Margin</th></tr></thead><tbody>
  ${top.length ? top.map((t, i) => `<tr><td class="muted">${i + 1}</td><td>${esc(pname(t.pid))}</td><td>${P(t.pid)?.kind === 'design' ? pill('Design', 'brand') : pill('Unstitched', 'mute')}</td><td class="n">${qty(t.qty)}</td><td class="n">${money(t.rev)}</td><td class="n">${money(t.cost)}</td><td class="n ${t.profit < 0 ? 'bad' : ''}">${money(t.profit)}</td><td class="n">${t.rev ? Math.round(t.profit / t.rev * 100) : 0}%</td></tr>`).join('') : emptyRow(8, 'No sales in this period', 'Pick a wider period above.')}
  </tbody></table></div></div>
  <div class="grid2" style="margin-top:16px">
  <div class="panel"><h2>Stuck in inventory <small>idle ${S.settings.deadDays || 90}+ days · ${money(sum(stuck, x => x.value))}</small></h2><div class="tw"><table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Value</th><th>Last moved</th></tr></thead><tbody>
  ${stuck.length ? stuck.map(x => `<tr><td>${esc(x.p.name)}</td><td class="n">${qty(x.qty)}</td><td class="n">${money(x.value)}</td><td>${x.lastMove ? fdate(x.lastMove) : 'Never'} <span class="muted">(${x.age}d)</span></td></tr>`).join('') : emptyRow(4, 'No stuck stock', '')}
  </tbody></table></div>
  ${never.length ? `<h2 style="margin-top:16px">Never sold <small>${never.length} items</small></h2><div class="tw"><table><tbody>${never.map(x => `<tr><td>${esc(x.p.name)}</td><td class="n">${qty(x.qty)} ${esc(x.p.unit || '')}</td><td class="n">${money(x.value)}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>
  <div class="panel"><h2>Who owes you</h2><div class="tw"><table><tbody>${recv.length ? recv.map(([p, b]) => `<tr class="click" data-open="party:${p.id}"><td>${esc(p.name)}</td><td class="mono">${esc(p.phone || '')}</td><td class="n bad">${money(b)}</td></tr>`).join('') : emptyRow(3, 'Nothing outstanding', '')}</tbody></table></div>
  <h2 style="margin-top:16px">Whom you owe</h2><div class="tw"><table><tbody>${pay.length ? pay.map(([p, b]) => `<tr class="click" data-open="party:${p.id}"><td>${esc(p.name)}</td><td class="mono">${esc(p.phone || '')}</td><td class="n">${money(b)}</td></tr>`).join('') : emptyRow(3, 'All suppliers paid', '')}</tbody></table></div></div>
  </div>`;
};

/* ===== Settings ===== */
VIEWS.settings = () => {
  const samples = COLS.reduce((t, c) => t + S[c].filter(x => x.sample).length, 0);
  const docs = COLS.reduce((t, c) => t + S[c].length, 0);
  return `<div class="head"><div><h1>Settings</h1><p>Business details, team access, alerts and backups.</p></div></div>
  <div class="grid2">${teamPanel()}
  <form class="panel" id="settingsForm"><h2>Business</h2><div class="fg">
    <label class="f">Business name<input id="setBiz" name="business" value="${esc(S.settings.business || '')}"></label>
    <label class="f">Currency symbol<input id="setCur" name="currency" value="${esc(S.settings.currency || 'Rs')}"></label>
    <label class="f">Mark stock as stuck after (days)<input id="setDead" name="deadDays" type="number" min="7" value="${esc(S.settings.deadDays || 90)}"></label>
    <label class="f">Phone on receipts<input id="setPhone" name="phone" value="${esc(S.settings.phone || '')}"></label>
    <label class="f">Address on receipts<input id="setAddr" name="address" value="${esc(S.settings.address || '')}" placeholder="Shop 12, Liberty Market, Lahore"></label>
    <label class="f">Thank-you line on receipts<input id="setFoot" name="footer" value="${esc(S.settings.footer || '')}" placeholder="Thank you for your business."></label>
  </div><div class="row" style="margin-top:14px"><button class="btn primary" type="submit">Save settings</button></div></form>
  <div class="panel"><h2>Backup & data</h2>
    <p class="muted" style="margin-top:0">${docs} records stored${mode === 'db' ? ' in the cloud, shared with everyone you give access to' : ' in this browser'}.</p>
    <div class="row"><button class="btn" data-act="backup">Download backup (.json)</button><label class="btn">Restore from backup<input type="file" id="restoreFile" accept=".json,application/json" hidden></label></div>
    ${samples ? `<div class="note" style="margin-top:14px">${samples} example records are loaded so you can see how everything works. Remove them before entering your own data.<div class="row" style="margin-top:8px"><button class="btn danger" data-act="clearSamples">Remove example data</button></div></div>` : ''}
  </div>
  <div class="panel"><h2>Saved categories & colours</h2>
    <p class="muted" style="margin-top:0">New categories and colours are saved automatically when you save a product, and suggested next time you type. Remove ones you no longer use.</p>
    ${[['fabricCats', 'Fabric categories'], ['designCats', 'Design categories'], ['colors', 'Colours / prints']].map(([k, l]) => { const L = (S.settings.lists || {})[k] || [];
      return `<div style="margin-bottom:12px"><div style="font-weight:600;font-size:13px;margin-bottom:6px">${l} <span class="muted">(${L.length})</span></div><div class="chips">${L.map((x, i) => `<span class="pill t-mute" style="padding-right:4px">${esc(x)}<button class="x" style="width:20px;height:20px;font-size:15px" data-dellist="${k}:${i}" aria-label="Remove ${esc(x)}">×</button></span>`).join('') || '<span class="muted" style="font-size:12.5px">None saved yet</span>'}</div>
      <div class="row" style="margin-top:6px"><input class="search" style="width:200px" id="add-${k}" placeholder="Add ${l.toLowerCase().replace(/s$/, '').replace(/ \/ prints$/, '')}…"><button class="btn sm" data-addlist="${k}">Add</button></div></div>`; }).join('')}
  </div>
  <div class="panel"><h2>How the numbers work</h2><div class="note" style="line-height:1.6">
    <b>Stock</b> = purchases + opening/ready pieces + restocked returns − sales − fabric used for stitched orders − returns to suppliers − write-offs.<br>
    <b>Cost</b> of a fabric is its weighted average purchase rate, with freight spread over the bill. A design's cost = fabric used × fabric cost + extras (lace, embroidery) + stitching.<br>
    <b>Profit</b> = net sales − cost of goods − expenses − written-off stock. Cost is locked on each sale when you save it.<br>
    <b>Stuck</b> = stock on hand with no sale or use for the number of days set above.</div></div>
  </div>`;
};
/* ===== modal & toast ===== */
let modalBind = null;
function openModal(title, body, foot = '', narrow = false) {
  $('#modalRoot').innerHTML = `<div class="scrim" id="scrim"><div class="modal ${narrow ? 'narrow' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="mh"><h2>${title}</h2><button class="x" data-close aria-label="Close">×</button></div><div class="mb" id="mb">${body}</div>${foot ? `<div class="mf">${foot}</div>` : ''}</div></div>`;
  const f = $('#modalRoot input:not([type=hidden]):not([type=checkbox]), #modalRoot select'); if (f) setTimeout(() => f.focus(), 30);
}
function closeModal() { $('#modalRoot').innerHTML = ''; }
let toastT; function toast(msg) { $('#toastRoot').innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`; clearTimeout(toastT); toastT = setTimeout(() => $('#toastRoot').innerHTML = '', 2800); }
const opt = (v, l, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(l)}</option>`;
const partyOpts = (role, sel, blank = 'Select…') => opt('', blank, !sel) + S.parties.filter(p => p.role === role).sort((a, b) => a.name.localeCompare(b.name)).map(p => opt(p.id, p.name + (p.phone ? ' · ' + p.phone : ''), p.id === sel)).join('');
const prodOpts = (kind, sel) => opt('', 'Choose item…', !sel) + S.products.filter(p => kind === 'any' || (kind === 'design' ? p.kind === 'design' : p.kind !== 'design')).sort((a, b) => String(a.code || a.name).localeCompare(String(b.code || b.name))).map(p => opt(p.id, (p.code ? p.code + ' — ' : '') + p.name, p.id === sel)).join('');
const stockOf = id => D.st[id]?.qty || 0;
const fv = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
function paymentsTable(list, key) {
  return `<div class="tw"><table><thead><tr><th>Date</th><th>Method</th><th class="n">Amount</th><th></th></tr></thead><tbody>${(list || []).length ? list.map((p, i) => `<tr><td>${fdate(p.date)}</td><td>${esc(p.method || '')}${p.note ? ` <span class="muted">· ${esc(p.note)}</span>` : ''}</td><td class="n">${money(p.amount)}</td><td class="n"><button class="btn sm danger" data-delpay="${key}:${i}">Remove</button></td></tr>`).join('') : `<tr><td colspan="4" class="muted">No payments yet</td></tr>`}</tbody></table></div>`;
}
const payForm = (due) => `<div class="fg" style="align-items:end"><label class="f">Amount<input id="payAmt" type="number" min="0" step="any" value="${due > 0 ? Math.round(due) : ''}"></label><label class="f">Method<select id="payMethod">${PAY_METHODS.map(m => opt(m, m)).join('')}</select></label><label class="f">Date<input id="payDate" type="date" value="${today()}"></label><button class="btn primary" data-addpay>Add payment</button></div>`;

/* ===== Sale form ===== */
function lineCost(p, src) {
  if (!p) return { matCost: 0, stitch: 0 };
  if (p.kind !== 'design') return { matCost: D.unit[p.id] || N(p.cost), stitch: 0 };
  if (src === 'ready') return { matCost: fullDesignCost(p), stitch: 0 };
  return { matCost: designCost(p), stitch: N(p.stitchCost) };
}
function saleForm(so, type) {
  const isNew = !so; so = so ? JSON.parse(JSON.stringify(so)) : { type: type || 'custom', date: today(), items: [], status: type === 'wholesale' ? 'delivered' : 'received', dueDate: addDays(today(), 10), payments: [] };
  if (!so.items.length) so.items.push({ pid: '', qty: 1, rate: 0, src: 'order' });
  const draw = () => {
    const custom = so.type === 'custom';
    const body = `
    <div class="chips">${[['custom', 'Stitched outfit order'], ['wholesale', 'Unstitched / wholesale sale']].map(([k, l]) => `<button class="chip ${so.type === k ? 'on' : ''}" data-stype="${k}">${l}</button>`).join('')}</div>
    <div class="fg">
      <label class="f">Customer<select id="sCust">${partyOpts('customer', so.partyId, 'Walk-in customer')}${opt('__new', '+ Add new customer…', so.partyId === '__new')}</select></label>
      ${so.partyId === '__new' ? `<label class="f">New customer name<input id="sNewName" value="${esc(so._newName || '')}"></label><label class="f">Phone<input id="sNewPhone" value="${esc(so._newPhone || '')}"></label>` : ''}
      <label class="f">Date<input id="sDate" type="date" value="${esc(so.date)}"></label>
      ${custom ? `<label class="f">Delivery due<input id="sDue" type="date" value="${esc(so.dueDate || '')}"></label><label class="f">Tailor<select id="sTailor">${partyOpts('tailor', so.tailorId, 'Assign later')}</select></label>` : ''}
      <label class="f">Status<select id="sStatus">${Object.entries(STATUS).filter(([k]) => custom || ['received', 'delivered', 'cancelled'].includes(k)).map(([k, v]) => opt(k, custom ? v.label : (k === 'received' ? 'Pending dispatch' : v.label), so.status === k)).join('')}</select></label>
    </div>
    <div class="lines tw"><table><thead><tr><th style="min-width:200px">${custom ? 'Design / item' : 'Fabric / suit'}</th>${custom ? '<th>Source</th>' : ''}<th class="n" style="width:80px">Qty</th><th class="n" style="width:110px">Rate</th><th class="n">Amount</th><th></th></tr></thead><tbody>
    ${so.items.map((it, i) => { const p = P(it.pid); const warn = stockWarn(it, p);
      return `<tr class="li"><td><select data-li="pid" data-i="${i}">${prodOpts(custom ? 'any' : 'fabric', it.pid)}</select>${warn ? `<div class="warn" style="font-size:11.5px;margin-top:2px">${warn}</div>` : ''}</td>
      ${custom ? `<td>${p && p.kind === 'design' ? `<select data-li="src" data-i="${i}">${opt('order', 'Make to order', it.src !== 'ready')}${opt('ready', 'From ready stock', it.src === 'ready')}</select>` : '<span class="muted">From stock</span>'}</td>` : ''}
      <td><input class="n" type="number" min="0" step="any" data-li="qty" data-i="${i}" value="${it.qty}"></td>
      <td><input class="n" type="number" min="0" step="any" data-li="rate" data-i="${i}" value="${it.rate}"></td>
      <td class="n" data-amt="${i}">${money(N(it.qty) * N(it.rate))}</td>
      <td><button class="x" data-rmline="${i}" aria-label="Remove line">×</button></td></tr>`; }).join('')}
    </tbody></table></div>
    <div><button class="btn sm" data-addline>+ Add line</button></div>
    <div class="fg">
      <label class="f">Discount<input id="sDisc" type="number" min="0" step="any" value="${N(so.discount) || ''}"></label>
      <label class="f">Delivery charge<input id="sDeliv" type="number" min="0" step="any" value="${N(so.delivery) || ''}"></label>
      ${isNew ? `<label class="f">Method<select id="sMethod">${PAY_METHODS.map(m => opt(m, m, m === so._method)).join('')}${opt('credit', 'Credit (pay later)', so._method === 'credit')}</select></label><label class="f">${so._method === 'credit' ? 'Paid now (optional)' : custom ? 'Advance received' : 'Amount received'}<input id="sPaid" type="number" min="0" step="any" value="${so._paid ?? ''}" placeholder="${so._method === 'credit' || custom ? '0' : 'Full amount'}"></label>` : ''}
    </div>
    <label class="f">Notes (measurements, colour changes, address)<textarea id="sNote" rows="2">${esc(so.note || '')}</textarea></label>
    <div id="sCredit"></div><div id="sSum"></div>`;
    creditKey = null;
    $('#mb').innerHTML = body; drawSum();
  };
  const stockWarn = (it, p) => { if (!p || !N(it.qty)) return '';
    if (p.kind === 'design' && it.src !== 'ready') { if (!p.fabricId) return 'No fabric linked to this design, so stock is not deducted.'; const need = N(it.qty) * (N(p.fabricQty) || 1); const have = stockOf(p.fabricId) + (isNew ? 0 : need); return have < need ? `Only ${qty(have)} ${P(p.fabricId)?.unit || ''} of ${pname(p.fabricId)} in stock` : ''; }
    const have = stockOf(p.id) + (isNew ? 0 : N(it.qty)); return have < N(it.qty) ? `Only ${qty(have)} in stock` : ''; };
  let creditKey = null;
  const saleTotal = () => sum(so.items, i => N(i.qty) * N(i.rate)) - N(so.discount) + N(so.delivery);
  const paidEff = () => { if (!isNew) return sum(so.payments || [], p => p.amount); const v = so._paid;
    if (so._method === 'credit') return N(v); if (v === '' || v == null) return so.type === 'custom' ? 0 : saleTotal(); return N(v); };
  const balance = () => saleTotal() - paidEff();
  const drawCredit = () => { const box = $('#sCredit'); if (!box) return;
    const bal = balance(), need = bal > 0.5 && so.status !== 'cancelled' && so.items.some(i => i.pid); const pid = so.partyId || '';
    const key = need + '|' + pid; if (key === creditKey) { const a = $('#crAmt'); if (a) a.textContent = money(bal); return; }
    creditKey = key; if (!need) { box.innerHTML = ''; return; }
    const cust = party(pid); const owes = cust ? partyBalance(cust) : 0;
    const payBy = `<label class="f">Promised payment date<input id="crPayBy" type="date" value="${esc(so.payBy || addDays(today(), 7))}"></label>`;
    box.innerHTML = `<div class="note" style="border-left:3px solid var(--warn)"><b class="warn"><span id="crAmt">${money(bal)}</span> ${so.type === 'custom' ? 'balance to collect' : 'on credit (receivable)'}</b>
      ${!pid ? '<div style="margin-top:4px">Add who owes this so you can collect it later.</div>' : pid === '__new' ? '<div style="margin-top:4px">It will be added to this new customer’s account.</div>' : `<div style="margin-top:4px">It will be added to ${esc(cust?.name || 'this customer')}’s account${owes > 0.5 ? `, who already owes ${money(owes)}` : ''}.</div>`}
      <div class="fg" style="margin-top:8px">${!pid ? `<label class="f">Customer name *<input id="crName" value="${esc(so._crName || '')}" placeholder="Who will pay?"></label><label class="f">Phone / WhatsApp *<input id="crPhone" value="${esc(so._crPhone || '')}" placeholder="03xx-xxxxxxx"></label>` : ''}
      ${pid && pid !== '__new' && cust && !cust.phone ? `<label class="f">Phone / WhatsApp<input id="crPhone" value="${esc(so._crPhone || '')}" placeholder="Add a number to follow up"></label>` : ''}${payBy}</div></div>`; };
  const drawSum = () => {
    drawCredit();
    const sub = sum(so.items, i => N(i.qty) * N(i.rate)); const tot = sub - N(so.discount) + N(so.delivery);
    const cost = sum(so.items, i => { const c = lineCost(P(i.pid), i.src); return N(i.qty) * (c.matCost + c.stitch); });
    $('#sSum').innerHTML = `<div class="sum"><span class="muted">Subtotal</span><span>${money(sub)}</span><span class="muted">Discount</span><span>${money(-N(so.discount))}</span><span class="muted">Delivery</span><span>${money(so.delivery)}</span><span class="g">Total</span><span class="g">${money(tot)}</span><span class="muted profit">Estimated cost</span><span class="profit">${money(cost)}</span><span class="muted profit">Estimated profit</span><span class="profit ${tot - N(so.delivery) - cost < 0 ? 'bad' : 'good'}">${money(tot - N(so.delivery) - cost)}</span></div>`;
  };
  const collect = () => {
    so.partyId = fv('sCust'); so.date = fv('sDate') || today(); so.status = fv('sStatus');
    if ($('#sDue')) so.dueDate = fv('sDue'); if ($('#sTailor')) so.tailorId = fv('sTailor');
    if ($('#sNewName')) { so._newName = fv('sNewName'); so._newPhone = fv('sNewPhone'); }
    so.discount = N(fv('sDisc')); so.delivery = N(fv('sDeliv')); so.note = fv('sNote');
    if ($('#sPaid')) { so._paid = fv('sPaid'); so._method = fv('sMethod'); }
    if ($('#crName')) so._crName = fv('crName').trim(); if ($('#crPhone')) so._crPhone = fv('crPhone').trim(); if ($('#crPayBy')) so.payBy = fv('crPayBy');
  };
  openModal(isNew ? 'New sale / order' : 'Edit ' + esc(so.no), '', `<button class="btn" data-close>Cancel</button><button class="btn primary" data-savesale>${isNew ? 'Save sale' : 'Save changes'}</button>`);
  draw();
  const root = $('#modalRoot'); const orig = isNew ? [] : JSON.parse(JSON.stringify(so.items));
  modalBind = {
    click: async e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.stype) { collect(); so.type = t.dataset.stype; so.status = so.type === 'wholesale' ? 'delivered' : 'received'; draw(); }
      else if (t.hasAttribute('data-addline')) { collect(); so.items.push({ pid: '', qty: 1, rate: 0, src: 'order' }); draw(); }
      else if (t.dataset.rmline) { collect(); so.items.splice(+t.dataset.rmline, 1); if (!so.items.length) so.items.push({ pid: '', qty: 1, rate: 0, src: 'order' }); draw(); }
      else if (t.hasAttribute('data-savesale')) {
        collect(); const items = so.items.filter(i => i.pid && N(i.qty) > 0);
        if (!items.length) return toast('Add at least one item with a quantity');
        if (so.partyId === '__new' && !so._newName) return toast('Enter the new customer’s name');
        so.items = so.items.filter(i => i.pid); const bal = balance(), owing = bal > 0.5 && so.status !== 'cancelled';
        if (owing && !so.partyId) { if (!so._crName) { $('#crName')?.focus(); return toast('Enter the name of the customer who will pay later'); }
          if (!so._crPhone) { $('#crPhone')?.focus(); return toast('Enter their phone number so you can follow up'); }
          so.partyId = '__new'; so._newName = so._crName; so._newPhone = so._crPhone; }
        if (owing && so.partyId === '__new' && !so._newPhone) return toast('Enter the customer’s phone number so you can follow up');
        const paidNow = paidEff(); if (!owing) delete so.payBy;
        t.disabled = true;
        try {
          if (so.partyId === '__new') so.partyId = await put('parties', { role: 'customer', name: so._newName, phone: so._newPhone });
          else if (owing && so._crPhone) { const c = party(so.partyId); if (c && !c.phone) await put('parties', { ...c, phone: so._crPhone }); }
          so.items = items.map((i, k) => { const o = orig.find(x => x.pid === i.pid && (x.src || 'order') === (i.src || 'order'));
            const c = o && o.matCost !== undefined ? { matCost: o.matCost, stitch: o.stitch } : lineCost(P(i.pid), i.src);
            const p = P(i.pid); return { pid: i.pid, qty: N(i.qty), rate: N(i.rate), src: p && p.kind === 'design' ? (i.src || 'order') : 'stock', matCost: Math.round(c.matCost * 100) / 100, stitch: c.stitch }; });
          if (isNew) { so.no = nextNo('sales', 'INV'); if (paidNow > 0) so.payments = [{ date: so.date, amount: Math.round(paidNow * 100) / 100, method: so._method === 'credit' ? 'Cash' : (so._method || 'Cash'), note: so.type === 'custom' && paidNow < saleTotal() - 0.5 ? 'Advance' : '' }]; }
          if (so.status === 'delivered' && !so.deliveredDate) so.deliveredDate = so.date === today() ? today() : so.date;
          if (so.status === 'tailor' && !so.sentDate) so.sentDate = today();
          delete so._paid; delete so._method; delete so._newName; delete so._newPhone; delete so._crName; delete so._crPhone;
          const id = await put('sales', so); toast(isNew ? `Saved ${so.no}` : 'Changes saved'); closeModal(); setTimeout(() => saleDetail(id), 60);
        } catch (err) { t.disabled = false; }
      }
    },
    input: e => { const el = e.target; if (el.dataset.li) { const i = +el.dataset.i; const it = so.items[i]; if (el.dataset.li === 'qty' || el.dataset.li === 'rate') { it[el.dataset.li] = el.value; const a = root.querySelector(`[data-amt="${i}"]`); if (a) a.textContent = money(N(it.qty) * N(it.rate)); } drawSum(); }
      else if (['sDisc', 'sDeliv'].includes(el.id)) { so.discount = N(fv('sDisc')); so.delivery = N(fv('sDeliv')); drawSum(); }
      else if (el.id === 'sPaid') { so._paid = el.value; drawSum(); }
      else if (el.id === 'crName') so._crName = el.value.trim(); else if (el.id === 'crPhone') so._crPhone = el.value.trim(); },
    change: e => { const el = e.target;
      if (el.dataset.li === 'pid' || el.dataset.li === 'src') { collect(); const it = so.items[+el.dataset.i]; it[el.dataset.li] = el.value; if (el.dataset.li === 'pid') { const p = P(el.value); it.rate = p ? (so.type === 'wholesale' && N(p.wholesale) ? N(p.wholesale) : N(p.price)) : 0; it.src = 'order'; } draw(); }
      else if (el.id === 'sCust' || el.id === 'sMethod' || el.id === 'sStatus') { collect(); draw(); } }
  };
}

/* ===== Sale detail ===== */
function saleDetail(id) {
  const so = S.sales.find(x => x.id === id); if (!so) return;
  const t = saleTotals(so); const custom = so.type === 'custom'; const cust = party(so.partyId);
  const idx = FLOW.indexOf(so.status); const nx = custom && idx >= 0 ? FLOW[idx + 1] : null;
  const profit = t.sub - N(so.discount) - t.cogs;
  const body = `
  ${custom ? `<div class="steps">${FLOW.map((s, i) => `<span class="${so.status === 'cancelled' ? '' : i < idx ? 'done' : i === idx ? 'cur' : ''}">${STATUS[s].label}</span>`).join('')}</div>` : ''}
  <div class="grid2" style="gap:12px"><dl class="dl">
    <dt>Customer</dt><dd>${esc(partyName(so.partyId))}${cust?.phone ? ` · <span class="mono">${esc(cust.phone)}</span>` : ''}</dd>
    <dt>Date</dt><dd>${fdate(so.date)}</dd><dt>Type</dt><dd>${custom ? 'Stitched outfit order' : 'Unstitched / wholesale'}</dd>
    <dt>Status</dt><dd>${statusPill(so.status)}</dd>
    ${so.payBy && t.due > 0.5 ? `<dt>Promised to pay</dt><dd class="${so.payBy < today() ? 'bad' : ''}">${fdate(so.payBy)}${so.payBy < today() ? ' ' + pill('Overdue', 'bad') : ''}</dd>` : ''}
    ${custom ? `<dt>Due</dt><dd class="${so.dueDate && so.dueDate < today() && idx < 3 ? 'bad' : ''}">${fdate(so.dueDate)}</dd><dt>Tailor</dt><dd>${so.tailorId ? esc(partyName(so.tailorId)) + (so.tailorPaid ? ' · ' + pill('Paid', 'good') : t.stitch ? ' · ' + pill('Unpaid ' + money(t.stitch), 'warn') : '') : '<span class="muted">Not assigned</span>'}</dd>` : ''}
    ${so.note ? `<dt>Notes</dt><dd>${esc(so.note)}</dd>` : ''}
  </dl>
  <div class="sum" style="justify-self:stretch"><span class="muted">Subtotal</span><span class="n">${money(t.sub)}</span><span class="muted">Discount</span><span class="n">${money(-N(so.discount))}</span><span class="muted">Delivery</span><span class="n">${money(so.delivery)}</span><span class="g">Total</span><span class="g n">${money(t.total)}</span><span class="muted">Paid</span><span class="n">${money(t.paid)}</span>${t.credit ? `<span class="muted">Returns credit</span><span class="n">${money(-t.credit)}</span>` : ''}<span class="g">${t.due < -0.5 ? 'Refund owed' : 'Balance due'}</span><span class="g n ${t.due > 0.5 ? 'bad' : t.due < -0.5 ? 'warn' : 'good'}">${money(Math.abs(t.due))}</span><span class="muted profit">Cost (fabric ${money(t.mat)} + stitching ${money(t.stitch)})</span><span class="n profit">${money(t.cogs)}</span><span class="muted profit">Profit on this sale</span><span class="n profit ${profit < 0 ? 'bad' : 'good'}">${money(profit)}</span></div></div>
  <div class="tw"><table><thead><tr><th>Item</th><th>Source</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th><th class="n profit">Unit cost</th></tr></thead><tbody>
  ${(so.items || []).map(i => `<tr><td>${esc(pname(i.pid))}</td><td class="muted">${i.src === 'order' ? 'Made to order' : i.src === 'ready' ? 'Ready stock' : 'Stock'}</td><td class="n">${qty(i.qty)}</td><td class="n">${money(i.rate)}</td><td class="n">${money(N(i.qty) * N(i.rate))}</td><td class="n muted profit">${money(N(i.matCost) + N(i.stitch))}</td></tr>`).join('')}</tbody></table></div>
  ${custom && so.status !== 'cancelled' ? `<div class="fg" style="align-items:end"><label class="f">Tailor<select id="dTailor">${partyOpts('tailor', so.tailorId, 'Not assigned')}</select></label><button class="btn" data-settailor>Save tailor</button>${so.tailorId && !so.tailorPaid && t.stitch ? `<button class="btn" data-tailorpaid="${so.id}">Mark stitching paid</button>` : ''}</div>` : ''}
  <h3 style="font-size:15px">Payments</h3>${paymentsTable(so.payments, 'sale')}
  ${so.status !== 'cancelled' && t.due > 0.5 ? payForm(t.due) : ''}`;
  const foot = `<div class="row"><button class="btn danger" data-delsale>Delete</button>${so.status !== 'cancelled' ? `<button class="btn danger" data-cancelsale>Cancel order</button>` : `<button class="btn" data-reopen>Reopen</button>`}</div>
    <div class="row"><button class="btn" data-printsale>Print</button><button class="btn" data-copyinv>Copy invoice text</button>${so.status !== 'cancelled' ? `<button class="btn" data-mkreturn>Return items</button>` : ''}<button class="btn" data-editsale>Edit</button>${nx && so.status !== 'cancelled' ? `<button class="btn primary" data-advance="${so.id}">${nx === 'tailor' ? 'Send to tailor' : nx === 'ready' ? 'Mark stitched' : 'Mark delivered'} →</button>` : ''}</div>`;
  openModal(`${esc(so.no)} · ${esc(partyName(so.partyId))}`, body, foot);
  const save = async patch => { await put('sales', { ...so, ...patch }); };
  modalBind = { click: async e => { const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-editsale')) { closeModal(); saleForm(so); }
    else if (b.hasAttribute('data-settailor')) { await save({ tailorId: fv('dTailor') }); toast('Tailor saved'); reopen(); }
    else if (b.hasAttribute('data-addpay')) { const a = N(fv('payAmt')); if (a <= 0) return toast('Enter an amount'); await save({ payments: [...(so.payments || []), { date: fv('payDate') || today(), amount: a, method: fv('payMethod') }] }); toast('Payment added'); reopen(); }
    else if (b.dataset.delpay) { if (!armed(b)) return; const i = +b.dataset.delpay.split(':')[1]; await save({ payments: (so.payments || []).filter((_, k) => k !== i) }); reopen(); }
    else if (b.hasAttribute('data-cancelsale')) { if (!armed(b)) return; await save({ status: 'cancelled' }); toast('Order cancelled; stock returned'); reopen(); }
    else if (b.hasAttribute('data-reopen')) { await save({ status: custom ? 'received' : 'delivered' }); reopen(); }
    else if (b.hasAttribute('data-delsale')) { if (!armed(b)) return; if (S.returns.some(r => r.refId === so.id)) return toast('Delete the returns against this sale first'); await removeDoc('sales', so.id); closeModal(); toast('Sale deleted'); }
    else if (b.hasAttribute('data-copyinv')) copyText(invoiceText(so));
    else if (b.hasAttribute('data-printsale')) { closeModal(); printChoice(saleSpec(so), () => saleDetail(id)); }
    else if (b.hasAttribute('data-mkreturn')) { closeModal(); returnForm('sale', so.id); }
  } };
  function reopen() { setTimeout(() => saleDetail(id), 80); }
}
function invoiceText(so) {
  const t = saleTotals(so), c = S.settings.currency || 'Rs';
  return [`*${S.settings.business || ''}*${S.settings.phone ? ' · ' + S.settings.phone : ''}`, `Invoice ${so.no} · ${fdate(so.date)}`, `Customer: ${partyName(so.partyId)}`, '',
    ...(so.items || []).map(i => `• ${pname(i.pid)} × ${qty(i.qty)} @ ${c} ${N(i.rate).toLocaleString('en-PK')} = ${c} ${(N(i.qty) * N(i.rate)).toLocaleString('en-PK')}`), '',
    N(so.discount) ? `Discount: ${money(-so.discount)}` : '', N(so.delivery) ? `Delivery: ${money(so.delivery)}` : '',
    `*Total: ${money(t.total)}*`, `Paid: ${money(t.paid)}`, t.credit ? `Returns: ${money(-t.credit)}` : '', `*Balance: ${money(t.due)}*`,
    so.type === 'custom' && so.dueDate ? `Expected delivery: ${fdate(so.dueDate)}` : ''].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}
async function copyText(s, title = 'Invoice text') { try { await navigator.clipboard.writeText(s); toast('Copied. Paste it into WhatsApp or SMS.'); } catch (e) {
  openModal(esc(title), `<textarea id="copyBox" rows="14" style="width:100%;font:13px var(--f-mono);border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--surface);color:var(--ink)">${esc(s)}</textarea><p class="muted">Select all and copy.</p>`, '', true); const b = $('#copyBox'); b.focus(); b.select(); } }
function armed(b) { if (b.dataset.armed === '1') return true; b.dataset.armed = '1'; b.dataset.label = b.textContent; b.textContent = 'Click again to confirm'; setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = b.dataset.label; } }, 3500); return false; }
async function advance(id) {
  const so = S.sales.find(x => x.id === id); if (!so) return; const nx = FLOW[FLOW.indexOf(so.status) + 1]; if (!nx) return;
  const patch = { status: nx }; if (nx === 'tailor') patch.sentDate = today(); if (nx === 'ready') patch.readyDate = today(); if (nx === 'delivered') patch.deliveredDate = today();
  if (nx === 'tailor' && !so.tailorId) { const ts = S.parties.filter(p => p.role === 'tailor'); if (ts.length === 1) patch.tailorId = ts[0].id; }
  await put('sales', { ...so, ...patch }); toast(`${so.no}: ${STATUS[nx].label}`);
  if ($('#modalRoot').innerHTML) setTimeout(() => saleDetail(id), 80);
}
/* ===== Purchase ===== */
function purchaseForm(pu, forceNew) {
  const isNew = forceNew || !pu; pu = pu ? JSON.parse(JSON.stringify(pu)) : { date: today(), items: [{ pid: '', qty: 1, rate: 0 }], payments: [], status: 'received' };
  if (!pu.status) pu.status = 'received';
  if (pu.status === 'scheduled' && !pu.expected) pu.expected = addDays(today(), 7);
  const draw = () => {
    const sch = pu.status === 'scheduled';
    $('#mb').innerHTML = `${isNew ? `<div class="chips">${[['received', 'Bought now (add to stock)'], ['scheduled', 'Schedule for later']].map(([k, l]) => `<button class="chip ${pu.status === k ? 'on' : ''}" data-pmode="${k}">${l}</button>`).join('')}</div>` : ''}
    ${sch ? `<div class="note">A scheduled purchase is a list of what you plan to buy. Stock does not change until you press <b>Receive stock</b>.</div>` : ''}
    <div class="fg">
      <label class="f">Supplier<select id="pSup">${partyOpts('supplier', pu.partyId)}${opt('__new', '+ Add new supplier…', pu.partyId === '__new')}</select></label>
      ${pu.partyId === '__new' ? `<label class="f">New supplier name<input id="pNewName" value="${esc(pu._newName || '')}"></label>` : ''}
      <label class="f">${sch ? 'Order date' : 'Purchase date'}<input id="pDate" type="date" value="${esc(pu.date)}"></label>
      ${sch ? `<label class="f">Expected delivery<input id="pExp" type="date" value="${esc(pu.expected || '')}"></label>` : `<label class="f">Supplier bill / ref<input id="pRef" value="${esc(pu.ref || '')}"></label>`}</div>
    <div class="lines tw"><table><thead><tr><th style="min-width:220px">Fabric / unstitched suit</th><th class="n" style="width:90px">Qty</th><th class="n" style="width:110px">${sch ? 'Expected rate' : 'Rate'}</th><th class="n">Amount</th><th></th></tr></thead><tbody>
    ${pu.items.map((it, i) => { const p = P(it.pid); const info = p ? `In stock ${qty(stockOf(p.id))} ${esc(p.unit || '')}${D.onOrder[p.id] && !(!isNew && sch) ? ` · on order ${qty(D.onOrder[p.id])}` : ''}${N(p.reorder) ? ` · reorder at ${qty(p.reorder)}` : ''}` : '';
      return `<tr class="li"><td><select data-li="pid" data-i="${i}">${prodOpts('fabric', it.pid)}</select>${info ? `<div class="muted" style="font-size:11.5px;margin-top:2px">${info}</div>` : ''}</td><td><input class="n" type="number" min="0" step="any" data-li="qty" data-i="${i}" value="${it.qty}"></td><td><input class="n" type="number" min="0" step="any" data-li="rate" data-i="${i}" value="${it.rate}"></td><td class="n" data-amt="${i}">${money(N(it.qty) * N(it.rate))}</td><td><button class="x" data-rmline="${i}" aria-label="Remove line">×</button></td></tr>`; }).join('')}
    </tbody></table></div>
    <div class="row"><button class="btn sm" data-addline>+ Add line</button><button class="btn sm" data-addlow>+ Add all low-stock items</button><button class="btn sm" data-inline="1">+ New fabric</button></div>
    <div class="fg">${sch ? '' : `<label class="f">Freight / loading (spread into cost)<input id="pExtra" type="number" min="0" step="any" value="${N(pu.extra) || ''}"></label>`}
      ${isNew ? `<label class="f">${sch ? 'Advance paid (optional)' : 'Paid now'}<input id="pPaid" type="number" min="0" step="any" value="${pu._paid ?? ''}"></label><label class="f">Method<select id="pMethod">${PAY_METHODS.map(m => opt(m, m)).join('')}</select></label>` : ''}</div>
    <label class="f">Notes<textarea id="pNote" rows="2">${esc(pu.note || '')}</textarea></label><div id="pSum"></div>`; drawSum(); };
  const drawSum = () => { const sub = sum(pu.items, i => N(i.qty) * N(i.rate)); const sch = pu.status === 'scheduled';
    $('#pSum').innerHTML = `<div class="sum"><span class="muted">Items</span><span>${money(sub)}</span>${sch ? '' : `<span class="muted">Freight</span><span>${money(pu.extra)}</span>`}<span class="g">${sch ? 'Estimated total' : 'Bill total'}</span><span class="g">${money(sub + (sch ? 0 : N(pu.extra)))}</span></div>`; };
  const collect = () => { pu.partyId = fv('pSup'); pu.date = fv('pDate') || today(); if ($('#pRef')) pu.ref = fv('pRef'); if ($('#pExp')) pu.expected = fv('pExp'); if ($('#pExtra')) pu.extra = N(fv('pExtra')); pu.note = fv('pNote'); if ($('#pNewName')) pu._newName = fv('pNewName'); if ($('#pPaid')) pu._paid = fv('pPaid'); };
  const title = () => isNew ? (pu.status === 'scheduled' ? 'Schedule a purchase' : 'New purchase') : 'Edit ' + esc(pu.no);
  openModal(title(), '', `<button class="btn" data-close>Cancel</button><button class="btn primary" data-savep>${isNew ? 'Save' : 'Save changes'}</button>`);
  draw(); const root = $('#modalRoot');
  modalBind = {
    click: async e => { const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.pmode) { collect(); pu.status = t.dataset.pmode; if (pu.status === 'scheduled' && !pu.expected) pu.expected = addDays(today(), 7); draw(); $('.mh h2').textContent = title(); }
      else if (t.hasAttribute('data-addline')) { collect(); pu.items.push({ pid: '', qty: 1, rate: 0 }); draw(); }
      else if (t.hasAttribute('data-addlow')) { collect(); const add = reorderLines().filter(l => !pu.items.some(i => i.pid === l.pid)); if (!add.length) return toast('No fabric is below its reorder level');
        pu.items = pu.items.filter(i => i.pid); pu.items.push(...add); draw(); toast(`Added ${add.length} low-stock item${add.length > 1 ? 's' : ''}`); }
      else if (t.dataset.rmline) { collect(); pu.items.splice(+t.dataset.rmline, 1); if (!pu.items.length) pu.items.push({ pid: '', qty: 1, rate: 0 }); draw(); }
      else if (t.dataset.inline) { collect(); const keep = pu; productForm('fabric', null, () => setTimeout(() => purchaseForm(keep, isNew), 120)); }
      else if (t.hasAttribute('data-savep')) { collect(); const items = pu.items.filter(i => i.pid && N(i.qty) > 0);
        if (!items.length) return toast('Add at least one fabric with a quantity'); if (!pu.partyId) return toast('Choose a supplier');
        if (pu.partyId === '__new' && !pu._newName) return toast('Enter the supplier name');
        t.disabled = true;
        try { if (pu.partyId === '__new') pu.partyId = await put('parties', { role: 'supplier', name: pu._newName });
          pu.items = items.map(i => ({ pid: i.pid, qty: N(i.qty), rate: N(i.rate) }));
          if (isNew) { pu.no = nextNo('purchases', pu.status === 'scheduled' ? 'PO' : 'PUR'); if (N(pu._paid) > 0) pu.payments = [{ date: pu.date, amount: N(pu._paid), method: fv('pMethod'), note: pu.status === 'scheduled' ? 'Advance' : '' }]; }
          if (pu.status === 'scheduled') pu.extra = 0;
          delete pu._paid; delete pu._newName; const id = await put('purchases', pu);
          toast(pu.status === 'scheduled' ? `${pu.no} scheduled for ${fdate(pu.expected)}` : 'Purchase saved · stock updated'); closeModal(); setTimeout(() => purchaseDetail(id), 60);
        } catch (err) { t.disabled = false; } } },
    input: e => { const el = e.target; if (el.dataset.li && el.dataset.li !== 'pid') { const i = +el.dataset.i; pu.items[i][el.dataset.li] = el.value; const a = root.querySelector(`[data-amt="${i}"]`); if (a) a.textContent = money(N(pu.items[i].qty) * N(pu.items[i].rate)); drawSum(); } else if (el.id === 'pExtra') { pu.extra = N(el.value); drawSum(); } },
    change: e => { const el = e.target; if (el.dataset.li === 'pid') { collect(); const it = pu.items[+el.dataset.i]; it.pid = el.value; const p = P(el.value); if (p && !N(it.rate)) it.rate = Math.round(D.unit[p.id] || N(p.cost)); draw(); } else if (el.id === 'pSup') { collect(); draw(); } }
  };
}
/* Low-stock fabrics with a suggested quantity: fill back up to twice the reorder level, minus what is already on order */
function reorderLines() {
  return D.inv.filter(r => r.p.kind !== 'design' && N(r.p.reorder) > 0 && r.qty + (D.onOrder[r.p.id] || 0) <= N(r.p.reorder))
    .map(r => ({ pid: r.p.id, qty: Math.max(1, Math.ceil(N(r.p.reorder) * 2 - r.qty - (D.onOrder[r.p.id] || 0))), rate: Math.round(r.unit || N(r.p.cost)) }));
}
function purchaseDetail(id) {
  const pu = S.purchases.find(x => x.id === id); if (!pu) return; const t = purchaseTotals(pu); const sch = !received(pu);
  const late = sch && pu.expected && pu.expected < today();
  const body = `<dl class="dl"><dt>Status</dt><dd>${sch ? pill('Scheduled', 'info') + (late ? ' ' + pill('Overdue', 'bad') : '') : pill('Received · in stock', 'good')}</dd>
    <dt>Supplier</dt><dd>${esc(partyName(pu.partyId))}</dd><dt>${sch ? 'Ordered' : 'Received'}</dt><dd>${fdate(pu.date)}</dd>
    ${sch ? `<dt>Expected</dt><dd class="${late ? 'bad' : ''}">${fdate(pu.expected)}</dd>` : (pu.orderNo ? `<dt>From order</dt><dd class="mono">${esc(pu.orderNo)}</dd>` : '')}
    ${pu.ref ? `<dt>Supplier ref</dt><dd>${esc(pu.ref)}</dd>` : ''}${pu.note ? `<dt>Notes</dt><dd>${esc(pu.note)}</dd>` : ''}</dl>
  <div class="tw"><table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th>${sch ? '<th class="n">In stock now</th>' : ''}</tr></thead><tbody>${(pu.items || []).map(i => `<tr><td>${esc(pname(i.pid))}</td><td class="n">${qty(i.qty)} ${esc(P(i.pid)?.unit || '')}</td><td class="n">${money(i.rate)}</td><td class="n">${money(N(i.qty) * N(i.rate))}</td>${sch ? `<td class="n muted">${qty(stockOf(i.pid))}</td>` : ''}</tr>`).join('')}</tbody></table></div>
  ${sch ? `<div class="sum"><span class="g">Estimated total</span><span class="g n">${money(t.sub)}</span>${t.paid ? `<span class="muted">Advance paid</span><span class="n">${money(t.paid)}</span>` : ''}</div>`
    : `<div class="sum"><span class="muted">Items</span><span class="n">${money(t.sub)}</span><span class="muted">Freight</span><span class="n">${money(pu.extra)}</span><span class="g">Total</span><span class="g n">${money(t.total)}</span><span class="muted">Paid</span><span class="n">${money(t.paid)}</span>${t.credit ? `<span class="muted">Returned</span><span class="n">${money(-t.credit)}</span>` : ''}<span class="g">You owe</span><span class="g n ${t.due > 0.5 ? 'bad' : 'good'}">${money(t.due)}</span></div>`}
  <h3 style="font-size:15px">${sch ? 'Advance payments' : 'Payments to supplier'}</h3>${paymentsTable(pu.payments, 'pur')}${sch || t.due > 0.5 ? payForm(sch ? 0 : t.due) : ''}`;
  openModal(`${esc(pu.no)} · ${esc(partyName(pu.partyId))}`, body, `<button class="btn danger" data-delp>Delete</button><div class="row"><button class="btn" data-printp>Print</button>${sch ? '' : '<button class="btn" data-mkret>Return to supplier</button>'}<button class="btn" data-editp>Edit</button>${sch ? '<button class="btn primary" data-receive>Receive stock →</button>' : ''}</div>`);
  const save = async patch => put('purchases', { ...pu, ...patch }); const re = () => setTimeout(() => purchaseDetail(id), 80);
  modalBind = { click: async e => { const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-editp')) { closeModal(); purchaseForm(pu); }
    else if (b.hasAttribute('data-receive')) { closeModal(); receiveForm(pu.id); }
    else if (b.hasAttribute('data-printp')) { closeModal(); printChoice(purchaseSpec(pu), () => purchaseDetail(id)); }
    else if (b.hasAttribute('data-mkret')) { closeModal(); returnForm('purchase', pu.id); }
    else if (b.hasAttribute('data-addpay')) { const a = N(fv('payAmt')); if (a <= 0) return toast('Enter an amount'); await save({ payments: [...(pu.payments || []), { date: fv('payDate') || today(), amount: a, method: fv('payMethod'), note: sch ? 'Advance' : '' }] }); toast('Payment recorded'); re(); }
    else if (b.dataset.delpay) { if (!armed(b)) return; const i = +b.dataset.delpay.split(':')[1]; await save({ payments: (pu.payments || []).filter((_, k) => k !== i) }); re(); }
    else if (b.hasAttribute('data-delp')) { if (!armed(b)) return; if (S.returns.some(r => r.refId === pu.id)) return toast('Delete the returns against this bill first'); await removeDoc('purchases', pu.id); closeModal(); toast(sch ? 'Scheduled purchase deleted' : 'Purchase deleted'); } } };
}
/* Receive a scheduled purchase: whatever arrives goes into stock; any shortfall can stay on order */
function receiveForm(id) {
  const pu = S.purchases.find(x => x.id === id); if (!pu) return;
  const lines = (pu.items || []).map(i => ({ pid: i.pid, ordered: N(i.qty), qty: N(i.qty), rate: N(i.rate) }));
  const draw = () => { const short = lines.some(l => N(l.qty) < l.ordered); const sub = sum(lines, l => N(l.qty) * N(l.rate));
    $('#mb').innerHTML = `<div class="note">Enter what actually arrived. Received quantities are added to inventory straight away.</div>
    <div class="fg"><label class="f">Received on<input id="rvDate" type="date" value="${esc(fv('rvDate') || today())}"></label><label class="f">Supplier bill / ref<input id="rvRef" value="${esc(fv('rvRef') || pu.ref || '')}"></label></div>
    <div class="lines tw"><table><thead><tr><th>Item</th><th class="n">Ordered</th><th class="n" style="width:100px">Received</th><th class="n" style="width:110px">Actual rate</th><th class="n">Amount</th></tr></thead><tbody>
    ${lines.map((l, i) => `<tr class="li"><td>${esc(pname(l.pid))}<div class="muted" style="font-size:11.5px">In stock ${qty(stockOf(l.pid))} → ${qty(stockOf(l.pid) + N(l.qty))}</div></td><td class="n">${qty(l.ordered)}</td><td><input class="n" type="number" min="0" step="any" data-rv="qty" data-i="${i}" value="${l.qty}"></td><td><input class="n" type="number" min="0" step="any" data-rv="rate" data-i="${i}" value="${l.rate}"></td><td class="n">${money(N(l.qty) * N(l.rate))}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="fg"><label class="f">Freight / loading<input id="rvExtra" type="number" min="0" step="any" value="${esc(fv('rvExtra'))}"></label><label class="f">Paid now<input id="rvPaid" type="number" min="0" step="any" value="${esc(fv('rvPaid'))}"></label><label class="f">Method<select id="rvMethod">${PAY_METHODS.map(m => opt(m, m, m === fv('rvMethod'))).join('')}</select></label></div>
    ${short ? `<label class="check"><input type="checkbox" id="rvKeep" ${$('#rvKeep') === null || $('#rvKeep')?.checked ? 'checked' : ''}> Keep the missing quantity on order as a new scheduled purchase</label>` : ''}
    <div class="sum"><span class="muted">Items received</span><span>${money(sub)}</span><span class="muted">Freight</span><span>${money(fv('rvExtra'))}</span>${sum(pu.payments || [], p => p.amount) ? `<span class="muted">Advance already paid</span><span>${money(-sum(pu.payments || [], p => p.amount))}</span>` : ''}<span class="g">Bill total</span><span class="g">${money(sub + N(fv('rvExtra')))}</span></div>`; };
  openModal(`Receive ${esc(pu.no)} · ${esc(partyName(pu.partyId))}`, '', `<button class="btn" data-close>Cancel</button><button class="btn primary" data-dorecv>Receive into stock</button>`);
  draw();
  modalBind = {
    change: e => { if (e.target.dataset.rv || e.target.id === 'rvExtra') { const k = e.target.dataset.rv; if (k) lines[+e.target.dataset.i][k] = e.target.value; draw(); } },
    input: e => { const k = e.target.dataset.rv; if (k) lines[+e.target.dataset.i][k] = e.target.value; },
    click: async e => { const b = e.target.closest('[data-dorecv]'); if (!b) return;
      const got = lines.filter(l => N(l.qty) > 0); if (!got.length) return toast('Enter the quantity that arrived');
      const keep = $('#rvKeep')?.checked; const rest = lines.filter(l => N(l.qty) < l.ordered).map(l => ({ pid: l.pid, qty: Math.round((l.ordered - N(l.qty)) * 100) / 100, rate: l.rate }));
      const date = fv('rvDate') || today(); const payments = [...(pu.payments || [])]; if (N(fv('rvPaid')) > 0) payments.push({ date, amount: N(fv('rvPaid')), method: fv('rvMethod') });
      b.disabled = true;
      try {
        await put('purchases', { ...pu, status: 'received', orderNo: pu.no, orderDate: pu.date, date, ref: fv('rvRef'), extra: N(fv('rvExtra')), payments,
          items: got.map(l => ({ pid: l.pid, qty: N(l.qty), rate: N(l.rate) })) });
        if (keep && rest.length) await put('purchases', { status: 'scheduled', no: nextNo('purchases', 'PO'), partyId: pu.partyId, date, expected: pu.expected && pu.expected > today() ? pu.expected : addDays(today(), 7), items: rest, payments: [], note: 'Balance of ' + pu.no });
        toast(`Stock updated from ${pu.no}${keep && rest.length ? ' · balance kept on order' : ''}`); closeModal(); setTimeout(() => purchaseDetail(pu.id), 80);
      } catch (err) { b.disabled = false; } }
  };
}

/* ===== Returns ===== */
function returnForm(kind, refId) {
  const list = kind === 'sale' ? S.sales.filter(live) : S.purchases.filter(received);
  const st = { refId: refId || '', lines: [], reason: '', date: today() };
  const load = () => { const ref = list.find(x => x.id === st.refId); st.lines = ref ? (ref.items || []).map(i => {
    const done = sum(S.returns.filter(r => r.refId === ref.id).flatMap(r => r.items || []).filter(x => x.pid === i.pid), x => x.qty);
    return { pid: i.pid, max: Math.max(0, N(i.qty) - done), qty: 0, rate: N(i.rate), cost: N(i.matCost) + N(i.stitch), restock: true, src: i.src }; }) : []; };
  if (st.refId) load();
  const draw = () => { const amt = sum(st.lines, l => N(l.qty) * N(l.rate));
    $('#mb').innerHTML = `<div class="fg"><label class="f">${kind === 'sale' ? 'Sale invoice' : 'Purchase bill'}<select id="rRef">${opt('', 'Choose…', !st.refId)}${[...list].sort((a, b) => b.date.localeCompare(a.date)).map(x => opt(x.id, `${x.no} · ${partyName(x.partyId)} · ${fdate(x.date)}`, x.id === st.refId)).join('')}</select></label>
      <label class="f">Date<input id="rDate" type="date" value="${st.date}"></label><label class="f">Reason<input id="rReason" placeholder="${kind === 'sale' ? 'Size issue, colour, fault…' : 'Faulty print, wrong fabric…'}" value="${esc(st.reason)}"></label></div>
    ${st.lines.length ? `<div class="lines tw"><table><thead><tr><th>Item</th><th class="n">Can return</th><th class="n" style="width:90px">Return qty</th><th class="n">Rate</th>${kind === 'sale' ? '<th>Back to stock?</th>' : ''}</tr></thead><tbody>
      ${st.lines.map((l, i) => `<tr class="li"><td>${esc(pname(l.pid))}</td><td class="n">${qty(l.max)}</td><td><input class="n" type="number" min="0" max="${l.max}" step="any" data-rl="${i}" value="${l.qty || ''}"></td><td class="n">${money(l.rate)}</td>${kind === 'sale' ? `<td><label class="check"><input type="checkbox" data-rs="${i}" ${l.restock ? 'checked' : ''}> ${l.restock ? (P(l.pid)?.kind === 'design' ? 'As ready piece' : 'Restock') : 'Write off'}</label></td>` : ''}</tr>`).join('')}</tbody></table></div>
      <div class="fg"><label class="f">${kind === 'sale' ? 'Credit / refund to customer' : 'Credit from supplier'}<input id="rAmt" type="number" min="0" step="any" value="${st.amt ?? Math.round(amt)}"></label></div>
      <div class="note">${kind === 'sale' ? 'The amount reduces the customer’s balance. If they already paid in full, it shows as a refund owed. Restocked items go back into inventory; written-off items count as a loss.' : 'Returned quantity leaves your stock and the amount reduces what you owe this supplier.'}</div>` : '<div class="note">Choose an invoice to see its items.</div>'}`; };
  openModal(kind === 'sale' ? 'Customer return' : 'Return to supplier', '', `<button class="btn" data-close>Cancel</button><button class="btn primary" data-saver>Save return</button>`); draw();
  modalBind = {
    change: e => { const el = e.target; if (el.id === 'rRef') { st.refId = el.value; st.amt = undefined; load(); draw(); } else if (el.dataset.rs) { st.lines[+el.dataset.rs].restock = el.checked; draw(); } },
    input: e => { const el = e.target; if (el.dataset.rl) { const l = st.lines[+el.dataset.rl]; l.qty = Math.min(N(el.value), l.max); st.amt = undefined; const a = $('#rAmt'); if (a) a.value = Math.round(sum(st.lines, x => N(x.qty) * N(x.rate))); } else if (el.id === 'rAmt') st.amt = el.value; else if (el.id === 'rReason') st.reason = el.value; else if (el.id === 'rDate') st.date = el.value; },
    click: async e => { const b = e.target.closest('button'); if (!b || !b.hasAttribute('data-saver')) return;
      const items = st.lines.filter(l => N(l.qty) > 0); if (!items.length) return toast('Enter a return quantity');
      const ref = list.find(x => x.id === st.refId); b.disabled = true;
      try { await put('returns', { kind, no: nextNo('returns', 'RET'), refId: ref.id, partyId: ref.partyId, date: fv('rDate') || today(), reason: fv('rReason'), amount: N(fv('rAmt')),
        items: items.map(l => kind === 'sale' ? { pid: l.pid, qty: N(l.qty), rate: l.rate, cost: l.cost, restock: !!l.restock } : { pid: l.pid, qty: N(l.qty), rate: l.rate }) });
        toast('Return saved'); closeModal(); go('returns'); } catch (err) { b.disabled = false; } }
  };
}

/* ===== Product ===== */
/* ===== saved categories & suggestions ===== */
const uniqCI = arr => { const m = new Map(); arr.forEach(x => { const t = String(x || '').trim(); if (t && !m.has(t.toLowerCase())) m.set(t.toLowerCase(), t); }); return [...m.values()]; };
const lists = () => ({ fabricCats: [], designCats: [], colors: [], ...(S.settings.lists || {}) });
function suggestList(type, kind, selfId) {
  const L = lists(); const des = kind === 'design';
  if (type === 'cat') return uniqCI([...(des ? L.designCats : L.fabricCats), ...S.products.filter(x => (x.kind === 'design') === des).map(x => x.category), ...(des ? DES_CATS : FAB_CATS)]);
  if (type === 'color') return uniqCI([...L.colors, ...S.products.map(x => x.color)]);
  return uniqCI(S.products.filter(x => x.id !== selfId && (x.kind === 'design') === des).map(x => x.name));
}
async function rememberLists(o) {
  const L = lists(); const key = o.kind === 'design' ? 'designCats' : 'fabricCats'; let changed = false;
  const add = (k, v) => { v = String(v || '').trim(); if (v && !L[k].some(x => x.toLowerCase() === v.toLowerCase())) { L[k] = [...L[k], v].sort((a, b) => a.localeCompare(b)); changed = true; } };
  add(key, o.category); if (o.kind !== 'design') add('colors', o.color);
  if (changed) { try { await saveSettings({ lists: L }); } catch (e) {} }
}
function attachSuggest(id, source, isName) {
  const inp = document.getElementById(id), box = document.getElementById('sg-' + id); if (!inp || !box) return;
  const draw = () => {
    const q = inp.value.trim().toLowerCase(); const all = source();
    if (isName) { const hit = all.find(x => x.toLowerCase() === q);
      const m = q.length >= 2 ? all.filter(x => x.toLowerCase().includes(q) && x.toLowerCase() !== q).slice(0, 6) : [];
      box.innerHTML = (hit ? `<span class="warn" style="font-size:12px;width:100%">“${esc(hit)}” is already in your list</span>` : '') + (m.length ? `<span class="muted" style="font-size:11.5px;width:100%">Already saved:</span>` + m.map(x => `<button type="button" data-sg="${esc(x)}">${esc(x)}</button>`).join('') : '');
      return; }
    if (document.activeElement !== inp) { box.innerHTML = ''; return; }
    const m = all.filter(x => !q || x.toLowerCase().includes(q)).filter(x => x.toLowerCase() !== q)
      .sort((a, b) => (b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q)) || a.localeCompare(b)).slice(0, 10);
    box.innerHTML = m.map(x => `<button type="button" data-sg="${esc(x)}">${esc(x)}</button>`).join('') + (q && !all.some(x => x.toLowerCase() === q) ? `<span class="muted" style="font-size:11.5px">New, saved when you press Save</span>` : '');
  };
  inp.addEventListener('input', draw); inp.addEventListener('focus', draw);
  inp.addEventListener('blur', () => setTimeout(() => { if (!isName) box.innerHTML = ''; }, 150));
  box.addEventListener('mousedown', e => { if (e.target.closest('[data-sg]')) e.preventDefault(); });
  box.addEventListener('click', e => { const b = e.target.closest('[data-sg]'); if (!b) return; e.preventDefault(); inp.value = b.dataset.sg; inp.dispatchEvent(new Event('input', { bubbles: true })); if (!isName) { box.innerHTML = ''; inp.blur(); } });
}
const FAB_CATS = ['Lawn', 'Cotton', 'Khaddar', 'Linen', 'Karandi', 'Chiffon', 'Silk', 'Organza', 'Velvet', 'Cambric', 'Jacquard', 'Marina', 'Wash & wear'];
const DES_CATS = ['2-piece', '3-piece', 'Kurta', 'Formal', 'Bridal', 'Party wear', 'Co-ord set', 'Kids'];
function productForm(kind, p, after) {
  const isNew = !p; p = p ? { ...p } : { kind, unit: kind === 'design' ? 'piece' : 'suit', fabricQty: 1 };
  const des = p.kind === 'design'; const inv = D.inv.find(r => r.p.id === p.id);
  const body = `${inv ? `<div class="kpis" style="margin:0"><div class="kpi"><div class="l">${des ? 'Ready pieces' : 'In stock'}</div><div class="v">${qty(inv.qty)} ${esc(p.unit || '')}</div></div><div class="kpi cost"><div class="l">${des ? 'Cost per outfit' : 'Avg cost'}</div><div class="v">${money(des ? fullDesignCost(p) : inv.unit)}</div></div><div class="kpi"><div class="l">Sold</div><div class="v">${qty(inv.soldQty)}</div><div class="s">Last sale ${fdate(inv.lastSale)}</div></div></div>` : ''}
  <div class="fg">
    <label class="f">${des ? 'Design no.' : 'Code / article no.'}<input id="fCode" value="${esc(p.code || '')}" placeholder="${des ? 'ZD-101' : 'LWN-24'}"></label>
    <label class="f">Name<input id="fName" autocomplete="off" value="${esc(p.name || '')}" placeholder="${des ? 'Noor embroidered 3-piece' : 'Gul Ahmed lawn 3-pc'}"><div class="sugg" id="sg-fName"></div></label>
    <label class="f">Category<input id="fCat" autocomplete="off" value="${esc(p.category || '')}" placeholder="Type or pick one"><div class="sugg" id="sg-fCat"></div></label>
    ${des ? '' : `<label class="f">Colour / print<input id="fColor" autocomplete="off" value="${esc(p.color || '')}"><div class="sugg" id="sg-fColor"></div></label>`}
    <label class="f">Unit<select id="fUnit">${(des ? ['piece', 'suit'] : ['suit', 'meter', 'yard', 'piece', 'than']).map(u => opt(u, u, p.unit === u)).join('')}</select></label>
  </div>
  ${des ? `<div class="fg">
    <label class="f">Fabric used<select id="fFab">${prodOpts('fabric', p.fabricId)}</select></label>
    <label class="f">Fabric qty per outfit<input id="fFabQty" type="number" min="0" step="any" value="${esc(p.fabricQty ?? 1)}"></label>
    <label class="f cost">Extras per outfit (lace, embroidery, buttons)<input id="fOther" type="number" min="0" step="any" value="${esc(p.otherCost || '')}"></label>
    <label class="f cost">Tailor stitching per outfit<input id="fStitch" type="number" min="0" step="any" value="${esc(p.stitchCost || '')}"></label>
    <label class="f">Sale price<input id="fPrice" type="number" min="0" step="any" value="${esc(p.price || '')}"></label>
    <label class="f">Designer<select id="fDesigner">${partyOpts('designer', p.designerId, 'None')}</select></label>
  </div><div class="note profit" id="fCalc"></div>` : `<div class="fg">
    <label class="f cost">Default cost (used until first purchase)<input id="fCost" type="number" min="0" step="any" value="${esc(p.cost || '')}"></label>
    <label class="f">Retail price<input id="fPrice" type="number" min="0" step="any" value="${esc(p.price || '')}"></label>
    <label class="f">Wholesale price<input id="fWhole" type="number" min="0" step="any" value="${esc(p.wholesale || '')}"></label>
    <label class="f">Alert when stock falls to<input id="fReorder" type="number" min="0" step="any" value="${esc(p.reorder || '')}"></label>
  </div>`}
  <label class="f">Notes<textarea id="fNote" rows="2">${esc(p.note || '')}</textarea></label>`;
  openModal(isNew ? (des ? 'New outfit design' : 'New fabric / unstitched suit') : esc(p.name), body, `${isNew ? '<span></span>' : '<button class="btn danger" data-delprod>Delete</button>'}<div class="row"><button class="btn" data-close>Cancel</button><button class="btn primary" data-saveprod>Save</button></div>`);
  const calc = () => { if (!des) return; const tmp = { fabricId: fv('fFab'), fabricQty: N(fv('fFabQty')) || 1, otherCost: N(fv('fOther')) }; const mc = designCost(tmp), tc = mc + N(fv('fStitch')), pr = N(fv('fPrice'));
    $('#fCalc').innerHTML = `Fabric + extras ${money(mc)} + stitching ${money(fv('fStitch'))} = <b>cost ${money(tc)}</b> per outfit · profit ${money(pr - tc)} (${pr ? Math.round((pr - tc) / pr * 100) : 0}% margin)`; };
  calc();
  const sources = { fName: () => suggestList('name', p.kind, p.id), fCat: () => suggestList('cat', p.kind), fColor: () => suggestList('color') };
  Object.keys(sources).forEach(id => attachSuggest(id, sources[id], id === 'fName'));
  modalBind = { input: calc, change: calc, click: async e => { const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-saveprod')) { const name = fv('fName').trim(); if (!name) return toast('Enter a name');
      const o = { ...p, code: fv('fCode').trim(), name, category: fv('fCat'), unit: fv('fUnit'), note: fv('fNote'), price: N(fv('fPrice')) };
      if (des) Object.assign(o, { fabricId: fv('fFab'), fabricQty: N(fv('fFabQty')) || 1, otherCost: N(fv('fOther')), stitchCost: N(fv('fStitch')), designerId: fv('fDesigner') });
      else Object.assign(o, { color: fv('fColor'), cost: N(fv('fCost')), wholesale: N(fv('fWhole')), reorder: N(fv('fReorder')) });
      const dup = S.products.find(x => x.id !== p.id && x.kind === o.kind && x.name.trim().toLowerCase() === name.toLowerCase());
      if (dup && !b.dataset.dupok) { b.dataset.dupok = '1'; b.textContent = 'Save anyway'; return toast(`“${dup.name}” already exists. Press Save anyway to add a second one.`); }
      b.disabled = true; try { await put('products', o); await rememberLists(o); toast('Saved ' + name); closeModal(); if (after) after(); } catch (err) { b.disabled = false; } }
    else if (b.hasAttribute('data-delprod')) { if (!armed(b)) return;
      const used = S.sales.some(s => (s.items || []).some(i => i.pid === p.id)) || S.purchases.some(s => (s.items || []).some(i => i.pid === p.id)) || S.products.some(x => x.fabricId === p.id);
      if (used) return toast('This item is used in sales, purchases or designs, so it can’t be deleted');
      await removeDoc('products', p.id); closeModal(); toast('Deleted'); } } };
}

/* ===== Contacts ===== */
function partyForm(role, pt) {
  const isNew = !pt; pt = pt ? { ...pt } : { role };
  openModal(isNew ? 'New ' + ROLES[role].toLowerCase() : 'Edit ' + esc(pt.name), `<div class="fg">
    <label class="f">Name<input id="cName" value="${esc(pt.name || '')}"></label><label class="f">Phone / WhatsApp<input id="cPhone" value="${esc(pt.phone || '')}"></label>
    <label class="f">City<input id="cCity" value="${esc(pt.city || '')}"></label><label class="f">Type<select id="cRole">${Object.entries(ROLES).map(([k, v]) => opt(k, v, k === pt.role)).join('')}</select></label></div>
    <label class="f">Address / notes<textarea id="cNote" rows="2">${esc(pt.note || '')}</textarea></label>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" data-saveparty>Save</button>`, true);
  modalBind = { click: async e => { const b = e.target.closest('[data-saveparty]'); if (!b) return; const name = fv('cName').trim(); if (!name) return toast('Enter a name');
    b.disabled = true; try { await put('parties', { ...pt, name, phone: fv('cPhone').trim(), city: fv('cCity').trim(), role: fv('cRole'), note: fv('cNote') }); toast('Saved'); closeModal(); } catch (err) { b.disabled = false; } } };
}
function partyDetail(id) {
  const pt = party(id); if (!pt) return; const bal = partyBalance(pt); let rows = [], run = 0;
  if (pt.role === 'customer' || pt.role === 'supplier') {
    const docs = pt.role === 'customer' ? S.sales.filter(s => s.partyId === id && live(s)) : S.purchases.filter(s => s.partyId === id && received(s));
    const ev = [];
    docs.forEach(d => { const t = pt.role === 'customer' ? saleTotals(d) : purchaseTotals(d); ev.push({ date: d.date, what: (pt.role === 'customer' ? 'Invoice ' : 'Bill ') + d.no, amt: t.total, open: `${pt.role === 'customer' ? 'sale' : 'purchase'}:${d.id}` }); (d.payments || []).forEach(p => ev.push({ date: p.date, what: 'Payment · ' + (p.method || ''), amt: -N(p.amount) })); });
    S.returns.filter(r => r.partyId === id && docs.some(d => d.id === r.refId)).forEach(r => ev.push({ date: r.date, what: 'Return ' + r.no, amt: -N(r.amount) }));
    ev.sort((a, b) => a.date.localeCompare(b.date)); rows = ev.map(e => { run += e.amt; return { ...e, run }; });
  }
  const tailorRows = pt.role === 'tailor' ? S.sales.filter(s => s.tailorId === id && live(s)).sort((a, b) => b.date.localeCompare(a.date)) : [];
  const designs = pt.role === 'designer' ? S.products.filter(p => p.designerId === id) : [];
  const body = `<dl class="dl"><dt>Type</dt><dd>${ROLES[pt.role]}</dd>${pt.phone ? `<dt>Phone</dt><dd class="mono">${esc(pt.phone)}</dd>` : ''}${pt.city ? `<dt>City</dt><dd>${esc(pt.city)}</dd>` : ''}${pt.note ? `<dt>Notes</dt><dd>${esc(pt.note)}</dd>` : ''}
    ${pt.role !== 'designer' ? `<dt>Balance</dt><dd class="${bal > 0.5 ? 'bad' : 'good'}"><b>${money(bal)}</b> ${pt.role === 'customer' ? 'owed to you' : pt.role === 'supplier' ? 'you owe' : 'stitching unpaid'}</dd>` : ''}</dl>
    ${rows.length ? `<h3 style="font-size:15px">Account statement</h3><div class="tw"><table><thead><tr><th>Date</th><th>Entry</th><th class="n">Amount</th><th class="n">Balance</th></tr></thead><tbody>${rows.map(r => `<tr ${r.open ? `class="click" data-open="${r.open}"` : ''}><td>${fdate(r.date)}</td><td>${esc(r.what)}</td><td class="n ${r.amt < 0 ? 'good' : ''}">${money(r.amt)}</td><td class="n">${money(r.run)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${(pt.role === 'customer' || pt.role === 'supplier') && bal > 0.5 ? `<h3 style="font-size:15px">${pt.role === 'customer' ? 'Receive payment' : 'Pay supplier'}</h3><p class="muted" style="margin:0">Applied to the oldest unpaid ${pt.role === 'customer' ? 'invoices' : 'bills'} first.</p>${payForm(bal)}` : ''}
    ${tailorRows.length ? `<div class="tw"><table><thead><tr><th>Order</th><th>Status</th><th class="n">Stitching</th><th>Paid</th></tr></thead><tbody>${tailorRows.map(s => `<tr class="click" data-open="sale:${s.id}"><td class="mono">${esc(s.no)}</td><td>${statusPill(s.status)}</td><td class="n">${money(saleTotals(s).stitch)}</td><td>${s.tailorPaid ? pill('Paid', 'good') : pill('Unpaid', 'warn')}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${designs.length ? `<div class="tw"><table><tbody>${designs.map(d => `<tr class="click" data-open="product:${d.id}"><td class="mono">${esc(d.code || '')}</td><td>${esc(d.name)}</td><td class="n">${money(d.price)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  openModal(esc(pt.name), body, `<button class="btn danger" data-delparty>Delete</button><div class="row">${pt.role === 'customer' || pt.role === 'supplier' ? '<button class="btn" data-printstmt>Print statement</button>' : ''}<button class="btn" data-editparty>Edit</button></div>`);
  modalBind = { click: async e => { const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-editparty')) { closeModal(); partyForm(pt.role, pt); }
    else if (b.hasAttribute('data-printstmt')) { closeModal(); printChoice(statementSpec(pt), () => partyDetail(id)); }
    else if (b.hasAttribute('data-delparty')) { if (!armed(b)) return; const used = S.sales.some(s => s.partyId === id || s.tailorId === id) || S.purchases.some(s => s.partyId === id);
      if (used) return toast('This contact has transactions, so it can’t be deleted'); await removeDoc('parties', id); closeModal(); toast('Deleted'); }
    else if (b.hasAttribute('data-addpay')) { let left = N(fv('payAmt')); if (left <= 0) return toast('Enter an amount'); const date = fv('payDate') || today(), method = fv('payMethod');
      const isC = pt.role === 'customer'; const docs = (isC ? S.sales.filter(s => s.partyId === id && live(s)) : S.purchases.filter(s => s.partyId === id && received(s))).map(d => [d, (isC ? saleTotals(d) : purchaseTotals(d)).due]).filter(x => x[1] > 0.5).sort((a, b) => a[0].date.localeCompare(b[0].date));
      b.disabled = true;
      for (const [d, due] of docs) { if (left <= 0) break; const a = Math.min(left, due); left -= a; await put(isC ? 'sales' : 'purchases', { ...d, payments: [...(d.payments || []), { date, amount: Math.round(a * 100) / 100, method }] }); }
      if (left > 0.5 && docs.length) { const [d] = docs[docs.length - 1]; const cur = (isC ? S.sales : S.purchases).find(x => x.id === d.id); await put(isC ? 'sales' : 'purchases', { ...cur, payments: [...(cur.payments || []), { date, amount: left, method, note: 'Advance' }] }); }
      toast('Payment recorded'); setTimeout(() => partyDetail(id), 80); } } };
}

/* ===== Expense ===== */
function expenseForm(ex) {
  const isNew = !ex; ex = ex ? { ...ex } : { date: today(), category: 'Designer fee' };
  openModal(isNew ? 'New expense' : 'Edit expense', `<div class="fg">
    <label class="f">Category<select id="eCat">${EXP_CATS.map(c => opt(c, c, c === ex.category)).join('')}</select></label>
    <label class="f">Amount<input id="eAmt" type="number" min="0" step="any" value="${esc(ex.amount || '')}"></label>
    <label class="f">Date<input id="eDate" type="date" value="${esc(ex.date)}"></label>
    <label class="f">Paid to (optional)<select id="eParty">${opt('', 'Nobody specific', !ex.partyId)}${S.parties.filter(p => p.role === 'designer' || p.role === 'tailor' || p.role === 'supplier').map(p => opt(p.id, `${p.name} (${ROLES[p.role]})`, p.id === ex.partyId)).join('')}</select></label>
    <label class="f">Method<select id="eMethod">${PAY_METHODS.map(m => opt(m, m, m === ex.method)).join('')}</select></label></div>
    <label class="f">Note<input id="eNote" value="${esc(ex.note || '')}" placeholder="e.g. Eid collection design fee"></label>`,
    `${isNew ? '<span></span>' : '<button class="btn danger" data-delexp>Delete</button>'}<div class="row"><button class="btn" data-close>Cancel</button><button class="btn primary" data-saveexp>Save</button></div>`, true);
  modalBind = { click: async e => { const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-saveexp')) { const a = N(fv('eAmt')); if (a <= 0) return toast('Enter an amount'); b.disabled = true;
      try { await put('expenses', { ...ex, category: fv('eCat'), amount: a, date: fv('eDate') || today(), partyId: fv('eParty'), method: fv('eMethod'), note: fv('eNote') }); toast('Expense saved'); closeModal(); } catch (err) { b.disabled = false; } }
    else if (b.hasAttribute('data-delexp')) { if (!armed(b)) return; await removeDoc('expenses', ex.id); closeModal(); toast('Deleted'); } } };
}

/* ===== Stock adjustment ===== */
function adjustForm(pid) {
  openModal('Adjust stock', `<div class="fg">
    <label class="f">Item<select id="aItem">${prodOpts('any', pid)}</select></label>
    <label class="f">Reason<select id="aReason">${Object.entries(ADJ_REASONS).map(([k, v]) => opt(k, v)).join('')}</select></label>
    <label class="f" id="aQtyL">Quantity to add<input id="aQty" type="number" step="any" min="0"></label>
    <label class="f" id="aCostL">Cost per unit<input id="aCost" type="number" step="any" min="0"></label>
    <label class="f">Date<input id="aDate" type="date" value="${today()}"></label></div>
    <label class="f">Note<input id="aNote"></label><div class="note" id="aHint"></div>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" data-saveadj>Save adjustment</button>`, true);
  const upd = () => { const r = fv('aReason'), id = fv('aItem'), have = stockOf(id), p = P(id);
    const add = ['opening', 'made'].includes(r), count = r === 'count';
    $('#aQtyL').firstChild.textContent = count ? 'Actual quantity counted' : add ? 'Quantity to add' : 'Quantity to remove';
    $('#aCostL').hidden = !add; if (add && p && !fv('aCost')) $('#aCost').value = Math.round(p.kind === 'design' ? fullDesignCost(p) : (D.unit[id] || N(p.cost)));
    $('#aHint').textContent = id ? `Current stock: ${qty(have)} ${p?.unit || ''}. ${r === 'made' ? 'Use this for stitched pieces made for display or ready stock (fabric is not deducted automatically, so remove it separately if needed).' : ['damage', 'lost', 'sample'].includes(r) ? 'Removed stock is counted as a loss in profit & loss.' : ''}` : 'Choose an item.'; };
  upd();
  modalBind = { change: upd, click: async e => { const b = e.target.closest('[data-saveadj]'); if (!b) return; const id = fv('aItem'), r = fv('aReason'); let q = N(fv('aQty'));
    if (!id) return toast('Choose an item'); if (r === 'count') q = q - stockOf(id); else if (!['opening', 'made'].includes(r)) q = -Math.abs(q); else q = Math.abs(q);
    if (!q) return toast(r === 'count' ? 'Count matches current stock, nothing to change' : 'Enter a quantity');
    b.disabled = true; try { await put('adjustments', { pid: id, reason: r, qty: q, cost: ['opening', 'made'].includes(r) ? N(fv('aCost')) : 0, date: fv('aDate') || today(), note: fv('aNote') }); toast('Stock adjusted'); closeModal(); } catch (err) { b.disabled = false; } } };
}
/* ===== MiniPDF: tiny self-contained PDF writer (Helvetica text, lines, filled boxes) =====
   Covers only what the receipts need, so the app has no external PDF library to load. Units are mm, origin top-left. */
const HELV_W = {
  n: [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],
  b: [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584]
};
class MiniPDF {
  constructor(opts = {}) {
    const f = opts.format || 'a4'; [this.W, this.H] = f === 'a4' ? [210, 297] : f;
    this.pages = [[]]; this.cur = 0; this.font = 'n'; this.size = 12; this.tc = [0, 0, 0]; this.fc = [0, 0, 0]; this.dc = [0, 0, 0]; this.dash = null;
  }
  static k = 72 / 25.4;
  _c(a) { return a.length === 1 ? [a[0], a[0], a[0]] : a; }
  _col(c) { return c.map(v => (v / 255).toFixed(3)).join(' '); }
  _n(v) { return (Math.round(v * 100) / 100).toString(); }
  _p(s) { this.pages[this.cur].push(s); }
  setFont(name, style) { this.font = style === 'bold' ? 'b' : 'n'; return this; }
  setFontSize(s) { this.size = s; return this; }
  setTextColor(...a) { this.tc = this._c(a); return this; }
  setFillColor(...a) { this.fc = this._c(a); return this; }
  setDrawColor(...a) { this.dc = this._c(a); return this; }
  setLineDashPattern(arr) { this.dash = arr && arr.length ? arr : null; return this; }
  getTextWidth(s) { const w = HELV_W[this.font]; let t = 0; for (const ch of String(s)) { const c = ch.charCodeAt(0); t += (c >= 32 && c <= 126) ? w[c - 32] : 556; } return t / 1000 * this.size / MiniPDF.k; }
  splitTextToSize(text, max) {
    const out = []; String(text ?? '').split('\n').forEach(par => {
      let line = ''; par.split(/\s+/).filter(Boolean).forEach(word => {
        const tryL = line ? line + ' ' + word : word;
        if (this.getTextWidth(tryL) <= max || !line) {
          if (!line && this.getTextWidth(word) > max) { let chunk = ''; for (const ch of word) { if (this.getTextWidth(chunk + ch) > max && chunk) { out.push(chunk); chunk = ''; } chunk += ch; } line = chunk; }
          else line = tryL;
        } else { out.push(line); line = word; if (this.getTextWidth(word) > max) { let chunk = ''; for (const ch of word) { if (this.getTextWidth(chunk + ch) > max && chunk) { out.push(chunk); chunk = ''; } chunk += ch; } line = chunk; } }
      }); out.push(line);
    }); return out;
  }
  _esc(s) { let o = ''; for (const ch of String(s)) { const c = ch.charCodeAt(0); if (c > 255) continue; o += (ch === '(' || ch === ')' || ch === '\\') ? '\\' + ch : ch; } return o; }
  text(s, x, y, o = {}) {
    const lines = Array.isArray(s) ? s : [s]; const lh = this.size * 1.15 / MiniPDF.k;
    lines.forEach((ln, i) => { const w = this.getTextWidth(ln); const xx = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
      const X = xx * MiniPDF.k, Y = (this.H - (y + i * lh)) * MiniPDF.k;
      this._p(`BT /F${this.font === 'b' ? 2 : 1} ${this._n(this.size)} Tf ${this._col(this.tc)} rg ${this._n(X)} ${this._n(Y)} Td (${this._esc(ln)}) Tj ET`); });
    return this;
  }
  rect(x, y, w, h, style) { const k = MiniPDF.k; const op = style === 'F' ? 'f' : style === 'FD' ? 'B' : 'S';
    this._p(`${this._col(this.fc)} rg ${this._col(this.dc)} RG ${this._n(x * k)} ${this._n((this.H - y - h) * k)} ${this._n(w * k)} ${this._n(h * k)} re ${op}`); return this; }
  roundedRect(x, y, w, h, rx, ry, style) { return this.rect(x, y, w, h, style); }
  line(x1, y1, x2, y2) { const k = MiniPDF.k; const d = this.dash ? `[${this.dash.map(v => this._n(v * k)).join(' ')}] 0 d` : '[] 0 d';
    this._p(`${this._col(this.dc)} RG 0.57 w ${d} ${this._n(x1 * k)} ${this._n((this.H - y1) * k)} m ${this._n(x2 * k)} ${this._n((this.H - y2) * k)} l S`); return this; }
  addPage() { this.pages.push([]); this.cur = this.pages.length - 1; return this; }
  getNumberOfPages() { return this.pages.length; }
  setPage(i) { this.cur = i - 1; return this; }
  _build() {
    const k = MiniPDF.k, objs = []; const add = s => { objs.push(s); return objs.length; };
    add('<< /Type /Catalog /Pages 2 0 R >>'); add('PAGES');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = this.pages.map(ops => { const content = ops.join('\n');
      const cid = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this._n(this.W * k)} ${this._n(this.H * k)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cid} 0 R >>`); });
    objs[1] = `<< /Type /Pages /Kids [${kids.map(i => i + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
    let out = '%PDF-1.4\n%âãÏÓ\n'; const offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const bytes = new Uint8Array(out.length); for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255; return bytes;
  }
  output(type) { const b = this._build(); if (type === 'arraybuffer') return b.buffer;
    let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return 'data:application/pdf;base64,' + btoa(s); }
}
/* ===== Printable receipts (PDF) =====
   The app frame cannot open the browser's print dialog, so each receipt is generated as a PDF
   the viewer saves and prints from their PDF viewer. Two sizes: A4 and 80mm thermal. */
const pm = v => { const c = S.settings.currency || 'Rs'; const r = Math.round(N(v)); return (r < 0 ? '-' : '') + c + ' ' + Math.abs(r).toLocaleString('en-PK'); };
const pd = s => fdate(s).replace(/ /g, ' ');
const pt = s => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—−]/g, '-').replace(/×/g, 'x').replace(/[^\x20-\x7e -ÿ]/g, '');

function saleSpec(so) {
  const t = saleTotals(so), c = party(so.partyId);
  return { title: so.type === 'custom' && so.status !== 'delivered' ? 'ORDER RECEIPT' : 'INVOICE', no: so.no, file: so.no,
    meta: [['Date', pd(so.date)], ['Status', STATUS[so.status]?.label || so.status], ...(so.type === 'custom' && so.dueDate ? [['Delivery due', pd(so.dueDate)]] : []), ...(so.payBy && t.due > 0.5 ? [['Payment due', pd(so.payBy)]] : [])],
    partyLabel: 'Bill to', partyName: partyName(so.partyId), partyInfo: [c?.phone, c?.city].filter(Boolean).join(' · '),
    cols: [['Item', 'l'], ['Qty', 'r'], ['Rate', 'r'], ['Amount', 'r']],
    lines: (so.items || []).map(i => [pname(i.pid), qty(i.qty), pm(i.rate), pm(N(i.qty) * N(i.rate))]),
    totals: [['Subtotal', pm(t.sub)], ...(N(so.discount) ? [['Discount', pm(-so.discount)]] : []), ...(N(so.delivery) ? [['Delivery', pm(so.delivery)]] : []), ['Total', pm(t.total), 1],
      ['Paid', pm(t.paid)], ...(t.credit ? [['Returns', pm(-t.credit)]] : []), [t.due < -0.5 ? 'Refund due' : 'Balance due', pm(Math.abs(t.due)), 1]],
    notes: [...(so.payments || []).map(p => `Paid ${pm(p.amount)} on ${pd(p.date)}${p.method ? ' by ' + p.method : ''}${p.note ? ' (' + p.note + ')' : ''}`), ...(so.note ? ['Note: ' + so.note] : [])] };
}
function purchaseSpec(pu) {
  const t = purchaseTotals(pu), c = party(pu.partyId), sch = !received(pu);
  return { title: sch ? 'PURCHASE ORDER' : 'PURCHASE BILL', no: pu.no, file: pu.no,
    meta: [[sch ? 'Order date' : 'Received', pd(pu.date)], ...(sch && pu.expected ? [['Expected', pd(pu.expected)]] : []), ...(pu.ref ? [['Supplier ref', pu.ref]] : [])],
    partyLabel: 'Supplier', partyName: partyName(pu.partyId), partyInfo: [c?.phone, c?.city].filter(Boolean).join(' · '),
    cols: [['Item', 'l'], ['Qty', 'r'], ['Rate', 'r'], ['Amount', 'r']],
    lines: (pu.items || []).map(i => [pname(i.pid), qty(i.qty) + ' ' + (P(i.pid)?.unit || ''), pm(i.rate), pm(N(i.qty) * N(i.rate))]),
    totals: sch ? [['Estimated total', pm(t.sub), 1], ...(t.paid ? [['Advance paid', pm(t.paid)]] : [])]
      : [['Items', pm(t.sub)], ...(N(pu.extra) ? [['Freight', pm(pu.extra)]] : []), ['Total', pm(t.total), 1], ['Paid', pm(t.paid)], ...(t.credit ? [['Returned', pm(-t.credit)]] : []), ['Balance', pm(t.due), 1]],
    notes: [...(pu.payments || []).map(p => `Paid ${pm(p.amount)} on ${pd(p.date)}${p.method ? ' by ' + p.method : ''}`), ...(pu.note ? ['Note: ' + pu.note] : [])] };
}
function returnSpec(r) {
  const ref = (r.kind === 'sale' ? S.sales : S.purchases).find(x => x.id === r.refId), c = party(r.partyId);
  return { title: r.kind === 'sale' ? 'CREDIT NOTE' : 'RETURN TO SUPPLIER', no: r.no, file: r.no,
    meta: [['Date', pd(r.date)], ['Against', ref?.no || '-'], ...(r.reason ? [['Reason', r.reason]] : [])],
    partyLabel: r.kind === 'sale' ? 'Customer' : 'Supplier', partyName: partyName(r.partyId), partyInfo: [c?.phone, c?.city].filter(Boolean).join(' · '),
    cols: [['Item', 'l'], ['Qty', 'r'], ['Rate', 'r'], ['Amount', 'r']],
    lines: (r.items || []).map(i => [pname(i.pid), qty(i.qty), pm(i.rate), pm(N(i.qty) * N(i.rate))]),
    totals: [[r.kind === 'sale' ? 'Credited to customer' : 'Credit from supplier', pm(r.amount), 1]], notes: [] };
}
function statementSpec(p) {
  const rows = partyLedger(p);
  return { title: 'ACCOUNT STATEMENT', no: '', file: 'statement-' + p.name.replace(/\W+/g, '-').toLowerCase(),
    meta: [['Date', pd(today())], ['Type', ROLES[p.role]]], partyLabel: ROLES[p.role], partyName: p.name, partyInfo: [p.phone, p.city].filter(Boolean).join(' · '),
    cols: [['Date', 'l'], ['Entry', 'l'], ['Amount', 'r'], ['Balance', 'r']],
    lines: rows.map(r => [pd(r.date), r.what, pm(r.amt), pm(r.run)]),
    totals: [[p.role === 'customer' ? 'Balance owed to us' : 'Balance we owe', pm(partyBalance(p)), 1]], notes: [] };
}
function partyLedger(p) {
  if (p.role !== 'customer' && p.role !== 'supplier') return [];
  const docs = p.role === 'customer' ? S.sales.filter(s => s.partyId === p.id && live(s)) : S.purchases.filter(s => s.partyId === p.id && received(s));
  const ev = [];
  docs.forEach(d => { const t = p.role === 'customer' ? saleTotals(d) : purchaseTotals(d); ev.push({ date: d.date, what: (p.role === 'customer' ? 'Invoice ' : 'Bill ') + d.no, amt: t.total, open: `${p.role === 'customer' ? 'sale' : 'purchase'}:${d.id}` }); (d.payments || []).forEach(x => ev.push({ date: x.date, what: 'Payment - ' + (x.method || ''), amt: -N(x.amount) })); });
  S.returns.filter(r => r.partyId === p.id && docs.some(d => d.id === r.refId)).forEach(r => ev.push({ date: r.date, what: 'Return ' + r.no, amt: -N(r.amount) }));
  ev.sort((a, b) => a.date.localeCompare(b.date)); let run = 0; return ev.map(e => { run += e.amt; return { ...e, run }; });
}

function buildPdf(spec, size) {
  const jsPDF = MiniPDF; const biz = pt(S.settings.business || ''), addr = pt(S.settings.address || ''), phone = pt(S.settings.phone || ''), foot = pt(S.settings.footer || 'Thank you for your business.');
  if (size === 'a4') {
    const d = new jsPDF({ unit: 'mm', format: 'a4' }); const W = 210, L = 16, R = W - 16; let y = 20;
    d.setFont('helvetica', 'bold'); d.setFontSize(18); d.text(biz, L, y);
    d.setFont('helvetica', 'normal'); d.setFontSize(9); d.setTextColor(90);
    let yy = y + 6; [addr, phone].filter(Boolean).forEach(s => { d.text(d.splitTextToSize(s, 90), L, yy); yy += 5; });
    d.setTextColor(46, 58, 140); d.setFont('helvetica', 'bold'); d.setFontSize(15); d.text(spec.title, R, y, { align: 'right' });
    d.setTextColor(30); d.setFontSize(10); if (spec.no) d.text(pt(spec.no), R, y + 6, { align: 'right' });
    d.setFont('helvetica', 'normal'); d.setFontSize(9); let my = y + 12; spec.meta.forEach(([k, v]) => { d.setTextColor(110); d.text(pt(k), R - 45, my); d.setTextColor(30); d.text(pt(v), R, my, { align: 'right' }); my += 5; });
    y = Math.max(yy, my) + 6;
    d.setFillColor(243, 244, 249); d.roundedRect(L, y, 100, spec.partyInfo ? 17 : 12, 2, 2, 'F');
    d.setFontSize(8); d.setTextColor(110); d.text(pt(spec.partyLabel).toUpperCase(), L + 4, y + 5);
    d.setFontSize(11); d.setTextColor(30); d.setFont('helvetica', 'bold'); d.text(pt(spec.partyName), L + 4, y + 10.5);
    d.setFont('helvetica', 'normal'); d.setFontSize(9); if (spec.partyInfo) d.text(pt(spec.partyInfo), L + 4, y + 15);
    y += (spec.partyInfo ? 17 : 12) + 8;
    const four = spec.cols.length === 4; const xs = spec.title === 'ACCOUNT STATEMENT' ? [L + 2, L + 30, R - 32, R - 2] : [L + 2, R - 72, R - 38, R - 2];
    const head = () => { d.setFillColor(46, 58, 140); d.rect(L, y, R - L, 8, 'F'); d.setTextColor(255); d.setFont('helvetica', 'bold'); d.setFontSize(9);
      spec.cols.forEach(([h, a], i) => d.text(h.toUpperCase(), xs[i], y + 5.4, { align: a === 'r' ? 'right' : 'left' })); y += 8; d.setFont('helvetica', 'normal'); d.setTextColor(30); };
    head();
    const itemW = spec.title === 'ACCOUNT STATEMENT' ? (R - 32 - 28) - (L + 30) : (R - 72 - 20) - (L + 2);
    spec.lines.forEach((ln, k) => {
      const wi = spec.title === 'ACCOUNT STATEMENT' ? 1 : 0; const wrapped = d.splitTextToSize(pt(ln[wi]), itemW); const h = Math.max(7, wrapped.length * 4.4 + 3);
      if (y + h > 270) { d.addPage(); y = 20; head(); }
      if (k % 2) { d.setFillColor(248, 249, 252); d.rect(L, y, R - L, h, 'F'); }
      d.setFontSize(9.5); ln.forEach((v, i) => { if (i === wi) d.text(wrapped, xs[i], y + 4.8); else d.text(pt(v), xs[i], y + 4.8, { align: spec.cols[i][1] === 'r' ? 'right' : 'left' }); });
      y += h; d.setDrawColor(224, 226, 238); d.line(L, y, R, y);
    });
    y += 6; if (y + spec.totals.length * 6.5 > 275) { d.addPage(); y = 20; }
    spec.totals.forEach(([k, v, b]) => { d.setFont('helvetica', b ? 'bold' : 'normal'); d.setFontSize(b ? 11 : 9.5); d.setTextColor(b ? 30 : 90); d.text(pt(k), R - 40, y, { align: 'right' }); d.setTextColor(30); d.text(pt(v), R - 2, y, { align: 'right' }); y += b ? 7 : 5.5; });
    d.setFont('helvetica', 'normal'); d.setFontSize(8.5); d.setTextColor(90); y += 4;
    spec.notes.forEach(n => { const w = d.splitTextToSize(pt(n), R - L); if (y + w.length * 4 > 280) { d.addPage(); y = 20; } d.text(w, L, y); y += w.length * 4 + 1; });
    const pages = d.getNumberOfPages(); for (let i = 1; i <= pages; i++) { d.setPage(i); d.setFontSize(8.5); d.setTextColor(120); d.text(foot, W / 2, 288, { align: 'center' }); if (pages > 1) d.text(`Page ${i} of ${pages}`, R, 288, { align: 'right' }); }
    return d;
  }
  // 80mm thermal receipt: measure first, then draw on a page exactly as tall as the content
  const W = 80, M = 4, CW = W - 2 * M;
  const draw = (d, dry) => { let y = 7; const T = (s, x, o = {}) => { if (!dry) d.text(s, x, y, o); };
    d.setFont('helvetica', 'bold'); d.setFontSize(12); T(biz, W / 2, { align: 'center' }); y += 4.5;
    d.setFont('helvetica', 'normal'); d.setFontSize(7.5); [addr, phone].filter(Boolean).forEach(s => d.splitTextToSize(s, CW).forEach(l => { T(l, W / 2, { align: 'center' }); y += 3.4; }));
    y += 1.5; d.setFont('helvetica', 'bold'); d.setFontSize(9.5); T(spec.title + (spec.no ? '  ' + pt(spec.no) : ''), W / 2, { align: 'center' }); y += 4.5;
    d.setFont('helvetica', 'normal'); d.setFontSize(7.5);
    [...spec.meta, [spec.partyLabel, spec.partyName], ...(spec.partyInfo ? [['', spec.partyInfo]] : [])].forEach(([k, v]) => { T(pt(k), M); T(pt(v), W - M, { align: 'right' }); y += 3.6; });
    const rule = () => { if (!dry) { d.setLineDashPattern([0.8, 0.8], 0); d.line(M, y - 1, W - M, y - 1); d.setLineDashPattern([], 0); } y += 2.5; };
    y += 1; rule();
    const stmt = spec.title === 'ACCOUNT STATEMENT';
    spec.lines.forEach(ln => { d.setFontSize(8); d.setFont('helvetica', 'bold');
      const name = stmt ? `${ln[0]}  ${ln[1]}` : ln[0]; d.splitTextToSize(pt(name), CW).forEach(l => { T(l, M); y += 3.5; });
      d.setFont('helvetica', 'normal'); d.setFontSize(7.5);
      if (stmt) { T(pt(ln[2]), M); T('Bal ' + pt(ln[3]), W - M, { align: 'right' }); } else { T(`${pt(ln[1])} x ${pt(ln[2])}`, M); T(pt(ln[3]), W - M, { align: 'right' }); }
      y += 4.2; });
    rule();
    spec.totals.forEach(([k, v, b]) => { d.setFont('helvetica', b ? 'bold' : 'normal'); d.setFontSize(b ? 9 : 7.8); T(pt(k), M); T(pt(v), W - M, { align: 'right' }); y += b ? 4.6 : 3.8; });
    d.setFont('helvetica', 'normal'); d.setFontSize(7); y += 1.5;
    spec.notes.forEach(n => d.splitTextToSize(pt(n), CW).forEach(l => { T(l, M); y += 3.2; }));
    y += 2; rule(); d.splitTextToSize(foot, CW).forEach(l => { T(l, W / 2, { align: 'center' }); y += 3.4; });
    return y + 4; };
  const probe = new jsPDF({ unit: 'mm', format: [W, 300] }); const H = Math.max(60, draw(probe, true));
  const d = new jsPDF({ unit: 'mm', format: [W, H] }); draw(d, false); return d;
}

function printChoice(spec, back) {
  let last = 'a4'; try { last = localStorage.getItem('zia-print-size') || 'a4'; } catch (e) {}
  openModal('Print ' + esc(spec.title.toLowerCase()) + (spec.no ? ' ' + esc(spec.no) : ''), `
    <p style="margin:0">Choose a size. The receipt downloads as a PDF. Open it and print it, or send it on WhatsApp.</p>
    <div class="fg">
      <button class="btn ${last === 'a4' ? 'primary' : ''}" style="justify-content:center;padding:14px" data-psize="a4">A4 page<br><span style="font-weight:400;font-size:12px">For normal printers</span></button>
      <button class="btn ${last === 'thermal' ? 'primary' : ''}" style="justify-content:center;padding:14px" data-psize="thermal">Small receipt (80mm)<br><span style="font-weight:400;font-size:12px">For receipt printers</span></button>
    </div>
    ${!S.settings.address ? '<p class="muted" style="margin:0;font-size:12.5px">Tip: add your shop address and a thank-you line in Settings to show them on receipts.</p>' : ''}`,
    `<button class="btn" data-pback>Back</button><span></span>`, true);
  modalBind = { click: async e => { const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-pback')) { closeModal(); if (back) back(); return; }
    const size = b.dataset.psize; if (!size) return; try { localStorage.setItem('zia-print-size', size); } catch (err) {}
    b.disabled = true;
    try { const d = buildPdf(spec, size); await offerFile(`${spec.file}${size === 'thermal' ? '-receipt' : ''}.pdf`, d.output('arraybuffer')); }
    catch (err) { toast('Could not create the PDF: ' + (err.message || err)); }
    b.disabled = false; } };
}
/* ===== Receivables: who owes you, from the dashboard ===== */
function receivableRows() {
  const g = {};
  S.sales.filter(live).forEach(so => { const due = saleTotals(so).due; if (due <= 0.5) return; const k = so.partyId || 'walkin:' + so.id;
    const r = g[k] || (g[k] = { key: k, pid: so.partyId, sales: [], due: 0, oldest: so.date, payBy: '' }); r.sales.push(so); r.due += due;
    if (so.date < r.oldest) r.oldest = so.date; if (so.payBy && (!r.payBy || so.payBy < r.payBy)) r.payBy = so.payBy; });
  return Object.values(g).sort((a, b) => b.due - a.due);
}
function reminderText(r) {
  const c = party(r.pid); const nos = r.sales.map(s => s.no).join(', ');
  return `Assalam o Alaikum ${c?.name || ''},\nThis is a friendly reminder from ${S.settings.business || 'us'}. Your balance of ${money(r.due)} (${nos}) is ${r.payBy && r.payBy < today() ? 'overdue since ' + fdate(r.payBy) : r.payBy ? 'due on ' + fdate(r.payBy) : 'pending'}.${S.settings.phone ? `\nFor any query: ${S.settings.phone}` : ''}\nThank you!`.replace(/ /g, ' ');
}
function receivablesList() {
  const rows = receivableRows(); const total = sum(rows, r => r.due); const late = rows.filter(r => r.payBy && r.payBy < today());
  const body = `<div class="kpis" style="margin:0"><div class="kpi"><div class="l">Total receivable</div><div class="v warn">${money(total)}</div></div><div class="kpi"><div class="l">Customers</div><div class="v">${rows.length}</div></div><div class="kpi"><div class="l">Overdue</div><div class="v ${late.length ? 'bad' : ''}">${money(sum(late, r => r.due))}</div><div class="s">${late.length} past promised date</div></div></div>
  <div class="tw"><table><thead><tr><th>Customer</th><th>Invoices</th><th>Since</th><th>Promised by</th><th class="n">Amount due</th><th></th></tr></thead><tbody>
  ${rows.length ? rows.map((r, i) => { const c = party(r.pid); const od = r.payBy && r.payBy < today();
    return `<tr class="click" data-open="${r.pid ? 'party:' + r.pid : 'sale:' + r.sales[0].id}"><td><b>${esc(c?.name || 'Walk-in (no name)')}</b>${c?.phone ? `<div class="mono muted">${esc(c.phone)}</div>` : ''}</td>
      <td class="mono" style="font-size:12px">${r.sales.map(s => esc(s.no)).join('<br>')}</td><td>${fdate(r.oldest)}<div class="muted" style="font-size:12px">${daysBetween(r.oldest, today())} days</div></td>
      <td class="${od ? 'bad' : ''}">${r.payBy ? fdate(r.payBy) + (od ? ' ' + pill('Overdue', 'bad') : '') : '<span class="muted">—</span>'}</td>
      <td class="n"><b>${money(r.due)}</b></td><td class="n" style="white-space:nowrap">${c ? `<button class="btn sm" data-remind="${i}">Copy reminder</button>` : ''}</td></tr>`; }).join('')
  : emptyRow(6, 'Nobody owes you anything', 'Sales on credit, or with a balance left to pay, show up here.')}</tbody></table></div>
  <p class="muted" style="margin:0;font-size:12.5px">Tap a customer to see their account and record a payment. “Copy reminder” copies a polite WhatsApp message with the amount.</p>`;
  openModal('Customers who owe you', body, `<button class="btn" data-recvcsv>Export CSV</button><button class="btn" data-close>Close</button>`);
  modalBind = { click: e => { const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.remind) { e.stopPropagation(); copyText(reminderText(rows[+b.dataset.remind]), 'Reminder message'); }
    else if (b.hasAttribute('data-recvcsv')) offerFile(`receivables-${today()}.csv`, csv([['Customer', 'Phone', 'Invoices', 'Since', 'Promised by', 'Amount due'], ...rows.map(r => { const c = party(r.pid); return [c?.name || 'Walk-in', c?.phone || '', r.sales.map(s => s.no).join(' '), r.oldest, r.payBy, Math.round(r.due)]; })])); } };
}
/* ===== Team access & roles =====
   People reach the app through the Share menu. When someone opens it without a role, they send an access request;
   the owner (or an Editor) grants a role here. Roles decide which pages and figures the app shows them. */
const ROLE_DEF = {
  admin: { label: 'Admin', desc: 'Everything, including settings and team access.', views: 'all', cost: true, profit: true, write: true },
  manager: { label: 'Manager', desc: 'All daily work, stock, expenses and reports. No settings or team access.', views: ['dashboard', 'sales', 'tailor', 'purchases', 'returns', 'inventory', 'catalog', 'parties', 'expenses', 'reports'], cost: true, profit: true, write: true },
  sales: { label: 'Sales staff', desc: 'Sales, stitched orders, tailor board, returns, stock levels and contacts. Does not see costs, profit or purchases.', views: ['dashboard', 'sales', 'tailor', 'returns', 'inventory', 'parties'], cost: false, profit: false, write: true },
  stock: { label: 'Stock keeper', desc: 'Purchases, inventory, fabrics & designs, returns and contacts. Does not see profit, expenses or reports.', views: ['dashboard', 'purchases', 'returns', 'inventory', 'catalog', 'parties'], cost: true, profit: false, write: true },
  viewer: { label: 'View only', desc: 'Can look at sales, orders, stock and contacts. Cannot change anything and does not see costs or profit.', views: ['dashboard', 'sales', 'tailor', 'purchases', 'returns', 'inventory', 'catalog', 'parties'], cost: false, profit: false, write: false }
};
const A = { user: null, me: null, isAdmin: true, role: 'admin', team: [], requests: [], requested: false, ready: false };
const R = () => ROLE_DEF[A.role] || null;
const canView = v => { const r = R(); return !!r && (r.views === 'all' || r.views.includes(v)); };
const canCost = () => !!R()?.cost, canProfit = () => !!R()?.profit;
function applyAccess() {
  const old = A.role;
  A.role = A.isAdmin ? 'admin' : (A.team.find(t => t.id === A.me?.id)?.role || null);
  if (!ROLE_DEF[A.role] && A.role) A.role = 'viewer';
  document.body.classList.toggle('hide-cost', !canCost());
  document.body.classList.toggle('hide-profit', !canProfit());
  S.readOnly = !!R() && !R().write;
  if (R() && !canView(S.view)) S.view = 'dashboard';
  if (!R() && !A.requested && db && A.me?.id && mode === 'db') sendRequest();
  if (old !== A.role && A.ready) queue();
}
async function sendRequest() {
  A.requested = true;
  try { await db.collection('requests').doc(A.me.id).set({ requestedAt: Date.now(), date: today() }); A.requestSent = true; }
  catch (e) { A.requestSent = false; A.requestError = e && e.code; }
  queue();
}
function waitingView() {
  const noId = !A.me?.id;
  return `<div class="panel" style="max-width:560px;margin:40px auto;text-align:center;padding:32px 24px">
    <div style="width:56px;height:56px;border-radius:50%;margin:0 auto 14px;background:var(--brand-soft);color:var(--brand);display:grid;place-items:center;font:700 24px var(--f-display)">${esc((S.settings.business || 'Z').charAt(0))}</div>
    <h1 style="font-size:22px;margin-bottom:6px">${noId ? 'Sign in to continue' : 'Waiting for access'}</h1>
    <p class="muted" style="margin:0 auto;max-width:42ch">${noId ? (window.ERP_HOSTED ? 'Sign in to continue.' : 'Open this app while signed in to your Claude account so the owner can give you access.')
      : A.requestSent ? `Your request has been sent to the owner of ${esc(S.settings.business || 'this business')}. This page opens by itself as soon as they grant you access.`
      : A.requestError ? (window.ERP_HOSTED ? 'Your request could not be sent. Reload the page to try again.' : 'Your access level can only view this link, so your request could not be sent. Ask the owner to share it with you as <b>Contributor</b>.')
      : 'Sending your access request…'}</p>
    ${A.me?.name ? `<p style="margin-top:14px;font-size:13px">Signed in as <b>${esc(A.me.name)}</b>${A.me.email ? ' · ' + esc(A.me.email) : ''}</p>` : ''}</div>`;
}
const personCell = (uid, extra = '') => `<div class="row" style="gap:10px;flex-wrap:nowrap"><img data-avatar="${esc(uid)}" alt="" width="32" height="32" style="border-radius:50%;flex:none;background:var(--surface-2)"><div style="min-width:0"><b data-name="${esc(uid)}">…</b><div class="muted" style="font-size:12px" data-email="${esc(uid)}"></div>${extra}</div></div>`;
function teamPanel() {
  if (!A.isAdmin) return '';
  if (!A.user || mode !== 'db') return `<div class="panel"><h2>Team & access</h2><p class="muted" style="margin:0">Team access works when the app is opened from claude.ai with cloud storage.</p></div>`;
  const roleOpts = sel => Object.entries(ROLE_DEF).map(([k, v]) => opt(k, v.label, k === sel)).join('');
  const reqs = A.requests.filter(r => !A.team.some(t => t.id === r.id));
  return `<div class="panel" style="grid-column:1/-1"><h2>Team & access <small>${A.team.length} member${A.team.length === 1 ? '' : 's'}${reqs.length ? ` · <span class="warn">${reqs.length} waiting</span>` : ''}</small></h2>
    <div class="note" style="margin-bottom:14px;line-height:1.6"><b>How to give someone access</b><br>${window.ERP_HOSTED ? `1. Send them this app's link: <span class="mono">${esc(location.origin + location.pathname)}</span><br>2. They press <b>Create an account</b> and sign up with their email. Their request appears below.` : `1. Press <b>Share</b> at the top of this app and invite them by email. Choose <b>Contributor</b> so they can enter data (they need a Claude account).<br>2. When they open the app, their request appears below.`}<br>3. Pick a role and press <b>Grant access</b>. You can change or remove it any time.</div>
    ${reqs.length ? `<h3 style="font-size:14px;margin:0 0 8px">Waiting for access</h3><div class="tw" style="margin-bottom:16px"><table><tbody>${reqs.map(r => `<tr><td>${personCell(r.id, `<div class="muted" style="font-size:11.5px">Asked ${fdate(r.date)}</div>`)}</td>
      <td style="width:170px"><select id="rq-role-${esc(r.id)}" class="search" style="width:100%">${roleOpts('sales')}</select></td>
      <td class="n" style="white-space:nowrap"><button class="btn sm primary" data-grant="${esc(r.id)}">Grant access</button> <button class="btn sm danger" data-decline="${esc(r.id)}">Decline</button></td></tr>`).join('')}</tbody></table></div>` : ''}
    <h3 style="font-size:14px;margin:0 0 8px">People with access</h3>
    <div class="tw"><table><thead><tr><th>Person</th><th>Role</th><th>What they can do</th><th></th></tr></thead><tbody>
      <tr><td>${personCell(A.me?.id || 'me')}</td><td>${pill('Owner', 'brand')}</td><td class="muted" style="font-size:12.5px">Everything</td><td></td></tr>
      ${A.team.filter(t => t.id !== A.me?.id).map(t => `<tr><td>${personCell(t.id)}</td><td style="width:170px"><select class="search" style="width:100%" data-setrole="${esc(t.id)}">${roleOpts(t.role)}</select></td><td class="muted" style="font-size:12.5px;max-width:320px">${esc(ROLE_DEF[t.role]?.desc || '')}</td><td class="n"><button class="btn sm danger" data-revoke="${esc(t.id)}">Remove access</button></td></tr>`).join('')}
    </tbody></table></div>
    <details style="margin-top:14px"><summary style="cursor:pointer;font-weight:600;font-size:13.5px">What each role can do</summary><div class="tw" style="margin-top:8px"><table><tbody>${Object.values(ROLE_DEF).map(r => `<tr><td style="white-space:nowrap"><b>${r.label}</b></td><td class="muted" style="font-size:12.5px">${r.desc}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted" style="font-size:12px;margin:8px 0 0">Roles control what the app shows and lets each person do. ${window.ERP_HOSTED ? 'The database itself enforces what each role may change. Anyone with a role can read the records, so give access only to people you trust.' : 'Anyone you share the app with can technically reach its stored records, so share it only with people you trust, and remove them in the Share menu too when they leave.'}</p></details>
  </div>`;
}
async function fillPeople() {
  if (!A.user) return; const els = $$('[data-name],[data-avatar],[data-email]'); if (!els.length) return;
  const ids = [...new Set(els.map(e => e.dataset.name || e.dataset.avatar || e.dataset.email))].map(id => id === 'me' ? A.me?.id : id).filter(Boolean);
  const ps = ids.length ? await A.user.profiles(ids) : {};
  els.forEach(e => { const raw = e.dataset.name || e.dataset.avatar || e.dataset.email; const id = raw === 'me' ? A.me?.id : raw; const p = ps[id] || {};
    if (e.dataset.name) e.textContent = (p.name || (raw === 'me' || p.isMe ? (A.me?.name || 'You') : 'Someone')) + (p.isMe || raw === 'me' ? ' (you)' : '') + (p.guest ? ' · guest' : '');
    else if (e.dataset.email) e.textContent = p.email || (raw === 'me' ? (A.me?.email || '') : '');
    else if (p.avatarUrl || A.me?.avatarUrl) e.src = p.avatarUrl || A.me.avatarUrl; });
}
async function startAccess() {
  try { A.user = await window.claude.use('user'); } catch (e) { A.user = null; }
  if (!A.user) { A.isAdmin = true; A.ready = true; applyAccess(); queue(); return; }
  A.me = await A.user.me(); A.isAdmin = !!(A.me.isOwner || A.me.canEdit);
  db.collection('team').onSnapshot(snap => { A.team = snap.docs.map(d => ({ ...d.data(), id: d.id })); A.ready = true; applyAccess(); queue(); }, () => { A.ready = true; applyAccess(); queue(); });
  if (A.isAdmin) db.collection('requests').onSnapshot(snap => { A.requests = snap.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0)); queue(); }, () => {});
  applyAccess(); queue();
}
async function grantRole(uid, role) {
  try { await db.collection('team').doc(uid).set({ role, grantedAt: Date.now(), date: today() }); try { await db.collection('requests').doc(uid).delete(); } catch (e) {} toast('Access granted as ' + ROLE_DEF[role].label); }
  catch (e) { toast('Could not grant access: ' + (e.message || e.code)); }
}
/* ===== events ===== */
function openRef(ref) { const [t, id] = ref.split(':'); closeModal();
  if (t === 'sale') saleDetail(id); else if (t === 'purchase') purchaseDetail(id); else if (t === 'party') partyDetail(id);
  else if (t === 'expense') expenseForm(S.expenses.find(x => x.id === id)); else if (t === 'product') { const p = P(id); if (p) productForm(p.kind, p); } }
const ACTS = {
  newSale: b => saleForm(null, b.dataset.type), newPurchase: () => purchaseForm(),
  schedulePurchase: () => purchaseForm({ date: today(), status: 'scheduled', items: [{ pid: '', qty: 1, rate: 0 }], payments: [] }, true),
  reorderPlan: () => { const l = reorderLines(); if (!l.length) return toast('No fabric is below its reorder level. Set reorder levels under Fabrics & designs.'); purchaseForm({ date: today(), status: 'scheduled', items: l, payments: [], note: 'Reorder of low-stock items' }, true); }, newReturn: b => returnForm(b.dataset.kind),
  receivables: () => receivablesList(),
  newProduct: b => productForm(b.dataset.kind || 'fabric'), newParty: b => partyForm(b.dataset.role || 'customer'), newExpense: () => expenseForm(), adjust: () => adjustForm(),
  exportSales: () => offerFile(`sales-${today()}.csv`, csv([['Invoice', 'Date', 'Customer', 'Type', 'Status', 'Items', 'Subtotal', 'Discount', 'Delivery', 'Total', 'Paid', 'Due', 'Cost', 'Profit'],
    ...S.sales.map(so => { const t = saleTotals(so); return [so.no, so.date, partyName(so.partyId), so.type, so.status, itemsLine(so), t.sub, N(so.discount), N(so.delivery), t.total, t.paid, t.due, t.cogs, t.sub - N(so.discount) - t.cogs]; })])),
  exportPurchases: () => offerFile(`purchases-${today()}.csv`, csv([['No.', 'Status', 'Date', 'Expected', 'Supplier', 'Items', 'Freight', 'Total', 'Paid', 'Due'], ...S.purchases.map(pu => { const t = purchaseTotals(pu); return [pu.no, received(pu) ? 'Received' : 'Scheduled', pu.date, pu.expected || '', partyName(pu.partyId), (pu.items || []).map(i => `${pname(i.pid)} x ${i.qty} @ ${i.rate}`).join('; '), N(pu.extra), t.total, t.paid, t.due]; })])),
  exportStock: () => offerFile(`stock-${today()}.csv`, csv([['Code', 'Item', 'Type', 'Category', 'Qty', 'Unit', 'Avg cost', 'Value', 'Sale price', 'Sold', 'Last movement', 'Idle days', 'Status'], ...D.inv.map(r => [r.p.code, r.p.name, r.p.kind === 'design' ? 'Design' : 'Fabric', r.p.category, r.qty, r.p.unit, Math.round(r.unit), Math.round(r.value), r.p.price, r.soldQty, r.lastMove || '', r.age ?? '', r.status])])),
  exportPL: () => { const rg = range(), r = pnl(rg); offerFile(`profit-loss-${rg[0]}-to-${rg[1] > today() ? today() : rg[1]}.csv`, csv([['Line', 'Amount'], ['Gross sales', r.gross], ['Discounts', -r.disc], ['Customer returns', -r.retRev], ['Delivery charges', r.deliv], ['Net sales', r.netRev], ['Fabric & materials', -r.mat], ['Tailor stitching', -r.stitch], ['Restocked returns cost', r.retCost], ['Gross profit', r.grossProfit], ...Object.entries(r.exp).map(([k, v]) => [k, -v]), ['Stock written off', -r.writeoffs], ['Net profit', r.net]])); },
  exportTop: () => offerFile(`top-sellers-${today()}.csv`, csv([['Product', 'Qty', 'Sales', 'Cost', 'Profit'], ...topSellers(range()).map(t => [pname(t.pid), t.qty, Math.round(t.rev), Math.round(t.cost), Math.round(t.profit)])])),
  backup: () => { const o = { app: 'zia-erp', version: 1, exportedAt: new Date().toISOString(), settings: S.settings }; COLS.forEach(c => o[c] = S[c]); offerFile(`${(S.settings.business || 'erp').replace(/\W+/g, '-').toLowerCase()}-backup-${today()}.json`, JSON.stringify(o, null, 1)); },
  clearSamples: async b => { if (!armed(b)) return; b.disabled = true; let n = 0; for (const c of COLS) for (const x of S[c].filter(x => x.sample)) { try { await removeDoc(c, x.id); n++; } catch (e) {} } toast(`Removed ${n} example records`); }
};
document.addEventListener('click', e => {
  const inModal = e.target.closest('#modalRoot');
  if (inModal) {
    if (e.target.id === 'scrim' || e.target.closest('[data-close]')) { closeModal(); return; }
    const o = e.target.closest('[data-open]'), ob = e.target.closest('button'); if (o && (!ob || ob === o || !o.contains(ob))) { openRef(o.dataset.open); return; }
    const a = e.target.closest('[data-advance]'); if (a) { advance(a.dataset.advance); return; }
    const tp = e.target.closest('[data-tailorpaid]'); if (tp) { const so = S.sales.find(x => x.id === tp.dataset.tailorpaid); if (so) put('sales', { ...so, tailorPaid: true, tailorPaidDate: today() }).then(() => { toast('Stitching marked paid'); setTimeout(() => saleDetail(so.id), 80); }); return; }
    if (modalBind?.click) modalBind.click(e);
    return;
  }
  const b = e.target.closest('button, [data-open], label');
  if (!b) return;
  if (b.dataset.go) return go(b.dataset.go);
  if (b.dataset.period) { S.period = b.dataset.period; if (b.dataset.period === 'custom' && !S.from) { S.from = addDays(today(), -30); S.to = today(); } return render(); }
  if (b.dataset.tab) { const t = b.dataset.tab, j = t.indexOf(':'); S.tab[t.slice(0, j)] = t.slice(j + 1); return render(); }
  if (b.dataset.open) return openRef(b.dataset.open);
  if (b.dataset.act && ACTS[b.dataset.act]) return ACTS[b.dataset.act](b);
  if (b.dataset.receive) return receiveForm(b.dataset.receive);
  if (b.dataset.advance) return advance(b.dataset.advance);
  if (b.dataset.tailorpaid) { const so = S.sales.find(x => x.id === b.dataset.tailorpaid); if (so) put('sales', { ...so, tailorPaid: true, tailorPaidDate: today() }).then(() => toast('Stitching marked paid')); return; }
  if (b.dataset.grant) { const uid = b.dataset.grant; b.disabled = true; grantRole(uid, fv('rq-role-' + uid) || 'sales'); return; }
  if (b.dataset.decline) { if (!armed(b)) return; db.collection('requests').doc(b.dataset.decline).delete().then(() => toast('Request declined')).catch(e => toast('Could not decline: ' + e.message)); return; }
  if (b.dataset.revoke) { if (!armed(b)) return; db.collection('team').doc(b.dataset.revoke).delete().then(() => toast(window.ERP_HOSTED ? 'Access removed' : 'Access removed. Also remove them in the Share menu.')).catch(e => toast('Could not remove: ' + e.message)); return; }
  if (b.dataset.addlist) { const k = b.dataset.addlist, el = document.getElementById('add-' + k), v = (el?.value || '').trim(); if (!v) return toast('Type a name first');
    const L = lists(); if (L[k].some(x => x.toLowerCase() === v.toLowerCase())) return toast('Already saved'); L[k] = [...L[k], v].sort((a, c) => a.localeCompare(c)); saveSettings({ lists: L }).then(() => toast('Added ' + v)); return; }
  if (b.dataset.dellist) { const [k, i] = b.dataset.dellist.split(':'); const L = lists(); const v = L[k][+i]; L[k] = L[k].filter((_, j) => j !== +i); saveSettings({ lists: L }).then(() => toast('Removed ' + v)); return; }
  if (b.dataset.printret) { const r = S.returns.find(x => x.id === b.dataset.printret); if (r) printChoice(returnSpec(r)); return; }
  if (b.dataset.delreturn) { if (!armed(b)) return; removeDoc('returns', b.dataset.delreturn).then(() => toast('Return deleted')); return; }
  if (b.dataset.deladj) { if (!armed(b)) return; removeDoc('adjustments', b.dataset.deladj).then(() => toast('Adjustment deleted')); return; }
});
document.addEventListener('input', e => {
  if (e.target.closest('#modalRoot')) { modalBind?.input?.(e); return; }
  const q = e.target.dataset?.q; if (q !== undefined) { S.q[q] = e.target.value; render(); }
});
document.addEventListener('change', e => {
  if (e.target.closest('#modalRoot')) { modalBind?.change?.(e); return; }
  if (e.target.id === 'pFrom' || e.target.id === 'pTo') { S.from = fv('pFrom'); S.to = fv('pTo'); render(); }
  if (e.target.id === 'restoreFile' && e.target.files[0]) restore(e.target.files[0]);
  if (e.target.dataset?.setrole) grantRole(e.target.dataset.setrole, e.target.value);
});
document.addEventListener('submit', e => { if (e.target.id === 'settingsForm') { e.preventDefault(); const f = new FormData(e.target);
  saveSettings({ business: f.get('business').trim() || 'My business', currency: f.get('currency').trim() || 'Rs', deadDays: N(f.get('deadDays')) || 90, phone: f.get('phone').trim(), address: f.get('address').trim(), footer: f.get('footer').trim() }).then(() => toast('Settings saved')).catch(() => toast('Could not save settings')); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#modalRoot').innerHTML) closeModal(); });

async function restore(file) {
  let o; try { o = JSON.parse(await file.text()); } catch (e) { return toast('That file is not a valid backup'); }
  if (!o || o.app !== 'zia-erp') return toast('That file is not a backup from this ERP');
  const n = COLS.reduce((t, c) => t + (o[c] || []).length, 0);
  openModal('Restore backup', `<p style="margin:0">This backup from ${esc(fdate((o.exportedAt || '').slice(0, 10)))} has <b>${n}</b> records. Records with the same ID are overwritten; nothing else is deleted.</p><div id="restoreProg" class="note">Ready.</div>`, `<button class="btn" data-close>Cancel</button><button class="btn primary" data-dorestore>Restore ${n} records</button>`, true);
  modalBind = { click: async e => { const b = e.target.closest('[data-dorestore]'); if (!b) return; b.disabled = true; let k = 0;
    if (o.settings) await saveSettings(o.settings);
    for (const c of COLS) for (const x of o[c] || []) { try { await put(c, x); } catch (err) {} k++; if (k % 10 === 0) $('#restoreProg').textContent = `Restored ${k} of ${n}…`; }
    toast(`Restored ${k} records`); closeModal(); } };
}

/* ===== boot ===== */
(function boot() {
  document.body.classList.remove('hide-cost', 'hide-profit');
  const h = (location.hash || '').slice(1); if (VIEWS[h]) S.view = h;
  render();
  (async () => {
    if (!window.claude || !window.claude.use) { mode = 'local'; A.ready = true; applyAccess(); loadLocal(); render(); return; }
    try { db = await window.claude.use('db'); } catch (e) { db = null; }
    try { dl = await window.claude.use('downloads'); } catch (e) { dl = null; }
    if (!db) { mode = 'local'; A.ready = true; applyAccess(); loadLocal(); render(); return; }
    mode = 'db'; render(); startAccess();
    COLS.forEach(c => db.collection(c).onSnapshot(snap => { S[c] = snap.docs.map(d => ({ ...d.data(), id: d.id })); S.loaded.add(c); queue(); },
      err => { if (err.code === 'revoked') { S.readOnly = true; } toast('Live sync paused. Reload the page to reconnect.'); queue(); }));
    db.doc('meta/settings').onSnapshot(s => { if (s.exists) { S.settings = { ...S.settings, ...s.data() }; queue(); } }, () => {});
  })();
})();
