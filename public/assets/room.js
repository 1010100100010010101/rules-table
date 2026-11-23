import { $, el, avatar, toast, quoteRows, renderVerdict, store, deviceId, copyText, wireCounter, COLORS } from "/assets/common.js";
import { dict, fmt, getLang, applyI18n, langSwitch } from "/assets/i18n.js";

const params = new URLSearchParams(location.search);
const code = (params.get("c") || "").toUpperCase();
const device = deviceId();
const privKey = `priv:${code}`;
const setupKey = `setup:${code}`;
let lang = getLang();
let t = dict(lang);
// 骰面點數在 3×3 格子裡的位置
const PIPS = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
let lastRollKey = null;
function die(v, roll) {
  const d = el("span", "die" + (v === 1 ? " one" : "") + (roll ? " roll" : ""));
  d.setAttribute("role", "img"); d.setAttribute("aria-label", String(v));
  for (let i = 0; i < 9; i++) d.append(el("i", PIPS[v].includes(i) ? "p" : null));
  return d;
}

let S = null;            // 伺服器送來的最新房間狀態
let info = null;         // 加入前查到的房間資訊
let ws = null;
let closedByServer = false;
let retry = 0;
let mode = "duel";
let tab = store(`tab:${code}`) || "rule";
let joinRole = params.get("role") === "viewer" ? "viewer" : "player";
let chat = store(privKey) || [];
let pendingPriv = null;
const drafts = {};

// ---------- 小工具 ----------
const isPlayer = () => S?.me?.role === "player";
const isHost = () => !!S?.me?.isHost;
function myColor() {
  let c = store("color");
  if (!COLORS.includes(c)) { c = COLORS[Math.floor(Math.random() * COLORS.length)]; store("color", c); }
  return c;
}
function sentMap() {
  const m = new Map();
  for (const s of S?.sentences || []) m.set(s.sid, s.text);
  for (const h of S?.house || []) m.set(h.hid, h.text);
  return m;
}
function quotesOf(ids) {
  const m = sentMap();
  return (ids || []).filter((id) => m.has(id)).map((id) => ({ sid: id, text: m.get(id) }));
}
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(obj)); return true; }
  toast(t.reconnecting);
  return false;
}
function setConn(on) { $("conn").classList.toggle("off", !on); }

let fatalMsg = null;
function fatal(key) {
  fatalMsg = key;
  const f = $("fatal");
  f.replaceChildren(el("h2", null, t.fatalTitle), el("p", "muted", t[key] || key));
  const a = el("a", "btn", t.goHome); a.href = "/"; f.append(a);
  f.hidden = false;
  $("tabs").hidden = true;
  $("joinCard").hidden = true;
  document.querySelectorAll("[id^=tab-]").forEach((x) => (x.hidden = true));
}

// ---------- 語言 ----------
function applyLang(l) {
  lang = l;
  t = dict(l);
  applyI18n(t);
  if (S || info) $("title").textContent = S?.title || info.title; // 標題是遊戲名稱，不跟著換語言
  $("codeChip").title = t.copyInvite;
  [...$("dseg").children].forEach((b) => (b.textContent = fmt(t.diceN, { n: b.dataset.n })));
  if (info && !S) $("joinInfo").textContent = fmt(t.joinInfo, { title: info.title, n: info.players });
  if (fatalMsg) fatal(fatalMsg);
  renderAll();
}
langSwitch($("langs"), (l) => {
  applyLang(l);
  // 重新連線，讓伺服器的錯誤訊息也換成新語言
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
});

// ---------- 分頁 ----------
function switchTab(x) {
  tab = x;
  store(`tab:${code}`, x);
  document.querySelectorAll("[id^=tab-]").forEach((e) => (e.hidden = e.id !== `tab-${x}`));
  [...$("tabs").querySelectorAll("button")].forEach((b) => b.classList.toggle("on", b.dataset.t === x));
  window.scrollTo({ top: 0 });
}
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b?.dataset.t) switchTab(b.dataset.t);
});

