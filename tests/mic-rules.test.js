import assert from "node:assert/strict";
import test from "node:test";
import {
  MIC_TERMS,
  MicError,
  YC,
  askerTurn,
  campDone,
  campOf,
  checkPledge,
  checkQuestion,
  cutTurn,
  endingRefunds,
  fire,
  fundCloses,
  fundPledge,
  listDone,
  majority,
  micFor,
  newListVoteCounts,
  nextTurn,
  openFund,
  otherSide,
  raised,
  ranked,
  seatClaimRefunds,
  splitToDebaters,
  total,
  viewersCanEnd,
  withdrawal,
} from "../dist/features/mic/rules.js";

const list = { id: "l1", state: "open", openedRound: 4 };
const viewer = (account, more = {}) => ({
  account,
  present: true,
  seated: false,
  heldSeat: false,
  ...more,
});
let seq = 0;
const pledge = (account, coins, more = {}) => ({
  id: `p${++seq}`,
  account,
  amount: BigInt(coins) * YC,
  wager: false,
  add: null,
  state: "held",
  ...more,
});
const question = (author, target, wagerCoins, backers = [], more = {}) => ({
  id: `q${++seq}`,
  listId: "l1",
  author,
  target,
  text: `question by ${author}`,
  seq,
  state: "open",
  pledges: [
    pledge(author, wagerCoins, { wager: true }),
    ...backers.map(([who, coins]) => pledge(who, coins)),
  ],
  ...more,
});
const refused = (fn, pattern, status) =>
  assert.throws(
    fn,
    (error) =>
      error instanceof MicError &&
      pattern.test(error.message) &&
      (status === undefined || error.status === status),
  );

test("a question's camp is the side opposite its target", () => {
  assert.equal(campOf("A"), "B");
  assert.equal(campOf("B"), "A");
  assert.equal(otherSide("A"), "B");
  assert.equal(new MicError("x").status, 409);
});

test("L8, L9: each camp ranks open questions by total, ties to the earlier", () => {
  const first = question("ana", "A", 50);
  const tied = question("ben", "A", 50);
  const top = question("cy", "A", 20, [["dee", 40]]);
  const otherCamp = question("eve", "B", 500);
  const gone = question("fay", "A", 900, [], { state: "removed" });
  const qs = [tied, first, top, otherCamp, gone];
  assert.deepEqual(
    ranked(qs, "l1", "B").map((q) => q.author),
    ["cy", "ana", "ben"],
  );
  assert.deepEqual(
    ranked(qs, "l1", "A").map((q) => q.author),
    ["eve"],
  );
  assert.equal(total(top), 60n * YC);
  assert.equal(
    total({ ...top, pledges: [pledge("x", 5, { state: "refunded" })] }),
    0n,
  );
});

