// TWO MINDS — 二人の長期記憶（画面には触れない。ブラウザでも Node のテストでも動く）
//
// 3 層の記憶:
//   短期記憶   … 直近の発言と会話の状態（engine.js / サーバーの state。ここでは扱わない）
//   長期記憶   … 話題・問題ごとの要約（問い・結論・二人の考え・残った疑問）と、元の発言ログ
//   関係性の記憶 … 二人の間で起きた出来事（出した問題、レオの仮説、冗談、食い違い、相手について知ったこと など）
//
// 守ること:
//   ・実際に再生された発言だけをログに残す。記憶（要約・出来事）は、最後まで再生された記録からだけ作る
//     （観察者の割り込みで再生されなかった内容は、確定した事実として記憶しない）
//   ・要約は会話の生成と同じ 1 回の応答で書かせる（recap / memo）。記憶のための追加の API 呼び出しはしない
//   ・生成のたびに、いまの話題に関係する記憶だけを選んで渡す（件数と文字数に上限があるので、記憶が増えても入力は増え続けない）
//   ・古い記憶を無条件には消さない。容量を超えたときだけ、重要度・思い出された回数・新しさの低いものから整理する
//   ・保存先はこのブラウザ（localStorage）だけ。サーバーには保存しない

const MEMORY_KEY = 'twominds:memory:v1';
const LOG_KEY = 'twominds:log:v1';
const DAY = 24 * 60 * 60 * 1000;

const RELATION_KINDS = ['joke', 'disagreement', 'about_leo', 'about_mina', 'shared', 'promise'];
const IMPORTANCE = { topic: 3, quiz: 3, hypothesis: 3, joke: 2, disagreement: 3, about_leo: 4, about_mina: 4, shared: 3, finding: 3, promise: 4 };