// ---------- 連線 ----------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ device, name: store("name") || "", color: myColor(), role: joinRole, lang });
  ws = new WebSocket(`${proto}://${location.host}/api/rooms/${code}/ws?${q}`);
  ws.onopen = () => { retry = 0; setConn(true); ws.send(JSON.stringify({ type: "sync" })); };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onMessage(m);
  };
  ws.onclose = () => {
    setConn(false);
    if (pendingPriv) { pendingPriv = null; renderChat(); toast(t.privLost); }
    if (closedByServer) return;
    if (!S && retry >= 2) { fatal("cantConnect"); return; }
    const wait = Math.min(10000, 800 * 2 ** retry);
    retry++;
    setTimeout(connect, wait);
  };
}

function onMessage(m) {
  if (m.type === "state") { S = m.state; renderAll(); }
  else if (m.type === "private_result") onPrivate(m);
  else if (m.type === "error") toast(m.message);
  else if (m.type === "toast") toast(m.message);
  else if (m.type === "closed") { closedByServer = true; fatal("roomEnded"); }
}

// ---------- 全部重畫 ----------
function renderAll() {
  if (!S) return;
  $("joinCard").hidden = true;
  $("tabs").hidden = false;
  $("title").textContent = S.title;
  document.title = fmt(t.tabRoomTitle, { title: S.title });
  if (document.querySelector("[id^=tab-]:not([hidden])") === null) switchTab(tab);
  renderHeader();
  renderRuleTab();
  renderChat();
  renderGuide();
  renderTools();
  renderHouse();
  renderPips();
}

function renderHeader() {
  const box = $("avs"); box.replaceChildren();
  const ps = [...S.players].sort((a, b) => Number(b.online) - Number(a.online));
  for (const p of ps) {
    const a = avatar(p.name, p.color, { off: !p.online, dot: p.online });
    const tags = [p.isHost && t.host, p.role === "viewer" && t.roleViewer].filter(Boolean);
    a.title = p.name + (tags.length ? ` (${tags.join(", ")})` : "") + (p.device === device ? t.you : "");
    box.append(a);
  }
}

function renderPips() {
  const needVote = (v) => v && v.status === "open" && v.canVote && v.mine === null;
  const rulePip = S.disputes.some((d) => needVote(d.vote));
  const housePip = S.votes.some(needVote);
  for (const b of $("tabs").querySelectorAll("button")) {
    b.querySelector(".pip")?.remove();
    if ((b.dataset.t === "rule" && rulePip) || (b.dataset.t === "house" && housePip)) b.append(el("span", "pip"));
  }
}

// ---------- 裁定分頁 ----------
function setMode(m) {
  mode = m;
  [...$("mseg").children].forEach((b) => b.classList.toggle("on", b.dataset.m === m));
  $("duel").hidden = m !== "duel";
  $("ask").hidden = m !== "ask";
}
$("mseg").addEventListener("click", (e) => { const m = e.target.dataset?.m; if (m) setMode(m); });
wireCounter($("a"), $("ca")); wireCounter($("b"), $("cb")); wireCounter($("q"), $("cq")); wireCounter($("pq"), $("cpq"));

$("send").onclick = () => {
  const body = mode === "duel"
    ? { type: "dispute", mode, a: $("a").value.trim(), b: $("b").value.trim() }
    : { type: "dispute", mode, q: $("q").value.trim() };
  if (mode === "duel" && (!body.a || !body.b)) return toast(t.needBothClaims);
  if (mode === "ask" && !body.q) return toast(t.needQuestion);
  if (send(body)) {
    for (const id of ["a", "b", "q"]) { $(id).value = ""; $(id).dispatchEvent(new Event("input")); }
  }
};

function renderRuleTab() {
  $("disputeForm").hidden = !isPlayer();
  $("viewerNote").hidden = isPlayer();
  const play = S.guide.play;
  $("ctxNote").hidden = !(play && !play.done);

  const box = $("disputes"); box.replaceChildren();
  if (!S.disputes.length) {
    box.append(el("p", "muted", t.noDisputes));
    return;
  }
  for (const d of S.disputes) box.append(disputeCard(d));
}