test("L5, L16, L17, L21, L22: submitting a question", () => {
  const ok = checkQuestion({
    list,
    questions: [],
    mics: [],
    actor: viewer("ana"),
    target: "B",
    text: "  Who pays?  ",
    wager: 5n * YC,
  });
  assert.deepEqual(ok, { text: "Who pays?", wager: 5n * YC, camp: "A" });
  const base = {
    list,
    questions: [],
    mics: [],
    actor: viewer("ana"),
    target: "A",
    text: "Why?",
    wager: YC,
  };
  refused(() => checkQuestion({ ...base, list: undefined }), /isn't open/);
  refused(
    () => checkQuestion({ ...base, list: { ...list, state: "closed" } }),
    /isn't open/,
  );
  refused(
    () => checkQuestion({ ...base, actor: viewer("ana", { present: false }) }),
    /join the live debate/,
    403,
  );
  refused(
    () => checkQuestion({ ...base, actor: viewer("ana", { seated: true }) }),
    /debaters can't/,
    403,
  );
  refused(
    () => checkQuestion({ ...base, actor: viewer("ana", { heldSeat: true }) }),
    /debaters can't/,
    403,
  );
  refused(
    () => checkQuestion({ ...base, text: "   " }),
    /write a question/,
    400,
  );
  refused(
    () => checkQuestion({ ...base, text: "x".repeat(201) }),
    /at most 200/,
    400,
  );
  assert.ok(checkQuestion({ ...base, text: "é".repeat(200) }));
  refused(() => checkQuestion({ ...base, wager: 0n }), /whole Yap Coins/, 400);
  refused(
    () => checkQuestion({ ...base, wager: YC + 1n }),
    /whole Yap Coins/,
    400,
  );
  const mine = question("ana", "B", 5);
  refused(
    () => checkQuestion({ ...base, questions: [mine] }),
    /already have a question open/,
  );
  assert.ok(
    checkQuestion({ ...base, questions: [{ ...mine, state: "fired" }] }),
    "L23: another once the first is gone",
  );
  const fired = {
    id: "m1",
    listId: "l1",
    camp: "B",
    questionId: "q",
    holder: "x",
    target: "A",
    state: "live",
    price: YC,
  };
  refused(
    () => checkQuestion({ ...base, mics: [fired] }),
    /already fired in this list/,
  );
  assert.ok(checkQuestion({ ...base, target: "B", mics: [fired] }));
});

test("L6, L16, L19: pledging, with an optional paid comment", () => {
  const q = question("ana", "A", 5);
  assert.deepEqual(
    checkPledge({
      list,
      question: q,
      actor: viewer("ben"),
      amount: 2n * YC,
      add: " Numbers please ",
    }),
    { amount: 2n * YC, add: "Numbers please" },
  );
  assert.deepEqual(
    checkPledge({ list, question: q, actor: viewer("ana"), amount: YC }),
    { amount: YC, add: null },
  );
  refused(
    () =>
      checkPledge({
        list,
        question: q,
        actor: viewer("ben"),
        amount: YC,
        add: "y".repeat(201),
      }),
    /comment is at most 200/,
  );
  refused(
    () =>
      checkPledge({
        list,
        question: { ...q, state: "fired" },
        actor: viewer("ben"),
        amount: YC,
      }),
    /isn't open any more/,
  );
  refused(
    () =>
      checkPledge({
        list,
        question: { ...q, listId: "l0" },
        actor: viewer("ben"),
        amount: YC,
      }),
    /isn't open any more/,
  );
  refused(
    () =>
      checkPledge({
        list,
        question: q,
        actor: viewer("ben", { seated: true }),
        amount: YC,
      }),
    /debaters can't/,
  );
  refused(
    () =>
      checkPledge({
        list: undefined,
        question: q,
        actor: viewer("ben"),
        amount: YC,
      }),
    /isn't open/,
  );
});

test("L11, L20, S5: withdrawing at any time until the camp fires", () => {
  const q = question("ana", "A", 5, [
    ["ben", 3],
    ["cy", 2],
  ]);
  const benPledge = q.pledges[1];
  assert.deepEqual(withdrawal(q, benPledge.id, viewer("ben")), {
    removesQuestion: false,
    refund: [benPledge],
  });
  const byAuthor = withdrawal(q, q.pledges[0].id, viewer("ana"));
  assert.equal(byAuthor.removesQuestion, true);
  assert.equal(byAuthor.refund.length, 3);
  refused(
    () => withdrawal(q, benPledge.id, viewer("cy")),
    /nothing to withdraw/,
    404,
  );
  refused(() => withdrawal(q, "missing", viewer("ben")), /nothing to withdraw/);
  refused(
    () => withdrawal({ ...q, state: "fired" }, benPledge.id, viewer("ben")),
    /nothing to withdraw/,
  );
  refused(
    () => withdrawal(q, benPledge.id, viewer("ben", { heldSeat: true })),
    /can't change/,
    403,
  );
});

test("F1, L13, L14: only the camp's #1 fires; the rest of the camp is refunded", () => {
  const top = question("ana", "A", 30, [["ben", 20]]);
  const second = question("cy", "A", 40);
  const otherCamp = question("dee", "B", 10);
  const qs = [top, second, otherCamp];
  const result = fire({
    list,
    questions: qs,
    mics: [],
    questionId: top.id,
    actor: viewer("ana"),
  });
  assert.equal(result.camp, "B");
  assert.equal(result.target, "A");
  assert.equal(result.price, 50n * YC);
  assert.deepEqual(result.paid, top.pledges);
  assert.deepEqual(result.refunded, second.pledges);
  assert.deepEqual(result.refundedQuestions, [second.id]);
  assert.equal(result.state, "live");
  refused(
    () =>
      fire({
        list,
        questions: qs,
        mics: [],
        questionId: second.id,
        actor: viewer("cy"),
      }),
    /only the camp's #1/,
  );
  refused(
    () =>
      fire({
        list,
        questions: qs,
        mics: [],
        questionId: top.id,
        actor: viewer("ben"),
      }),
    /only the question's author/,
    403,
  );
  refused(
    () =>
      fire({
        list,
        questions: qs,
        mics: [],
        questionId: "nope",
        actor: viewer("ana"),
      }),
    /isn't open/,
    404,
  );
  refused(
    () =>
      fire({
        list: undefined,
        questions: qs,
        mics: [],
        questionId: top.id,
        actor: viewer("ana"),
      }),
    /list isn't open/,
  );
  refused(
    () =>
      fire({
        list,
        questions: qs,
        mics: [],
        questionId: top.id,
        actor: viewer("ana", { seated: true }),
      }),
    /debaters can't/,
  );
  const done = {
    id: "m0",
    listId: "l1",
    camp: "B",
    questionId: "old",
    holder: "z",
    target: "A",
    state: "done",
    price: YC,
  };
  refused(
    () =>
      fire({
        list,
        questions: qs,
        mics: [done],
        questionId: top.id,
        actor: viewer("ana"),
      }),
    /already fired/,
  );
  assert.equal(micFor([done], "l1", "B"), done);
});

test("F11, F12, F13: a mic fired while another is live or queued is queued", () => {
  const top = question("ana", "A", 30);
  for (const state of ["live", "queued"]) {
    const busy = {
      id: "m9",
      listId: "l1",
      camp: "A",
      questionId: "x",
      holder: "z",
      target: "B",
      state,
      price: YC,
    };
    assert.equal(
      fire({
        list,
        questions: [top],
        mics: [busy],
        questionId: top.id,
        actor: viewer("ana"),
      }).state,
      "queued",
    );
  }
  const done = {
    id: "m8",
    listId: "l1",
    camp: "A",
    questionId: "x",
    holder: "z",
    target: "B",
    state: "done",
    price: YC,
  };
  assert.equal(
    fire({
      list,
      questions: [top],
      mics: [done],
      questionId: top.id,
      actor: viewer("ana"),
    }).state,
    "live",
  );
});

test("E1, E4, E8, X4: exchange turns, extensions and the resume", () => {
  assert.equal(nextTurn("question", false), "answer");
  assert.equal(nextTurn("answer", false), "followup");
  assert.equal(nextTurn("followup", false), "answer2");
  assert.equal(nextTurn("answer2", false), "resume");
  assert.equal(nextTurn("answer2", true), "extq");
  assert.equal(nextTurn("extq", false), "exta");
  assert.equal(nextTurn("exta", true), "extq");
  assert.equal(nextTurn("exta", false), "resume");
  refused(() => nextTurn("debate", false), /not an exchange turn/, 500);
  assert.deepEqual(
    ["question", "answer", "followup", "answer2", "extq", "exta", "debate"].map(
      askerTurn,
    ),
    [true, false, true, false, true, false, false],
  );
});

test("E5, E6, E10: a cut turn loses its rest, answers are never stretched", () => {
  assert.deepEqual(cutTurn(40_000), {
    lostMs: 40_000,
    answerMs: 60_000,
    refundWindow: true,
  });
  assert.deepEqual(cutTurn(-5), {
    lostMs: 0,
    answerMs: 60_000,
    refundWindow: true,
  });
  assert.equal(cutTurn(10, { ...MIC_TERMS, turnSeconds: 45 }).answerMs, 45_000);
});

test("X1, X2, X6, X7, X10 to X12: keep the asker on", () => {
  const fund = openFund("question", 100n * YC);
  assert.deepEqual(fund, {
    price: 100n * YC,
    closesAfter: "followup",
    state: "open",
    pledges: [],
  });
  assert.equal(openFund("extq", YC).closesAfter, "extq");
  refused(() => openFund("answer", YC), /asker's first turn/, 500);
  assert.deepEqual(fundPledge(fund, viewer("ana"), 30n * YC), {
    accepted: 30n * YC,
    funded: false,
  });
  fund.pledges.push({ account: "ana", amount: 30n * YC });
  assert.equal(raised(fund), 30n * YC);
  assert.deepEqual(
    fundPledge(fund, viewer("asker"), 500n * YC),
    { accepted: 70n * YC, funded: true },
    "X6 and X12: capped, then funded",
  );
  assert.deepEqual(fundPledge(fund, viewer("ben"), 70n * YC), {
    accepted: 70n * YC,
    funded: true,
  });
  refused(
    () => fundPledge({ ...fund, state: "funded" }, viewer("ben"), YC),
    /isn't open/,
  );
  refused(
    () => fundPledge(fund, viewer("ben", { heldSeat: true }), YC),
    /debaters can't/,
  );
  refused(() => fundPledge(fund, viewer("ben"), 0n), /whole Yap Coins/);
  assert.equal(fundCloses(fund, "followup"), true);
  assert.equal(fundCloses(fund, "answer"), false);
  assert.equal(fundCloses({ ...fund, state: "funded" }, "followup"), false);
});

test("D6, D8: when a camp counts as done", () => {
  const q = question("ana", "A", 5);
  const live = {
    id: "m1",
    listId: "l1",
    camp: "B",
    questionId: q.id,
    holder: "ana",
    target: "A",
    state: "live",
    price: YC,
  };
  assert.equal(
    campDone({ list, questions: [], mics: [], camp: "A", roundsDone: 3 }),
    false,
    "empty, list's round not over",
  );
  assert.equal(
    campDone({ list, questions: [], mics: [], camp: "A", roundsDone: 4 }),
    true,
    "empty after the round",
  );
  assert.equal(
    campDone({ list, questions: [q], mics: [], camp: "B", roundsDone: 9 }),
    false,
    "a question waits",
  );
  assert.equal(
    campDone({ list, questions: [q], mics: [live], camp: "B", roundsDone: 9 }),
    false,
  );
  assert.equal(
    campDone({
      list,
      questions: [q],
      mics: [{ ...live, state: "done" }],
      camp: "B",
      roundsDone: 9,
    }),
    true,
  );
  assert.equal(
    listDone({
      list,
      questions: [q],
      mics: [{ ...live, state: "done" }],
      roundsDone: 9,
    }),
    true,
  );
  assert.equal(
    listDone({ list, questions: [q], mics: [], roundsDone: 9 }),
    false,
  );
});

test("D2, D5, N1, N5: standing buttons", () => {
  const present = ["a", "b", "c", "d"];
  assert.equal(
    majority(present, new Set(["a", "b"])),
    false,
    "half is not more than half",
  );
  assert.equal(majority(present, new Set(["a", "b", "c", "gone"])), true);
  assert.equal(
    majority(present, new Set(["a", "b", "x", "y"])),
    false,
    "absent accounts don't count",
  );
  assert.equal(majority([], new Set(["a"])), false);
  assert.equal(viewersCanEnd(2, true), false);
  assert.equal(viewersCanEnd(3, false), false);
  assert.equal(viewersCanEnd(3, true), true);
  const done = {
    id: "m",
    listId: "l1",
    camp: "A",
    questionId: "q",
    holder: "z",
    target: "B",
    state: "done",
    price: YC,
  };
  assert.equal(
    newListVoteCounts({
      latestListDone: true,
      mics: [done],
      votePassed: false,
    }),
    true,
  );
  assert.equal(
    newListVoteCounts({
      latestListDone: true,
      mics: [{ ...done, state: "queued" }],
      votePassed: false,
    }),
    false,
  );
  assert.equal(
    newListVoteCounts({ latestListDone: false, mics: [], votePassed: false }),
    false,
  );
  assert.equal(
    newListVoteCounts({ latestListDone: true, mics: [], votePassed: true }),
    false,
  );
});

test("L15, S13: equal halves, an empty seat's half kept for it", () => {
  assert.deepEqual(splitToDebaters(3n * YC, { A: "maya", B: "theo" }), [
    { side: "A", account: "maya", amount: 15_000n },
    { side: "B", account: "theo", amount: 15_000n },
  ]);
  assert.deepEqual(
    splitToDebaters(2n * YC, { A: "maya", B: null }).map((s) => s.account),
    ["maya", null],
  );
});

test("S8, D7, D9: seat claims and the end of the debate refund what hasn't fired", () => {
  const mine = question("ana", "A", 5);
  const fired = question("ana", "B", 5, [], { state: "fired" });
  const theirs = question("ben", "A", 5, [["ana", 2]]);
  assert.deepEqual(seatClaimRefunds([mine, fired, theirs], "ana"), [mine]);
  const open = openFund("question", 10n * YC);
  open.pledges.push({ account: "cy", amount: 4n * YC });
  const funded = {
    ...openFund("extq", YC),
    state: "funded",
    pledges: [{ account: "dee", amount: YC }],
  };
  const ending = endingRefunds([mine, fired, theirs], [open, funded]);
  assert.deepEqual(ending.questions, [mine, theirs]);
  assert.equal(ending.pledges.length, 3);
  assert.deepEqual(ending.fundPledges, open.pledges);
});

test("random lists conserve every coin and only the #1 ever fires", () => {
  let state = 7;
  const next = () =>
    (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const accounts = ["a", "b", "c", "d", "e", "f", "g", "h"];
  for (let run = 0; run < 200; run++) {
    const questions = [];
    const mics = [];
    let held = 0n,
      paid = 0n,
      refunded = 0n,
      put = 0n;
    for (let step = 0; step < 60; step++) {
      const who = viewer(accounts[Math.floor(next() * accounts.length)]);
      const roll = next();
      try {
        if (roll < 0.25) {
          const target = next() < 0.5 ? "A" : "B";
          const { wager } = checkQuestion({
            list,
            questions,
            mics,
            actor: who,
            target,
            text: "q",
            wager: BigInt(1 + Math.floor(next() * 50)) * YC,
          });
          questions.push(question(who.account, target, Number(wager / YC)));
          put += wager;
          held += wager;
        } else if (roll < 0.6) {
          const q = questions[Math.floor(next() * questions.length)];
          if (!q) continue;
          const { amount } = checkPledge({
            list,
            question: q,
            actor: who,
            amount: BigInt(1 + Math.floor(next() * 30)) * YC,
          });
          q.pledges.push(pledge(who.account, Number(amount / YC)));
          put += amount;
          held += amount;
        } else if (roll < 0.75) {
          const q = questions[Math.floor(next() * questions.length)];
          const p = q?.pledges.find(
            (x) => x.account === who.account && x.state === "held",
          );
          if (!p) continue;
          const result = withdrawal(q, p.id, who);
          for (const r of result.refund) {
            r.state = "refunded";
            held -= r.amount;
            refunded += r.amount;
          }
          if (result.removesQuestion) q.state = "removed";
        } else {
          const camp = next() < 0.5 ? "A" : "B";
          const top = ranked(questions, "l1", camp)[0];
          if (!top) continue;
          const pretender = questions.find(
            (q) => q.state === "open" && campOf(q.target) === camp && q !== top,
          );
          if (pretender)
            refused(
              () =>
                fire({
                  list,
                  questions,
                  mics,
                  questionId: pretender.id,
                  actor: viewer(pretender.author),
                }),
              /#1|already fired/,
            );
          const result = fire({
            list,
            questions,
            mics,
            questionId: top.id,
            actor: viewer(top.author),
          });
          for (const p of result.paid) {
            p.state = "paid";
            held -= p.amount;
            paid += p.amount;
          }
          for (const p of result.refunded) {
            p.state = "refunded";
            held -= p.amount;
            refunded += p.amount;
          }
          for (const id of result.refundedQuestions)
            questions.find((q) => q.id === id).state = "refunded";
          top.state = "fired";
          mics.push({
            id: `m${step}`,
            listId: "l1",
            camp,
            questionId: top.id,
            holder: top.author,
            target: top.target,
            state: result.state,
            price: result.price,
          });
          for (const m of mics)
            if (m.state === "live" && next() < 0.5) m.state = "done";
        }
      } catch (error) {
        assert.ok(error instanceof MicError, error.message);
      }
      assert.equal(put, held + paid + refunded);
      const counted = questions.reduce((sum, q) => sum + total(q), 0n);
      assert.equal(counted, held);
      for (const camp of ["A", "B"])
        assert.ok(
          mics.filter((m) => m.camp === camp).length <= 1,
          "one mic per camp per list",
        );
    }
  }
});
