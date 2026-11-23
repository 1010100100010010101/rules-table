import { $, el, avatar, toast, quoteRows, renderVerdict, store, deviceId, copyText, wireCounter, COLORS } from "/assets/common.js";

const params = new URLSearchParams(location.search);
const code = (params.get("c") || "").toUpperCase();
const device = deviceId();
const privKey = `priv:${code}`;
const setupKey = `setup:${code}`;
const DICE = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

let S = null;            // 伺服器送來的最新房間狀態
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
  toast("連線中斷，正在重新連線⋯");
  return false;
}
function setConn(on) { $("conn").classList.toggle("off", !on); }

function fatal(msg) {
  const f = $("fatal");
  f.replaceChildren(el("h2", null, "沒辦法進入房間"), el("p", "muted", msg));
  const a = el("a", "btn", "回首頁"); a.href = "/"; f.append(a);
  f.hidden = false;
  $("tabs").hidden = true;
  $("joinCard").hidden = true;
  document.querySelectorAll("[id^=tab-]").forEach((t) => (t.hidden = true));
}

// ---------- 分頁 ----------
function switchTab(t) {
  tab = t;
  store(`tab:${code}`, t);
  document.querySelectorAll("[id^=tab-]").forEach((x) => (x.hidden = x.id !== `tab-${t}`));
  [...$("tabs").querySelectorAll("button")].forEach((b) => b.classList.toggle("on", b.dataset.t === t));
  window.scrollTo({ top: 0 });
}
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b?.dataset.t) switchTab(b.dataset.t);
});

// ---------- 連線 ----------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ device, name: store("name") || "", color: myColor(), role: joinRole });
  ws = new WebSocket(`${proto}://${location.host}/api/rooms/${code}/ws?${q}`);
  ws.onopen = () => { retry = 0; setConn(true); ws.send(JSON.stringify({ type: "sync" })); };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onMessage(m);
  };
  ws.onclose = () => {
    setConn(false);
    if (pendingPriv) { pendingPriv = null; renderChat(); toast("連線中斷，私下問的那一題請再送一次"); }
    if (closedByServer) return;
    if (!S && retry >= 2) { fatal("無法連線到房間。房間可能已過期，或已滿（最多 12 人）。"); return; }
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
  else if (m.type === "closed") { closedByServer = true; fatal("房主已結束這個房間，或房間已過期。"); }
}

// ---------- 全部重畫 ----------
function renderAll() {
  if (!S) return;
  $("joinCard").hidden = true;
  $("tabs").hidden = false;
  $("title").textContent = S.title;
  document.title = `${S.title}｜規則仲裁桌`;
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
    a.title = `${p.name}${p.isHost ? "（房主）" : ""}${p.role === "viewer" ? "（只看）" : ""}${p.device === device ? "（你）" : ""}`;
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
  if (mode === "duel" && (!body.a || !body.b)) return toast("兩方的主張都要填");
  if (mode === "ask" && !body.q) return toast("問題不能空白");
  if (send(body)) {
    for (const id of ["a", "b", "q"]) { $(id).value = ""; $(id).dispatchEvent(new Event("input")); }
  }
};

function renderRuleTab() {
  $("disputeForm").hidden = !isPlayer();
  $("viewerNote").hidden = isPlayer();
  const play = S.guide.play;
  $("ctxNote").hidden = !(play && !play.done);
  $("ctxNote").textContent = "第一回合進行中：目前的步驟會一起交給 AI，讓它知道你們卡在哪裡。";

  const box = $("disputes"); box.replaceChildren();
  if (!S.disputes.length) {
    box.append(el("p", "muted", "還沒有爭議。兩方各寫一句主張，或直接問一個規則問題。"));
    return;
  }
  for (const d of S.disputes) box.append(disputeCard(d));
}