function disputeCard(d) {
  const c = el("section", "card");
  const head = el("div", "dispute-head");
  head.append(avatar(d.byName, d.byColor));
  head.append(el("div", "grow", fmt(d.mode === "duel" ? t.raisedDispute : t.askedQuestion, { name: d.byName })));
  c.append(head);

  const cl = el("div", "claims");
  const line = (label, text) => { const x = el("div"); x.append(el("b", null, label), document.createTextNode(text)); return x; };
  if (d.mode === "duel") cl.append(line(t.claimLabelA, d.a), line(t.claimLabelB, d.b));
  else cl.append(line(t.claimLabelQ, d.q));
  c.append(cl);

  if (d.status === "pending") {
    const p = el("div", "pending");
    p.append(el("span", "spin"), el("span", null, t.pendingRuling));
    c.append(p);
    return c;
  }
  if (d.status === "error") {
    const e = el("div", "err", d.error || t.rulingFailed); e.style.marginTop = "8px"; c.append(e);
    if (isPlayer()) {
      const b = el("button", "btn sm", t.retry); b.style.marginTop = "8px";
      b.onclick = () => send({ type: "dispute", mode: d.mode, a: d.a, b: d.b, q: d.q });
      c.append(b);
    }
    return c;
  }
  const r = d.result;
  c.classList.add("verdict"); c.dataset.kind = r.kind;
  const body = el("div"); body.style.marginTop = "10px";
  renderVerdict(body, r, d.mode, {}, t);
  c.append(body);

  if (["explicit", "inferred"].includes(r.kind)) c.append(ackRow(d));
  const rejected = r.kind === "explicit" && d.ack.disagree * 2 > d.ack.eligible;
  if (["not_covered", "conflict"].includes(r.kind) || rejected) c.append(d.vote ? voteBox(d.vote, false) : proposeBox(d));
  return c;
}

function ackRow(d) {
  const r = d.result, a = d.ack;
  const box = el("div"); box.style.marginTop = "10px";
  if (r.kind === "inferred") {
    const passed = a.agree * 2 > a.eligible;
    box.append(el("div", passed ? "ck y" : "muted small", passed ? t.ackPassed : fmt(t.ackProgress, { a: a.agree, e: a.eligible })));
    const bar = el("div", "bar"); const i = el("i"); i.style.width = `${Math.min(100, (a.agree / a.eligible) * 100)}%`; bar.append(i); box.append(bar);
    if (isPlayer()) {
      const row = el("div", "row"); row.style.marginTop = "8px";
      const y = el("button", "btn sm" + (a.mine === true ? " on" : ""), t.agree);
      y.onclick = () => send({ type: "ack", id: d.id, agree: true });
      const n = el("button", "btn sm" + (a.mine === false ? " on" : ""), t.disagree);
      n.onclick = () => send({ type: "ack", id: d.id, agree: false });
      row.append(y, n); box.append(row);
    }
  } else if (a.disagree * 2 > a.eligible) {
    box.append(el("div", "warnbox small", t.rejectedNote));
  } else if (isPlayer()) {
    const row = el("div", "row");
    const n = el("button", "btn sm" + (a.mine === false ? " on" : ""), a.mine === false ? t.disagreed : t.disagreeBtn);
    n.onclick = () => send({ type: "ack", id: d.id, agree: a.mine === false });
    row.append(n);
    if (a.disagree) row.append(el("span", "muted small", fmt(t.disagreeCount, { n: a.disagree })));
    box.append(row);
  }
  return box;
}

function proposeBox(d) {
  const box = el("div", "vote");
  const opts = d.result.house_rule_options || [];
  box.append(el("div", "subh", d.result.kind === "conflict" ? t.proposeConflict : t.proposeGap));
  for (const o of opts) {
    const r = el("div", "opt");
    r.append(el("p", null, o.text), el("small", null, fmt(t.effect, { e: o.effect || "" })));
    box.append(r);
  }
  if (isPlayer()) {
    const inp = el("input"); inp.type = "text"; inp.maxLength = 120; inp.placeholder = t.customPh;
    inp.value = drafts[d.id] || ""; inp.oninput = () => (drafts[d.id] = inp.value); inp.style.marginTop = "8px";
    const b = el("button", "btn acc block", t.startVote); b.style.marginTop = "8px";
    b.onclick = () => {
      if (!opts.length && !inp.value.trim()) return toast(t.needRuleText);
      if (send({ type: "vote_open", disputeId: d.id, custom: inp.value })) drafts[d.id] = "";
    };
    box.append(inp, b);
  }
  return box;
}

