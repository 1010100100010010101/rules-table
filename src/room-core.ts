// 房間的所有規則（純邏輯，不碰網路或 Cloudflare，方便測試）
import type { Sentence } from "./split";
import { splitSentences } from "./split";
import { checkInput, cleanText, type ArbInput } from "./input";
import type { Graph, Step } from "./graph-validate";
import { tr, normLang, type Lang } from "./i18n";

export const ROOM_HOURLY_LIMIT = 40;
export const MAX_PLAYERS = 12;
export const MAX_DISPUTES = 25;
export const COLORS = ["#c2410c", "#1f5f8b", "#2e7d55", "#7b4cd6", "#c98a00", "#b4235a", "#0e7c86", "#5d6b78"];

export type Player = { name: string; color: string; role: "player" | "viewer"; joined: number };
export type Dispute = {
  id: string; by: string; mode: "duel" | "ask"; a: string; b: string; q: string;
  status: "pending" | "done" | "error"; result?: any; error?: string;
  acks: Record<string, boolean>; voteId?: string; at: number;
};
export type Vote = {
  id: string; disputeId?: string; title: string; options: string[]; reject: number;
  eligible: string[]; ballots: Record<string, number>; status: "open" | "closed";
  winner?: number | null; tally?: number[]; ruleId?: string; by: string; at: number;
};
export type HouseRule = { hid: string; text: string; origin: string; tally: string; at: number };
export type Play = {
  seats: string[]; seatIdx: number; stepId: string; seq: number;
  visits: Record<string, number>; done: boolean; suggested: number | null;
  lastRoll: { values: number[]; total: number } | null;
};
export type RoomState = {
  v: 1; code: string; title: string; host: string; createdAt: number; lastActive: number;
  lang?: Lang; // 房間語言：AI 的裁定與回合地圖用這個語言寫（舊房間沒有這欄，視為繁體）
  sentences: Sentence[]; sourceCount: number;
  players: Record<string, Player>; seats: string[];
  disputes: Dispute[]; votes: Record<string, Vote>; house: HouseRule[]; houseSeq: number;
  guide: { graph: Graph | null; confirmed: boolean; generating: boolean; error?: string; play: Play | null };
  dice: { by: string; values: number[]; total: number; at: number }[]; diceCount: number;
  hour: { key: number; n: number }; seq: number; closed?: boolean;
};

type Fail = { ok: false; status?: number; error?: string; message: string };
export interface Deps {
  now(): number;
  randInt(n: number): number; // 0..n-1
  arbitrate(input: ArbInput, sentences: Sentence[]): Promise<{ ok: true; data: any } | Fail>;
  generateGraph(sentences: Sentence[]): Promise<{ ok: true; graph: Graph } | Fail>;
  quota(key: string): Promise<{ ok: true } | { ok: false; message: string }>;
  commit(): Promise<void>; // 存檔並把新狀態廣播給所有人
}
export type HandleResult = { reply?: any; error?: string };

export function newRoom(init: { code: string; title: string; host: string; hostName: string; hostColor: string; sentences: Sentence[]; now: number; lang?: string }): RoomState {
  const lang = normLang(init.lang);
  return {
    v: 1, code: init.code, title: init.title, host: init.host, createdAt: init.now, lastActive: init.now, lang,
    sentences: init.sentences, sourceCount: 0,
    players: { [init.host]: { name: cleanName(init.hostName, 1, lang), color: cleanColor(init.hostColor, 0), role: "player", joined: init.now } },
    seats: [init.host],
    disputes: [], votes: {}, house: [], houseSeq: 0,
    guide: { graph: null, confirmed: false, generating: false, play: null },
    dice: [], diceCount: 1, hour: { key: 0, n: 0 }, seq: 0,
  };
}

function cleanName(s: any, n: number, lang?: Lang) {
  return cleanText(s, 12) || tr(lang).playerN(n);
}
function cleanColor(c: any, i: number) {
  return COLORS.includes(c) ? c : COLORS[i % COLORS.length];
}

export class RoomCore {
  private lang: Lang; // 這次操作者的語言（錯誤訊息用）
  private t: ReturnType<typeof tr>;
  private rt: ReturnType<typeof tr>; // 房間語言（全桌共享的文字用）
  constructor(public s: RoomState, private d: Deps, lang?: string) {
    this.lang = normLang(lang ?? s.lang);
    this.t = tr(this.lang);
    this.rt = tr(s.lang);
  }

