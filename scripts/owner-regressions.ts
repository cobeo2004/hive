import assert from "node:assert/strict";
import { isAdmin, isMember } from "../lib/auth/owner";

// R4, R33: a member is a user with TOTP on who finished /setup; an admin is a member with the admin role.
const admin = { email: "admin@example.com", role: "admin", twoFactorEnabled: true, setupDoneAt: new Date() };
const engineer = { email: "eng@example.com", role: "engineer", twoFactorEnabled: true, setupDoneAt: new Date() };

assert.equal(isMember(engineer), true, "an engineer with TOTP is a member");
assert.equal(isAdmin(engineer), false, "an engineer is not an admin");
assert.equal(isMember(admin), true);
assert.equal(isAdmin(admin), true, "an admin with TOTP is an admin");
for (const user of [{ ...engineer, twoFactorEnabled: false }, { ...engineer, twoFactorEnabled: null }, { email: engineer.email }]) {
  assert.equal(isMember(user), false, `a user without TOTP is not a member (${JSON.stringify(user)})`);
}
assert.equal(isAdmin({ ...admin, twoFactorEnabled: false }), false, "an admin without TOTP is not an admin");
for (const setupDoneAt of [null, undefined]) {
  assert.equal(isMember({ ...engineer, setupDoneAt }), false, "TOTP without finished setup is not a member");
  assert.equal(isAdmin({ ...admin, setupDoneAt }), false, "nor an admin");
}
assert.equal(isAdmin({ ...admin, role: "Admin" }), false, "the role matches exactly");
assert.equal(isAdmin({ ...admin, role: "admin,engineer" }), false, "a role list is not admin");
assert.equal(isMember(null), false, "no session is not a member");
assert.equal(isAdmin(undefined), false, "no session is not an admin");

console.log("owner regressions passed");