function voteBox(v, showTitle) {
  const box = el("div", "vote");
  const open = v.status === "open";
  if (showTitle) box.append(el("div", null, v.title));
  box.append(el("div", "subh", open ? fmt(t.voteHeadOpen, { v: v.voted, e: v.eligible }) : t.voteHeadClosed));
  v.options.forEach((text, i) => {
    const b = el("button", "vopt" + (v.mine === i ? " mine" : "") + (!open && v.winner === i ? " win" : ""));
    b.type = "button";
    b.append(el("span", "grow", text));
    if (!open && v.tally) b.append(el("span", "tally", fmt(t.voteTally, { n: v.tally[i] })));
    else if (v.mine === i) b.append(el("span", "tally", t.voteMine));
    b.disabled = !open || !v.canVote;
    b.onclick = () => send({ type: "vote_cast", voteId: v.id, choice: i });
    box.append(b);
  });
  if (open && !v.canVote) box.append(el("p", "muted small", t.voteLate));
  if (open && (isHost() || v.byMe)) {
    const c = el("button", "btn sm", t.voteCloseEarly); c.style.marginTop = "8px";
    c.onclick = () => send({ type: "vote_close", voteId: v.id });
    box.append(c);
  }
  if (!open) {
    const msg = v.ruleId ? fmt(t.votePassed, { id: v.ruleId }) : v.winner === v.reject ? t.voteKept : t.voteTie;
    box.append(el("p", v.ruleId ? "ck y" : "muted small", msg));
  }
  return box;
}

// ---------- 私下問 ----------
function renderChat() {
  const box = $("chat"); box.replaceChildren();
  if (!chat.length && !pendingPriv) box.append(el("p", "muted", t.privEmpty));
  for (const x of chat) {
    if (x.role === "me") { box.append(el("div", "bub me", x.q)); continue; }
    const b = el("div", "bub bot");
    if (x.error || !x.data) { b.append(el("div", "err", x.error || t.noAnswer)); box.append(b); continue; }
    b.append(el("span", "priv", t.privBadge));
    const inner = el("div"); inner.style.marginTop = "6px";
    renderVerdict(inner, x.data, "ask", { hideChecks: true, source: false }, t);
    b.append(inner);
    if (isPlayer()) {
      const row = el("div", "row"); row.style.marginTop = "8px";
      const pub = el("button", "btn sm", t.publish);
      pub.onclick = () => { if (send({ type: "dispute", mode: "ask", q: x.q })) { switchTab("rule"); toast(t.published); } };
      const dis = el("button", "btn sm warn", t.thisDisputed);
      dis.onclick = () => { setMode("ask"); $("q").value = x.q; $("q").dispatchEvent(new Event("input")); switchTab("rule"); $("q").focus(); };
      row.append(pub, dis); b.append(row);
    }
    box.append(b);
  }
  if (pendingPriv) {
    box.append(el("div", "bub me", pendingPriv.q));
    const p = el("div", "bub bot"); const r = el("div", "pending"); r.append(el("span", "spin"), el("span", null, t.thinking)); p.append(r); box.append(p);
  }
}

$("psend").onclick = () => {
  const q = $("pq").value.trim();
  if (!q) return;
  if (pendingPriv) return toast(t.privBusy);
  const id = Date.now();
  const history = chat.filter((x) => x.role === "bot" && x.data).slice(-6).map((x) => ({ q: x.q, a: x.data.result }));
  if (!send({ type: "private", id, q, history })) return;
  pendingPriv = { id, q };
  $("pq").value = ""; $("pq").dispatchEvent(new Event("input"));
  renderChat();
};
$("pq").addEventListener("keydown", (e) => { if (e.key === "Enter") $("psend").click(); });
$("privClear").onclick = () => { chat = []; store(privKey, chat); renderChat(); };

function onPrivate(m) {
  if (!pendingPriv || m.id !== pendingPriv.id) return;
  chat.push({ role: "me", q: pendingPriv.q }, { role: "bot", q: pendingPriv.q, data: m.data, error: m.error });
  chat = chat.slice(-30);
  store(privKey, chat);
  pendingPriv = null;
  renderChat();
}

