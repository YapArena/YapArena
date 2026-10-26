import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import pg from "pg";
import { encodeFunctionData, erc20Abi, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createCoinSandboxOperatorRepository,
  createCoinSandboxRepository,
} from "../dist/features/account-wallet/sandbox-repository.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { baseSepoliaAsset } from "../dist/features/account-wallet/base-sepolia.js";
import { runCoinSandboxOperator } from "../scripts/coin-sandbox-operator.ts";
import {
  attachSubject,
  confirmedApproval,
  openSandbox,
} from "./helpers/confirmations.js";

const ownerUrl = process.env.COIN_TREASURY_TEST_OWNER_DATABASE_URL,
  runtimeUrl = process.env.COIN_TREASURY_TEST_DATABASE_URL;
const custody = "0x1111111111111111111111111111111111111111",
  network = "base-sepolia:84532",
  config = { rail: "base-sepolia", depositDestination: custody },
  unopened = /this account has not used its coin sandbox/;
describe(
  "receipt-backed system treasury funding in a dedicated disposable Base Sepolia ledger",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, a, b, runtime, operator, other;
    before(async () => {
      for (const value of [ownerUrl, runtimeUrl]) {
        const url = new URL(value);
        assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
        assert.match(
          url.pathname,
          /^\/revocation_test_coin_treasury(?:_(?:fresh|upgrade|ci))?$/,
        );
      }
      const options = { options: "-c search_path=pg_catalog,yaparena,pg_temp" };
      owner = new pg.Pool({ ...options, connectionString: ownerUrl });
      a = new pg.Pool({ ...options, connectionString: ownerUrl });
      b = new pg.Pool({ ...options, connectionString: ownerUrl });
      runtime = new pg.Pool({ ...options, connectionString: runtimeUrl });
      const current = (
        await owner.query(
          "SELECT rail FROM coin_sandbox_controls WHERE singleton",
        )
      ).rows[0];
      if (current.rail !== "base-sepolia")
        await owner.query(
          "UPDATE coin_sandbox_controls SET rail='base-sepolia' WHERE singleton",
        );
      operator = createCoinSandboxOperatorRepository(a, config);
      other = createCoinSandboxOperatorRepository(b, config);
    });
    after(async () => {
      await Promise.all([owner?.end(), a?.end(), b?.end(), runtime?.end()]);
    });
    // Treasury operators are plain accounts; none has opened the sandbox.
    async function actor() {
      return (
        await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")
      ).rows[0].id;
    }
    function evidence(amount = "1000000") {
      const transactionId = `0x${randomBytes(32).toString("hex")}`;
      return {
        network,
        transactionId,
        locator: "log:0",
        amount,
        evidenceDigest: createHash("sha256")
          .update(
            JSON.stringify([
              "synthetic finalized incoming receipt fixture",
              transactionId,
              amount,
              custody,
            ]),
          )
          .digest("hex"),
      };
    }
    async function balance(purpose) {
      return (
        (
          await owner.query(
            "SELECT a.balance::text FROM coin_sandbox_system_accounts s JOIN coin_accounts a ON a.id=s.account_id WHERE s.purpose=$1",
            [purpose],
          )
        ).rows[0]?.balance ?? "0"
      );
    }
    it("reserves only owner-admitted signed payout identities and fences duplicate sender nonces", async () => {
      // Offline generated test key only: no RPC, token movement or broadcast.
      const signer = privateKeyToAccount(generatePrivateKey()),
        userId = await actor(),
        generation = (
          await owner.query("SELECT auth_generation FROM users WHERE id=$1", [
            userId,
          ])
        ).rows[0].auth_generation,
        token = createSessionToken(),
        localConfig = {
          rail: "base-sepolia",
          depositDestination: signer.address,
          withdrawalFee: "0",
        },
        repo = createCoinSandboxRepository(runtime, localConfig),
        ownerRepo = createCoinSandboxOperatorRepository(owner, localConfig);
      await createSessionRepository(runtime).create(
        userId,
        token.tokenHash,
        new Date(Date.now() + 600000),
        { authGeneration: generation },
      );
      const subject = await attachSubject(owner, userId);
      await openSandbox(owner, userId);
      const context = { userId, sessionTokenHash: token.tokenHash },
        incoming = await repo.quoteFunding(context, {
          amount: "10000000",
          idempotencyKey: randomUUID(),
        });
      await ownerRepo.confirmFunding({
        userId,
        requestId: incoming.id,
        // Synthetic authoritative receipt tests repository accounting only.
        receipt: evidence("10000000"),
      });
      let first;
      for (let index = 0; index < 2; index++) {
        const destination = `0x${(index ? "44" : "33").repeat(20)}`,
          quote = await repo.quoteWithdrawal(context, {
            gross: "5000000",
            destination,
            idempotencyKey: randomUUID(),
          }),
          { approval } = await confirmedApproval(runtime, {
            ...context,
            subject,
            purpose: "withdrawal.request",
            terms: quote.terms,
          });
        await repo.requestWithdrawal(context, {
          requestId: quote.id,
          approval,
        });
        await ownerRepo.review({
          userId,
          requestId: quote.id,
          decision: "approve",
          idempotencyKey: randomUUID(),
        });
        const signed = await signer.signTransaction({
            type: "eip1559",
            chainId: 84532,
            to: baseSepoliaAsset.token,
            nonce: 0,
            gas: 100000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
            value: 0n,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [destination, 5000000n],
            }),
          }),
          prepared = {
            environment: "sandbox",
            chainId: 84532,
            token: baseSepoliaAsset.token,
            from: signer.address,
            to: destination,
            amount: 5000000n,
            operationId: quote.id,
            nonce: 0,
            serializedTransaction: signed,
            hash: keccak256(signed),
          };
        await assert.rejects(
          runtime.query(
            "INSERT INTO coin_nonce_reservations(request_id,network,sender,nonce,transaction_id,signed_bytes) VALUES($1,$2,$3,0,$4,$5)",
            [
              quote.id,
              network,
              signer.address.toLowerCase(),
              prepared.hash,
              signed,
            ],
          ),
          (error) => error.code === "42501",
        );
        if (!index) {
          first = { quote, prepared };
          // Signing admission re-checks the opening rather than trusting the
          // earlier approval. Openings are permanent in the product; removing
          // the record stands in for an account that never opened.
          await owner.query(
            "DELETE FROM coin_sandbox_openings WHERE user_id=$1",
            [userId],
          );
          await assert.rejects(
            ownerRepo.reserveSignedPayout({
              userId,
              requestId: quote.id,
              prepared,
            }),
            unopened,
          );
          assert.equal(
            (
              await owner.query(
                "SELECT count(*)::int n FROM coin_nonce_reservations WHERE request_id=$1",
                [quote.id],
              )
            ).rows[0].n,
            0,
          );
          await openSandbox(owner, userId);
          assert.equal(
            (
              await ownerRepo.reserveSignedPayout({
                userId,
                requestId: quote.id,
                prepared,
              })
            ).created,
            true,
          );
          assert.equal(
            (
              await ownerRepo.reserveSignedPayout({
                userId,
                requestId: quote.id,
                prepared,
              })
            ).created,
            false,
          );
        } else
          await assert.rejects(
            ownerRepo.reserveSignedPayout({
              userId,
              requestId: quote.id,
              prepared,
            }),
            (error) => error.code === "23505",
          );
      }
      assert.deepEqual(
        (
          await owner.query(
            "SELECT request_id AS request,transaction_id AS hash,nonce::text FROM coin_nonce_reservations WHERE sender=$1",
            [signer.address.toLowerCase()],
          )
        ).rows,
        [{ request: first.quote.id, hash: first.prepared.hash, nonce: "0" }],
      );
      assert.equal((await repo.summary(context)).balances.pending, "10000000");
    });
    it("credits only separately identified system treasury buckets without issuing purchased coins, grants or cash to the audit account", async () => {
      const userId = await actor(),
        historical = (
          await owner.query("SELECT count(*)::int n FROM a4_postings")
        ).rows[0].n;
      for (const purpose of ["promotional", "center", "correction"]) {
        const destination = `${purpose}_available`,
          before = BigInt(await balance(destination));
        const result = await operator.confirmTreasuryFunding({
          operatorUserId: userId,
          purpose,
          amount: "1000000",
          idempotencyKey: randomUUID(),
          receipt: evidence(),
        });
        assert.equal(result.created, true);
        assert.equal(result.request.kind, "treasury");
        assert.equal(result.request.status, "completed");
        assert.equal(BigInt(await balance(destination)) - before, 1000000n);
        for (const [key, value] of Object.entries({
          environment: "sandbox",
          rail: "base-sepolia",
          network,
          asset: "USDC",
          precision: "6",
          destination: custody,
          purpose,
          amount: "1000000",
        }))
          assert.equal(result.request.terms[key], value);
      }
      const book = (
        await owner.query(
          "SELECT book FROM coin_sandbox_books WHERE user_id=$1",
          [userId],
        )
      ).rows[0].book;
      assert.deepEqual(book.grants, []);
      assert.deepEqual(book.purchased, []);
      assert.equal(
        (
          await owner.query(
            "SELECT COALESCE(sum(balance),0)::text amount FROM coin_accounts WHERE user_id=$1",
            [userId],
          )
        ).rows[0].amount,
        "0",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM coin_grant_lots WHERE user_id=$1",
            [userId],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (await owner.query("SELECT count(*)::int n FROM a4_postings")).rows[0]
          .n,
        historical,
      );
      assert.equal(
        (
          await owner.query(
            `SELECT count(*)::int n FROM coin_journals j WHERE environment='sandbox' AND EXISTS(SELECT 1 FROM coin_postings p WHERE p.journal_id=j.id) AND (SELECT sum(amount) FROM coin_postings p WHERE p.journal_id=j.id)<>0`,
          )
        ).rows[0].n,
        0,
      );
    });
    it("consumes one exact external receipt and immutable idempotency scope across concurrent owner instances", async () => {
      const userId = await actor(),
        receipt = evidence(),
        input = {
          operatorUserId: userId,
          purpose: "promotional",
          amount: receipt.amount,
          idempotencyKey: randomUUID(),
          receipt,
        },
        before = BigInt(await balance("promotional_available"));
      const results = await Promise.all([
        operator.confirmTreasuryFunding(input),
        other.confirmTreasuryFunding(input),
      ]);
      assert.equal(results.filter((result) => result.created).length, 1);
      assert.equal(new Set(results.map((result) => result.request.id)).size, 1);
      assert.equal(
        BigInt(await balance("promotional_available")) - before,
        1000000n,
      );
      for (const changes of [
        { amount: "2000000", receipt: evidence("2000000") },
        { purpose: "center" },
        { receipt: evidence() },
      ])
        await assert.rejects(
          operator.confirmTreasuryFunding({ ...input, ...changes }),
          /idempotency conflict|assigned or conflicts/,
        );
      await assert.rejects(
        operator.confirmTreasuryFunding({
          ...input,
          idempotencyKey: randomUUID(),
        }),
        /assigned or conflicts/,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM coin_sandbox_requests WHERE user_id=$1 AND kind='treasury'",
            [userId],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM coin_external_receipts WHERE transaction_id=$1",
            [receipt.transactionId],
          )
        ).rows[0].n,
        1,
      );
    });
    it("globally rejects reassigning a treasury receipt to another operator or a purchased funding request", async () => {
      const first = await actor(),
        second = await actor(),
        receipt = evidence(),
        input = {
          purpose: "center",
          amount: receipt.amount,
          idempotencyKey: randomUUID(),
          receipt,
        };
      const results = await Promise.allSettled([
        operator.confirmTreasuryFunding({ ...input, operatorUserId: first }),
        other.confirmTreasuryFunding({ ...input, operatorUserId: second }),
      ]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
      );
      const fundingId = randomUUID(),
        terms = {
          environment: "sandbox",
          rail: "base-sepolia",
          network,
          asset: "USDC",
          precision: "6",
          amount: receipt.amount,
          destination: custody,
        };
      await owner.query(
        "INSERT INTO coin_sandbox_requests(id,user_id,kind,reference,terms_digest,terms,status) VALUES($1,$2,'funding',$3,$4,$5::jsonb,'quoted')",
        [
          fundingId,
          second,
          randomBytes(32).toString("hex"),
          randomBytes(32).toString("hex"),
          JSON.stringify(terms),
        ],
      );
      // Owner funding first requires the account's own sandbox opening.
      await assert.rejects(
        operator.confirmFunding({
          userId: second,
          requestId: fundingId,
          receipt,
        }),
        unopened,
      );
      await openSandbox(owner, second);
      await assert.rejects(
        operator.confirmFunding({
          userId: second,
          requestId: fundingId,
          receipt,
        }),
        /assigned or conflicts/,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT COALESCE(sum(balance),0)::text amount FROM coin_accounts WHERE user_id=$1 AND asset='USDC'",
            [second],
          )
        ).rows[0].amount,
        "0",
      );
    });
    it("rejects runtime authority, simulation credits, mismatched receipts and ordinary funding completion of treasury requests", async () => {
      const userId = await actor(),
        receipt = evidence(),
        input = {
          operatorUserId: userId,
          purpose: "correction",
          amount: receipt.amount,
          idempotencyKey: randomUUID(),
          receipt,
        };
      await assert.rejects(
        createCoinSandboxOperatorRepository(
          runtime,
          config,
        ).confirmTreasuryFunding(input),
        /operator ownership is required/,
      );
      await assert.rejects(
        createCoinSandboxOperatorRepository(owner, {
          rail: "simulation",
        }).confirmTreasuryFunding(input),
        /isolated testnet ledger/,
      );
      await assert.rejects(
        runCoinSandboxOperator({
          command: "confirm-treasury",
          body: {},
          environment: {
            COIN_SANDBOX_OWNER_DATABASE_URL: ownerUrl,
            COIN_SANDBOX_RAIL: "simulation",
          },
        }),
        /sandbox rail does not match this isolated database/,
      );
      for (const wrong of [
        { ...receipt, network: "simulation:usdc" },
        { ...receipt, amount: "1" },
        { ...receipt, evidenceDigest: "invalid" },
      ])
        await assert.rejects(
          operator.confirmTreasuryFunding({ ...input, receipt: wrong }),
          /does not match/,
        );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM coin_sandbox_requests WHERE user_id=$1",
            [userId],
          )
        ).rows[0].n,
        0,
      );
      const result = await operator.confirmTreasuryFunding(input);
      await openSandbox(owner, userId);
      await assert.rejects(
        operator.confirmFunding({
          userId,
          requestId: result.request.id,
          receipt,
        }),
        /funding request conflicts/,
      );
      assert.throws(
        () =>
          createCoinSandboxRepository(runtime, config).confirmSimulatedFunding(
            { userId, sessionTokenHash: "synthetic-unusable-session" },
            { requestId: result.request.id },
          ),
        /simulated credits are prohibited/,
      );
      await assert.rejects(
        owner.query(
          'UPDATE coin_sandbox_requests SET terms=terms||\'{"purpose":"center"}\'::jsonb WHERE id=$1',
          [result.request.id],
        ),
        /terms are immutable/,
      );
    });
  },
);