// ---------- 文字列の似ている度合い（2 文字ずつの組の重なり） ----------
function grams(s) {
  const t = String(s || '').replace(/[\s、。！？!?「」『』（）()…・,.\-ー〜~:：/]/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / Math.min(a.size, b.size);
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}
const join = (v) => (Array.isArray(v) ? v.filter(Boolean).join(' / ') : String(v || ''));

/** 「問題の種類」の分類（サーバーの kindClass と同じ考え方） */
export function kindClass(kind) {
  const k = String(kind || '');
  if (!k || /雑談|なし|none/i.test(k)) return 'chat';
  if (/未解決|未知|仮説|open|unsolved/i.test(k)) return 'unsolved';
  if (/謎|ミステリ|mystery/i.test(k)) return 'mystery';
  if (/哲学|倫理|価値|意見|社会|芸術|文学|人間関係|文化|好み|philosophy|opinion/i.test(k)) return 'opinion';
  if (/数学|算数|定理|証明|論理|パズル|クイズ|計算|物理|化学|生物|科学|天文|地学|歴史|地理|知識|事実|quiz|math|science|fact/i.test(k)) return 'known';
  return 'mystery';
}

/** 経過時間を、会話で使える言い方にする */
export function whenLabel(t, now) {
  const d = now - t;
  if (d < 30 * 60 * 1000) return 'さっき';
  const days = Math.floor((startOfDay(now) - startOfDay(t)) / DAY);
  if (days <= 0) return '今日';
  if (days === 1) return '昨日';
  if (days < 7) return `${days}日前`;
  if (days < 30) return `${Math.floor(days / 7)}週間前`;
  return `${Math.floor(days / 30)}か月前`;
}
function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export class MemoryStore {
  /**
   * storage: { get(key) → string|null, set(key, value), remove(key) }（ブラウザでは localStorage）
   */
  constructor({ storage, now = () => Date.now(), maxRecords = 600, maxLines = 4000, perRequest = 6, relationPerRequest = 2 } = {}) {
    this.storage = storage;
    this.now = now;
    this.o = { maxRecords, maxLines, perRequest, relationPerRequest };
    this.data = { v: 1, seq: 0, records: [], segment: null, quizzes: [], recentKinds: [], sid: 0 };
    this.log = { v: 1, seq: 0, lines: [] };
    this.dirty = false;
    this.load();
    // 前回、途中のまま閉じられた問題は「途中」として記憶にしておく（ページを閉じたときなど）
    if (this.data.segment) this.closeSegment(this.data.segment, '');
    this.data.sid++; // 会話（セッション）を区別する番号
  }

  // ---------- 保存 ----------

  load() {
    try {
      const d = JSON.parse(this.storage?.get(MEMORY_KEY) || 'null');
      if (d && d.v === 1 && Array.isArray(d.records)) this.data = { ...this.data, ...d };
    } catch {}
    try {
      const l = JSON.parse(this.storage?.get(LOG_KEY) || 'null');
      if (l && l.v === 1 && Array.isArray(l.lines)) this.log = l;
    } catch {}
  }

  save() {
    if (!this.storage) return;
    try {
      this.storage.set(MEMORY_KEY, JSON.stringify(this.data));
    } catch {
      // 容量が足りないときは、記憶より先に元のログを減らす
      this.trimLog(Math.floor(this.log.lines.length / 2));
    }
    try {
      this.storage.set(LOG_KEY, JSON.stringify(this.log));
    } catch {
      this.trimLog(Math.floor(this.log.lines.length / 2));
      try {
        this.storage.set(LOG_KEY, JSON.stringify(this.log));
      } catch {}
    }
    this.dirty = false;
  }

  clear() {
    this.data = { v: 1, seq: 0, records: [], segment: null, quizzes: [], recentKinds: [], sid: 1 };
    this.log = { v: 1, seq: 0, lines: [] };
    try {
      this.storage?.remove(MEMORY_KEY);
      this.storage?.remove(LOG_KEY);
    } catch {}
  }

  stats() {
    const byKind = {};
    for (const r of this.data.records) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    return { records: this.data.records.length, lines: this.log.lines.length, byKind, segment: this.data.segment?.question || '' };
  }

  // ---------- 元の発言ログ（実際に再生された発言だけ） ----------

  addLine({ kind = 'say', speaker = null, text, type = '', phase = '' }) {
    if (!text) return null;
    const id = ++this.log.seq;
    this.log.lines.push({ id, t: this.now(), sid: this.data.sid, kind, speaker, text: String(text).slice(0, 200), type, phase });
    if (this.log.lines.length > this.o.maxLines) this.trimLog(this.log.lines.length - this.o.maxLines);
    this.dirty = true;
    return id;
  }

  trimLog(n) {
    if (n > 0) this.log.lines.splice(0, n);
  }

  linesBetween(from, to) {
    return this.log.lines.filter((l) => l.id >= from && l.id <= to);
  }

  // ---------- 記憶を作る（最後まで再生された記録だけ） ----------

  /**
   * 記録（数発言のまとまり）を最後まで再生し終えたときに呼ぶ。
   * before / after: その記録の前後の会話の状態。recap / memos: その記録と一緒に書かれた要約と出来事
   */
  onChunkCommitted({ before = null, after = null, recap = '', memos = [] } = {}) {
    if (!after) return;
    for (const m of memos || []) this.addRecord({ kind: m.kind, text: m.text, topic: after.topic || before?.topic || '' });
    const seg = this.data.segment;
    const q = after.question || '';
    if (q) {
      if (!seg || !sameQuestion(seg.question, q)) {
        if (seg) this.closeSegment(seg, '');
        this.data.segment = { question: q, topic: after.topic, kind: after.kind, from: this.log.seq, recap: '', state: after };
        if (after.kind) this.data.recentKinds = [...this.data.recentKinds, after.kind].slice(-6);
      }
      const s = this.data.segment;
      s.state = after;
      if (recap) s.recap = recap;
      if (kindClass(after.kind) === 'known' && /クイズ|パズル|問題/.test(after.kind + q) && !this.data.quizzes.includes(q)) {
        this.data.quizzes = [...this.data.quizzes, q].slice(-30);
      }
    } else if (seg) {
      // 問いが閉じた（解決・未解決の確認のあと、余韻や雑談に移った）
      this.closeSegment(seg, recap);
    } else if (recap) {
      // 問題のない雑談が区切りに着いた
      this.addRecord({ kind: 'topic', topic: after.topic, text: recap, status: 'none', importance: 1, from: Math.max(1, this.log.seq - 12), to: this.log.seq });
    }
    this.dirty = true;
  }

  closeSegment(seg, recap) {
    const st = seg.state || {};
    const status = st.status && st.status !== 'none' ? st.status : 'exploring';
    const conclusion = st.final_answer || join(st.known);
    this.addRecord({
      kind: 'topic',
      topic: seg.topic || st.topic || '',
      question: seg.question,
      qkind: seg.kind || st.kind || '',
      status,
      text: recap || seg.recap || st.summary || '',
      conclusion,
      open: join(st.open_points),
      leo: st.leo_view || '',
      mina: st.mina_view || '',
      explored: join(st.explored),
      importance: status === 'resolved' ? 3 : 4, // 未解決や途中の疑問は、あとで再挑戦できるよう重要度を高くする
      from: seg.from + 1,
      to: this.log.seq,
    });
    this.data.segment = null;
  }

  /** 会話（セッション）を終えるとき：途中の問題も「途中」として記憶しておく */
  endSession() {
    if (this.data.segment) this.closeSegment(this.data.segment, '');
    this.save();
  }

  addRecord(r) {
    const kind = r.kind || 'finding';
    const now = this.now();
    const rec = {
      id: ++this.data.seq,
      kind,
      t: now,
      updated: now,
      sid: this.data.sid,
      topic: (r.topic || '').slice(0, 30),
      question: (r.question || '').slice(0, 100),
      qkind: (r.qkind || '').slice(0, 20),
      status: r.status || 'none',
      text: (r.text || '').slice(0, 200),
      conclusion: (r.conclusion || '').slice(0, 160),
      open: (r.open || '').slice(0, 120),
      leo: (r.leo || '').slice(0, 100),
      mina: (r.mina || '').slice(0, 100),
      explored: (r.explored || '').slice(0, 160),
      importance: r.importance ?? IMPORTANCE[kind] ?? 3,
      refs: 0,
      lastRecalled: 0,
      from: r.from || 0,
      to: r.to || 0,
    };
    if (!rec.text && !rec.question && !rec.conclusion) return null;
    // 同じ内容の記憶は増やさず、まとめる（同じ問いを別の日にまた話した、など）
    const g = grams(indexText(rec));
    const dup = this.data.records.find((x) => x.kind === kind && (rec.question ? sameQuestion(x.question, rec.question) : jaccard(grams(indexText(x)), g) >= 0.6));
    if (dup) {
      dup.updated = now;
      dup.refs++;
      dup.importance = Math.max(dup.importance, rec.importance);
      for (const k of ['text', 'conclusion', 'open', 'leo', 'mina', 'explored', 'topic', 'qkind']) if (rec[k] && rec[k].length >= (dup[k] || '').length * 0.6) dup[k] = rec[k];
      if (rec.status !== 'none') dup.status = rec.status;
      if (rec.to) {
        dup.from = dup.from || rec.from;
        dup.to = rec.to;
      }
      return dup;
    }
    this.data.records.push(rec);
    this.compact();
    return rec;
  }

  /** 容量を超えたときだけ、残す価値の低いものから整理する（重要度・思い出された回数・新しさ） */
  compact() {
    const max = this.o.maxRecords;
    if (this.data.records.length <= max) return;
    const now = this.now();
    const keep = (r) => r.importance * 2 + Math.log2(r.refs + 1) - Math.min(4, (now - (r.lastRecalled || r.updated)) / (30 * DAY));
    const sorted = [...this.data.records].sort((a, b) => keep(a) - keep(b));
    const drop = new Set(sorted.slice(0, this.data.records.length - max).map((r) => r.id));
    this.data.records = this.data.records.filter((r) => !drop.has(r.id));
  }

  // ---------- 思い出す（いまの話題に関係する記憶だけ） ----------

  /**
   * state: いまの会話の状態 / recent: 直近の発言
   * 返す: サーバーに送る { memories, quizzes, recentKinds }（件数・長さに上限あり）
   */
  retrieve({ state = null, recent = [] } = {}) {
    const now = this.now();
    const queryText = [state?.topic, state?.question, state?.next_focus, ...recent.slice(-4).map((e) => e.text)].filter(Boolean).join(' ');
    const q = grams(queryText);
    const fresh = q.size === 0;
    // いま考えている途中の問題は、まだ記録になっていない（閉じたときに記録になる）ので、ここに出てくるのは過去の記憶だけ
    const scored = this.data.records
      .map((r) => {
        const rel = fresh ? 0 : overlap(q, grams(indexText(r)));
        const ageDays = (now - r.updated) / DAY;
        const recency = ageDays < 1 ? 0.15 : ageDays < 7 ? 0.08 : 0;
        const openBonus = r.kind === 'topic' && r.status !== 'resolved' && r.question ? 0.1 : 0;
        const score = rel * 3 + r.importance * 0.06 + recency + Math.min(0.2, Math.log2(r.refs + 1) * 0.05) + openBonus;
        return { r, rel, score };
      });
    // 関係のある知識・問題の記憶（話題に関係があるものだけ。会話の始まりは、重要で新しいものを少しだけ）
    const knowledge = scored
      .filter((x) => !RELATION_KINDS.includes(x.r.kind))
      .filter((x) => (fresh ? x.r.importance >= 3 : x.rel >= 0.18))
      .sort((a, b) => b.score - a.score)
      .slice(0, fresh ? 3 : this.o.perRequest);
    // 関係性の記憶（関係のあるものを優先し、なければ最近の出来事を 1 つ）
    const relRanked = scored.filter((x) => RELATION_KINDS.includes(x.r.kind)).sort((a, b) => b.score - a.score);
    const relation = relRanked.filter((x) => x.rel >= 0.18).slice(0, this.o.relationPerRequest);
    if (fresh && !relation.length && relRanked.length) relation.push(relRanked[0]); // 会話の始まりだけ、最近の出来事を 1 つ
    const picked = [...knowledge, ...relation];

    // いちばん関係の深い「元の発言が残っている記憶」1 つだけに、当時の発言を少し添える
    const withSource = picked.find((x) => x.rel >= 0.3 && x.r.to)?.r.id;
    // 送る量に上限を設ける（サーバー側の上限と同じ 2400 文字。記憶が増えても通信量とトークン数が増え続けない）
    let budget = 2400;
    const memories = [];
    for (const { r } of picked) {
      const item = {
        kind: r.kind,
        when: whenLabel(r.updated, now),
        topic: r.topic,
        question: r.question,
        status: r.status,
        text: r.text,
        conclusion: r.conclusion,
        open: r.open,
        leo: r.leo,
        mina: r.mina,
        excerpt: r.id === withSource ? this.excerpt(r) : [],
      };
      const size = JSON.stringify(item).length;
      if (size > budget) continue;
      budget -= size;
      memories.push(item);
      // 思い出された回数（同じ話題の続きで毎回数えないよう、10 分あけて 1 回と数える）
      if (now - (r.lastRecalled || 0) > 10 * 60 * 1000) r.refs++;
      r.lastRecalled = now;
    }
    if (picked.length) this.dirty = true;
    return { memories, quizzes: this.data.quizzes.slice(-10).map((q) => q.slice(0, 60)), recentKinds: this.data.recentKinds.slice(-6) };
  }

  /** 記憶のもとになった元の発言から、結論・気づき・仮説を優先して最大 4 つ */
  excerpt(r) {
    const lines = this.linesBetween(r.from, r.to).filter((l) => l.kind === 'say');
    if (!lines.length) return [];
    const rank = { conclusion: 0, insight: 1, hypothesis: 2, discovery: 3, reasoning: 4 };
    const best = [...lines].sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9)).slice(0, 4);
    return best.sort((a, b) => a.id - b.id).map((l) => ({ kind: 'say', speaker: l.speaker, text: l.text.slice(0, 100) }));
  }
}

function indexText(r) {
  return [r.topic, r.question, r.text, r.conclusion, r.open, r.leo, r.mina, r.explored].filter(Boolean).join(' ');
}

function sameQuestion(a, b) {
  if (!a || !b) return false;
  return a === b || jaccard(grams(a), grams(b)) >= 0.6;
}