// ---------- 流程分頁 ----------
function renderGuide() {
  const g = S.guide, box = $("guide"); box.replaceChildren();
  if (g.generating) {
    const c = el("section", "card"); const p = el("div", "pending");
    p.append(el("span", "spin"), el("span", null, t.graphGenerating));
    c.append(el("h3", null, t.turnMap), p); box.append(c);
    return;
  }
  if (!g.graph) {
    const c = el("section", "card");
    c.append(el("h3", null, t.guideIntroTitle));
    c.append(el("p", "muted", t.guideIntro));
    if (g.error) c.append(el("div", "err", g.error));
    if (isHost()) {
      const b = el("button", "btn pri block", t.genGraph); b.style.marginTop = "10px";
      b.onclick = () => send({ type: "guide_generate" });
      c.append(b);
    } else c.append(el("p", "muted", t.waitHostGraph));
    box.append(c);
    return;
  }
  if (g.play) box.append(playCard(g));

  const ctl = el("section", "card");
  if (!g.confirmed) {
    ctl.append(el("h3", null, t.draftTitle));
    ctl.append(el("div", "warnbox small", t.draftNote));
    if (isHost()) {
      const row = el("div", "row"); row.style.marginTop = "10px";
      const ok = el("button", "btn pri", t.confirmGraph); ok.onclick = () => send({ type: "guide_confirm" });
      const re = el("button", "btn", t.regenerate); re.onclick = () => send({ type: "guide_generate" });
      row.append(ok, re); ctl.append(row);
    }
  } else if (!g.play) {
    ctl.append(el("h3", null, t.firstRoundTitle));
    ctl.append(el("p", "muted", t.firstRoundIntro));
    const strip = el("div", "avs"); S.seats.forEach((s) => strip.append(avatar(s.name, s.color))); ctl.append(strip);
    if (isHost()) {
      const row = el("div", "row"); row.style.marginTop = "10px";
      const st = el("button", "btn pri", t.startFirst); st.onclick = () => send({ type: "guide_start" });
      const re = el("button", "btn sm", t.regenMap); re.onclick = () => send({ type: "guide_generate" });
      row.append(st, re); ctl.append(row);
    } else ctl.append(el("p", "muted", t.waitHostStart));
  } else if (isHost()) {
    const e = el("button", "btn sm", t.endGuide); e.onclick = () => send({ type: "guide_end" });
    ctl.append(e);
  }
  if (ctl.childNodes.length) box.append(ctl);
  box.append(setupCard(g.graph));
  box.append(mapCard(g.graph, g.play));
}