  private id(prefix: string) {
    this.s.seq += 1;
    return `${prefix}${this.s.seq}`;
  }
  allSentences(): Sentence[] {
    return [...this.s.sentences, ...this.s.house.map((h) => ({ sid: h.hid, section: "H", text: h.text }))];
  }
  private step(id: string): Step | undefined {
    return this.s.guide.graph?.steps.find((x) => x.id === id);
  }
  private onlinePlayers(online: Set<string>) {
    return Object.entries(this.s.players).filter(([dv, p]) => p.role === "player" && online.has(dv)).map(([dv]) => dv);
  }
  private takeHour(): string | null {
    const key = Math.floor(this.d.now() / 3600000);
    if (this.s.hour.key !== key) this.s.hour = { key, n: 0 };
    if (this.s.hour.n >= ROOM_HOURLY_LIMIT) return this.t.hourLimit;
    this.s.hour.n += 1;
    return null;
  }
  private async allowAI(device: string): Promise<string | null> {
    const q = await this.d.quota(device);
    if (!q.ok) return q.message;
    return this.takeHour();
  }

  join(device: string, info: { name?: string; color?: string; role?: string }): string | null {
    if (this.s.closed) return this.t.roomClosed;
    const now = this.d.now();
    const p = this.s.players[device];
    if (p) {
      if (info.name) p.name = cleanName(info.name, 0, this.s.lang);
      if (info.color) p.color = cleanColor(info.color, 0);
      return null;
    }
    const count = Object.keys(this.s.players).length;
    if (count >= MAX_PLAYERS) return this.t.roomFull;
    const role = info.role === "viewer" ? "viewer" : "player";
    this.s.players[device] = { name: cleanName(info.name, count + 1, this.s.lang), color: cleanColor(info.color, count), role, joined: now };
    if (role === "player" && !this.s.guide.play) this.s.seats.push(device);
    return null;
  }