function disputeCard(d) {
  const c = el("section", "card");
  const head = el("div", "dispute-head");
  head.append(avatar(d.byName, d.byColor));
  const hb = el("div", "grow");
  hb.append(el("div", null, `${d.byName}${d.mode === "duel" ? " 提出爭議" : " 提問"}`));
  head.append(hb);
  c.append(head);

  const cl = el("div", "claims");
  const line = (label, text) => { const x = el("div"); x.append(el("b", null, label), document.createTextNode(text)); return x; };
  if (d.mode === "duel") cl.append(line("A：", d.a), line("B：", d.b));
  else cl.append(line("問：", d.q));
  c.append(cl);

  if (d.status === "pending") {
    const p = el("div", "pending");
    p.append(el("span", "spin"), el("span", null, "裁定中⋯ 全桌都會看到結果"));
    c.append(p);
    return c;
  }
  if (d.status === "error") {
    const e = el("div", "err", d.error || "裁定失敗"); e.style.marginTop = "8px"; c.append(e);
    if (isPlayer()) {
      const b = el("button", "btn sm", "再試一次"); b.style.marginTop = "8px";
      b.onclick = () => send({ type: "dispute", mode: d.mode, a: d.a, b: d.b, q: d.q });
      c.append(b);
    }
    return c;
  }
  const r = d.result;
  const body = el("div"); body.style.marginTop = "10px";
  renderVerdict(body, r, d.mode);
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
    box.append(el("div", passed ? "ck y" : "muted small", passed ? "✓ 全桌過半同意，已生效" : `同意 ${a.agree} / ${a.eligible} 人，過半才生效`));
    const bar = el("div", "bar"); const i = el("i"); i.style.width = `${Math.min(100, (a.agree / a.eligible) * 100)}%`; bar.append(i); box.append(bar);
    if (isPlayer()) {
      const row = el("div", "row"); row.style.marginTop = "8px";
      const y = el("button", "btn sm" + (a.mine === true ? " on" : ""), "同意");
      y.onclick = () => send({ type: "ack", id: d.id, agree: true });
      const n = el("button", "btn sm" + (a.mine === false ? " on" : ""), "不同意");
      n.onclick = () => send({ type: "ack", id: d.id, agree: false });
      row.append(y, n); box.append(row);
    }
  } else if (a.disagree * 2 > a.eligible) {
    box.append(el("div", "warnbox small", "全桌多數不同意這次裁定，所以這次不算。可以在下面投票，定成這一桌的房規。"));
  } else if (isPlayer()) {
    const row = el("div", "row");
    const n = el("button", "btn sm" + (a.mine === false ? " on" : ""), a.mine === false ? "已表示不同意（再按收回）" : "不同意這個裁定");
    n.onclick = () => send({ type: "ack", id: d.id, agree: a.mine === false });
    row.append(n);
    if (a.disagree) row.append(el("span", "muted small", `${a.disagree} 人不同意；過半不同意就不算`));
    box.append(row);
  }
  return box;
}