function playCard(g) {
  const p = g.play, graph = g.graph;
  const c = el("section", "card stack");
  if (p.done) {
    c.append(el("div", "big", t.allDone));
    c.append(el("div", "subh", t.walked));
    for (const st of graph.steps) {
      const r = el("div", "cov"); const dot = el("i"); const seen = (p.visits[st.id] || 0) > 0;
      dot.style.background = seen ? "var(--ok)" : "#d0d5da";
      r.append(dot, el("span", seen ? null : "muted", seen ? st.text : fmt(t.notYet, { t: st.text })));
      c.append(r);
    }
    c.append(el("p", "muted small", t.afterNote));
    if (isHost()) {
      const row = el("div", "row");
      const again = el("button", "btn", t.again); again.onclick = () => send({ type: "guide_start" });
      const end = el("button", "btn pri", t.continueGame); end.onclick = () => send({ type: "guide_end" });
      row.append(again, end); c.append(row);
    }
    return c;
  }
  const st = graph.steps.find((s) => s.id === p.stepId);
  const cur = p.seats[p.seatIdx];
  const turn = el("div", "turn");
  turn.append(avatar(cur.name, cur.color));
  const tx = el("div"); tx.append(el("b", null, fmt(t.turnOf, { name: cur.name })), el("div", "small", fmt(t.seatLine, { i: p.seatIdx + 1, n: p.seats.length })));
  turn.append(tx); c.append(turn);
  if (!st) { c.append(el("div", "err", t.stepMissing)); return c; }

  c.append(el("div", "big", st.text));
  if (st.inferred) c.append(el("div", "warnbox small", t.inferredStep));
  const qs = quotesOf(st.cites);
  if (qs.length && p.firstTime) {
    c.append(el("div", "note", t.firstTimeNote));
    quoteRows(c, qs);
  } else if (qs.length) {
    const det = el("details"); det.append(el("summary", "muted small", t.seeBasis));
    quoteRows(det, qs); c.append(det);
  }

  if (isPlayer()) {
    const hasDice = st.next.some((b) => b.dice && b.dice.length);
    if (hasDice) {
      const db = el("button", "btn block", fmt(t.rollN, { n: S.diceCount }));
      db.onclick = () => send({ type: "roll", count: S.diceCount });
      c.append(db);
      if (p.lastRoll && p.suggested != null) {
        const a = el("div", "auto");
        a.append(el("b", null, fmt(t.rolled, { v: p.lastRoll.values.join("＋"), t: p.lastRoll.total })), el("span", null, fmt(t.autoPicked, { l: st.next[p.suggested].label })));
        c.append(a);
      }
    }
    if (st.next.length) {
      const grid = el("div", "grid2");
      st.next.forEach((b, i) => {
        const btn = el("button", "branch" + (p.suggested === i ? " sug" : ""), b.label);
        btn.type = "button";
        btn.onclick = () => send({ type: "guide_step", seq: p.seq, branch: i });
        grid.append(btn);
      });
      c.append(grid);
    } else {
      const last = p.seatIdx + 1 >= p.seats.length;
      const btn = el("button", "btn pri block", last ? t.endTurnLast : t.endTurnNext);
      btn.onclick = () => send({ type: "guide_step", seq: p.seq });
      c.append(btn);
    }
  }

  const det = el("details"); det.append(el("summary", null, t.whatCanIDo));
  if (!st.next.length) det.append(el("p", "muted", t.endOfStep));
  for (const b of st.next) {
    const target = graph.steps.find((s) => s.id === b.to);
    const r = el("div", "opt");
    r.append(el("p", null, b.label), el("small", null, fmt(t.nextIs, { t: target?.text || b.to })));
    if (target) quoteRows(r, quotesOf(target.cites));
    det.append(r);
  }
  c.append(det);

  const q = el("div", "row");
  const pb = el("button", "btn sm", t.askPrivately);
  pb.onclick = () => { $("pq").value = fmt(t.stepPrefix, { t: st.text }); $("pq").dispatchEvent(new Event("input")); switchTab("private"); $("pq").focus(); };
  const db2 = el("button", "btn sm warn", t.thisDisputed);
  db2.onclick = () => { setMode("ask"); $("q").value = fmt(t.stepPrefix, { t: st.text }); $("q").dispatchEvent(new Event("input")); switchTab("rule"); $("q").focus(); };
  q.append(pb, db2); c.append(q);

  const strip = el("div", "avs");
  p.seats.forEach((s, i) => strip.append(avatar(s.name, s.color, { off: i !== p.seatIdx })));
  c.append(strip);
  return c;
}

function setupCard(graph) {
  const c = el("section", "card");
  c.append(el("h3", null, t.setupTitle));
  if (!graph.setup.length) { c.append(el("p", "muted", t.noSetup)); return c; }
  const done = store(setupKey) || {};
  for (const s of graph.setup) {
    const row = el("label", "chk");
    const cb = el("input"); cb.type = "checkbox"; cb.checked = !!done[s.id];
    cb.onchange = () => { const d = store(setupKey) || {}; d[s.id] = cb.checked; store(setupKey, d); };
    const body = el("span", "grow"); body.append(el("span", null, s.text));
    if (s.cites.length) { body.append(document.createTextNode(" ")); s.cites.forEach((id) => body.append(el("span", "cid", id), document.createTextNode(" "))); }
    row.append(cb, body); c.append(row);
  }
  c.append(el("p", "muted small", t.setupLocal));
  return c;
}

