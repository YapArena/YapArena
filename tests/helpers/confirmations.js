// Shared fixtures for Decision 0009 confirmations in PostgreSQL tests. A
// sensitive operation is confirmed by a fresh sign-in of one of the account's
// Auth0 subjects; these helpers stand in for that sign-in.
import { randomUUID } from "node:crypto";
import { createAccountOperationRepository } from "../../dist/platform/auth/account-operations.js";

// Attaches an Auth0 email-code subject to an account and returns it.
export async function attachSubject(
  owner,
  userId,
  subject = `email|${randomUUID()}`,
) {
  await owner.query(
    `INSERT INTO provider_identities(provider,subject,user_id,email,methods)
     VALUES('auth0',$1,$2,$3,'["email"]'::jsonb)`,
    [subject, userId, `${randomUUID()}@example.test`],
  );
  return subject;
}

// Records the automatic opening that an account's first own sandbox request
// creates (Decision 0013), for tests whose first step is owner authority.
export async function openSandbox(owner, userId) {
  await owner.query(
    `INSERT INTO coin_sandbox_openings(user_id) VALUES($1)
     ON CONFLICT(user_id) DO NOTHING`,
    [userId],
  );
}

// Creates, confirms (as a fresh sign-in by `subject`) and prepares one
// operation. Returns the prepared approval and the operation id.
export async function confirmedApproval(
  pool,
  { userId, sessionTokenHash, purpose, terms, subject },
  operations = createAccountOperationRepository(pool),
) {
  const issued = await operations.create({
    userId,
    sessionTokenHash,
    purpose,
    terms,
  });
  await operations.confirm({
    id: issued.id,
    userId,
    identity: { subject, authTime: Math.ceil(Date.now() / 1000) },
  });
  const approval = await operations.prepare({
    id: issued.id,
    userId,
    sessionTokenHash,
    purpose,
    terms,
  });
  return { id: issued.id, approval, operations };
}