function proposeBox(d) {
  const box = el("div", "vote");
  const opts = d.result.house_rule_options || [];
  box.append(el("div", "subh", d.result.kind === "conflict" ? "兩種讀法，全桌投票選一種（AI 建議，不是規則）" : "可以定成這一桌的房規（AI 建議，不是規則）"));
  for (const o of opts) {
    const r = el("div", "opt");
    r.append(el("p", null, o.text), el("small", null, "影響：" + (o.effect || "")));
    box.append(r);
  }
  if (isPlayer()) {
    const inp = el("input"); inp.type = "text"; inp.maxLength = 120; inp.placeholder = "也可以自己寫一個（選填）";
    inp.value = drafts[d.id] || ""; inp.oninput = () => (drafts[d.id] = inp.value); inp.style.marginTop = "8px";
    const b = el("button", "btn acc block", "發起房規投票"); b.style.marginTop = "8px";
    b.onclick = () => {
      if (!opts.length && !inp.value.trim()) return toast("請先寫一個房規內容");
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
  box.append(el("div", "subh", open ? `房規投票中．已投 ${v.voted} / ${v.eligible} 人（開票前看不到別人投什麼）` : "投票結果"));
  v.options.forEach((t, i) => {
    const b = el("button", "vopt" + (v.mine === i ? " mine" : "") + (!open && v.winner === i ? " win" : ""));
    b.type = "button";
    b.append(el("span", "grow", t));
    if (!open && v.tally) b.append(el("span", "tally", `${v.tally[i]} 票`));
    else if (v.mine === i) b.append(el("span", "tally", "你的選擇"));
    b.disabled = !open || !v.canVote;
    b.onclick = () => send({ type: "vote_cast", voteId: v.id, choice: i });
    box.append(b);
  });
  if (open && !v.canVote) box.append(el("p", "muted small", "你在投票開始後才加入，這一票不能投。"));
  if (open && (isHost() || v.byMe)) {
    const c = el("button", "btn sm", "提前開票"); c.style.marginTop = "8px";
    c.onclick = () => send({ type: "vote_close", voteId: v.id });
    box.append(c);
  }
  if (!open) {
    const msg = v.ruleId ? `✓ 通過，已寫入房規 ${v.ruleId}` : v.winner === v.reject ? "多數選擇維持現狀，沒有新增房規" : "平手或沒人投票，沒有新增房規";
    const p = el("p", v.ruleId ? "ck y" : "muted small", msg); box.append(p);
  }
  return box;
}

// ---------- 私下問 ----------
function renderChat() {
  const box = $("chat"); box.replaceChildren();
  if (!chat.length && !pendingPriv) box.append(el("p", "muted", "例如：「停在別人的攤位但錢不夠怎麼辦？」不會打擾其他人。"));
  for (const x of chat) {
    if (x.role === "me") { box.append(el("div", "bub me", x.q)); continue; }
    const b = el("div", "bub bot");
    if (x.error) { b.append(el("div", "err", x.error)); box.append(b); continue; }
    b.append(el("span", "priv", "私下參考，不是全桌裁定"));
    const inner = el("div"); inner.style.marginTop = "6px";
    renderVerdict(inner, x.data, "ask", { hideChecks: true, source: false });
    b.append(inner);
    if (isPlayer()) {
      const row = el("div", "row"); row.style.marginTop = "8px";
      const pub = el("button", "btn sm", "公開給全桌");
      pub.onclick = () => { if (send({ type: "dispute", mode: "ask", q: x.q })) { switchTab("rule"); toast("已送到全桌，等待裁定"); } };
      const dis = el("button", "btn sm warn", "這裡有爭議");
      dis.onclick = () => { setMode("ask"); $("q").value = x.q; $("q").dispatchEvent(new Event("input")); switchTab("rule"); $("q").focus(); };
      row.append(pub, dis); b.append(row);
    }
    box.append(b);
  }
  if (pendingPriv) {
    box.append(el("div", "bub me", pendingPriv.q));
    const p = el("div", "bub bot"); const r = el("div", "pending"); r.append(el("span", "spin"), el("span", null, "思考中⋯")); p.append(r); box.append(p);
  }
}

$("psend").onclick = () => {
  const q = $("pq").value.trim();
  if (!q) return;
  if (pendingPriv) return toast("上一題還在回答中");
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
    p.append(el("span", "spin"), el("span", null, "AI 正在讀規則書，整理回合地圖⋯（約 30–90 秒）"));
    c.append(el("h3", null, "回合地圖"), p); box.append(c);
    return;
  }
  if (!g.graph) {
    const c = el("section", "card");
    c.append(el("h3", null, "讀完規則還是不懂怎麼玩？"));
    c.append(el("p", "muted", "AI 會把規則書整理成「輪到你時依序做什麼」的回合地圖，每一步都附規則原句。房主確認後，可以用第一回合模式一步一步帶大家玩。"));
    if (g.error) c.append(el("div", "err", g.error));
    if (isHost()) {
      const b = el("button", "btn pri block", "產生回合地圖"); b.style.marginTop = "10px";
      b.onclick = () => send({ type: "guide_generate" });
      c.append(b);
    } else c.append(el("p", "muted", "等房主產生回合地圖。"));
    box.append(c);
    return;
  }
  if (g.play) box.append(playCard(g));

  const ctl = el("section", "card");
  if (!g.confirmed) {
    ctl.append(el("h3", null, "回合地圖草稿"));
    ctl.append(el("div", "warnbox small", "這是 AI 整理的草稿，房主確認後才能開始第一回合。虛線框是規則書沒寫清楚、AI 推論的步驟。"));
    if (isHost()) {
      const row = el("div", "row"); row.style.marginTop = "10px";
      const ok = el("button", "btn pri", "確認回合地圖"); ok.onclick = () => send({ type: "guide_confirm" });
      const re = el("button", "btn", "重新產生"); re.onclick = () => send({ type: "guide_generate" });
      row.append(ok, re); ctl.append(row);
    }
  } else if (!g.play) {
    ctl.append(el("h3", null, "第一回合模式"));
    ctl.append(el("p", "muted", "從擺桌面開始，一步一步帶每位玩家走完一輪。擲骰點數會自動選好下一步。玩家順序在「工具」分頁調整。"));
    const strip = el("div", "avs"); S.seats.forEach((s) => strip.append(avatar(s.name, s.color))); ctl.append(strip);
    if (isHost()) {
      const row = el("div", "row"); row.style.marginTop = "10px";
      const st = el("button", "btn pri", "開始第一回合"); st.onclick = () => send({ type: "guide_start" });
      const re = el("button", "btn sm", "重新產生地圖"); re.onclick = () => send({ type: "guide_generate" });
      row.append(st, re); ctl.append(row);
    } else ctl.append(el("p", "muted", "等房主開始。"));
  } else if (isHost()) {
    const e = el("button", "btn sm", "結束陪玩"); e.onclick = () => send({ type: "guide_end" });
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
    c.append(el("div", "big", "每個人都走完一輪了 🎉"));
    c.append(el("div", "subh", "這一輪你們已經走過"));
    for (const st of graph.steps) {
      const r = el("div", "cov"); const dot = el("i"); const seen = (p.visits[st.id] || 0) > 0;
      dot.style.background = seen ? "var(--ok)" : "#d0d5da";
      r.append(dot, el("span", seen ? null : "muted", seen ? st.text : `還沒遇到：${st.text}`));
      c.append(r);
    }
    c.append(el("p", "muted small", "之後遇到沒走過的步驟，可以回到這裡看回合地圖，或直接問規則。"));
    if (isHost()) {
      const row = el("div", "row");
      const again = el("button", "btn", "再走一次"); again.onclick = () => send({ type: "guide_start" });
      const end = el("button", "btn pri", "繼續遊戲"); end.onclick = () => send({ type: "guide_end" });
      row.append(again, end); c.append(row);
    }
    return c;
  }
  const st = graph.steps.find((s) => s.id === p.stepId);
  const cur = p.seats[p.seatIdx];
  const turn = el("div", "turn");
  turn.append(avatar(cur.name, cur.color));
  const tx = el("div"); tx.append(el("b", null, `輪到 ${cur.name}`), el("div", "small", `第 ${p.seatIdx + 1} / ${p.seats.length} 位玩家`));
  turn.append(tx); c.append(turn);
  if (!st) { c.append(el("div", "err", "找不到目前的步驟")); return c; }

  c.append(el("div", "big", st.text));
  if (st.inferred) c.append(el("div", "warnbox small", "這一步是 AI 推論的（規則書沒寫清楚），有疑問可以按下方「這裡有爭議」。"));
  const qs = quotesOf(st.cites);
  if (qs.length && p.firstTime) {
    c.append(el("div", "note", "第一次遇到這一步，規則書這樣寫："));
    quoteRows(c, qs);
  } else if (qs.length) {
    const det = el("details"); det.append(el("summary", "muted small", "看依據"));
    quoteRows(det, qs); c.append(det);
  }

  if (isPlayer()) {
    const hasDice = st.next.some((b) => b.dice && b.dice.length);
    if (hasDice) {
      const db = el("button", "btn block", `🎲 擲 ${S.diceCount} 顆骰子`);
      db.onclick = () => send({ type: "roll", count: S.diceCount });
      c.append(db);
      if (p.lastRoll && p.suggested != null) {
        const a = el("div", "auto");
        a.append(el("b", null, `擲出 ${p.lastRoll.values.join("＋")}＝${p.lastRoll.total}`), el("span", null, `→ 自動選了「${st.next[p.suggested].label}」`));
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
      const btn = el("button", "btn pri block", last ? "回合結束，完成第一輪" : "回合結束，換下一位");
      btn.onclick = () => send({ type: "guide_step", seq: p.seq });
      c.append(btn);
    }
  }

  const det = el("details"); det.append(el("summary", null, "這一步我能做什麼？"));
  if (!st.next.length) det.append(el("p", "muted", "這一步做完就換下一位玩家。"));
  for (const b of st.next) {
    const t = graph.steps.find((s) => s.id === b.to);
    const r = el("div", "opt");
    r.append(el("p", null, b.label), el("small", null, "接下來：" + (t?.text || b.to)));
    if (t) quoteRows(r, quotesOf(t.cites));
    det.append(r);
  }
  c.append(det);

  const q = el("div", "row");
  const pb = el("button", "btn sm", "私下問規則");
  pb.onclick = () => { $("pq").value = `「${st.text}」這一步，`; $("pq").dispatchEvent(new Event("input")); switchTab("private"); $("pq").focus(); };
  const db2 = el("button", "btn sm warn", "這裡有爭議");
  db2.onclick = () => { setMode("ask"); $("q").value = `「${st.text}」這一步，`; $("q").dispatchEvent(new Event("input")); switchTab("rule"); $("q").focus(); };
  q.append(pb, db2); c.append(q);

  const strip = el("div", "avs");
  p.seats.forEach((s, i) => strip.append(avatar(s.name, s.color, { off: i !== p.seatIdx })));
  c.append(strip);
  return c;
}

function setupCard(graph) {
  const c = el("section", "card");
  c.append(el("h3", null, "開局準備"));
  if (!graph.setup.length) { c.append(el("p", "muted", "規則書沒有列出準備項目。")); return c; }
  const done = store(setupKey) || {};
  for (const s of graph.setup) {
    const row = el("label", "chk");
    const cb = el("input"); cb.type = "checkbox"; cb.checked = !!done[s.id];
    cb.onchange = () => { const d = store(setupKey) || {}; d[s.id] = cb.checked; store(setupKey, d); };
    const body = el("span", "grow"); body.append(el("span", null, s.text));
    if (s.cites.length) { body.append(document.createTextNode(" ")); s.cites.forEach((id) => body.append(el("span", "cid", id), document.createTextNode(" "))); }
    row.append(cb, body); c.append(row);
  }
  c.append(el("p", "muted small", "勾選只存在這支手機。"));
  return c;
}

function mapCard(graph, play) {
  const c = el("section", "card stack");
  c.append(el("h3", null, "回合地圖：輪到你時依序做什麼"));
  const byId = new Map(graph.steps.map((s) => [s.id, s]));
  for (const st of graph.steps) {
    const box = el("div", "step" + (st.inferred ? " inf" : "") + (st.end_turn ? " end" : ""));
    if (play && !play.done && play.stepId === st.id) box.style.boxShadow = "0 0 0 3px var(--acc)";
    const h = el("div"); h.append(el("span", "sid", st.id + (st.id === graph.start ? "．起點" : "")), document.createTextNode(" "), el("b", null, st.text));
    if (st.inferred) h.append(el("span", "badge inf", "推論"));
    if (st.end_turn) h.append(el("span", "badge end", "回合結束"));
    box.append(h);
    const qs = quotesOf(st.cites);
    if (qs.length) { const det = el("details"); det.append(el("summary", "muted small", `依據 ${st.cites.join("、")}`)); quoteRows(det, qs); box.append(det); }
    for (const b of st.next) {
      const t = byId.get(b.to);
      box.append(el("div", "br", `→ ${b.label}${b.dice?.length ? `（點數 ${b.dice.join("、")}）` : ""}：${t ? t.text : b.to}`));
    }
    c.append(box);
  }
  if (graph.end) {
    const e = el("div", "note"); e.append(el("b", null, "遊戲結束："), document.createTextNode(graph.end.text));
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
    out.append(el("div", "muted small", `${last.byName} 擲出`));
    const d = el("div", "dice"); last.values.forEach((v) => d.append(el("span", null, DICE[v - 1]))); out.append(d);
    out.append(el("div", "total", String(last.total)));
  } else out.append(el("p", "muted", "還沒有人擲骰。"));
  const hist = $("diceHist"); hist.replaceChildren();
  S.dice.slice(1).forEach((x) => hist.append(el("span", "chip", `${x.byName} ${x.values.join("＋")}`)));

  const hints = $("hints"); hints.replaceChildren();
  if (S.startHints.length) { hints.append(el("div", "subh", "規則書怎麼說")); quoteRows(hints, S.startHints); }

  const playing = S.guide.play && !S.guide.play.done;
  const players = S.players.filter((p) => p.role === "player");
  const order = [...S.seats.map((s) => s.device).filter((dv) => players.some((p) => p.device === dv)), ...players.map((p) => p.device).filter((dv) => !S.seats.some((s) => s.device === dv))];
  const byDev = new Map(players.map((p) => [p.device, p]));
  const box = $("seats"); box.replaceChildren();
  order.forEach((dv, i) => {
    const p = byDev.get(dv); if (!p) return;
    const r = el("div", "seat");
    r.append(el("span", "n", String(i + 1)), avatar(p.name, p.color), el("span", "grow", p.name + (dv === device ? "（你）" : "")));
    if (isHost() && !playing) {
      const up = el("button", "btn sm", "↑"); up.disabled = i === 0; up.setAttribute("aria-label", `把${p.name}往前移`);
      up.onclick = () => { const o = [...order]; [o[i - 1], o[i]] = [o[i], o[i - 1]]; send({ type: "seats_set", order: o }); };
      const dn = el("button", "btn sm", "↓"); dn.disabled = i === order.length - 1; dn.setAttribute("aria-label", `把${p.name}往後移`);
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
  const t = $("hprop").value.trim();
  if (!t) return toast("請先寫房規內容");
  if (send({ type: "vote_open", custom: t })) $("hprop").value = "";
};
$("copyHouse").onclick = () => {
  if (!S?.house.length) return toast("還沒有房規");
  copyText(`${S.title}．本桌房規\n` + S.house.map((h) => `${h.hid} ${h.text}`).join("\n"));
};
$("srcBtn").onclick = () => {
  const t = $("srcText").value.trim();
  if (!t) return toast("請先貼上內容");
  if (send({ type: "source_add", text: t })) $("srcText").value = "";
};
$("closeRoom").onclick = () => { $("closeConfirm").hidden = false; $("closeRoom").hidden = true; };
$("closeNo").onclick = () => { $("closeConfirm").hidden = true; $("closeRoom").hidden = false; };
$("closeYes").onclick = () => send({ type: "close_room" });
$("codeChip").onclick = () => copyText(`${location.origin}/room.html?c=${code}`);

function renderHouse() {
  const box = $("house"); box.replaceChildren();
  if (!S.house.length) box.append(el("p", "muted", "還沒有房規。規則書沒寫到的爭議，投票通過後會出現在這裡，之後的裁定也會引用。"));
  for (const h of S.house) {
    const r = el("div", "hrow");
    r.append(el("span", "cid h", h.hid));
    const b = el("div", "grow"); b.append(el("div", null, h.text), el("div", "muted small", `來自「${h.origin}」．${h.tally} 票`));
    r.append(b);
    if (isHost()) { const del = el("button", "btn sm", "刪除"); del.onclick = () => send({ type: "house_delete", hid: h.hid }); r.append(del); }
    box.append(r);
  }
  $("hprop").disabled = !isPlayer(); $("hpropBtn").disabled = !isPlayer();
  const vb = $("votes"); vb.replaceChildren();
  for (const v of S.votes) vb.append(voteBox(v, true));

  $("scount").textContent = S.sentences.length;
  const rb = $("rulebook"); rb.replaceChildren(); quoteRows(rb, S.sentences);
  $("sourceCard").hidden = !isHost();

  const pl = $("players"); pl.replaceChildren();
  for (const p of S.players) {
    const r = el("div", "row");
    r.append(avatar(p.name, p.color, { off: !p.online, dot: p.online }), el("span", "grow", p.name + (p.device === device ? "（你）" : "")));
    r.append(el("span", "muted small", [p.isHost ? "房主" : p.role === "viewer" ? "只看" : "玩家", p.online ? "在線" : "離線"].join("．")));
    pl.append(r);
  }
  $("expiry").textContent = `房間會在最後一次活動 48 小時後自動刪除（目前預計 ${new Date(S.expiresAt).toLocaleString("zh-TW", { hour12: false })}）。`;
  $("closeBox").hidden = !isHost();
}

// ---------- 啟動 ----------
async function boot() {
  if (!/^[A-Z0-9]{6}$/.test(code)) return fatal("房號不正確。");
  $("code").textContent = code;
  let info;
  try {
    const r = await fetch(`/api/rooms/${code}`);
    if (!r.ok) return fatal("房間不存在或已過期。");
    info = await r.json();
  } catch {
    return fatal("網路連線失敗，請重新整理。");
  }
  $("title").textContent = info.title;
  if (store("name")) { connect(); return; }

  $("joinInfo").textContent = `「${info.title}」．目前 ${info.players} 人`;
  $("joinCard").hidden = false;
  $("roleSeg").addEventListener("click", (e) => {
    const v = e.target.dataset?.v; if (!v) return;
    joinRole = v;
    [...$("roleSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  });
  [...$("roleSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.v === joinRole));
  $("joinBtn").onclick = () => {
    const n = $("jname").value.trim();
    if (!n) return toast("請先填暱稱");
    store("name", n);
    $("joinCard").hidden = true;
    connect();
  };
}

boot();