function mapCard(graph, play) {
  const c = el("section", "card stack");
  c.append(el("h3", null, t.mapTitle));
  const byId = new Map(graph.steps.map((s) => [s.id, s]));
  for (const st of graph.steps) {
    const box = el("div", "step" + (st.inferred ? " inf" : "") + (st.end_turn ? " end" : ""));
    if (play && !play.done && play.stepId === st.id) box.style.boxShadow = "0 0 0 3px var(--acc)";
    const h = el("div"); h.append(el("span", "sid", st.id + (st.id === graph.start ? t.startTag : "")), document.createTextNode(" "), el("b", null, st.text));
    if (st.inferred) h.append(el("span", "badge inf", t.inferredTag));
    if (st.end_turn) h.append(el("span", "badge end", t.endTurnTag));
    box.append(h);
    const qs = quotesOf(st.cites);
    if (qs.length) { const det = el("details"); det.append(el("summary", "muted small", fmt(t.basisOf, { c: st.cites.join(t.listSep) }))); quoteRows(det, qs); box.append(det); }
    for (const b of st.next) {
      const target = byId.get(b.to);
      const dice = b.dice?.length ? fmt(t.diceTag, { d: b.dice.join(t.listSep) }) : "";
      box.append(el("div", "br", `→ ${b.label}${dice}：${target ? target.text : b.to}`));
    }
    c.append(box);
  }
  if (graph.end) {
    const e = el("div", "note"); e.append(el("b", null, t.gameEnd), document.createTextNode(graph.end.text));
    c.append(e);
    quoteRows(c, quotesOf(graph.end.cites));
  }
  return c;
}

// ---------- 工具分頁 ----------
$("dseg").addEventListener("click", (e) => { const n = Number(e.target.dataset?.n); if (n) send({ type: "dice_count", count: n }); });
$("roll").onclick = () => send({ type: "roll", count: S?.diceCount || 1 });
$("shuffle").onclick = () => send({ type: "seats_random" });

function renderTools() {
  [...$("dseg").children].forEach((b) => b.classList.toggle("on", Number(b.dataset.n) === S.diceCount));
  $("roll").disabled = !isPlayer();
  const out = $("diceOut"); out.replaceChildren();
  const last = S.dice[0];
  if (last) {
    out.append(el("div", "muted small", fmt(t.rolledBy, { name: last.byName })));
    const key = JSON.stringify(last);
    const fresh = lastRollKey !== null && key !== lastRollKey;
    lastRollKey = key;
    const d = el("div", "dice"); last.values.forEach((v) => d.append(die(v, fresh))); out.append(d);
    out.append(el("div", "total", String(last.total)));
  } else { lastRollKey = ""; out.append(el("p", "muted", t.noRolls)); }
  const hist = $("diceHist"); hist.replaceChildren();
  S.dice.slice(1).forEach((x) => hist.append(el("span", "chip", `${x.byName} ${x.values.join("＋")}`)));

  const hints = $("hints"); hints.replaceChildren();
  if (S.startHints.length) { hints.append(el("div", "subh", t.rulebookSays)); quoteRows(hints, S.startHints); }

  const playing = S.guide.play && !S.guide.play.done;
  const players = S.players.filter((p) => p.role === "player");
  const order = [...S.seats.map((s) => s.device).filter((dv) => players.some((p) => p.device === dv)), ...players.map((p) => p.device).filter((dv) => !S.seats.some((s) => s.device === dv))];
  const byDev = new Map(players.map((p) => [p.device, p]));
  const box = $("seats"); box.replaceChildren();
  order.forEach((dv, i) => {
    const p = byDev.get(dv); if (!p) return;
    const r = el("div", "seat");
    r.append(el("span", "n", String(i + 1)), avatar(p.name, p.color), el("span", "grow", p.name + (dv === device ? t.you : "")));
    if (isHost() && !playing) {
      const up = el("button", "btn sm", "↑"); up.disabled = i === 0; up.setAttribute("aria-label", `↑ ${p.name}`);
      up.onclick = () => { const o = [...order]; [o[i - 1], o[i]] = [o[i], o[i - 1]]; send({ type: "seats_set", order: o }); };
      const dn = el("button", "btn sm", "↓"); dn.disabled = i === order.length - 1; dn.setAttribute("aria-label", `↓ ${p.name}`);
      dn.onclick = () => { const o = [...order]; [o[i + 1], o[i]] = [o[i], o[i + 1]]; send({ type: "seats_set", order: o }); };
      r.append(up, dn);
    }
    box.append(r);
  });
  $("seatCtl").hidden = !isHost();
  $("shuffle").disabled = !!playing;
}

