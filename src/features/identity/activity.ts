// Readable names for identity audit events on the account page. Database
// triggers name events after their table ("sessions.insert"), so people never
// see the raw type. The subject is read only for role and sign-in method
// events, where it is a role or method name rather than a record ID.
const fixed: Readonly<Record<string, string>> = {
  "sessions.insert": "Signed in",
  "sessions.delete": "Signed out",
  "sessions.incident": "Signed out everywhere by YapArena",
  "public_profiles.insert": "Created your profile",
  "public_profiles.update": "Updated your profile",
  "public_profiles.delete": "Removed your profile",
  "follows.insert": "Followed a person or topic",
  "follows.delete": "Unfollowed a person or topic",
  "account.operation_authorized": "Confirmed a sensitive action",
};

const methods: Readonly<Record<string, string>> = {
  google: "Linked Google sign-in",
  email: "Linked email-code sign-in",
};

export function activityLabel(eventType: string, subject: string | null) {
  const label = fixed[eventType];
  if (label) return label;
  if (eventType === "account_roles.insert")
    return subject === "participant"
      ? "Created your account"
      : `Added the ${subject ?? "account"} role`;
  if (eventType === "account_roles.delete")
    return `Removed the ${subject ?? "account"} role`;
  if (eventType === "sign_in.method_linked")
    return methods[subject ?? ""] ?? "Linked a sign-in method";
  if (
    eventType.startsWith("credentials.") ||
    eventType.startsWith("wallet_identities.")
  )
    return "Changed a sign-in method";
  return "Updated your account";
}

// Sign-out of one session also writes the trigger's sessions.delete, so the
// explicit row would list the same sign-out twice.
export const hiddenActivityTypes = ["sessions.logout_one"] as const;
