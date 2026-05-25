import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://localhost:4000";
const password = process.env.E2E_PASSWORD ?? "Password123!";
const users = [
  {
    phone: process.env.E2E_PHONE_A ?? "+15550001001",
    displayName: process.env.E2E_DISPLAY_NAME_A ?? "E2E Alice"
  },
  {
    phone: process.env.E2E_PHONE_B ?? "+15550001002",
    displayName: process.env.E2E_DISPLAY_NAME_B ?? "E2E Bob"
  }
];

function keyBundle(label) {
  const key = (name) => `${label}-${name}-${"x".repeat(32)}`;
  return {
    registrationId: Math.floor(1 + Math.random() * 16000),
    identityKey: key("identity"),
    signedPreKey: {
      keyId: 1,
      publicKey: key("signed-pre-key"),
      signature: key("signature")
    },
    oneTimePreKeys: Array.from({ length: 10 }, (_, index) => ({
      keyId: index + 1,
      publicKey: key(`one-time-${index + 1}`)
    })),
    kyberPreKeys: []
  };
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function signupOrLogin(user, index) {
  try {
    return await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        phone: user.phone,
        password,
        device: { platform: "e2e", label: `e2e-seed-${index}` }
      })
    });
  } catch {
    // Fall through to signup when the test user does not exist yet.
  }

  try {
    return await request("/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        phone: user.phone,
        password,
        displayName: user.displayName,
        device: { platform: "e2e", label: `e2e-seed-${index}` },
        keys: keyBundle(`e2e-${index}-${Date.now()}`)
      })
    });
  } catch (error) {
    if (!String(error.message).includes("Unique constraint") && !String(error.message).includes("Internal server error")) throw error;
    return request("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        phone: user.phone,
        password,
        device: { platform: "e2e", label: `e2e-seed-${index}` }
      })
    });
  }
}

const [alice, bob] = await Promise.all(users.map(signupOrLogin));
const direct = await request("/conversations/direct", {
  method: "POST",
  headers: { Authorization: `Bearer ${alice.accessToken}` },
  body: JSON.stringify({ userId: bob.user.id })
});
const group = await request("/groups", {
  method: "POST",
  headers: { Authorization: `Bearer ${alice.accessToken}` },
  body: JSON.stringify({ name: "E2E Group", memberIds: [bob.user.id] })
}).catch(() => null);

const env = {
  TEST_PHONE_A: users[0].phone,
  TEST_PHONE_B: users[1].phone,
  TEST_PASSWORD: password,
  TEST_DISPLAY_NAME_A: users[0].displayName,
  TEST_USER_A_ID: alice.user.id,
  TEST_USER_B_ID: bob.user.id,
  TEST_DIRECT_CONVERSATION_ID: direct.conversation.id,
  TEST_GROUP_NAME: group?.conversation?.group?.name ?? "E2E Group",
  TEST_GROUP_CONVERSATION_ID: group?.conversation?.id ?? "",
  TEST_GROUP_MEMBER_IDS: bob.user.id
};

const output = resolve("../HM-Frontend/e2e/maestro/.env.generated.json");
writeFileSync(output, `${JSON.stringify(env, null, 2)}\n`);
console.log(JSON.stringify(env, null, 2));