// ---------- 房規分頁 ----------
$("hpropBtn").onclick = () => {
  const text = $("hprop").value.trim();
  if (!text) return toast(t.needRuleText);
  if (send({ type: "vote_open", custom: text })) $("hprop").value = "";
};
$("copyHouse").onclick = () => {
  if (!S?.house.length) return toast(t.noHouseToast);
  copyText(fmt(t.houseCopyHead, { title: S.title }) + "\n" + S.house.map((h) => `${h.hid} ${h.text}`).join("\n"), t);
};
$("srcBtn").onclick = () => {
  const text = $("srcText").value.trim();
  if (!text) return toast(t.needPaste);
  if (send({ type: "source_add", text })) $("srcText").value = "";
};
$("closeRoom").onclick = () => { $("closeConfirm").hidden = false; $("closeRoom").hidden = true; };
$("closeNo").onclick = () => { $("closeConfirm").hidden = true; $("closeRoom").hidden = false; };
$("closeYes").onclick = () => send({ type: "close_room" });
$("codeChip").onclick = () => copyText(`${location.origin}/room.html?c=${code}`, t);

function renderHouse() {
  const box = $("house"); box.replaceChildren();
  if (!S.house.length) box.append(el("p", "muted", t.noHouse));
  for (const h of S.house) {
    const r = el("div", "hrow");
    r.append(el("span", "cid h", h.hid));
    const b = el("div", "grow"); b.append(el("div", null, h.text), el("div", "muted small", fmt(t.houseMeta, { o: h.origin, t: h.tally })));
    r.append(b);
    if (isHost()) { const del = el("button", "btn sm", t.del); del.onclick = () => send({ type: "house_delete", hid: h.hid }); r.append(del); }
    box.append(r);
  }
  $("hprop").disabled = !isPlayer(); $("hpropBtn").disabled = !isPlayer();
  const vb = $("votes"); vb.replaceChildren();
  for (const v of S.votes) vb.append(voteBox(v, true));

  $("rbSummary").textContent = fmt(t.rulebookAll, { n: S.sentences.length });
  const rb = $("rulebook"); rb.replaceChildren(); quoteRows(rb, S.sentences);
  $("sourceCard").hidden = !isHost();
  $("roomLang").textContent = fmt(t.roomLangNote, { l: t.langName[S.lang] || t.langName["zh-Hant"] });

  const pl = $("players"); pl.replaceChildren();
  for (const p of S.players) {
    const r = el("div", "row");
    r.append(avatar(p.name, p.color, { off: !p.online, dot: p.online }), el("span", "grow", p.name + (p.device === device ? t.you : "")));
    r.append(el("span", "muted small", [p.isHost ? t.host : p.role === "viewer" ? t.roleViewer : t.rolePlayer, p.online ? t.online : t.offline].join(" · ")));
    pl.append(r);
  }
  const locale = lang === "en" ? "en-US" : lang === "zh-Hans" ? "zh-CN" : "zh-TW";
  $("expiry").textContent = fmt(t.expiry, { t: new Date(S.expiresAt).toLocaleString(locale, { hour12: false }) });
  $("closeBox").hidden = !isHost();
}

// ---------- 啟動 ----------
async function boot() {
  applyLang(lang);
  if (!/^[A-Z0-9]{6}$/.test(code)) return fatal("badCode");
  $("code").textContent = code;
  try {
    const r = await fetch(`/api/rooms/${code}?lang=${lang}`);
    if (!r.ok) return fatal("roomGone");
    info = await r.json();
  } catch {
    return fatal("netLater");
  }
  $("title").textContent = info.title;
  if (store("name")) { connect(); return; }

  $("joinInfo").textContent = fmt(t.joinInfo, { title: info.title, n: info.players });
  $("joinCard").hidden = false;
  $("roleSeg").addEventListener("click", (e) => {
    const v = e.target.dataset?.v; if (!v) return;
    joinRole = v;
    [...$("roleSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  });
  [...$("roleSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.v === joinRole));
  $("joinBtn").onclick = () => {
    const n = $("jname").value.trim();
    if (!n) return toast(t.errName);
    store("name", n);
    $("joinCard").hidden = true;
    connect();
  };
}

boot();
