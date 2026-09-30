// 월 단위 실시간 조회 스토어 — 디스크 적재 없음, 프로세스 메모리 캐시만 사용
//   request(items) : 필요한 (시군구, 월)만 백그라운드로 호출하고 진행 상태를 즉시 돌려준다(논블로킹)
//   get(sgg, ym)   : 캐시된 행 배열 또는 undefined
// 보호 장치: 동시 호출 제한 · 같은 키 중복 호출 합치기 · 일시 오류 재시도 · 일일 쿼터 차단 · LRU 상한 · 최근 월 TTL
"use strict";

const DAY_MS = 24 * 3600 * 1000;

class MonthStore {
  constructor(source, opts = {}) {
    this.source = source;
    this.concurrency = opts.concurrency ?? 3;
    this.dailyLimit = opts.dailyLimit ?? 9000; // 개발계정 10,000건/일에서 여유를 둔다
    this.maxEntries = opts.maxEntries ?? 6000; // (시군구, 월) 항목 수 상한
    this.recentTtlMs = opts.recentTtlMs ?? 6 * 3600 * 1000; // 최근 월은 신고 지연·해제 반영을 위해 주기적으로 갱신
    this.retryFailedMs = opts.retryFailedMs ?? 60 * 1000;
    this.retryDelays = opts.retryDelays ?? [500, 1500]; // 일시 오류 재시도 간격
    this.now = opts.now ?? (() => new Date());

    this.entries = new Map(); // key → { rows, totalCount, at }  (Map 삽입 순서 = LRU 순서)
    this.failed = new Map(); // key → { message, at }
    this.queue = [];
    this.queued = new Set();
    this.inflight = new Set();
    this.blocked = null; // { kind:'quota'|'auth', message, until? }
    this.calls = { date: this._today(), n: 0 };

    // 실시간 소스는 호출마다 훅으로 알려 준다(재호출 포함) → 일일 호출 수 집계
    if ("onCall" in source) source.onCall = () => this._countCall();
  }

  static key(sgg, ym) {
    return `${sgg}|${ym}`;
  }

  _today() {
    const d = this.now();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  _countCall() {
    const today = this._today();
    if (this.calls.date !== today) this.calls = { date: today, n: 0 };
    if (this.calls.n >= this.dailyLimit) {
      const e = new Error(`일일 호출 상한(${this.dailyLimit}건)에 도달해 오늘은 더 조회하지 않습니다.`);
      e.kind = "quota";
      throw e;
    }
    this.calls.n++;
  }

  _isRecent(ym) {
    const d = this.now();
    const cur = d.getFullYear() * 12 + d.getMonth();
    return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6)) - 1 >= cur - 3;
  }

  _nextMidnight() {
    const d = this.now();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  }

  get(sgg, ym) {
    const k = MonthStore.key(sgg, ym);
    const e = this.entries.get(k);
    if (!e) return undefined;
    if (this._isRecent(ym) && this.now().getTime() - e.at > this.recentTtlMs) {
      this.entries.delete(k);
      return undefined;
    }
    this.entries.delete(k); // LRU: 최근 사용으로 이동
    this.entries.set(k, e);
    return e.rows;
  }

  // items: [{ sgg, ym }] → { total, done, failed, pending, blocked }
  request(items) {
    if (this.blocked && this.blocked.until && this.now().getTime() > this.blocked.until) this.blocked = null;
    let done = 0;
    let failed = 0;
    let pending = 0;
    for (const { sgg, ym } of items) {
      const k = MonthStore.key(sgg, ym);
      if (this.get(sgg, ym) !== undefined) {
        done++;
        continue;
      }
      const f = this.failed.get(k);
      if (f && this.now().getTime() - f.at < this.retryFailedMs) {
        failed++;
        continue;
      }
      pending++;
      if (!this.blocked && !this.inflight.has(k) && !this.queued.has(k)) {
        this.queued.add(k);
        this.queue.push({ sgg, ym, k });
      }
    }
    this._pump();
    return { total: items.length, done, failed, pending, blocked: this.blocked };
  }

  _pump() {
    while (!this.blocked && this.inflight.size < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.queued.delete(job.k);
      this.inflight.add(job.k);
      this._run(job).finally(() => {
        this.inflight.delete(job.k);
        this._pump();
      });
    }
  }

  async _run({ sgg, ym, k }) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
      try {
        const res = await this.source.fetchMonth(sgg, ym);
        this.entries.set(k, { rows: res.rows, totalCount: res.totalCount, at: this.now().getTime() });
        this.failed.delete(k);
        this._evict();
        return;
      } catch (err) {
        lastErr = err;
        if (err.kind === "quota") {
          this.blocked = { kind: "quota", message: err.message, until: this._nextMidnight() };
          this._dropQueue();
          return;
        }
        if (err.kind === "auth") {
          this.blocked = { kind: "auth", message: err.message };
          this._dropQueue();
          return;
        }
        if (err.kind !== "transient" && err.kind !== undefined) break; // fatal 은 재시도해도 소용없음
        if (attempt < this.retryDelays.length) await new Promise((r) => setTimeout(r, this.retryDelays[attempt]));
      }
    }
    this.failed.set(k, { message: lastErr ? lastErr.message : "알 수 없는 오류", at: this.now().getTime() });
  }

  _dropQueue() {
    this.queue = [];
    this.queued.clear();
  }

  _evict() {
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }

  // 차단 해제(예: 키를 바꾼 뒤)
  resetBlock() {
    this.blocked = null;
    this.failed.clear();
  }

  stats() {
    const today = this._today();
    return {
      kind: this.source.kind,
      cachedMonths: this.entries.size,
      inflight: this.inflight.size,
      queued: this.queue.length,
      callsToday: this.calls.date === today ? this.calls.n : 0,
      dailyLimit: this.dailyLimit,
      blocked: this.blocked,
    };
  }
}

module.exports = { MonthStore, DAY_MS };