  async handle(device: string, msg: any, online: Set<string>): Promise<HandleResult> {
    const s = this.s;
    if (s.closed) return { error: this.t.roomClosed };
    const p = s.players[device];
    if (!p) return { error: this.t.joinFirst };
    const isHost = device === s.host;
    const isPlayer = p.role === "player";
    const type = String(msg?.type ?? "");

    switch (type) {
      case "sync":
        return { reply: { type: "state", state: this.view(device, online) } };

      case "dispute": {
        if (!isPlayer) return { error: this.t.viewerNoDispute };
        const chk = checkInput(msg, this.lang);
        if (!chk.ok) return { error: chk.message };
        if (s.disputes.filter((x) => x.status === "pending").length >= 2) return { error: this.t.pendingWait };
        const deny = await this.allowAI(device);
        if (deny) return { error: deny };
        const input = chk.input;
        const play = s.guide.play;
        if (play && !play.done) {
          const st = this.step(play.stepId);
          if (st) input.context = `目前第一回合進行到：${st.text}${st.cites.length ? `（依據 ${st.cites.join("、")}）` : ""}`;
        }
        const dsp: Dispute = { id: this.id("d"), by: device, mode: input.mode, a: input.a, b: input.b, q: input.q, status: "pending", acks: {}, at: this.d.now() };
        s.disputes.push(dsp);
        this.trimDisputes();
        await this.d.commit();
        const r = await this.d.arbitrate(input, this.allSentences());
        if (r.ok) {
          const { usage, ...data } = r.data;
          dsp.result = data;
          dsp.status = "done";
        } else {
          dsp.status = "error";
          dsp.error = r.message;
        }
        await this.d.commit();
        return {};
      }

      case "ack": {
        if (!isPlayer) return { error: this.t.viewerNoAck };
        const dsp = s.disputes.find((x) => x.id === msg.id);
        if (!dsp || dsp.status !== "done") return { error: this.t.disputeNotFound };
        if (!["explicit", "inferred"].includes(dsp.result?.kind)) return { error: this.t.noAckNeeded };
        dsp.acks[device] = !!msg.agree;
        await this.d.commit();
        return {};
      }

      case "vote_open": {
        if (!isPlayer) return { error: this.t.viewerNoVote };
        const custom = cleanText(msg.custom, 120);
        let options: string[] = [];
        let title = this.rt.newProposal;
        let dsp: Dispute | undefined;
        if (msg.disputeId) {
          dsp = s.disputes.find((x) => x.id === msg.disputeId);
          if (!dsp || dsp.status !== "done") return { error: this.t.disputeNotFound };
          if (dsp.voteId && s.votes[dsp.voteId]?.status === "open") return { error: this.t.alreadyVoting };
          title = dsp.mode === "duel" ? `A：${dsp.a}／B：${dsp.b}` : dsp.q;
          options = (dsp.result?.house_rule_options ?? []).map((o: any) => cleanText(o.text, 200));
        }
        if (custom) options.push(custom);
        options = [...new Set(options.filter(Boolean))].slice(0, 4);
        if (!options.length) return { error: this.t.needOption };
        const eligible = this.onlinePlayers(online);
        if (!eligible.includes(device)) eligible.push(device);
        const v: Vote = {
          id: this.id("v"), disputeId: dsp?.id, title: title.slice(0, 160), options: [...options, this.rt.keepAsIs],
          reject: options.length, eligible, ballots: {}, status: "open", by: device, at: this.d.now(),
        };
        s.votes[v.id] = v;
        if (dsp) dsp.voteId = v.id;
        this.trimVotes();
        await this.d.commit();
        return {};
      }

      case "vote_cast": {
        const v = s.votes[msg.voteId];
        if (!v || v.status !== "open") return { error: this.t.voteEnded };
        if (!v.eligible.includes(device)) return { error: this.t.lateJoiner };
        const c = Number(msg.choice);
        if (!Number.isInteger(c) || c < 0 || c >= v.options.length) return { error: this.t.noSuchOption };
        v.ballots[device] = c;
        if (v.eligible.every((dv) => dv in v.ballots)) this.closeVote(v);
        await this.d.commit();
        return {};
      }

      case "vote_close": {
        const v = s.votes[msg.voteId];
        if (!v || v.status !== "open") return { error: this.t.voteEnded };
        if (!isHost && v.by !== device) return { error: this.t.closeVoteDenied };
        this.closeVote(v);
        await this.d.commit();
        return {};
      }

      case "house_delete": {
        if (!isHost) return { error: this.t.hostOnlyDeleteHouse };
        s.house = s.house.filter((h) => h.hid !== msg.hid);
        await this.d.commit();
        return {};
      }

      case "source_add": {
        if (!isHost) return { error: this.t.hostOnlySource };
        const text = String(msg.text ?? "").slice(0, 5000);
        const prefix = `F${s.sourceCount + 1}`;
        const add = splitSentences(text, prefix);
        if (!add.length) return { error: this.t.sourceEmpty };
        if (s.sentences.length + add.length > 450) return { error: this.t.tooManySentences };
        s.sentences.push(...add);
        s.sourceCount += 1;
        await this.d.commit();
        return { reply: { type: "toast", message: this.t.sourceAdded(prefix, add.length) } };
      }

      case "private": {
        const chk = checkInput({ mode: "ask", question: msg.q, history: msg.history }, this.lang);
        if (!chk.ok) return { reply: { type: "private_result", id: msg.id, error: chk.message } };
        const deny = await this.allowAI(device);
        if (deny) return { reply: { type: "private_result", id: msg.id, error: deny } };
        const r = await this.d.arbitrate(chk.input, this.allSentences());
        if (!r.ok) return { reply: { type: "private_result", id: msg.id, error: r.message } };
        const { usage, ...data } = r.data;
        return { reply: { type: "private_result", id: msg.id, data } };
      }

      case "roll": {
        if (!isPlayer) return { error: this.t.viewerNoRoll };
        const count = Math.min(3, Math.max(1, Number(msg.count) || s.diceCount || 1));
        s.diceCount = count;
        const values = Array.from({ length: count }, () => this.d.randInt(6) + 1);
        const total = values.reduce((a, b) => a + b, 0);
        s.dice.unshift({ by: device, values, total, at: this.d.now() });
        s.dice = s.dice.slice(0, 8);
        const play = s.guide.play;
        if (play && !play.done) {
          const st = this.step(play.stepId);
          const idx = st ? st.next.findIndex((b) => b.dice?.includes(total)) : -1;
          if (idx >= 0) {
            play.suggested = idx;
            play.lastRoll = { values, total };
          }
        }
        await this.d.commit();
        return {};
      }

      case "dice_count": {
        s.diceCount = Math.min(3, Math.max(1, Number(msg.count) || 1));
        await this.d.commit();
        return {};
      }

      case "seats_set": {
        if (!isHost) return { error: this.t.hostOnlySeats };
        if (s.guide.play && !s.guide.play.done) return { error: this.t.seatsLocked };
        const players = Object.entries(s.players).filter(([, x]) => x.role === "player").map(([dv]) => dv);
        const order: string[] = Array.isArray(msg.order) ? msg.order.map(String) : [];
        if (order.length !== players.length || new Set(order).size !== order.length || !order.every((dv) => players.includes(dv))) {
          return { error: this.t.seatsInvalid };
        }
        s.seats = order;
        await this.d.commit();
        return {};
      }

      case "seats_random": {
        if (!isHost) return { error: this.t.hostOnlySeats };
        if (s.guide.play && !s.guide.play.done) return { error: this.t.seatsLocked };
        const arr = Object.entries(s.players).filter(([, x]) => x.role === "player").map(([dv]) => dv);
        for (let i = arr.length - 1; i > 0; i--) {
          const j = this.d.randInt(i + 1);
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        s.seats = arr;
        await this.d.commit();
        return {};
      }

      case "guide_generate": {
        if (!isHost) return { error: this.t.hostOnlyGraph };
        if (s.guide.generating) return { error: this.t.graphBusy };
        const deny = await this.allowAI(device);
        if (deny) return { error: deny };
        s.guide = { graph: null, confirmed: false, generating: true, play: null };
        await this.d.commit();
        const r = await this.d.generateGraph(s.sentences);
        s.guide.generating = false;
        if (r.ok) s.guide.graph = r.graph;
        else s.guide.error = r.message;
        await this.d.commit();
        return {};
      }

      case "guide_confirm": {
        if (!isHost) return { error: this.t.hostOnlyConfirm };
        if (!s.guide.graph) return { error: this.t.noGraph };
        s.guide.confirmed = true;
        await this.d.commit();
        return {};
      }

      case "guide_discard": {
        if (!isHost) return { error: this.t.hostOnly };
        s.guide = { graph: null, confirmed: false, generating: false, play: null };
        await this.d.commit();
        return {};
      }

      case "guide_start": {
        if (!isHost) return { error: this.t.hostOnlyStart };
        const g = s.guide.graph;
        if (!g || !s.guide.confirmed) return { error: this.t.confirmFirst };
        const seats = s.seats.filter((dv) => s.players[dv]?.role === "player");
        if (!seats.length) return { error: this.t.noPlayers };
        s.guide.play = { seats, seatIdx: 0, stepId: g.start, seq: 1, visits: { [g.start]: 1 }, done: false, suggested: null, lastRoll: null };
        await this.d.commit();
        return {};
      }

      case "guide_step": {
        if (!isPlayer) return { error: this.t.viewerNoOp };
        const play = s.guide.play;
        const g = s.guide.graph;
        if (!play || play.done || !g) return { error: this.t.notPlaying };
        if (Number(msg.seq) !== play.seq) return { error: this.t.alreadyStepped };
        const st = this.step(play.stepId);
        if (!st) return { error: this.t.stepMissing };
        if (st.next.length) {
          const bi = Number(msg.branch);
          if (!Number.isInteger(bi) || bi < 0 || bi >= st.next.length) return { error: this.t.pickOption };
          play.stepId = st.next[bi].to;
        } else {
          play.seatIdx += 1;
          if (play.seatIdx >= play.seats.length) play.done = true;
          else play.stepId = g.start;
        }
        if (!play.done) play.visits[play.stepId] = (play.visits[play.stepId] ?? 0) + 1;
        play.seq += 1;
        play.suggested = null;
        play.lastRoll = null;
        await this.d.commit();
        return {};
      }

      case "guide_end": {
        if (!isHost) return { error: this.t.hostOnlyEnd };
        s.guide.play = null;
        await this.d.commit();
        return {};
      }

      case "close_room": {
        if (!isHost) return { error: this.t.hostOnlyClose };
        s.closed = true;
        await this.d.commit();
        return {};
      }

      default:
        return { error: this.t.unknownCmd };
    }
  }

  closeVote(v: Vote) {
    const tally = v.options.map(() => 0);
    for (const c of Object.values(v.ballots)) tally[c] += 1;
    const max = Math.max(...tally);
    let winner: number | null = null;
    if (max > 0) {
      const top = tally.map((n, i) => (n === max ? i : -1)).filter((i) => i >= 0);
      if (top.length === 1) winner = top[0];
      else {
        const hostChoice = v.ballots[this.s.host];
        winner = hostChoice !== undefined && top.includes(hostChoice) ? hostChoice : null;
      }
    }
    v.status = "closed";
    v.tally = tally;
    v.winner = winner;
    if (winner !== null && winner !== v.reject) {
      this.s.houseSeq += 1;
      const hid = `H${this.s.houseSeq}`;
      this.s.house.push({ hid, text: v.options[winner], origin: v.title, tally: `${tally[winner]}／${v.eligible.length}`, at: this.d.now() });
      v.ruleId = hid;
    }
  }

  private trimDisputes() {
    while (this.s.disputes.length > MAX_DISPUTES) {
      const i = this.s.disputes.findIndex((x) => x.status !== "pending");
      if (i < 0) break;
      this.s.disputes.splice(i, 1);
    }
  }
  private trimVotes() {
    const ids = Object.values(this.s.votes).sort((a, b) => a.at - b.at).map((v) => v.id);
    while (ids.length > 30) {
      const id = ids.shift()!;
      if (this.s.votes[id].status === "closed") delete this.s.votes[id];
    }
  }

  // 每位玩家看到的畫面資料（隱藏別人的投票內容）
  view(device: string, online: Set<string>) {
    const s = this.s;
    const name = (dv: string) => s.players[dv]?.name ?? this.rt.leftPlayer;
    const color = (dv: string) => s.players[dv]?.color ?? "#9aa5b1";
    const onlinePlayers = this.onlinePlayers(online).length;
    const voteView = (v: Vote) => ({
      id: v.id, title: v.title, options: v.options, reject: v.reject, status: v.status,
      voted: Object.keys(v.ballots).length, eligible: v.eligible.length,
      mine: v.ballots[device] ?? null, canVote: v.eligible.includes(device),
      tally: v.status === "closed" ? v.tally : null, winner: v.status === "closed" ? v.winner : null,
      ruleId: v.ruleId ?? null, byMe: v.by === device, disputeId: v.disputeId ?? null,
    });
    const play = s.guide.play;
    return {
      code: s.code, title: s.title, host: s.host, lang: normLang(s.lang),
      me: { device, name: name(device), role: s.players[device]?.role ?? "viewer", isHost: device === s.host },
      players: Object.entries(s.players).map(([dv, p]) => ({ device: dv, name: p.name, color: p.color, role: p.role, online: online.has(dv), isHost: dv === s.host })),
      seats: s.seats.filter((dv) => s.players[dv]).map((dv) => ({ device: dv, name: name(dv), color: color(dv) })),
      sentences: s.sentences,
      house: s.house,
      disputes: [...s.disputes].reverse().map((x) => {
        const agree = Object.values(x.acks).filter(Boolean).length;
        const disagree = Object.values(x.acks).filter((a) => !a).length;
        return {
          id: x.id, by: x.by, byName: name(x.by), byColor: color(x.by), mode: x.mode, a: x.a, b: x.b, q: x.q,
          status: x.status, result: x.result ?? null, error: x.error ?? null, at: x.at,
          ack: { agree, disagree, mine: x.acks[device] ?? null, eligible: Math.max(onlinePlayers, 1) },
          vote: x.voteId && s.votes[x.voteId] ? voteView(s.votes[x.voteId]) : null,
        };
      }),
      votes: Object.values(s.votes).filter((v) => !v.disputeId).sort((a, b) => b.at - a.at).slice(0, 10).map(voteView),
      guide: {
        graph: s.guide.graph, confirmed: s.guide.confirmed, generating: s.guide.generating, error: s.guide.error ?? null,
        play: play
          ? {
              seats: play.seats.map((dv) => ({ device: dv, name: name(dv), color: color(dv) })),
              seatIdx: play.seatIdx, current: play.done ? null : play.seats[play.seatIdx],
              currentName: play.done ? null : name(play.seats[play.seatIdx]),
              stepId: play.stepId, seq: play.seq, done: play.done, suggested: play.suggested, lastRoll: play.lastRoll,
              visits: play.visits, firstTime: (play.visits[play.stepId] ?? 0) <= 1,
            }
          : null,
      },
      dice: s.dice.slice(0, 5).map((x) => ({ ...x, byName: name(x.by) })),
      diceCount: s.diceCount,
      startHints: s.sentences.filter((x) => /先開始|先开始|先手|起始玩家|第一位玩家|先行|輪流順序|轮流顺序|goes first|go first|first player|starting player|turn order/i.test(x.text)).slice(0, 3),
      expiresAt: s.lastActive + 48 * 3600 * 1000,
    };
  }
}
